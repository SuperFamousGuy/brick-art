import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runSeed } from '../../src/seed/seed.ts';
import { readState } from '../../src/seed/lock.ts';
import { dataPaths } from '../../src/paths.ts';
import { readPointer } from '../../src/db/open.ts';
import type { Variant } from '../../src/projects/types.ts';
import { fixtureFetched, writeFixtureSources } from '../helpers/fixtures.ts';
import { MPD_10001_MINI, MPD_BMODEL } from '../helpers/models.ts';
import type { FakeReply } from '../helpers/models.ts';
import { FAN_SOURCES_YAML, omrPages, seedFixture } from '../helpers/seeded.ts';

type T = { after: (fn: () => Promise<void>) => void };
const repoRoot = resolve(import.meta.dirname, '..', '..');

async function setup(t: T) {
  const dir = await mkdtemp(join(tmpdir(), 'brick-art-seed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fx = await writeFixtureSources(join(dir, 'fx'));
  const dataDir = join(dir, 'data');
  return { dir, fx, dataDir, sources: fixtureFetched(fx) };
}

const dbFiles = async (dataDir: string) => (await readdir(dataDir)).filter((n) => /^parts-.*\.db$/.test(n));

function open(dataDir: string): DatabaseSync {
  return new DatabaseSync(join(dataDir, readPointer(dataDir)!), { readOnly: true });
}

test('runSeed builds the database from fixture sources', async (t) => {
  const s = await setup(t);
  const now = () => new Date('2026-11-09T12:34:56Z');
  const result = await runSeed({ dataDir: s.dataDir, repoRoot, refresh: false, sources: s.sources, now });
  assert.equal(result.dbFile, join(s.dataDir, 'parts-20261109T123456.db'));
  assert.equal(readPointer(s.dataDir), 'parts-20261109T123456.db');
  assert.equal(result.counts.parts, 20);
  const state = readState(dataPaths(s.dataDir).state);
  assert.equal(state.status, 'ready');
  assert.equal(state.failures, 0);
  assert.equal(existsSync(dataPaths(s.dataDir).lock), false);

  const db = open(s.dataDir);
  t.after(async () => db.close());
  const manifest = Object.fromEntries(
    (db.prepare('SELECT key, value FROM manifest').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]),
  );
  assert.equal(manifest.count_parts, '20');
  assert.equal(manifest.ldraw_release, '2026-10');
  assert.equal(manifest.ldcad_commit, 'abc123');
  assert.equal(manifest.seed_version, '3');
  for (const k of ['curated_hash', 'started_at', 'finished_at', 'match_rate_top1000',
    'count_with_connections', 'count_incomplete', 'count_creative_loaded', 'count_creative_rejected']) {
    assert.ok(k in manifest, k);
  }

  const part = (n: string) => db.prepare('SELECT * FROM parts WHERE part_num = ?').get(n) as Record<string, unknown>;
  const p = part('3001');
  assert.equal(p.is_complete, 1);
  assert.equal(p.width_studs, 4);
  assert.equal(p.set_count, 3);
  assert.equal((db.prepare("SELECT count(*) AS n FROM connections WHERE part_num = '3001'").get() as { n: number }).n, 16);
  const pr = part('3001pr0001');
  assert.equal(pr.is_print, 1);
  assert.equal(p.is_system, 1);
  assert.equal(part('3437').is_system, 0);
  assert.equal(pr.base_part_num, '3001');
  assert.equal(part('99999').is_complete, 0);
  const alt = part('3009b');
  assert.equal(alt.geometry_from, '3009');
  const none = part('003383');
  assert.equal(none.has_geometry, 0);
  assert.equal(none.ldraw_file, null);
  assert.equal(none.grid, null);
  assert.equal(none.is_complete, 0);

  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  assert.equal(count('SELECT count(*) AS n FROM sources'), 13);
  assert.equal(count('SELECT count(*) AS n FROM colors'), 7);
  assert.equal(count('SELECT count(*) AS n FROM colors WHERE is_placeholder = 1'), 2);
  assert.equal(
    (db.prepare('SELECT family AS f FROM colors WHERE id = 47').get() as { f: string }).f, 'transparent',
  );
  assert.equal(count('SELECT count(*) AS n FROM creative_uses'), Number(manifest.count_creative_loaded));
  assert.equal(count("SELECT count(*) AS n FROM creative_uses WHERE source <> 'curated'"), 0);
  assert.equal(count('SELECT count(*) AS n FROM part_relationships'), 2);
  assert.ok(count('SELECT count(*) AS n FROM part_colors') > 0);
  assert.match(await readFile(dataPaths(s.dataDir).log, 'utf8'), /^\d{4}-\d\d-\d\dT.*\S/m);
});

test('a second runSeed leaves exactly one db and repoints', async (t) => {
  const s = await setup(t);
  await runSeed({
    dataDir: s.dataDir, repoRoot, refresh: false, sources: s.sources, now: () => new Date('2026-11-09T01:00:00Z'),
  });
  await runSeed({
    dataDir: s.dataDir, repoRoot, refresh: false, sources: s.sources, now: () => new Date('2026-11-09T02:00:00Z'),
  });
  assert.deepEqual(await dbFiles(s.dataDir), ['parts-20261109T020000.db']);
  assert.equal(readPointer(s.dataDir), 'parts-20261109T020000.db');
});

test('a failed seed keeps the previous db and pointer and records the failure', async (t) => {
  const s = await setup(t);
  await runSeed({
    dataDir: s.dataDir, repoRoot, refresh: false, sources: s.sources, now: () => new Date('2026-11-09T01:00:00Z'),
  });
  const bad = { ...s.sources, rebrickableDir: join(s.dir, 'does-not-exist') };
  await assert.rejects(
    runSeed({ dataDir: s.dataDir, repoRoot, refresh: false, sources: bad, now: () => new Date('2026-11-09T02:00:00Z') }),
  );
  assert.deepEqual(await dbFiles(s.dataDir), ['parts-20261109T010000.db']);
  assert.equal(readPointer(s.dataDir), 'parts-20261109T010000.db');
  const state = readState(dataPaths(s.dataDir).state);
  assert.equal(state.status, 'failed');
  assert.equal(state.failures, 1);
  assert.ok(state.lastError);
  assert.equal(existsSync(dataPaths(s.dataDir).lock), false);
  assert.match(await readFile(dataPaths(s.dataDir).log, 'utf8'), /ENOENT/);
});

test('a failure after the schema exists removes the new db and keeps the old one', async (t) => {
  const s = await setup(t);
  await runSeed({
    dataDir: s.dataDir, repoRoot, refresh: false, sources: s.sources, now: () => new Date('2026-11-09T01:00:00Z'),
  });
  // An unbindable value makes writeSources throw after the new db has been created and filled.
  const records = s.sources.records.map((r, i) => (i === 0 ? { ...r, bytes: {} as unknown as number } : r));
  await assert.rejects(
    runSeed({
      dataDir: s.dataDir, repoRoot, refresh: false, sources: { ...s.sources, records },
      now: () => new Date('2026-11-09T02:00:00Z'),
    }),
  );
  assert.deepEqual(await dbFiles(s.dataDir), ['parts-20261109T010000.db']);
  assert.equal(readPointer(s.dataDir), 'parts-20261109T010000.db');
  const state = readState(dataPaths(s.dataDir).state);
  assert.equal(state.status, 'failed');
  assert.equal(state.failures, 1);
  assert.equal(existsSync(dataPaths(s.dataDir).lock), false);
  assert.match(await readFile(dataPaths(s.dataDir).log, 'utf8'), /seed failed/);
});

test('runSeed returns without work when another seed holds the lock', async (t) => {
  const s = await setup(t);
  await mkdir(s.dataDir, { recursive: true });
  await writeFile(dataPaths(s.dataDir).lock, String(process.pid));
  const r = await runSeed({ dataDir: s.dataDir, repoRoot, refresh: false, sources: s.sources });
  assert.equal(r.dbFile, '');
  assert.equal(readPointer(s.dataDir), null);
  assert.equal(existsSync(dataPaths(s.dataDir).lock), true);
});

test('runSeed with skipLock seeds under a lock its caller holds and leaves the lock alone', async (t) => {
  const s = await setup(t);
  await mkdir(s.dataDir, { recursive: true });
  await writeFile(dataPaths(s.dataDir).lock, String(process.pid));
  const r = await runSeed({ dataDir: s.dataDir, repoRoot, refresh: false, sources: s.sources, skipLock: true });
  assert.notEqual(r.dbFile, '');
  assert.equal(readPointer(s.dataDir), basename(r.dbFile));
  assert.equal(existsSync(dataPaths(s.dataDir).lock), true);
});

// ---- variants and project stages -----------------------------------------

async function seeded(t: T, variant: Variant, omr?: Map<string, FakeReply>, fanYaml?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'brick-art-seeded-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const s = await seedFixture(dir, variant, omr, fanYaml);
  t.after(() => s.close());
  const db = new DatabaseSync(s.dbFile, { readOnly: true });
  t.after(async () => db.close());
  const manifest = Object.fromEntries(
    (db.prepare('SELECT key, value FROM manifest').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]),
  );
  const count = (sql: string, ...args: (string | number)[]) => (db.prepare(sql).get(...args) as { n: number }).n;
  return { ...s, db, manifest, count };
}

