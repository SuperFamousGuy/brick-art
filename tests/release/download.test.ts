import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { readPointer } from '../../src/db/open.ts';
import { dataPaths } from '../../src/paths.ts';
import { buildRelease } from '../../src/release/build.ts';
import { RateLimited, findRelease, readUpdateState, runUpdate } from '../../src/release/download.ts';
import { runSeed } from '../../src/seed/seed.ts';
import { readState } from '../../src/seed/lock.ts';
import { fixtureFetched, writeFixtureSources } from '../helpers/fixtures.ts';
import type { FixtureSources } from '../helpers/fixtures.ts';
import { MPD_CLEAN, startFakeReleases } from '../helpers/models.ts';
import type { FakeRelease, FakeReply } from '../helpers/models.ts';
import { fixtureSeedOptions, omrPages } from '../helpers/seeded.ts';

type T = { after: (fn: () => Promise<void>) => void };
const repoRoot = resolve(import.meta.dirname, '..', '..');
const TAG = 'data-3-20261117';

let root: string;
let fx: FixtureSources;
/** Release assets built once for the whole file: name → bytes. */
let assets: Map<string, Buffer>;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'brick-art-download-'));
  fx = await writeFixtureSources(join(root, 'fx'));
  const omr = new Map<string, FakeReply>(omrPages());
  omr.set('/media/omr_models/1/S1-1.mpd', MPD_CLEAN);
  const { opts, close } = await fixtureSeedOptions(join(root, 'build'), 'full', omr);
  try {
    const { dataDir, repoRoot: buildRoot, ...seed } = opts;
    const outDir = join(root, 'out');
    const result = await buildRelease({
      dataDir, repoRoot: buildRoot, outDir, seed, minPartMatch: 0, now: () => new Date('2026-11-17T08:00:00Z'),
    });
    assert.deepEqual(result.gateFailures, []);
    assets = new Map();
    for (const name of result.assets) assets.set(name, await readFile(join(outDir, name)));
  } finally {
    await close();
  }
});
after(() => rm(root, { recursive: true, force: true }));

function release(tag = TAG, replace: Record<string, FakeReply> = {}): FakeRelease {
  const map = new Map<string, FakeReply>(assets);
  for (const [k, v] of Object.entries(replace)) map.set(k, v);
  return { tag, assets: map };
}

async function serve(t: T, releases: FakeRelease[], api?: FakeReply) {
  const server = await startFakeReleases(releases, { api });
  t.after(() => server.close());
  return server;
}

async function freshDataDir(t: T): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'brick-art-update-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'data');
}

/** A data dir that already holds a locally seeded fallback database. */
async function seededDataDir(t: T): Promise<string> {
  const dataDir = await freshDataDir(t);
  await runSeed({ dataDir, repoRoot, refresh: false, sources: fixtureFetched(fx) });
  return dataDir;
}

function manifest(dataDir: string, key: string): string {
  const db = new DatabaseSync(join(dataDir, readPointer(dataDir)!), { readOnly: true });
  try {
    return (db.prepare('SELECT value FROM manifest WHERE key = ?').get(key) as { value: string }).value;
  } finally {
    db.close();
  }
}

const assetHits = (hits: Map<string, number>) =>
  [...hits].filter(([p]) => p.startsWith('/download/')).reduce((n, [, c]) => n + c, 0);
const partFiles = async (dataDir: string) => (await readdir(dataDir)).filter((n) => n.endsWith('.part'));
const dbFiles = async (dataDir: string) => (await readdir(dataDir)).filter((n) => /^parts-.*\.db$/.test(n));
const throwingSeed = (async () => { throw new Error('runSeed must not be called'); }) as typeof runSeed;

