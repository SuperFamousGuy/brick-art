import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bootstrap, needsSeed } from '../../src/seed/bootstrap.ts';
import { runSeed } from '../../src/seed/seed.ts';
import { writeState } from '../../src/seed/lock.ts';
import { dataPaths } from '../../src/paths.ts';
import { curatedDir } from '../../src/curated/load.ts';
import { fixtureFetched, writeFixtureSources } from '../helpers/fixtures.ts';

type T = { after: (fn: () => Promise<void>) => void };
const repoRoot = resolve(import.meta.dirname, '..', '..');

async function setup(t: T) {
  const dir = await mkdtemp(join(tmpdir(), 'brick-art-boot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, dataDir: join(dir, 'data') };
}

async function seeded(t: T) {
  const s = await setup(t);
  const fx = await writeFixtureSources(join(s.dir, 'fx'));
  await runSeed({ dataDir: s.dataDir, repoRoot, refresh: false, sources: fixtureFetched(fx) });
  return s;
}

function counter() {
  let n = 0;
  return { spawn: () => { n++; }, get calls() { return n; } };
}

test('empty dataDir is missing and spawns once', async (t) => {
  const s = await setup(t);
  const c = counter();
  assert.deepEqual(await needsSeed(s.dataDir, repoRoot), { needed: true, reason: 'missing' });
  const line = await bootstrap(s.dataDir, repoRoot, c.spawn);
  assert.equal(c.calls, 1);
  assert.equal(line, 'brick-art: building the parts database in the background (first run takes a few minutes).');
});

test('seeded db is ok and does not spawn', async (t) => {
  const s = await seeded(t);
  const c = counter();
  assert.deepEqual(await needsSeed(s.dataDir, repoRoot), { needed: false, reason: 'ok' });
  const line = await bootstrap(s.dataDir, repoRoot, c.spawn);
  assert.equal(c.calls, 0);
  assert.match(line, /^brick-art: parts database ready \(20 parts, seeded \d{4}-\d{2}-\d{2}T[^)]*\)\.$/);
});

test('edited curated file gives curated and spawns', async (t) => {
  const s = await seeded(t);
  const copy = join(s.dir, 'repo');
  await mkdir(join(copy, 'data'), { recursive: true });
  await cp(curatedDir(repoRoot), curatedDir(copy), { recursive: true });
  const { readdir } = await import('node:fs/promises');
  const file = (await readdir(curatedDir(copy)))[0]!;
  await appendFile(join(curatedDir(copy), file), '\n# edited\n');
  const c = counter();
  assert.deepEqual(await needsSeed(s.dataDir, copy), { needed: true, reason: 'curated' });
  await bootstrap(s.dataDir, copy, c.spawn);
  assert.equal(c.calls, 1);
});

test('live lock gives running and does not spawn', async (t) => {
  const s = await seeded(t);
  await writeFile(dataPaths(s.dataDir).lock, String(process.pid));
  const c = counter();
  assert.deepEqual(await needsSeed(s.dataDir, repoRoot), { needed: false, reason: 'running' });
  const line = await bootstrap(s.dataDir, repoRoot, c.spawn);
  assert.equal(c.calls, 0);
  assert.match(line, /building the parts database in the background/);
});

test('stale lock with missing db gives missing and spawns', async (t) => {
  const s = await setup(t);
  await mkdir(s.dataDir, { recursive: true });
  await writeFile(dataPaths(s.dataDir).lock, '999999');
  const c = counter();
  assert.deepEqual(await needsSeed(s.dataDir, repoRoot), { needed: true, reason: 'missing' });
  await bootstrap(s.dataDir, repoRoot, c.spawn);
  assert.equal(c.calls, 1);
});

test('pointer to a missing db file is missing', async (t) => {
  const s = await setup(t);
  await mkdir(s.dataDir, { recursive: true });
  await writeFile(dataPaths(s.dataDir).pointer, JSON.stringify({ file: 'parts-x.db' }));
  assert.deepEqual(await needsSeed(s.dataDir, repoRoot), { needed: true, reason: 'missing' });
});

test('failed state prints the failure line and retries', async (t) => {
  const s = await setup(t);
  writeState(dataPaths(s.dataDir).state, { status: 'failed', startedAt: null, finishedAt: null, lastError: 'boom', failures: 1 });
  const c = counter();
  const line = await bootstrap(s.dataDir, repoRoot, c.spawn);
  assert.equal(line, 'brick-art: last parts database build failed: boom. Retrying in the background.');
  assert.equal(c.calls, 1);
});

test('spawn errors are caught and reported on the line', async (t) => {
  const s = await setup(t);
  const line = await bootstrap(s.dataDir, repoRoot, () => { throw new Error('nope'); });
  assert.equal(line, 'brick-art: setup check failed: nope');
});

test('bootstrap on a ready db takes under 1000 ms', async (t) => {
  const s = await seeded(t);
  const start = performance.now();
  await bootstrap(s.dataDir, repoRoot, () => {});
  assert.ok(performance.now() - start < 1000);
});
