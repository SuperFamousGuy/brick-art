import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runSeed } from '../../src/seed/seed.ts';
import { readState } from '../../src/seed/lock.ts';
import { dataPaths } from '../../src/paths.ts';
import { readPointer } from '../../src/db/open.ts';
import { fixtureFetched, writeFixtureSources } from '../helpers/fixtures.ts';

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