test('variant fallback writes set projects without positions', async (t) => {
  const s = await seeded(t, 'fallback');
  assert.equal(s.count("SELECT count(*) AS n FROM projects WHERE kind = 'official'"), 4);
  assert.equal(s.count('SELECT count(*) AS n FROM submodels'), 0);
  assert.equal(s.manifest.variant, 'fallback');
  assert.equal(s.manifest.placement_match_rate, '');
  assert.equal(s.manifest.built_by, 'local');
  assert.equal(s.manifest.count_projects_official, '4');
  assert.equal(s.manifest.count_projects_with_positions, '0');
  assert.equal(s.manifest.count_projects_fan, '0');
  assert.equal(s.manifest.failed_sources, '');
  for (const k of ['color_match_rate', 'count_models_skipped_license', 'count_omr_files_failed']) {
    assert.ok(k in s.manifest, k);
  }
});

test('variant standard attaches OMR positions to the set and skips unlicensed B-models', async (t) => {
  const s = await seeded(t, 'standard');
  const set = s.db.prepare("SELECT * FROM projects WHERE source = 'rebrickable' AND source_key = 'S1-1'")
    .get() as Record<string, unknown>;
  assert.equal(set.has_positions, 1);
  assert.equal(set.author, 'Test Builder');
  assert.match(String(set.license), /CC BY 4\.0/);
  assert.match(String(set.url), /\/media\/omr_models\/1\/S1-1\.mpd\?v=1$/);
  assert.equal(s.count('SELECT count(*) AS n FROM submodels WHERE project_id = ?', set.id as number), 2);
  assert.equal(s.count('SELECT count(*) AS n FROM placements'), 5);
  assert.equal(s.count("SELECT count(*) AS n FROM projects WHERE source = 'omr'"), 0);
  assert.equal(s.manifest.variant, 'standard');
  assert.equal(s.manifest.count_models_skipped_license, '1');
  assert.equal(s.manifest.count_projects_fan, '0');
  assert.equal(s.manifest.count_projects_with_positions, '1');
  assert.equal(s.manifest.failed_sources, '');
  // 3001 red, the Cab reference, and 3023 inheriting resolve; 9999x.dat and missing.ldr do not.
  assert.equal(s.manifest.placement_match_rate, String(3 / 5));
  assert.equal(s.manifest.color_match_rate, String(4 / 5));
});

