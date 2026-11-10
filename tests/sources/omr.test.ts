import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchOmr } from '../../src/sources/omr.ts';
import { MPD_10001_MINI, MPD_BMODEL, startFakeOmr } from '../helpers/models.ts';
import type { FakeReply } from '../helpers/models.ts';

type After = { after: (fn: () => Promise<void> | void) => void };

const file = (n: number, name: string, v: number) => `/media/omr_models/${n}/${name}?v=${v}`;
const setPage = (...links: string[]) =>
  `<html>${links.map((l) => `<a href="https://library.ldraw.org${l}">f</a>`).join('')}<img src="/media/omr_models/1/x-thumb.png?v=1"></html>`;

function site(v: Record<string, number> = {}) {
  const f = (n: number, name: string) => file(n, name, v[name] ?? 1);
  const pages = new Map<string, FakeReply | FakeReply[]>([
    ['/omr/sets?page=1', '<a href="https://library.ldraw.org/omr/sets/1">a</a><a href="/omr/sets/2">b</a>'],
    ['/omr/sets?page=2', '<a href="/omr/sets/2">b</a><a href="https://library.ldraw.org/omr/sets/3">c</a>'],
    ['/omr/sets?page=3', '<a href="/omr/sets/3">c</a>'],
    ['/omr/sets/1', setPage(f(10, '10001-1.mpd'), f(10, '10001-1_B-Model-from-Instruction.mpd'))],
    ['/omr/sets/2', setPage(f(20, '10002-1.mpd'))],
    ['/omr/sets/3', setPage(f(30, '10003-1.ldr'))],
    ['/media/omr_models/10/10001-1.mpd', MPD_10001_MINI],
    ['/media/omr_models/10/10001-1_B-Model-from-Instruction.mpd', MPD_BMODEL],
    ['/media/omr_models/20/10002-1.mpd', MPD_10001_MINI],
    ['/media/omr_models/30/10003-1.ldr', MPD_BMODEL],
  ]);
  return pages;
}

async function setup(t: After, pages = site(), delayMs = 0) {
  const dir = await mkdtemp(join(tmpdir(), 'brick-art-omr-'));
  const fake = await startFakeOmr(pages, { delayMs });
  t.after(async () => { await fake.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, fake, run: (o = {}) => fetchOmr(dir, { baseUrl: fake.url, backoffMs: 1, ...o }) };
}

const fileHits = (hits: Map<string, number>) =>
  [...hits].filter(([p]) => p.startsWith('/media/')).reduce((n, [, c]) => n + c, 0);

test('first run downloads every file and classifies B-models', async (t) => {
  const { run, dir } = await setup(t);
  const r = await run();
  assert.equal(r.files.length, 4);
  assert.equal(r.fetched, 4);
  assert.equal(r.fromCache, 0);
  assert.equal(r.failed, 0);
  const b = r.files.find((f) => f.fileName === '10001-1_B-Model-from-Instruction.mpd');
  assert.ok(b);
  assert.equal(b.setNum, '10001-1');
  assert.equal(b.isBModel, true);
  assert.equal(r.files.filter((f) => f.isBModel).length, 1);
  const main = r.files.find((f) => f.fileName === '10001-1.mpd');
  assert.equal(main?.isBModel, false);
  assert.equal(await readFile(main!.path, 'utf8'), MPD_10001_MINI);
  assert.ok(main!.url.endsWith('/media/omr_models/10/10001-1.mpd?v=1'));
  assert.ok(main!.path.startsWith(join(dir, 'omr')));
});

test('second run uses the cache; a changed v refetches only that file', async (t) => {
  const pages = site();
  const { run, fake } = await setup(t, pages);
  await run();
  const before = fileHits(fake.hits);
  const again = await run();
  assert.equal(again.fetched, 0);
  assert.equal(again.fromCache, 4);
  assert.equal(again.files.length, 4);
  assert.equal(fileHits(fake.hits), before);

  for (const [k, val] of site({ '10002-1.mpd': 2 })) pages.set(k, val);
  const third = await run();
  assert.equal(third.fetched, 1);
  assert.equal(third.fromCache, 3);
  assert.equal(fake.hits.get('/media/omr_models/20/10002-1.mpd'), 2);
  assert.equal(fake.hits.get('/media/omr_models/10/10001-1.mpd'), 1);
});

test('retries 5xx, gives up on 404 after one request', async (t) => {
  const pages = site();
  pages.set('/media/omr_models/20/10002-1.mpd', [503, 503, MPD_10001_MINI]);
  pages.set('/media/omr_models/30/10003-1.ldr', 404);
  const { run, fake } = await setup(t, pages);
  const r = await run({ retries: 3 });
  assert.equal(r.fetched, 3);
  assert.equal(r.failed, 1);
  assert.equal(r.files.length, 3);
  assert.equal(fake.hits.get('/media/omr_models/20/10002-1.mpd'), 3);
  assert.equal(fake.hits.get('/media/omr_models/30/10003-1.ldr'), 1);
});

test('a file that keeps failing with 5xx is counted failed after all retries', async (t) => {
  const pages = site();
  pages.set('/media/omr_models/30/10003-1.ldr', 500);
  const { run, fake } = await setup(t, pages);
  const r = await run({ retries: 2 });
  assert.equal(r.failed, 1);
  assert.equal(fake.hits.get('/media/omr_models/30/10003-1.ldr'), 3);
});

test('never exceeds the concurrency limit', async (t) => {
  const { run, fake } = await setup(t, site(), 15);
  await run({ concurrency: 2 });
  assert.ok(fake.maxInFlight() <= 2, `max in flight ${fake.maxInFlight()}`);
  assert.ok(fake.maxInFlight() >= 2, 'expected some parallelism');
});

test('ignores absolute hosts found in pages and thumbnails', async (t) => {
  const { run, fake } = await setup(t);
  await run();
  assert.equal(fake.hits.has('/media/omr_models/1/x-thumb.png'), false);
});

test('failed downloads are listed with url and reason', async (t) => {
  const pages = site();
  pages.set('/media/omr_models/30/10003-1.ldr', 404);
  const { run } = await setup(t, pages);
  const r = await run();
  assert.equal(r.failed, 1);
  assert.equal(r.failedUrls.length, 1);
  assert.ok(r.failedUrls[0].url.endsWith('/media/omr_models/30/10003-1.ldr?v=1'));
  assert.match(r.failedUrls[0].reason, /404/);
});

test('filesystem errors reject, and files saved before the error stay indexed', async (t) => {
  const { run, fake, dir } = await setup(t);
  await mkdir(join(dir, 'omr'), { recursive: true });
  await writeFile(join(dir, 'omr', '30'), 'not a directory'); // blocks writing set 3's file
  await assert.rejects(run());
  const index = JSON.parse(await readFile(join(dir, 'omr', 'index.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(Object.keys(index).length, 3);

  await rm(join(dir, 'omr', '30'));
  const before = fileHits(fake.hits);
  const r = await run();
  assert.equal(r.fromCache, 3);
  assert.equal(r.fetched, 1);
  assert.equal(fileHits(fake.hits), before + 1);
});

test('links without a set number are not downloaded', async (t) => {
  const pages = site();
  pages.set('/omr/sets/2', setPage(file(20, '10002-1.mpd', 1), file(21, 'readme.mpd', 1)));
  const { run, fake } = await setup(t, pages);
  const r = await run();
  assert.equal(r.files.length, 4);
  assert.equal(fake.hits.has('/media/omr_models/21/readme.mpd'), false);
});
