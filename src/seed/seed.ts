import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { basename, join } from 'node:path';
import { curatedDir, loadCurated, validateUses } from '../curated/load.ts';
import type { CreativeUse, FanSource } from '../curated/load.ts';
import { SEED_VERSION, createSchema } from '../db/schema.ts';
import { readPointer, writePointer } from '../db/open.ts';
import {
  writeColors, writeConnections, writeCreativeUses, writeManifest, writeParts, writePartColors,
  writePlacements, writeProjectParts, writeProjects, writeRelationships, writeSources, writeSubmodels, writeTraits,
} from '../db/write.ts';
import type { ConnectionRow, PartColorRow, PartRow, PlacementRow, SubmodelRow, TraitRow } from '../db/write.ts';
import { computeAvailability } from '../derive/availability.ts';
import { matchParts, matchRateTop } from '../derive/match.ts';
import { isSystemPart } from '../derive/system.ts';
import { deriveTraits } from '../derive/traits.ts';
import { LDrawLibrary } from '../ldraw/library.ts';
import { resolvePart } from '../ldraw/resolve.ts';
import { computeShape } from '../ldraw/shape.ts';
import { dataPaths } from '../paths.ts';
import { assembleProject } from '../projects/assemble.ts';
import type { AssembledProject } from '../projects/assemble.ts';
import { buildColorMap, buildPartMap } from '../projects/colors.ts';
import { licenseAllowed } from '../projects/license.ts';
import { parseModel } from '../projects/mpd.ts';
import { buildSetProjects } from '../projects/sets.ts';
import type { ProjectPartRow, ProjectRow } from '../projects/sets.ts';
import type { Variant } from '../projects/types.ts';
import { buildFanProjects, fetchFanSource } from '../sources/fan.ts';
import type { FanFetchOptions } from '../sources/fan.ts';
import { fetchSources } from '../sources/fetch.ts';
import type { FetchedSources } from '../sources/fetch.ts';
import { fetchOmr } from '../sources/omr.ts';
import type { OmrFile } from '../sources/omr.ts';
import { loadRebrickable } from '../sources/rebrickable.ts';
import type { RbPart, RebrickableData } from '../sources/rebrickable.ts';
import { acquireLock, readState, releaseLock, writeState } from './lock.ts';

export interface SeedOptions {
  dataDir: string;
  repoRoot: string;
  refresh: boolean;
  sources?: FetchedSources;
  now?: () => Date;
  /** Which projects to include. Default `'fallback'`: set parts lists only. */
  variant?: Variant;
  /** Who built the database, recorded in the manifest. Default `'local'`. */
  builtBy?: 'ci' | 'local';
  /** Test hooks: OMR base URL and retry backoff, or a ready file list that skips fetching. */
  omr?: { baseUrl?: string; backoffMs?: number; files?: OmrFile[] };
  /** Test hooks: GitHub API and codeload base URLs for fan sources. */
  fanFetch?: Pick<FanFetchOptions, 'githubApi' | 'codeload'>;
}
export interface SeedResult {
  /** Absolute path of the new database; empty when another seed already holds the lock. */
  dbFile: string;
  counts: Record<string, number>;
}

const CACHE_MAX_AGE_HOURS = 24;
const FLUSH_EVERY = 500;
const PLACEHOLDER_COLORS = new Set([-1, 9999]);
const PLACEMENT_FLUSH_EVERY = 5000;