test('variant standard turns licensed B-models and unknown sets into omr projects', async (t) => {
  const pages = omrPages();
  const licensed = MPD_BMODEL.replace('0 Author: B Builder', '0 Author: B Builder\n0 !LICENSE Licensed under CC BY 4.0');
  pages.set('/omr/sets/1', [
    'S1-1_B-Model.mpd', 'Z9-1.mpd',
  ].map((n) => `<a href="/media/omr_models/1/${n}?v=1">f</a>`).join(''));
  pages.set('/media/omr_models/1/S1-1_B-Model.mpd', licensed);
  pages.set('/media/omr_models/1/Z9-1.mpd', licensed);
  const s = await seeded(t, 'standard', pages);
  const set = s.db.prepare("SELECT * FROM projects WHERE source_key = 'S1-1'").get() as Record<string, unknown>;
  assert.equal(set.has_positions, 0);
  const rows = s.db.prepare("SELECT * FROM projects WHERE source = 'omr' ORDER BY source_key").all() as Record<string, unknown>[];
  assert.deepEqual(rows.map((r) => [r.source_key, r.kind, r.base_project_id, r.has_positions, r.author]), [
    ['S1-1_B-Model.mpd', 'official', set.id, 1, 'B Builder'],
    ['Z9-1.mpd', 'official', null, 1, 'B Builder'],
  ]);
  // 3001 in Dark Bluish Gray has no Rebrickable color in the fixture, so no part rows.
  assert.equal(s.count('SELECT count(*) AS n FROM submodels'), 2);
  assert.equal(s.manifest.count_models_skipped_license, '0');
  assert.equal(s.manifest.count_projects_official, '6');
});