test('runUpdate downloads the release, then reports current, then switches variant', async (t) => {
  const server = await serve(t, [release()]);
  const dataDir = await seededDataDir(t);
  const before = readPointer(dataDir);
  const opts = { dataDir, repoRoot, apiBase: server.url, runSeedImpl: throwingSeed };

  const first = await runUpdate({ ...opts, variant: 'standard' });
  assert.deepEqual(first, { outcome: 'updated', tag: TAG });
  assert.notEqual(readPointer(dataDir), before);
  assert.equal(manifest(dataDir, 'variant'), 'standard');
  assert.deepEqual(await dbFiles(dataDir), [readPointer(dataDir)]);
  assert.deepEqual(await partFiles(dataDir), []);
  const state = readUpdateState(dataDir);
  assert.equal(state.origin, 'release');
  assert.equal(state.releaseTag, TAG);
  assert.equal(state.variant, 'standard');
  assert.equal(state.lastError, null);
  assert.ok(state.lastCheckedAt !== null);
  assert.equal(readState(dataPaths(dataDir).state).status, 'ready');
  assert.equal(existsSync(dataPaths(dataDir).lock), false);

  const hitsBefore = assetHits(server.hits);
  const second = await runUpdate({ ...opts, variant: 'standard' });
  assert.deepEqual(second, { outcome: 'current', tag: TAG });
  assert.equal(assetHits(server.hits), hitsBefore);

  const third = await runUpdate({ ...opts, variant: 'full' });
  assert.deepEqual(third, { outcome: 'updated', tag: TAG });
  assert.equal(manifest(dataDir, 'variant'), 'full');
  assert.equal(readUpdateState(dataDir).variant, 'full');
  assert.equal((await dbFiles(dataDir)).length, 1);

  const forced = await runUpdate({ ...opts, variant: 'full', force: true });
  assert.deepEqual(forced, { outcome: 'updated', tag: TAG });
});

test('a local reseed after a release install is replaced by the same release, not reported current', async (t) => {
  const server = await serve(t, [release()]);
  const dataDir = await seededDataDir(t);
  const opts = { dataDir, repoRoot, apiBase: server.url, runSeedImpl: throwingSeed, variant: 'standard' as const };
  assert.deepEqual(await runUpdate(opts), { outcome: 'updated', tag: TAG });
  // `/reseed --local` of the same variant: update.json still names the release, the manifest says local.
  const db = new DatabaseSync(join(dataDir, readPointer(dataDir)!));
  db.prepare("UPDATE manifest SET value = 'local' WHERE key = 'built_by'").run();
  db.close();
  assert.equal(readUpdateState(dataDir).releaseTag, TAG);
  assert.deepEqual(await runUpdate(opts), { outcome: 'updated', tag: TAG });
  assert.equal(manifest(dataDir, 'built_by'), 'ci');
});

test('a corrupted download keeps the current database and leaves no .part files', async (t) => {
  const gz = Buffer.from(assets.get('standard.db.gz')!);
  gz[Math.floor(gz.length / 2)] ^= 0xff;
  const server = await serve(t, [release(TAG, { 'standard.db.gz': gz })]);
  const dataDir = await seededDataDir(t);
  const before = readPointer(dataDir);
  const r = await runUpdate({ dataDir, repoRoot, variant: 'standard', apiBase: server.url, runSeedImpl: throwingSeed });
  assert.deepEqual(r, { outcome: 'kept', tag: null });
  assert.equal(readPointer(dataDir), before);
  assert.deepEqual(await partFiles(dataDir), []);
  assert.deepEqual(await dbFiles(dataDir), [before]);
  const state = readUpdateState(dataDir);
  assert.match(state.lastError ?? '', /sha256/);
  assert.ok(state.lastCheckedAt !== null);
  assert.equal(readState(dataPaths(dataDir).state).status, 'ready');
});

test('a database hash mismatch after gunzip keeps the current database', async (t) => {
  const meta = JSON.parse(assets.get('release.json')!.toString('utf8'));
  meta.variants.standard.dbSha256 = '0'.repeat(64);
  const server = await serve(t, [release(TAG, { 'release.json': JSON.stringify(meta) })]);
  const dataDir = await seededDataDir(t);
  const before = readPointer(dataDir);
  const r = await runUpdate({ dataDir, repoRoot, variant: 'standard', apiBase: server.url, runSeedImpl: throwingSeed });
  assert.equal(r.outcome, 'kept');
  assert.equal(readPointer(dataDir), before);
  assert.deepEqual(await partFiles(dataDir), []);
  assert.deepEqual(await dbFiles(dataDir), [before]);
});

