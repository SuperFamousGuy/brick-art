import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { buildRelease, checkGates, deriveStandard } from '../../src/release/build.ts';
import { MPD_10001_MINI, MPD_CLEAN } from '../helpers/models.ts';
import type { FakeReply } from '../helpers/models.ts';
import { fixtureSeedOptions, omrPages } from '../helpers/seeded.ts';

const NOW = () => new Date('2026-11-17T08:00:00Z');

async function run(t: { after: (fn: () => Promise<void>) => void }, mpd: string) {
  const dir = await mkdtemp(join(tmpdir(), 'brick-art-release-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const omr = new Map<string, FakeReply>(omrPages());
  omr.set('/media/omr_models/1/S1-1.mpd', mpd);
  const { opts, close } = await fixtureSeedOptions(dir, 'full', omr);
  t.after(close);
  const { dataDir, repoRoot, ...seed } = opts;
  const outDir = join(dir, 'out');
  const result = await buildRelease({ dataDir, repoRoot, outDir, now: NOW, seed, minPartMatch: 0, source: { runId: '42', sha: 'abc123' } });
  return { dir, outDir, result };
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

test('buildRelease writes both databases, release.json and CREDITS.md', async (t) => {
  const { dir, outDir, result } = await run(t, MPD_CLEAN);
  assert.deepEqual(result.gateFailures, []);
  assert.equal(result.tag, 'data-3-20261117');
  assert.deepEqual((await readdir(outDir)).sort(), ['CREDITS.md', 'full.db.gz', 'release.json', 'standard.db.gz']);
  assert.deepEqual([...result.assets].sort(), ['CREDITS.md', 'full.db.gz', 'release.json', 'standard.db.gz']);

  const meta = JSON.parse(await readFile(join(outDir, 'release.json'), 'utf8'));
  assert.equal(meta.tag, 'data-3-20261117');
  assert.equal(meta.schemaVersion, 3);
  assert.equal(meta.builtAt, '2026-11-17T08:00:00.000Z');
  assert.deepEqual(meta.source, { runId: '42', sha: 'abc123' });
  const counts: Record<string, DatabaseSync> = {};
  for (const name of ['standard', 'full'] as const) {
    const gz = await readFile(join(outDir, `${name}.db.gz`));
    const v = meta.variants[name];
    assert.equal(v.file, `${name}.db.gz`);
    assert.equal(v.gzSha256, sha(gz));
    assert.equal(v.gzBytes, gz.length);
    const raw = gunzipSync(gz);
    assert.equal(v.dbSha256, sha(raw));
    assert.equal(v.dbBytes, raw.length);
    assert.ok(v.counts.parts > 0);
    const file = join(dir, `${name}.db`);
    await writeFile(file, raw);
    counts[name] = new DatabaseSync(file, { readOnly: true });
  }
  const fan = (db: DatabaseSync) =>
    (db.prepare("SELECT count(*) AS n FROM projects WHERE kind='fan'").get() as { n: number }).n;
  assert.equal(fan(counts.standard!), 0);
  assert.equal(fan(counts.full!), 1);
  const manifest = (db: DatabaseSync, k: string) =>
    (db.prepare('SELECT value FROM manifest WHERE key=?').get(k) as { value: string }).value;
  assert.equal(manifest(counts.standard!, 'variant'), 'standard');
  assert.equal(manifest(counts.standard!, 'count_projects_fan'), '0');
  assert.equal(manifest(counts.full!, 'variant'), 'full');
  const withPositions = (db: DatabaseSync) =>
    String((db.prepare('SELECT count(*) AS n FROM projects WHERE has_positions = 1').get() as { n: number }).n);
  assert.equal(manifest(counts.standard!, 'count_projects_with_positions'), withPositions(counts.standard!));
  assert.equal(manifest(counts.full!, 'count_projects_with_positions'), withPositions(counts.full!));
  assert.notEqual(withPositions(counts.standard!), withPositions(counts.full!));
  const orphans = counts.standard!.prepare(
    `SELECT (SELECT count(*) FROM project_parts WHERE project_id NOT IN (SELECT id FROM projects)) +
            (SELECT count(*) FROM submodels WHERE project_id NOT IN (SELECT id FROM projects)) +
            (SELECT count(*) FROM placements WHERE submodel_id NOT IN (SELECT id FROM submodels)) AS n`,
  ).get() as { n: number };
  assert.equal(orphans.n, 0);
  const fanAuthors = (db: DatabaseSync) => (db.prepare(
    `SELECT count(*) AS n FROM project_authors
     WHERE project_id NOT IN (SELECT id FROM projects WHERE kind <> 'fan')`,
  ).get() as { n: number }).n;
  assert.equal(fanAuthors(counts.standard!), 0);
  assert.ok(fanAuthors(counts.full!) > 0);
  for (const db of Object.values(counts)) db.close();

  const credits = await readFile(join(outDir, 'CREDITS.md'), 'utf8');
  assert.match(credits, /CC BY-SA 4\.0/);
  assert.match(credits, /Data sourced from Rebrickable/);
  assert.match(credits, /LDraw Parts Library/);
  assert.match(credits, /LDCad shadow library/);
  assert.match(credits, /abc123/);
  assert.match(credits, /Fixture Fan Town/);
  assert.match(credits, /https:\/\/example\.test\/fan/);
  assert.match(credits, /Mayor/);
  assert.match(credits, /Test Builder/);
  const section = (name: string) => credits.split('### ').find((x) => x.startsWith(`${name}\n`)) ?? '';
  assert.match(section('Rebrickable'), /License: .*Data sourced from Rebrickable\.\n- Version: downloaded 2026-11-09\n/);
  assert.match(section('LDraw Parts Library'), /License: CC BY 4\.0\n- Version: release 2026-10\n/);
  assert.match(section('LDCad shadow library'), /License: CC BY-SA 4\.0\n- Version: commit abc123\n/);
  assert.match(section('LDraw Official Model Repository'), /License: CC BY 4\.0 or CCAL 2\.0, per file\n[^]*  - Test Builder\n/);
  assert.match(section('LDraw Official Model Repository'), /  - Cab Builder\n/);
  assert.match(section('Fixture Fan Town'), /  - Builder\n/);
  assert.match(section('Fixture Fan Town'),
    /Link: https:\/\/example\.test\/fan\n- License: license per file\n- Version: commit f00dfacef00dface\n- Authors:\n[^]*  - Mayor\n/);
});

test('buildRelease refuses to publish when the placement rate is below the gate', async (t) => {
  const { outDir, result } = await run(t, MPD_10001_MINI);
  assert.ok(result.gateFailures.some((m) => m.includes('placement_match_rate')), result.gateFailures.join('\n'));
  assert.deepEqual(result.assets, []);
  assert.deepEqual(await readdir(outDir).catch(() => []), []);
});

test('checkGates reports each failed gate', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE manifest (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE projects (id INTEGER, license TEXT);
    CREATE TABLE parts (part_num TEXT, has_geometry INTEGER, license TEXT);
    INSERT INTO manifest VALUES ('match_rate_top1000','0.9'),('placement_match_rate','0.5'),('failed_sources','omr,fan_x');
    INSERT INTO projects VALUES (1,'CC BY 4.0'),(2,'Not redistributable'),(3,NULL);
    INSERT INTO parts VALUES ('a',1,'CC BY 2.0'),('b',1,'Not redistributable'),('c',0,'Not redistributable');`);
  const failures = checkGates(db);
  assert.equal(failures.length, 5);
  for (const key of ['match_rate_top1000', 'placement_match_rate', 'projects', 'parts', 'failed_sources']) {
    assert.ok(failures.some((m) => m.includes(key)), `${key}: ${failures.join('|')}`);
  }
  db.exec(`UPDATE manifest SET value='0.99' WHERE key<>'failed_sources'; UPDATE manifest SET value='fan_x' WHERE key='failed_sources';
    DELETE FROM projects WHERE id=2; DELETE FROM parts WHERE part_num='b'`);
  assert.deepEqual(checkGates(db), []);
});

test('checkGates accepts a placement rate of 0.95 and refuses 0.949', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE manifest (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE projects (id INTEGER, license TEXT);
    CREATE TABLE parts (part_num TEXT, has_geometry INTEGER, license TEXT);
    INSERT INTO manifest VALUES ('match_rate_top1000','0.99'),('placement_match_rate','0.95'),('failed_sources','');`);
  assert.deepEqual(checkGates(db), []);
  db.exec("UPDATE manifest SET value='0.949' WHERE key='placement_match_rate'");
  assert.deepEqual(checkGates(db), ['placement_match_rate is 0.949, below 0.95']);
});

test('deriveStandard drops fan source ids from failed_sources but keeps omr', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'brick-art-derive-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const full = join(dir, 'full.db');
  const db = new DatabaseSync(full);
  db.exec(`CREATE TABLE manifest (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE projects (id INTEGER, kind TEXT, has_positions INTEGER);
    CREATE TABLE project_parts (project_id INTEGER); CREATE TABLE project_authors (project_id INTEGER, author TEXT);
    CREATE TABLE submodels (id INTEGER, project_id INTEGER);
    CREATE TABLE placements (submodel_id INTEGER);
    INSERT INTO manifest VALUES ('failed_sources','omr,fan_x');`);
  db.close();
  deriveStandard(full, join(dir, 'std.db'));
  const std = new DatabaseSync(join(dir, 'std.db'), { readOnly: true });
  assert.equal((std.prepare("SELECT value FROM manifest WHERE key='failed_sources'").get() as { value: string }).value, 'omr');
  std.close();
});