test('variant full adds credited fan projects', async (t) => {
  const s = await seeded(t, 'full');
  assert.equal(s.manifest.count_projects_fan, '1');
  assert.equal(s.manifest.failed_sources, '');
  const fan = s.db.prepare("SELECT * FROM projects WHERE kind = 'fan'").get() as Record<string, unknown>;
  assert.equal(fan.source, 'fixture_fan');
  assert.equal(fan.source_key, 'town.ldr');
  assert.equal(fan.author, 'Mayor');
  assert.match(String(fan.license), /CC BY 4\.0/);
  assert.equal(fan.url, 'https://example.test/fan');
  assert.equal(fan.has_positions, 1);
  assert.equal(s.count('SELECT count(*) AS n FROM submodels WHERE project_id = ?', fan.id as number), 2);
  assert.deepEqual(
    s.db.prepare('SELECT part_num, color_id, quantity FROM project_parts WHERE project_id = ? ORDER BY part_num')
      .all(fan.id as number).map((r) => ({ ...r })),
    [{ part_num: '3001', color_id: 4, quantity: 1 }, { part_num: '3023', color_id: 4, quantity: 1 }],
  );
  // The fan model does not count toward the OMR placement rate.
  assert.equal(s.manifest.placement_match_rate, String(3 / 5));
});

test('an OMR outage is isolated: the seed completes with intact parts', async (t) => {
  const s = await seeded(t, 'standard', new Map([['/omr/sets?page=1', 500]]));
  assert.equal(s.manifest.failed_sources, 'omr');
  assert.equal(s.manifest.count_parts, '20');
  assert.equal(s.count("SELECT count(*) AS n FROM projects WHERE kind = 'official'"), 4);
  assert.equal(s.count('SELECT count(*) AS n FROM submodels'), 0);
  assert.equal(readState(dataPaths(s.dataDir).state).status, 'ready');
  assert.match(await readFile(dataPaths(s.dataDir).log, 'utf8'), /omr failed/);
});