test('a rate-limited API with a usable database keeps it without seeding', async (t) => {
  const server = await serve(t, [release()], 403);
  const dataDir = await seededDataDir(t);
  const before = readPointer(dataDir);
  const r = await runUpdate({ dataDir, repoRoot, variant: 'standard', apiBase: server.url, runSeedImpl: throwingSeed });
  assert.deepEqual(r, { outcome: 'kept', tag: null });
  assert.equal(readPointer(dataDir), before);
  assert.match(readUpdateState(dataDir).lastError ?? '', /rate limited/);
  assert.equal(assetHits(server.hits), 0);
});

test('no release on an empty data dir seeds the fallback database locally', async (t) => {
  const server = await serve(t, []);
  const dataDir = await freshDataDir(t);
  const r = await runUpdate({
    dataDir, repoRoot, variant: 'standard', apiBase: server.url, seed: { sources: fixtureFetched(fx) },
  });
  assert.deepEqual(r, { outcome: 'fallback_seeded', tag: null });
  assert.equal(manifest(dataDir, 'variant'), 'fallback');
  const state = readUpdateState(dataDir);
  assert.equal(state.origin, 'local');
  assert.equal(state.releaseTag, null);
  assert.equal(readState(dataPaths(dataDir).state).status, 'ready');
  assert.equal(existsSync(dataPaths(dataDir).lock), false);
});

test('findRelease ignores tags for another schema and picks the newest', async (t) => {
  const server = await serve(t, [
    release('data-2-20991231'), release('data-3-20261110'), release(TAG), release('data-3-nightly'),
  ]);
  const found = await findRelease(3, server.url);
  assert.equal(found?.tag, TAG);
  assert.equal(found?.assets.get('release.json'), `${server.url}/download/${TAG}/release.json`);
  assert.equal(await findRelease(4, server.url), null);
});

test('findRelease reads BRICK_ART_RELEASE_API and throws RateLimited on 429', async (t) => {
  const server = await serve(t, [], 429);
  const prior = process.env.BRICK_ART_RELEASE_API;
  process.env.BRICK_ART_RELEASE_API = server.url;
  t.after(async () => {
    if (prior === undefined) delete process.env.BRICK_ART_RELEASE_API;
    else process.env.BRICK_ART_RELEASE_API = prior;
  });
  await assert.rejects(findRelease(3), RateLimited);
  assert.equal(server.hits.get('/repos/SuperFamousGuy/brick-art/releases'), 1);
});

