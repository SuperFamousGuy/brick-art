import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bootstrap, needsUpdate, updateArgs } from '../../src/seed/bootstrap.ts';
import { writeState } from '../../src/seed/lock.ts';
import { writeUpdateState } from '../../src/release/download.ts';
import type { UpdateState } from '../../src/release/download.ts';
import { readPointer } from '../../src/db/open.ts';
import { dataPaths } from '../../src/paths.ts';
import { curatedDir } from '../../src/curated/load.ts';
import { seedFixture } from '../helpers/seeded.ts';

type T = { after: (fn: () => Promise<void>) => void };
const repoRoot = resolve(import.meta.dirname, '..', '..');
const HOUR = 60 * 60 * 1000;
const TAG = 'data-3-20261117';

let templates: string;
before(async () => {
  templates = await mkdtemp(join(tmpdir(), 'brick-art-boot-tpl-'));
  for (const variant of ['standard', 'fallback'] as const) {
    const s = await seedFixture(join(templates, variant), variant);
    await s.close();
  }
});
after(() => rm(templates, { recursive: true, force: true }));

async function setup(t: T) {
  const dir = await mkdtemp(join(tmpdir(), 'brick-art-boot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, dataDir: join(dir, 'data') };
}

/**
 * A data dir holding a copy of the fixture database for `variant`, with `update` as update.json when
 * given. The manifest's built_by is `builtBy`: by default `ci` when `update` records a release install.
 */
async function withDb(
  t: T, variant: 'standard' | 'fallback', update?: Partial<UpdateState>,
  builtBy: 'ci' | 'local' = update?.origin === 'release' ? 'ci' : 'local',
) {
  const s = await setup(t);
  await cp(join(templates, variant, 'data'), s.dataDir, { recursive: true });
  const db = new DatabaseSync(join(s.dataDir, readPointer(s.dataDir)!));
  db.prepare("UPDATE manifest SET value = ? WHERE key = 'built_by'").run(builtBy);
  db.close();
  if (update) {
    writeUpdateState(s.dataDir, {
      lastCheckedAt: null, releaseTag: null, variant: null, origin: null, lastError: null, ...update,
    });
  }
  return s;
}

const released = (now = new Date()): Partial<UpdateState> =>
  ({ lastCheckedAt: now.toISOString(), releaseTag: TAG, variant: 'standard', origin: 'release' });

/** A copy of the repo's curated files with one file edited, so its hash differs. */
async function editedRepo(dir: string): Promise<string> {
  const copy = join(dir, 'repo');
  await mkdir(join(copy, 'data'), { recursive: true });
  await cp(curatedDir(repoRoot), curatedDir(copy), { recursive: true });
  const file = (await readdir(curatedDir(copy)))[0]!;
  await appendFile(join(curatedDir(copy), file), '\n# edited\n');
  return copy;
}

function recorder() {
  const calls: string[] = [];
  return { spawn: (variant: string) => { calls.push(variant); }, calls };
}

const FIRST_INSTALL = 'brick-art: installing the standard database in the background. Fan-made designs are off; turn them on in /plugin → brick-art → Configure options.';
const READY = /^brick-art: database ready \(standard, 20 parts, \d+ sets, data-3-20261117\)\.$/;

test('first install with default options prints the first-install line and installs standard', async (t) => {
  const s = await setup(t);
  const r = recorder();
  assert.deepEqual(await needsUpdate(s.dataDir, repoRoot, 'standard'), { needed: true, reason: 'missing' });
  assert.equal(await bootstrap(s.dataDir, repoRoot, {}, r.spawn), FIRST_INSTALL);
  assert.deepEqual(r.calls, ['standard']);
  assert.equal(existsSync(join(s.dataDir, 'options.json')), false);
});

test('missing database with BRICK_ART_FAN_PROJECTS on installs full without saving the option', async (t) => {
  const s = await setup(t);
  const r = recorder();
  const line = await bootstrap(s.dataDir, repoRoot, { BRICK_ART_FAN_PROJECTS: 'true' }, r.spawn);
  assert.equal(line, 'brick-art: installing the full database in the background.');
  assert.deepEqual(r.calls, ['full']);
  assert.equal(existsSync(join(s.dataDir, 'options.json')), false);
});

test('BRICK_ART_FAN_PROJECTS does not overwrite the saved plugin option', async (t) => {
  const s = await withDb(t, 'standard', released());
  await writeFile(join(s.dataDir, 'options.json'), JSON.stringify({ fanProjects: false }));
  await bootstrap(s.dataDir, repoRoot, { BRICK_ART_FAN_PROJECTS: '1', CLAUDE_PLUGIN_OPTION_FAN_PROJECTS: 'false' }, () => {});
  assert.deepEqual(JSON.parse(await readFile(join(s.dataDir, 'options.json'), 'utf8')), { fanProjects: false });
});

test('the plugin option is saved to options.json for later /reseed runs', async (t) => {
  const s = await withDb(t, 'standard', released());
  await bootstrap(s.dataDir, repoRoot, { CLAUDE_PLUGIN_OPTION_FAN_PROJECTS: 'false' }, () => {});
  assert.deepEqual(JSON.parse(await readFile(join(s.dataDir, 'options.json'), 'utf8')), { fanProjects: false });
});

test('missing database with options.json set installs the saved variant', async (t) => {
  const s = await setup(t);
  await mkdir(s.dataDir, { recursive: true });
  await writeFile(join(s.dataDir, 'options.json'), JSON.stringify({ fanProjects: true }));
  const r = recorder();
  assert.equal(await bootstrap(s.dataDir, repoRoot, {}, r.spawn), 'brick-art: installing the full database in the background.');
  assert.deepEqual(r.calls, ['full']);
});

test('a recently checked release database is ok and does not spawn', async (t) => {
  const s = await withDb(t, 'standard', released());
  const r = recorder();
  assert.deepEqual(await needsUpdate(s.dataDir, repoRoot, 'standard'), { needed: false, reason: 'ok' });
  assert.match(await bootstrap(s.dataDir, repoRoot, {}, r.spawn), READY);
  assert.deepEqual(r.calls, []);
});

test('a release database with a different curated hash is ok, not curated', async (t) => {
  const s = await withDb(t, 'standard', released());
  const copy = await editedRepo(s.dir);
  assert.deepEqual(await needsUpdate(s.dataDir, copy, 'standard'), { needed: false, reason: 'ok' });
});

test('a local build without update.json and a different curated hash is curated', async (t) => {
  const s = await withDb(t, 'standard');
  const copy = await editedRepo(s.dir);
  const r = recorder();
  assert.deepEqual(await needsUpdate(s.dataDir, copy, 'standard'), { needed: true, reason: 'curated' });
  const line = await bootstrap(s.dataDir, copy, {}, r.spawn);
  assert.match(line, /^brick-art: database ready \(standard, 20 parts, \d+ sets, local build\)\.$/);
  assert.deepEqual(r.calls, ['standard']);
});

test('a local-origin database with a different curated hash is curated when the check is due', async (t) => {
  const s = await withDb(t, 'standard', { origin: 'local', variant: 'standard', lastCheckedAt: null });
  const copy = await editedRepo(s.dir);
  assert.deepEqual(await needsUpdate(s.dataDir, copy, 'standard'), { needed: true, reason: 'curated' });
});

test('a local reseed over a release install reports a local build and checks curated changes', async (t) => {
  // update.json still names the release; the manifest says the database was built locally.
  const s = await withDb(t, 'standard', released(new Date(Date.now() - 25 * HOUR)), 'local');
  const copy = await editedRepo(s.dir);
  const r = recorder();
  assert.deepEqual(await needsUpdate(s.dataDir, copy, 'standard'), { needed: true, reason: 'curated' });
  assert.match(await bootstrap(s.dataDir, copy, {}, r.spawn), /^brick-art: database ready \(standard, 20 parts, \d+ sets, local build\)\.$/);
  assert.deepEqual(r.calls, ['standard']);
});

test('a local-origin database checked within 24 hours is not rechecked for curated changes', async (t) => {
  const s = await withDb(t, 'standard', { origin: 'local', variant: 'standard', lastCheckedAt: new Date().toISOString() });
  const copy = await editedRepo(s.dir);
  assert.deepEqual(await needsUpdate(s.dataDir, copy, 'standard'), { needed: false, reason: 'ok' });
});

test('a database of another variant gives variant and switches', async (t) => {
  const s = await withDb(t, 'standard', released());
  const r = recorder();
  assert.deepEqual(await needsUpdate(s.dataDir, repoRoot, 'full'), { needed: true, reason: 'variant' });
  const line = await bootstrap(s.dataDir, repoRoot, { BRICK_ART_FAN_PROJECTS: '1' }, r.spawn);
  assert.equal(line, 'brick-art: switching to the full database in the background.');
  assert.deepEqual(r.calls, ['full']);
});

test('a held lock gives running even with a different variant and does not spawn', async (t) => {
  const s = await withDb(t, 'standard', released());
  await writeFile(dataPaths(s.dataDir).lock, String(process.pid));
  const r = recorder();
  assert.deepEqual(await needsUpdate(s.dataDir, repoRoot, 'full'), { needed: false, reason: 'running' });
  await bootstrap(s.dataDir, repoRoot, { BRICK_ART_FAN_PROJECTS: '1' }, r.spawn);
  assert.deepEqual(r.calls, []);
});

test('a held lock with no database prints the installing line', async (t) => {
  const s = await setup(t);
  await mkdir(s.dataDir, { recursive: true });
  await writeFile(dataPaths(s.dataDir).lock, String(process.pid));
  const r = recorder();
  assert.equal(await bootstrap(s.dataDir, repoRoot, {}, r.spawn), 'brick-art: installing the standard database in the background.');
  assert.deepEqual(r.calls, []);
});

test('lastCheckedAt 25 hours ago gives check_due, spawns, and prints the ready line', async (t) => {
  const now = new Date();
  const s = await withDb(t, 'standard', released(new Date(now.getTime() - 25 * HOUR)));
  const r = recorder();
  assert.deepEqual(await needsUpdate(s.dataDir, repoRoot, 'standard', now), { needed: true, reason: 'check_due' });
  assert.match(await bootstrap(s.dataDir, repoRoot, {}, r.spawn), READY);
  assert.deepEqual(r.calls, ['standard']);
});

test('lastCheckedAt 23 hours ago is ok', async (t) => {
  const now = new Date();
  const s = await withDb(t, 'standard', released(new Date(now.getTime() - 23 * HOUR)));
  assert.deepEqual(await needsUpdate(s.dataDir, repoRoot, 'standard', now), { needed: false, reason: 'ok' });
});

test('a null lastCheckedAt counts as due', async (t) => {
  const s = await withDb(t, 'standard', { ...released(), lastCheckedAt: null });
  assert.deepEqual(await needsUpdate(s.dataDir, repoRoot, 'standard'), { needed: true, reason: 'check_due' });
});

test('a fallback database gives fallback when the check is due and says positions arrive later', async (t) => {
  const s = await withDb(t, 'fallback', { origin: 'local', variant: 'fallback', lastCheckedAt: null });
  const r = recorder();
  assert.deepEqual(await needsUpdate(s.dataDir, repoRoot, 'standard'), { needed: true, reason: 'fallback' });
  const line = await bootstrap(s.dataDir, repoRoot, {}, r.spawn);
  assert.match(line, /^brick-art: database ready \(fallback, 20 parts, \d+ sets, local build\)\. Build positions arrive with the next published release\.$/);
  assert.deepEqual(r.calls, ['standard']);
});

test('a fallback database checked 61 minutes ago is rechecked', async (t) => {
  const now = new Date();
  const s = await withDb(t, 'fallback', { origin: 'local', variant: 'fallback', lastCheckedAt: new Date(now.getTime() - 61 * 60 * 1000).toISOString() });
  assert.deepEqual(await needsUpdate(s.dataDir, repoRoot, 'standard', now), { needed: true, reason: 'fallback' });
});

test('a fallback database checked 59 minutes ago is ok, even for another variant', async (t) => {
  const now = new Date();
  const s = await withDb(t, 'fallback', { origin: 'local', variant: 'fallback', lastCheckedAt: new Date(now.getTime() - 59 * 60 * 1000).toISOString() });
  assert.deepEqual(await needsUpdate(s.dataDir, repoRoot, 'full', now), { needed: false, reason: 'ok' });
  const r = recorder();
  await bootstrap(s.dataDir, repoRoot, { BRICK_ART_FAN_PROJECTS: '1' }, r.spawn);
  assert.deepEqual(r.calls, []);
});

test('a schema mismatch gives schema and installs', async (t) => {
  const s = await withDb(t, 'standard', released());
  const db = new DatabaseSync(join(s.dataDir, readPointer(s.dataDir)!));
  db.prepare("UPDATE manifest SET value = '2' WHERE key = 'seed_version'").run();
  db.close();
  const r = recorder();
  assert.deepEqual(await needsUpdate(s.dataDir, repoRoot, 'standard'), { needed: true, reason: 'schema' });
  assert.equal(await bootstrap(s.dataDir, repoRoot, {}, r.spawn), 'brick-art: installing the standard database in the background.');
  assert.deepEqual(r.calls, ['standard']);
});

test('stale lock with missing db gives missing', async (t) => {
  const s = await setup(t);
  await mkdir(s.dataDir, { recursive: true });
  await writeFile(dataPaths(s.dataDir).lock, '999999');
  assert.deepEqual(await needsUpdate(s.dataDir, repoRoot, 'standard'), { needed: true, reason: 'missing' });
});

test('pointer to a missing db file is missing', async (t) => {
  const s = await setup(t);
  await mkdir(s.dataDir, { recursive: true });
  await writeFile(dataPaths(s.dataDir).pointer, JSON.stringify({ file: 'parts-x.db' }));
  assert.deepEqual(await needsUpdate(s.dataDir, repoRoot, 'standard'), { needed: true, reason: 'missing' });
});

test('failed state with no database prints the failure line and retries', async (t) => {
  const s = await setup(t);
  writeState(dataPaths(s.dataDir).state, { status: 'failed', startedAt: null, finishedAt: null, lastError: 'boom', failures: 1 });
  const r = recorder();
  assert.equal(await bootstrap(s.dataDir, repoRoot, {}, r.spawn), 'brick-art: last parts database build failed: boom. Retrying in the background.');
  assert.deepEqual(r.calls, ['standard']);
});

test('a multi-line lastError shows only its first line, trimmed and capped at 200 characters', async (t) => {
  const s = await setup(t);
  const path = dataPaths(s.dataDir).state;
  const failed = { status: 'failed' as const, startedAt: null, finishedAt: null, failures: 1 };
  writeState(path, { ...failed, lastError: '  first line  \n    at stack (x.ts:1:1)\n' });
  assert.equal(
    await bootstrap(s.dataDir, repoRoot, {}, () => {}),
    'brick-art: last parts database build failed: first line. Retrying in the background.',
  );
  writeState(path, { ...failed, lastError: 'x'.repeat(500) });
  assert.equal(
    await bootstrap(s.dataDir, repoRoot, {}, () => {}),
    `brick-art: last parts database build failed: ${'x'.repeat(200)}. Retrying in the background.`,
  );
});

test('spawn errors are caught and reported on the line', async (t) => {
  const s = await setup(t);
  const line = await bootstrap(s.dataDir, repoRoot, {}, () => { throw new Error('nope'); });
  assert.equal(line, 'brick-art: setup check failed: nope');
});

test('bootstrap on a ready db takes under 1000 ms', async (t) => {
  const s = await withDb(t, 'standard', released());
  const start = performance.now();
  await bootstrap(s.dataDir, repoRoot, {}, () => {});
  assert.ok(performance.now() - start < 1000);
});

test('the detached update runs with a 3 GB heap and the chosen variant', () => {
  assert.deepEqual(
    updateArgs('/repo', 'full'),
    ['--max-old-space-size=3072', join('/repo', 'src', 'entry', 'update.mjs'), '--variant', 'full'],
  );
});