test('a part whose license is not redistributable loses its geometry', async (t) => {
  const s = await setup(t);
  const ldrawRoot = join(s.dir, 'ldraw-copy');
  await cp(s.fx.ldrawRoot, ldrawRoot, { recursive: true });
  const banana = join(ldrawRoot, 'parts', '33085.dat');
  await writeFile(banana, (await readFile(banana, 'utf8'))
    .replace(/^0 !LICENSE .*$/m, '0 !LICENSE Not redistributable : see NonCAreadme.txt'));
  await runSeed({ dataDir: s.dataDir, repoRoot, refresh: false, sources: { ...s.sources, ldrawRoot } });
  const db = open(s.dataDir);
  t.after(async () => db.close());
  const p = db.prepare("SELECT * FROM parts WHERE part_num = '33085'").get() as Record<string, unknown>;
  assert.equal(p.has_geometry, 0);
  assert.equal(p.has_grid, 0);
  assert.equal(p.has_connections, 0);
  assert.equal(p.is_complete, 0);
  assert.equal(p.grid, null);
  assert.equal(p.width_studs, null);
  assert.equal(p.license, 'Not redistributable : see NonCAreadme.txt');
  assert.equal((db.prepare("SELECT count(*) AS n FROM connections WHERE part_num = '33085'").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT is_complete AS c FROM parts WHERE part_num = '3001'").get() as { c: number }).c, 1);
});

test('a sub-file with a disallowed license excludes the OMR model', async (t) => {
  const pages = omrPages();
  const lines = MPD_10001_MINI.split('\n');
  const cab = lines.indexOf('0 Author: Cab Builder');
  lines[cab + 1] = '0 !LICENSE Not redistributable : see NonCAreadme.txt';
  pages.set('/media/omr_models/1/S1-1.mpd', lines.join('\n'));
  const s = await seeded(t, 'standard', pages);
  assert.equal(s.manifest.count_models_skipped_license, '2');
  assert.equal(s.count('SELECT count(*) AS n FROM submodels'), 0);
  assert.equal(s.count('SELECT count(*) AS n FROM placements'), 0);
  assert.equal(s.count("SELECT count(*) AS n FROM projects WHERE source_key = 'S1-1' AND has_positions = 1"), 0);
  assert.equal(s.manifest.failed_sources, '');
});

test('a sub-file without a license line inherits the top-level license', async (t) => {
  const pages = omrPages();
  pages.set('/media/omr_models/1/S1-1.mpd', MPD_10001_MINI.split('\n')
    .filter((l, i, all) => !(l.startsWith('0 !LICENSE') && all[i - 1] === '0 Author: Cab Builder')).join('\n'));
  const s = await seeded(t, 'standard', pages);
  assert.equal(s.manifest.count_models_skipped_license, '1');
  assert.equal(s.count('SELECT count(*) AS n FROM submodels'), 2);
});

for (const variant of ['standard', 'full'] as const) {
  test(`a missing LDConfig.ldr fails the ${variant} project sources, not the seed`, async (t) => {
    const s = await setup(t);
    const ldrawRoot = join(s.dir, 'ldraw-copy');
    await cp(s.fx.ldrawRoot, ldrawRoot, { recursive: true });
    await rm(join(ldrawRoot, 'LDConfig.ldr'));
    const r = await runSeed({
      dataDir: s.dataDir, repoRoot, refresh: false, sources: { ...s.sources, ldrawRoot }, variant, omr: { files: [] },
      fanFetch: { githubApi: 'http://127.0.0.1:9', codeload: 'http://127.0.0.1:9' },
    });
    const db = new DatabaseSync(r.dbFile, { readOnly: true });
    t.after(async () => db.close());
    const m = Object.fromEntries(
      (db.prepare('SELECT key, value FROM manifest').all() as { key: string; value: string }[]).map((x) => [x.key, x.value]),
    );
    assert.equal(m.failed_sources, variant === 'full' ? 'omr,datsville' : 'omr');
    assert.equal(m.count_parts, '20');
    assert.equal(m.color_match_rate, '');
    assert.equal(m.count_projects_official, '4');
  });
}

test('a fallback seed does not need LDConfig.ldr', async (t) => {
  const s = await setup(t);
  const ldrawRoot = join(s.dir, 'ldraw-copy');
  await cp(s.fx.ldrawRoot, ldrawRoot, { recursive: true });
  await rm(join(ldrawRoot, 'LDConfig.ldr'));
  const r = await runSeed({ dataDir: s.dataDir, repoRoot, refresh: false, sources: { ...s.sources, ldrawRoot } });
  const db = new DatabaseSync(r.dbFile, { readOnly: true });
  t.after(async () => db.close());
  const m = db.prepare("SELECT value FROM manifest WHERE key = 'failed_sources'").get() as { value: string };
  assert.equal(m.value, '');
});

test('one failing fan source keeps OMR and the other fan sources', async (t) => {
  const broken = FAN_SOURCES_YAML.replace('fixture_fan', 'broken_fan').replace('fan/town', 'fan/missing');
  const s = await seeded(t, 'full', undefined, FAN_SOURCES_YAML + broken);
  assert.equal(s.manifest.failed_sources, 'broken_fan');
  assert.equal(s.manifest.count_projects_fan, '1');
  assert.equal(s.count("SELECT count(*) AS n FROM projects WHERE source = 'broken_fan'"), 0);
  assert.equal(s.count("SELECT count(*) AS n FROM projects WHERE source = 'fixture_fan'"), 1);
  assert.equal(s.count("SELECT count(*) AS n FROM projects WHERE source_key = 'S1-1' AND has_positions = 1"), 1);
  // OMR main (2) plus the fan model (2).
  assert.equal(s.count('SELECT count(*) AS n FROM submodels'), 4);
  assert.match(await readFile(dataPaths(s.dataDir).log, 'utf8'), /fan broken_fan failed/);
});

/** OMR pages listing set pages 1 and 2, where `files` maps a media path to its content. */
function omrSite(files: Record<string, string>): Map<string, FakeReply> {
  const byId = new Map<string, string[]>();
  for (const path of Object.keys(files)) {
    const id = path.split('/')[3]!;
    byId.set(id, [...(byId.get(id) ?? []), path]);
  }
  const ids = [...byId.keys()];
  const pages = new Map<string, FakeReply>([
    ['/omr/sets?page=1', ids.map((id) => `<a href="/omr/sets/${id}">s</a>`).join('')],
  ]);
  for (const [id, paths] of byId) pages.set(`/omr/sets/${id}`, paths.map((p) => `<a href="${p}?v=1">f</a>`).join(''));
  for (const [path, text] of Object.entries(files)) pages.set(path, text);
  return pages;
}

const licensedAlt = (author: string) =>
  MPD_BMODEL.replace('0 Author: B Builder', `0 Author: ${author}\n0 !LICENSE Licensed under CC BY 4.0`);

test('an OMR re-upload under a new media id keeps only the latest file', async (t) => {
  const s = await seeded(t, 'standard', omrSite({
    '/media/omr_models/1/S1-1.mpd': MPD_10001_MINI,
    '/media/omr_models/12/S1-1_Alt.mpd': licensedAlt('Old Upload'),
    '/media/omr_models/30/S1-1_Alt.mpd': licensedAlt('New Upload'),
  }));
  assert.equal(s.manifest.failed_sources, '');
  assert.equal(s.manifest.count_omr_duplicates, '1');
  assert.equal(s.manifest.count_project_key_clashes, '0');
  const rows = s.db.prepare("SELECT author, url FROM projects WHERE source = 'omr'").all() as { author: string; url: string }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.author, 'New Upload');
  assert.match(rows[0]!.url, /\/omr_models\/30\//);
  assert.match(await readFile(dataPaths(s.dataDir).log, 'utf8'), /omr duplicate S1-1_Alt\.mpd: kept 30, dropped 12/);
});

test('a duplicated OMR main attaches to its set once', async (t) => {
  const newer = MPD_10001_MINI.replace('0 Author: Test Builder', '0 Author: Newer Builder');
  const s = await seeded(t, 'standard', omrSite({
    '/media/omr_models/40/S1-1.mpd': newer,
    '/media/omr_models/8/S1-1.mpd': MPD_10001_MINI,
  }));
  assert.equal(s.manifest.failed_sources, '');
  assert.equal(s.manifest.count_omr_duplicates, '1');
  const set = s.db.prepare("SELECT * FROM projects WHERE source_key = 'S1-1'").get() as Record<string, unknown>;
  assert.equal(set.author, 'Newer Builder');
  assert.equal(s.count('SELECT count(*) AS n FROM submodels WHERE project_id = ?', set.id as number), 2);
  assert.equal(s.count("SELECT count(*) AS n FROM projects WHERE source = 'omr'"), 0);
});