test('runUpdate returns busy while another process holds the lock', async (t) => {
  const server = await serve(t, [release()]);
  const dataDir = await freshDataDir(t);
  await mkdir(dataDir, { recursive: true });
  await writeFile(dataPaths(dataDir).lock, String(process.pid));
  const r = await runUpdate({ dataDir, repoRoot, variant: 'standard', apiBase: server.url, runSeedImpl: throwingSeed });
  assert.deepEqual(r, { outcome: 'busy', tag: null });
  assert.equal(existsSync(dataPaths(dataDir).lock), true);
  assert.equal(readPointer(dataDir), null);
  assert.equal(server.hits.size, 0);
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A release whose standard asset is a valid download of a database with one manifest key changed. */
async function releaseWithManifest(t: T, key: string, value: string): Promise<FakeRelease> {
  const dir = await mkdtemp(join(tmpdir(), 'brick-art-craft-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'standard.db');
  await writeFile(file, gunzipSync(assets.get('standard.db.gz')!));
  const db = new DatabaseSync(file);
  db.prepare('UPDATE manifest SET value = ? WHERE key = ?').run(value, key);
  db.close();
  const raw = await readFile(file);
  const gz = gzipSync(raw);
  const meta = JSON.parse(assets.get('release.json')!.toString('utf8'));
  meta.variants.standard = { ...meta.variants.standard, gzSha256: sha(gz), gzBytes: gz.length, dbSha256: sha(raw), dbBytes: raw.length };
  return release(TAG, { 'standard.db.gz': gz, 'release.json': JSON.stringify(meta) });
}

for (const [key, value] of [['seed_version', '2'], ['variant', 'full']] as const) {
  test(`a verified download whose manifest ${key} is wrong is rejected`, async (t) => {
    const server = await serve(t, [await releaseWithManifest(t, key, value)]);
    const dataDir = await seededDataDir(t);
    const before = readPointer(dataDir);
    const r = await runUpdate({ dataDir, repoRoot, variant: 'standard', apiBase: server.url, runSeedImpl: throwingSeed });
    assert.deepEqual(r, { outcome: 'kept', tag: null });
    assert.equal(readPointer(dataDir), before);
    assert.deepEqual(await partFiles(dataDir), []);
    assert.deepEqual(await dbFiles(dataDir), [before]);
    assert.match(readUpdateState(dataDir).lastError ?? '', new RegExp(key));
  });
}

test('a failed download with no usable database seeds the fallback', async (t) => {
  const server = await serve(t, [release(TAG, { 'standard.db.gz': 500 })]);
  const dataDir = await freshDataDir(t);
  const r = await runUpdate({
    dataDir, repoRoot, variant: 'standard', apiBase: server.url, seed: { sources: fixtureFetched(fx) },
  });
  assert.deepEqual(r, { outcome: 'fallback_seeded', tag: null });
  assert.equal(manifest(dataDir, 'variant'), 'fallback');
  assert.deepEqual(await partFiles(dataDir), []);
  assert.match(readUpdateState(dataDir).lastError ?? '', /500/);
});

test('a failing fallback seed releases the lock, writes update.json and rethrows', async (t) => {
  const server = await serve(t, []);
  const dataDir = await freshDataDir(t);
  await assert.rejects(
    runUpdate({ dataDir, repoRoot, variant: 'standard', apiBase: server.url, runSeedImpl: throwingSeed }),
    /runSeed must not be called/,
  );
  assert.equal(existsSync(dataPaths(dataDir).lock), false);
  const state = readUpdateState(dataDir);
  assert.ok(state.lastCheckedAt !== null);
  assert.match(state.lastError ?? '', /runSeed must not be called/);
});

/** A data dir whose pointer names `parts-20260101T000000.db`, written by `make`. */
async function brokenDataDir(t: T, make: (file: string) => Promise<void>): Promise<string> {
  const dataDir = await freshDataDir(t);
  await mkdir(dataDir, { recursive: true });
  await make(join(dataDir, 'parts-20260101T000000.db'));
  await writeFile(dataPaths(dataDir).pointer, JSON.stringify({ file: 'parts-20260101T000000.db' }));
  return dataDir;
}

const broken: [string, (file: string) => Promise<void>][] = [
  ['a non-SQLite file', (file) => writeFile(file, 'not a database, just text that fills more than a header '.repeat(4))],
  ['a database without a manifest table', async (file) => {
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE parts (part_num TEXT)');
    db.close();
  }],
  ['a truncated database', async (file) => {
    await writeFile(file, gunzipSync(assets.get('standard.db.gz')!).subarray(0, 8192));
  }],
];
for (const [label, make] of broken) {
  test(`${label} is unusable: with no release the fallback is seeded`, async (t) => {
    const server = await serve(t, []);
    const dataDir = await brokenDataDir(t, make);
    const r = await runUpdate({
      dataDir, repoRoot, variant: 'standard', apiBase: server.url, seed: { sources: fixtureFetched(fx) },
    });
    assert.deepEqual(r, { outcome: 'fallback_seeded', tag: null });
    assert.equal(manifest(dataDir, 'variant'), 'fallback');
    assert.deepEqual(await dbFiles(dataDir), [readPointer(dataDir)]);
  });
}

test('a database locked by another connection (SQLITE_BUSY) is kept, not replaced by a local seed', async (t) => {
  const server = await serve(t, [], 403);
  const dataDir = await seededDataDir(t);
  const before = readPointer(dataDir)!;
  const priorState = readState(dataPaths(dataDir).state);
  const holder = new DatabaseSync(join(dataDir, before));
  holder.exec("BEGIN EXCLUSIVE; INSERT OR REPLACE INTO manifest (key, value) VALUES ('probe', '1')");
  let r;
  try {
    r = await runUpdate({ dataDir, repoRoot, variant: 'standard', apiBase: server.url, runSeedImpl: throwingSeed });
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  assert.deepEqual(r, { outcome: 'kept', tag: null });
  assert.equal(readPointer(dataDir), before);
  assert.match(readUpdateState(dataDir).lastError ?? '', /could not be read/);
  assert.deepEqual(readState(dataPaths(dataDir).state), priorState);
});
