import { createHash } from 'node:crypto';
import { copyFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { loadCurated, curatedDir } from '../curated/load.ts';
import { SEED_VERSION } from '../db/schema.ts';
import { licenseAllowed } from '../projects/license.ts';
import { runSeed } from '../seed/seed.ts';
import type { SeedOptions } from '../seed/seed.ts';

const MIN_PART_MATCH = 0.95;
/** Share of OMR part references (primitives and segments excluded) resolving to a known part and color. */
const MIN_PLACEMENT_MATCH = 0.95;
const COUNT_TABLES = ['parts', 'projects', 'project_parts', 'submodels', 'placements'] as const;

export interface VariantMeta {
  file: string;
  gzSha256: string;
  gzBytes: number;
  dbSha256: string;
  dbBytes: number;
  counts: Record<string, number>;
}
export interface ReleaseResult { tag: string; assets: string[]; gateFailures: string[] }

function manifestOf(db: DatabaseSync): Map<string, string> {
  const rows = db.prepare('SELECT key, value FROM manifest').all() as { key: string; value: string }[];
  return new Map(rows.map((r) => [r.key, r.value]));
}

/** One message per failed publish gate; an empty list means the database may be published. */
export function checkGates(db: DatabaseSync, minPartMatch = MIN_PART_MATCH): string[] {
  const manifest = manifestOf(db);
  const failures: string[] = [];
  const rate = (key: string, min: number) => {
    const value = Number(manifest.get(key));
    if (!(value >= min)) failures.push(`${key} is ${manifest.get(key) ?? 'missing'}, below ${min}`);
  };
  rate('match_rate_top1000', minPartMatch);
  rate('placement_match_rate', MIN_PLACEMENT_MATCH);
  const badProjects = (db.prepare('SELECT DISTINCT license FROM projects WHERE license IS NOT NULL').all() as
    { license: string }[]).filter((r) => !licenseAllowed(r.license));
  if (badProjects.length > 0) {
    failures.push(`projects with a license that is not allowed: ${badProjects.map((r) => r.license).join('; ')}`);
  }
  const badParts = (db.prepare('SELECT DISTINCT license FROM parts WHERE has_geometry = 1').all() as
    { license: string | null }[]).filter((r) => !licenseAllowed(r.license));
  if (badParts.length > 0) {
    failures.push(`parts with geometry and a license that is not allowed: ${badParts.map((r) => r.license ?? 'none').join('; ')}`);
  }
  if ((manifest.get('failed_sources') ?? '').split(',').includes('omr')) {
    failures.push('failed_sources contains omr');
  }
  return failures;
}

/** Copies `fullFile` to `outFile` without the fan projects: variant `standard`, then VACUUM. */
export function deriveStandard(fullFile: string, outFile: string): void {
  copyFileSync(fullFile, outFile);
  const db = new DatabaseSync(outFile);
  try {
    db.exec(`
      DELETE FROM placements WHERE submodel_id IN
        (SELECT s.id FROM submodels s JOIN projects p ON p.id = s.project_id WHERE p.kind = 'fan');
      DELETE FROM submodels WHERE project_id IN (SELECT id FROM projects WHERE kind = 'fan');
      DELETE FROM project_parts WHERE project_id IN (SELECT id FROM projects WHERE kind = 'fan');
      DELETE FROM projects WHERE kind = 'fan';
      INSERT OR REPLACE INTO manifest (key, value) VALUES ('variant', 'standard'), ('count_projects_fan', '0');
      INSERT OR REPLACE INTO manifest (key, value)
        SELECT 'count_projects_with_positions', CAST(count(*) AS TEXT) FROM projects WHERE has_positions = 1;
    `);
    const failed = db.prepare("SELECT value FROM manifest WHERE key = 'failed_sources'").get() as { value: string } | undefined;
    if (failed !== undefined) {
      const kept = failed.value.split(',').filter((id) => id === 'omr').join(',');
      db.prepare("UPDATE manifest SET value = ? WHERE key = 'failed_sources'").run(kept);
    }
    db.exec('VACUUM');
  } finally {
    db.close();
  }
}

function distinct(db: DatabaseSync, sql: string, ...args: string[]): string[] {
  const rows = db.prepare(sql).all(...args) as { author: string }[];
  return [...new Set(rows.map((r) => r.author.trim()).filter((a) => a !== ''))].sort();
}

async function creditsText(db: DatabaseSync, repoRoot: string): Promise<string> {
  const manifest = manifestOf(db);
  const lines = [
    '# Credits and license',
    '',
    'This database is licensed under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/),',
    'because it includes data from the LDCad shadow library.',
    '',
    '## Sources',
    '',
    '- Data sourced from Rebrickable (https://rebrickable.com/downloads/).',
    `- LDraw Parts Library${manifest.get('ldraw_release') ? `, release ${manifest.get('ldraw_release')}` : ''} (https://www.ldraw.org/).`,
    `- LDCad shadow library${manifest.get('ldcad_commit') ? `, commit ${manifest.get('ldcad_commit')}` : ''} (https://github.com/RolandMelkert/LDCadShadowLibrary).`,
    '- LDraw Official Model Repository (https://library.ldraw.org/omr), by these authors:',
  ];
  const omr = distinct(db, "SELECT DISTINCT author FROM projects WHERE kind = 'official' AND has_positions = 1 AND author IS NOT NULL");
  lines.push(...(omr.length > 0 ? omr.map((a) => `  - ${a}`) : ['  - (none)']));
  const fan = (await loadCurated(curatedDir(repoRoot))).fanSources.slice().sort((a, b) => a.id.localeCompare(b.id));
  const used = new Set((db.prepare("SELECT DISTINCT source FROM projects WHERE kind = 'fan'").all() as { source: string }[])
    .map((r) => r.source));
  const listed = fan.filter((s) => used.has(s.id));
  if (listed.length > 0) {
    lines.push('', '## Fan sources', '');
    for (const s of listed) {
      lines.push(`- ${s.name} (${s.homepage}), by these authors:`);
      const authors = distinct(db, 'SELECT DISTINCT author FROM projects WHERE source = ? AND author IS NOT NULL', s.id);
      lines.push(...(authors.length > 0 ? authors.map((a) => `  - ${a}`) : [`  - ${s.designer}`]));
    }
  }
  return lines.join('\n') + '\n';
}

function counts(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of COUNT_TABLES) out[t] = (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
  return out;
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function variantAsset(file: string, name: string, outDir: string): Promise<VariantMeta> {
  const raw = await readFile(file);
  const gz = gzipSync(raw, { level: 9 });
  await writeFile(join(outDir, `${name}.db.gz`), gz);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      file: `${name}.db.gz`, gzSha256: sha256(gz), gzBytes: gz.length,
      dbSha256: sha256(raw), dbBytes: raw.length, counts: counts(db),
    };
  } finally {
    db.close();
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Seeds the `full` variant, checks the publish gates, and writes the release assets to `outDir`.
 * On a gate failure it returns the failures and writes nothing.
 */
export async function buildRelease(opts: {
  dataDir: string; repoRoot: string; outDir: string; now?: () => Date; seed?: Partial<SeedOptions>;
  /** Test hook: fixtures have far fewer than 1,000 parts, so they cannot reach the default 0.95. */
  minPartMatch?: number;
}): Promise<ReleaseResult> {
  const now = opts.now ?? (() => new Date());
  const built = now();
  const tag = `data-${SEED_VERSION}-${built.getUTCFullYear()}${pad(built.getUTCMonth() + 1)}${pad(built.getUTCDate())}`;
  const seeded = await runSeed({
    now, ...opts.seed, dataDir: opts.dataDir, repoRoot: opts.repoRoot, variant: 'full', builtBy: 'ci', refresh: false,
  });
  if (seeded.dbFile === '') return { tag, assets: [], gateFailures: ['seed already running'] };

  const full = new DatabaseSync(seeded.dbFile, { readOnly: true });
  let credits: string;
  try {
    const gateFailures = checkGates(full, opts.minPartMatch);
    if (gateFailures.length > 0) return { tag, assets: [], gateFailures };
    credits = await creditsText(full, opts.repoRoot);
  } finally {
    full.close();
  }

  const work = await mkdtemp(join(tmpdir(), 'brick-art-release-'));
  try {
    const standardFile = join(work, 'standard.db');
    deriveStandard(seeded.dbFile, standardFile);
    await mkdir(opts.outDir, { recursive: true });
    const variants = {
      standard: await variantAsset(standardFile, 'standard', opts.outDir),
      full: await variantAsset(seeded.dbFile, 'full', opts.outDir),
    };
    await writeFile(join(opts.outDir, 'CREDITS.md'), credits);
    const meta = { tag, schemaVersion: SEED_VERSION, builtAt: built.toISOString(), variants };
    await writeFile(join(opts.outDir, 'release.json'), JSON.stringify(meta, null, 2) + '\n');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return { tag, assets: ['standard.db.gz', 'full.db.gz', 'release.json', 'CREDITS.md'], gateFailures: [] };
}
