import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { fetchSources } from '../../src/sources/fetch.ts';
import { extractZip } from '../../src/sources/extract.ts';
import { writeFixtureSources } from '../helpers/fixtures.ts';

type After = { after: (fn: () => Promise<void> | void) => void };

async function setup(t: After, failParts = false) {
  const dir = await mkdtemp(join(tmpdir(), 'brick-art-fetch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const src = await writeFixtureSources(join(dir, 'fx'));
  const requests: { url: string; ua: string | undefined; accept: string | undefined }[] = [];
  const state = { failParts };
  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? '';
    requests.push({ url, ua: req.headers['user-agent'], accept: req.headers.accept });
    let file: string | null = null;
    if (url.startsWith('/rb/')) {
      if (state.failParts && url === '/rb/parts.csv.gz') { res.statusCode = 500; res.end('boom'); return; }
      file = join(src.rebrickableDir, url.slice(4));
    } else if (url === '/ldraw/complete.zip') file = src.ldrawZip;
    else if (url === '/archive/abc123') file = src.ldcadZip;
    else if (url === '/commits/main') {
      res.setHeader('content-type', 'application/json');
      res.end('{"sha": "abc123"}');
      return;
    }
    if (!file) { res.statusCode = 404; res.end(); return; }
    res.setHeader('last-modified', 'Wed, 01 Jan 2025 00:00:00 GMT');
    res.end(await readFile(file));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const baseUrls = {
    rebrickableBase: `${base}/rb`,
    ldrawZip: `${base}/ldraw/complete.zip`,
    ldcadCommitApi: `${base}/commits/main`,
    ldcadArchiveBase: `${base}/archive`,
  };
  return { dir, cacheDir: join(dir, 'cache'), requests, baseUrls, state, src };
}

test('first call downloads all 10 sources and extracts them', async (t) => {
  const s = await setup(t);
  const out = await fetchSources(s.cacheDir, { refresh: false, maxAgeHours: 24, baseUrls: s.baseUrls });
  assert.equal(out.records.length, 10);
  for (const r of out.records) assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.equal(out.ldcadCommit, 'abc123');
  assert.equal(out.rebrickableDir, s.cacheDir);
  assert.ok((await stat(join(out.ldrawRoot, 'parts', '3001.dat'))).isFile());
  assert.ok((await stat(join(out.shadowRoot, 'p', 'stud.dat'))).isFile());
  assert.equal(s.requests.length, 11); // 10 downloads + commits API
  assert.ok(s.requests.every((r) => r.ua === 'brick-art-seed'));
  assert.equal(s.requests.find((r) => r.url === '/commits/main')?.accept, 'application/vnd.github+json');
  const meta = JSON.parse(await readFile(join(s.cacheDir, 'parts.meta.json'), 'utf8'));
  assert.equal(meta.name, 'parts');
  assert.equal(meta.lastModified, 'Wed, 01 Jan 2025 00:00:00 GMT');
});

test('second call within maxAgeHours makes zero requests', async (t) => {
  const s = await setup(t);
  const first = await fetchSources(s.cacheDir, { refresh: false, maxAgeHours: 24, baseUrls: s.baseUrls });
  s.requests.length = 0;
  const second = await fetchSources(s.cacheDir, { refresh: false, maxAgeHours: 24, baseUrls: s.baseUrls });
  assert.equal(s.requests.length, 0);
  assert.equal(second.ldcadCommit, 'abc123');
  assert.equal(second.ldrawRoot, first.ldrawRoot);
  assert.deepEqual(second.records, first.records);
});

test('refresh: true downloads again', async (t) => {
  const s = await setup(t);
  await fetchSources(s.cacheDir, { refresh: false, maxAgeHours: 24, baseUrls: s.baseUrls });
  s.requests.length = 0;
  const out = await fetchSources(s.cacheDir, { refresh: true, maxAgeHours: 24, baseUrls: s.baseUrls });
  assert.equal(s.requests.length, 11); // 10 downloads + commits API
  assert.ok((await stat(join(out.ldrawRoot, 'parts', '3001.dat'))).isFile());
});

test('stale cache (maxAgeHours 0) downloads again', async (t) => {
  const s = await setup(t);
  await fetchSources(s.cacheDir, { refresh: false, maxAgeHours: 24, baseUrls: s.baseUrls });
  s.requests.length = 0;
  await fetchSources(s.cacheDir, { refresh: false, maxAgeHours: 0, baseUrls: s.baseUrls });
  assert.equal(s.requests.length, 11); // 10 downloads + commits API
});

test('HTTP 500 rejects, removes .part, and keeps the previous cached file', async (t) => {
  const s = await setup(t);
  await fetchSources(s.cacheDir, { refresh: false, maxAgeHours: 24, baseUrls: s.baseUrls });
  const before = await readFile(join(s.cacheDir, 'parts.csv.gz'));
  const metaBefore = await readFile(join(s.cacheDir, 'parts.meta.json'), 'utf8');
  s.state.failParts = true;
  await assert.rejects(
    fetchSources(s.cacheDir, { refresh: true, maxAgeHours: 24, baseUrls: s.baseUrls }),
    { message: 'download failed: parts 500' },
  );
  assert.deepEqual(await readFile(join(s.cacheDir, 'parts.csv.gz')), before);
  assert.equal(await readFile(join(s.cacheDir, 'parts.meta.json'), 'utf8'), metaBefore);
  assert.ok(!(await readdir(s.cacheDir)).some((n) => n.endsWith('.part')));
});

test('extractZip filters, strips the prefix, and blocks zip-slip', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'brick-art-zip-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const enc = (s: string) => new TextEncoder().encode(s);
  const zip = join(dir, 'x.zip');
  await writeFile(zip, zipSync({
    'ldraw/parts/a.dat': enc('A'),
    'ldraw/p/sub/b.dat': enc('B'),
    'ldraw/other/c.dat': enc('C'),
    'ldraw/parts/../../evil.dat': enc('E'),
    'ldraw/parts/': new Uint8Array(0),
  }));
  const dest = join(dir, 'out');
  await mkdir(dest);
  const n = await extractZip(zip, dest, (p) => /^(parts|p)\//.test(p), /^ldraw\//);
  assert.equal(n, 2);
  assert.equal(await readFile(join(dest, 'parts', 'a.dat'), 'utf8'), 'A');
  assert.equal(await readFile(join(dest, 'p', 'sub', 'b.dat'), 'utf8'), 'B');
  await assert.rejects(stat(join(dir, 'evil.dat')));
  await assert.rejects(stat(join(dest, 'other')));
});