const pad = (n: number) => String(n).padStart(2, '0');
function stampOf(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function uniqueDbFile(dataDir: string, start: Date): string {
  const paths = dataPaths(dataDir);
  const d = new Date(start);
  while (existsSync(paths.dbFile(stampOf(d)))) d.setUTCSeconds(d.getUTCSeconds() + 1);
  return paths.dbFile(stampOf(d));
}

export async function runSeed(opts: SeedOptions): Promise<SeedResult> {
  const now = opts.now ?? (() => new Date());
  const paths = dataPaths(opts.dataDir);
  mkdirSync(opts.dataDir, { recursive: true });
  const log = (msg: string) => appendFileSync(paths.log, `${now().toISOString()} ${msg}\n`);

  if (!acquireLock(paths.lock)) {
    log('seed already running; skipping');
    return { dbFile: '', counts: {} };
  }

  const startedAt = now().toISOString();
  let prior = readState(paths.state);
  let dbFile: string | null = null;
  let db: DatabaseSync | null = null;
  try {
    prior = readState(paths.state);
    writeState(paths.state, { status: 'seeding', startedAt, finishedAt: null, lastError: null, failures: prior.failures });
    log('seed start');
    dbFile = uniqueDbFile(opts.dataDir, now());

    const sources = opts.sources ?? await fetchSources(paths.cacheDir, {
      refresh: opts.refresh, maxAgeHours: CACHE_MAX_AGE_HOURS,
    });
    log(`sources ready (${sources.records.length} records, ldcad ${sources.ldcadCommit})`);

    const rb = await loadRebrickable(sources.rebrickableDir);
    const lib = await LDrawLibrary.fromDirs(sources.ldrawRoot, sources.shadowRoot);
    log(`loaded rebrickable: ${rb.parts.length} parts, ${rb.colors.length} colors`);

    const matches = matchParts(rb, (f) => lib.has(f));
    const avail = computeAvailability(rb);
    const setCounts = new Map<string, number>();
    for (const [partNum, a] of avail.parts) setCounts.set(partNum, a.setCount);
    log(`matched ${matches.size} of ${rb.parts.length} parts to LDraw files`);

    const curated = await loadCurated(curatedDir(opts.repoRoot));
    const partNums = new Set(rb.parts.map((p) => p.partNum));
    const { accepted, rejected } = validateUses(curated.uses, partNums);
    for (const r of rejected) log(`creative use rejected (${r.reason}): ${r.use.part} / ${r.use.represents}`);

    db = new DatabaseSync(dbFile);
    createSchema(db);

    const colorTrans = new Map(rb.colors.map((c) => [c.id, c.isTrans]));
    const printParent = new Map<string, string>();
    for (const r of rb.relationships) {
      if (r.relType === 'P' || r.relType === 'T') printParent.set(r.child, r.parent);
    }

    // Parts sharing an LDraw file (via geometryFrom) are resolved once.
    const byFile = new Map<string, RbPart[]>();
    const unmatched: RbPart[] = [];
    for (const p of rb.parts) {
      const m = matches.get(p.partNum);
      if (!m) { unmatched.push(p); continue; }
      let group = byFile.get(m.ldrawFile);
      if (!group) byFile.set(m.ldrawFile, (group = []));
      group.push(p);
    }

    let partRows: PartRow[] = [];
    let connRows: ConnectionRow[] = [];
    let traitRows: TraitRow[] = [];
    let nParts = 0;
    let nConnections = 0;
    let nWithConnections = 0;
    let nIncomplete = 0;
    const flush = () => {
      writeParts(db!, partRows);
      writeConnections(db!, connRows);
      writeTraits(db!, traitRows);
      partRows = []; connRows = []; traitRows = [];
    };

    const baseRow = (p: RbPart): PartRow => {
      const a = avail.parts.get(p.partNum);
      const parent = printParent.get(p.partNum);
      const categoryName = rb.categories.get(p.categoryId) ?? null;
      return {
        partNum: p.partNum, name: p.name, categoryId: p.categoryId, categoryName,
        ldrawFile: null, geometryFrom: null,
        widthStuds: null, depthStuds: null, heightPlates: null,
        minX: null, minY: null, minZ: null, maxX: null, maxY: null, maxZ: null,
        grid: null, slopeAngle: null, basicKind: null,
        setCount: a?.setCount ?? 0, firstYear: a?.firstYear ?? null, lastYear: a?.lastYear ?? null,
        license: null, hasGeometry: false, hasConnections: false, hasGrid: false, isComplete: false,
        isPrint: parent !== undefined, basePartNum: parent ?? null,
        isSystem: isSystemPart(p.name, categoryName ?? ''),
      };
    };
    const traitsFor = (p: RbPart, row: PartRow, connections: ConnectionRow[]) => {
      const colorsTrans = [...(avail.partColors.get(p.partNum)?.keys() ?? [])]
        .map((id) => colorTrans.get(id) ?? false);
      const t = deriveTraits({
        name: p.name, categoryName: row.categoryName ?? '', connections, colorsTrans,
      });
      row.slopeAngle = t.slopeAngle;
      row.basicKind = t.basicKind;
      for (const trait of t.traits) traitRows.push({ partNum: p.partNum, trait });
    };
    const finish = (row: PartRow, conns: ConnectionRow[]) => {
      partRows.push(row);
      connRows.push(...conns);
      nParts++;
      nConnections += conns.length;
      if (conns.length > 0) nWithConnections++;
      if (!row.isComplete) nIncomplete++;
      if (partRows.length >= FLUSH_EVERY) flush();
    };

    for (const p of unmatched) {
      const row = baseRow(p);
      traitsFor(p, row, []);
      finish(row, []);
    }

    for (const [file, group] of byFile) {
      const resolved = resolvePart(lib, file);
      // A part we may not redistribute keeps its license but none of its geometry.
      const licensed = licenseAllowed(resolved.license);
      if (!licensed) log(`${file}: license not allowed, geometry removed (${resolved.license ?? 'none'})`);
      const shape = licensed ? computeShape(resolved.bodyTriangles) : null;
      const connections = licensed ? resolved.connections : [];
      const hasConnections = connections.length > 0;
      const isComplete = shape !== null && hasConnections &&
        resolved.missingRefs.length === 0 && resolved.errors.length === 0 && !resolved.cyclic;
      for (const p of group) {
        const row = baseRow(p);
        const m = matches.get(p.partNum)!;
        row.ldrawFile = m.ldrawFile;
        row.geometryFrom = m.geometryFrom;
        row.license = resolved.license;
        if (shape !== null) {
          const { min, max } = shape.bounds;
          row.widthStuds = shape.widthStuds;
          row.depthStuds = shape.depthStuds;
          row.heightPlates = shape.heightPlates;
          [row.minX, row.minY, row.minZ] = min;
          [row.maxX, row.maxY, row.maxZ] = max;
          row.grid = shape.grid;
          row.hasGeometry = true;
          row.hasGrid = true;
        }
        row.hasConnections = hasConnections;
        row.isComplete = isComplete;
        const conns = connections.map((c): ConnectionRow => ({ ...c, partNum: p.partNum }));
        traitsFor(p, row, conns);
        finish(row, conns);
      }
      if (resolved.missingRefs.length > 0 || resolved.errors.length > 0 || resolved.cyclic) {
        log(`${file}: missingRefs=${resolved.missingRefs.length} errors=${resolved.errors.length} cyclic=${resolved.cyclic}`);
      }
    }
    flush();
    log(`processed ${nParts} parts, ${nConnections} connections, ${nIncomplete} incomplete`);

    writeColors(db, rb.colors.map((c) => ({
      id: c.id, name: c.name, rgb: c.rgb, isTrans: c.isTrans,
      family: curated.families.get(c.id) ?? 'other', isPlaceholder: PLACEHOLDER_COLORS.has(c.id),
    })));
    const partColorRows: PartColorRow[] = [];
    for (const [partNum, byColor] of avail.partColors) {
      if (!partNums.has(partNum)) continue;
      for (const [colorId, a] of byColor) {
        partColorRows.push({ partNum, colorId, setCount: a.setCount, lastYear: a.lastYear, inElements: a.inElements });
      }
    }
    writePartColors(db, partColorRows);
    writeRelationships(db, rb.relationships.map((r) => ({
      relType: r.relType, childPartNum: r.child, parentPartNum: r.parent,
    })));
    writeCreativeUses(db, accepted.map((u: CreativeUse) => ({
      partNum: u.part, represents: u.represents, note: u.note, reviewed: u.reviewed, source: 'curated',
    })));
    writeSources(db, sources.records.map((r) => ({
      name: r.name, url: r.url, downloadedAt: r.downloadedAt, bytes: r.bytes,
      sha256: r.sha256, lastModified: r.lastModified,
    })));

    const projects = await writeProjectStages(db, {
      opts, rb, sources, fanSources: curated.fanSources, log, cacheDir: paths.cacheDir,
      partMapInput: rb.parts.map((p) => {
        const m = matches.get(p.partNum);
        return { partNum: p.partNum, ldrawFile: m?.ldrawFile ?? null, geometryFrom: m?.geometryFrom ?? null };
      }),
    });

    const finishedAt = now().toISOString();
    writeManifest(db, {
      seed_version: SEED_VERSION,
      curated_hash: curated.hash,
      started_at: startedAt,
      finished_at: finishedAt,
      ldraw_release: lib.releaseName() ?? '',
      ldcad_commit: sources.ldcadCommit,
      match_rate_top1000: matchRateTop(rb, matches, setCounts, 1000),
      count_parts: nParts,
      count_with_connections: nWithConnections,
      count_incomplete: nIncomplete,
      count_creative_loaded: accepted.length,
      count_creative_rejected: rejected.length,
      ...projects,
    });
    db.close();
    db = null;
    log('database written');

    writePointer(opts.dataDir, basename(dbFile));
    // The new database is live from here on: nothing below may fail the seed.
    try {
      for (const name of readdirSync(opts.dataDir)) {
        if (!/^parts-.*\.db$/.test(name) || name === basename(dbFile)) continue;
        try {
          rmSync(join(opts.dataDir, name), { force: true });
        } catch (err) {
          log(`could not remove old database ${name}: ${(err as NodeJS.ErrnoException).code ?? err}`);
        }
      }
      writeState(paths.state, { status: 'ready', startedAt, finishedAt, lastError: null, failures: 0 });
      log(`seed done: ${basename(dbFile)}`);
    } catch { /* best effort */ }
    return {
      dbFile,
      counts: {
        parts: nParts,
        with_connections: nWithConnections,
        incomplete: nIncomplete,
        connections: nConnections,
        creative_loaded: accepted.length,
        creative_rejected: rejected.length,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Cleanup and bookkeeping must never mask the original error.
    try { db?.close(); } catch { /* already closed */ }
    try {
      if (dbFile !== null && dbFile !== readPointerPath(opts.dataDir)) rmSync(dbFile, { force: true });
    } catch { /* best effort */ }
    try { log(`seed failed: ${err instanceof Error ? (err.stack ?? message) : message}`); } catch { /* ignore */ }
    try {
      writeState(paths.state, {
        status: 'failed', startedAt, finishedAt: now().toISOString(), lastError: message, failures: prior.failures + 1,
      });
    } catch { /* ignore */ }
    throw err;
  } finally {
    try { releaseLock(paths.lock); } catch { /* ignore */ }
  }
}

function readPointerPath(dataDir: string): string | null {
  const name = readPointer(dataDir);
  return name === null ? null : join(dataDir, name);
}

interface StageInput {
  opts: SeedOptions;
  rb: RebrickableData;
  sources: FetchedSources;
  fanSources: FanSource[];
  log: (msg: string) => void;
  cacheDir: string;
  partMapInput: { partNum: string; ldrawFile: string | null; geometryFrom: string | null }[];
}

type Maps = { parts: Map<string, string>; colors: Map<number, number> };
type SetUpdate = { id: number; author: string | null; license: string | null; url: string };

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const sumParts = (parts: { quantity: number }[]) => parts.reduce((n, p) => n + p.quantity, 0);

/**
 * Writes the project stages and returns their manifest entries. Set projects are written for every
 * variant and their errors fail the seed. OMR (standard and full) and each fan source (full) are
 * isolated: a failure removes that stage's rows, is logged, and is listed in `failed_sources`.
 */
async function writeProjectStages(db: DatabaseSync, input: StageInput): Promise<Record<string, string | number>> {
  const { opts, rb, sources, log } = input;
  const variant: Variant = opts.variant ?? 'fallback';

  const sets = buildSetProjects(rb, 1);
  writeProjects(db, sets.projects);
  writeProjectParts(db, sets.parts);
  log(`wrote ${sets.projects.length} set projects`);
  const setByNum = new Map(sets.projects.map((p) => [p.sourceKey, p]));
  let nextProjectId = sets.projects.reduce((max, p) => Math.max(max, p.id), 0) + 1;
  let lastSubmodelId = 0;
  const nextSubmodelId = () => ++lastSubmodelId;

  // Rows are buffered and written in batches; each batch is one transaction per table.
  let projectRows: ProjectRow[] = [];
  let partRows: ProjectPartRow[] = [];
  let submodelRows: SubmodelRow[] = [];
  let placementRows: PlacementRow[] = [];
  const flush = () => {
    writeProjects(db, projectRows);
    writeProjectParts(db, partRows);
    writeSubmodels(db, submodelRows);
    writePlacements(db, placementRows);
    projectRows = []; partRows = []; submodelRows = []; placementRows = [];
  };
  const add = (projectId: number, a: AssembledProject, project: ProjectRow | null) => {
    if (project) {
      projectRows.push(project);
      for (const p of a.parts) partRows.push({ ...p, projectId });
    }
    for (const s of a.submodels) submodelRows.push({ ...s, projectId });
    for (const p of a.placements) placementRows.push(p);
    if (placementRows.length >= PLACEMENT_FLUSH_EVERY) flush();
  };
  // Removes everything a failed stage wrote: projects from `firstProject`, submodels after `lastSubmodel`.
  const discard = (firstProject: number, lastSubmodel: number) => {
    projectRows = []; partRows = []; submodelRows = []; placementRows = [];
    db.prepare('DELETE FROM placements WHERE submodel_id > ?').run(lastSubmodel);
    db.prepare('DELETE FROM submodels WHERE id > ?').run(lastSubmodel);
    db.prepare('DELETE FROM project_parts WHERE project_id >= ?').run(firstProject);
    db.prepare('DELETE FROM projects WHERE id >= ?').run(firstProject);
  };

  const failedSources: string[] = [];
  let colorRate: number | '' = '';
  let placementRate: number | '' = '';
  let skippedLicense = 0;
  let omrFilesFailed = 0;

  // The maps are needed by OMR and every fan source, so a failure here fails all of them.
  let maps: Maps | null = null;
  if (variant !== 'fallback') {
    try {
      const colors = buildColorMap(readFileSync(join(sources.ldrawRoot, 'LDConfig.ldr'), 'utf8'), rb.colors);
      if (colors.map.size === 0) throw new Error('LDConfig.ldr maps no colors');
      colorRate = colors.rate;
      maps = { parts: buildPartMap(input.partMapInput), colors: colors.map };
    } catch (err) {
      failedSources.push('omr');
      if (variant === 'full') failedSources.push(...input.fanSources.map((src) => src.id));
      log(`project maps failed: ${errText(err)}`);
    }
  }
  if (maps !== null) {

    const firstProject = nextProjectId;
    const lastSubmodel = lastSubmodelId;
    try {
      let files = opts.omr?.files;
      if (!files) {
        const r = await fetchOmr(input.cacheDir, { baseUrl: opts.omr?.baseUrl, backoffMs: opts.omr?.backoffMs });
        files = r.files;
        omrFilesFailed += r.failed;
        log(`omr: ${r.files.length} files (${r.fetched} fetched, ${r.fromCache} cached, ${r.failed} failed)`);
        for (const f of r.failedUrls.slice(0, 20)) log(`omr download failed: ${f.url}: ${f.reason}`);
      }
      const updates: SetUpdate[] = [];
      const attached = new Set<number>();
      let placements = 0;
      let resolved = 0;
      for (const f of files) {
        let a: AssembledProject;
        let author: string | null;
        let license: string | null;
        try {
          const parsed = parseModel(readFileSync(f.path, 'utf8'), f.fileName);
          const top = parsed.files.get(parsed.main);
          if (!top) throw new Error('no model in file');
          // Sub-files without a license line inherit the top-level one; an explicit disallowed line excludes the model.
          if (!licenseAllowed(top.license) ||
            [...parsed.files.values()].some((m) => m.license !== null && !licenseAllowed(m.license))) {
            skippedLicense++;
            continue;
          }
          a = assembleProject(parsed.main, parsed.files, maps, nextSubmodelId);
          author = top.author ?? a.authors[0] ?? null;
          license = top.license;
        } catch (err) {
          omrFilesFailed++;
          log(`omr file failed: ${f.fileName}: ${errText(err)}`);
          continue;
        }
        placements += a.stats.placements;
        resolved += a.stats.resolved;
        const set = setByNum.get(f.setNum);
        if (set && !f.isBModel && !attached.has(set.id)) {
          // A set's main model gives the set positions; the set keeps its Rebrickable parts list.
          attached.add(set.id);
          updates.push({ id: set.id, author, license, url: f.url });
          add(set.id, a, null);
          continue;
        }
        const id = nextProjectId++;
        const stem = f.fileName.replace(/\.[^.]+$/, '');
        const suffix = stem.slice(f.setNum.length).replace(/^[\s_-]+/, '');
        add(id, a, {
          id, source: 'omr', sourceKey: f.fileName, kind: 'official',
          name: set ? (suffix === '' ? set.name : `${set.name} (${suffix})`) : stem,
          year: set?.year ?? null, theme: set?.theme ?? null, parentTheme: set?.parentTheme ?? null,
          partCount: sumParts(a.parts), author, license, url: f.url,
          hasPositions: true, baseProjectId: set?.id ?? null,
        });
      }
      flush();
      const update = db.prepare('UPDATE projects SET has_positions = 1, author = ?, license = ?, url = ? WHERE id = ?');
      db.exec('BEGIN');
      try {
        for (const u of updates) update.run(u.author, u.license, u.url, u.id);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      placementRate = placements === 0 ? '' : resolved / placements;
      log(`omr: ${attached.size} sets with positions, ${nextProjectId - firstProject} omr projects, ` +
        `${skippedLicense} skipped for license, ${omrFilesFailed} failed, ${resolved}/${placements} placements resolved`);
    } catch (err) {
      discard(firstProject, lastSubmodel);
      failedSources.push('omr');
      log(`omr failed: ${errText(err)}`);
    }

    if (variant === 'full') {
      for (const src of input.fanSources) {
        const firstFan = nextProjectId;
        const lastFanSubmodel = lastSubmodelId;
        try {
          const { root, files } = await fetchFanSource(input.cacheDir, src, opts.fanFetch);
          const built = buildFanProjects(src, root, files, maps, nextSubmodelId);
          for (const p of built.projects) {
            const id = nextProjectId++;
            add(id, p, {
              id, source: src.id, sourceKey: p.root, kind: 'fan', name: p.root.replace(/\.[^.]+$/, ''),
              year: null, theme: null, parentTheme: null, partCount: sumParts(p.parts),
              author: p.authors[0] ?? src.designer, license: p.licenses[0] ?? src.defaultLicense,
              url: src.homepage, hasPositions: true, baseProjectId: null,
            });
          }
          flush();
          log(`fan ${src.id}: ${built.projects.length} projects, ${built.skipped} skipped for license`);
        } catch (err) {
          discard(firstFan, lastFanSubmodel);
          failedSources.push(src.id);
          log(`fan ${src.id} failed: ${errText(err)}`);
        }
      }
    }
  }

  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    variant,
    built_by: opts.builtBy ?? 'local',
    placement_match_rate: placementRate,
    color_match_rate: colorRate,
    count_projects_official: count("SELECT count(*) AS n FROM projects WHERE kind = 'official'"),
    count_projects_with_positions: count('SELECT count(*) AS n FROM projects WHERE has_positions = 1'),
    count_projects_fan: count("SELECT count(*) AS n FROM projects WHERE kind = 'fan'"),
    count_models_skipped_license: skippedLicense,
    count_omr_files_failed: omrFilesFailed,
    failed_sources: failedSources.join(','),
  };
}
