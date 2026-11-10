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

test('first call downloads all 13 sources and extracts them', async (t) => {
  const s = await setup(t);
  const out = await fetchSources(s.cacheDir, { refresh: false, maxAgeHours: 24, baseUrls: s.baseUrls });
  assert.equal(out.records.length, 13);
  for (const r of out.records) assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.equal(out.ldcadCommit, 'abc123');
  assert.equal(out.rebrickableDir, s.cacheDir);
  assert.ok((await stat(join(out.ldrawRoot, 'parts', '3001.dat'))).isFile());
  assert.ok((await stat(join(out.ldrawRoot, 'LDConfig.ldr'))).isFile());
  assert.ok((await stat(join(out.shadowRoot, 'p', 'stud.dat'))).isFile());
  assert.equal(s.requests.length, 14); // 13 downloads + commits API
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

test('an old-style extraction without LDConfig.ldr is replaced', async (t) => {
  const s = await setup(t);
  const first = await fetchSources(s.cacheDir, { refresh: false, maxAgeHours: 24, baseUrls: s.baseUrls });
  const sha = first.records.find((r) => r.name === 'ldraw')!.sha256;
  const oldDir = join(s.cacheDir, 'extract', `ldraw-${sha}`);
  await rm(first.ldrawRoot, { recursive: true, force: true });
  await mkdir(join(oldDir, 'parts'), { recursive: true });
  await writeFile(join(oldDir, 'parts', '3001.dat'), 'old');
  const out = await fetchSources(s.cacheDir, { refresh: false, maxAgeHours: 24, baseUrls: s.baseUrls });
  assert.ok((await stat(join(out.ldrawRoot, 'LDConfig.ldr'))).isFile());
  assert.notEqual(out.ldrawRoot, oldDir);
  await assert.rejects(stat(oldDir));
});

test('refresh: true downloads again', async (t) => {
  const s = await setup(t);
  await fetchSources(s.cacheDir, { refresh: false, maxAgeHours: 24, baseUrls: s.baseUrls });
  s.requests.length = 0;
  const out = await fetchSources(s.cacheDir, { refresh: true, maxAgeHours: 24, baseUrls: s.baseUrls });
  assert.equal(s.requests.length, 14); // 13 downloads + commits API
  assert.ok((await stat(join(out.ldrawRoot, 'parts', '3001.dat'))).isFile());
});

test('stale cache (maxAgeHours 0) downloads again', async (t) => {
  const s = await setup(t);
  await fetchSources(s.cacheDir, { refresh: false, maxAgeHours: 24, baseUrls: s.baseUrls });
  s.requests.length = 0;
  await fetchSources(s.cacheDir, { refresh: false, maxAgeHours: 0, baseUrls: s.baseUrls });
  assert.equal(s.requests.length, 14); // 13 downloads + commits API
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

test('idle timeout aborts a stalled download', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'brick-art-idle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write('x');
    // never ends
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cacheDir = join(dir, 'cache');
  await assert.rejects(
    fetchSources(cacheDir, {
      refresh: true, maxAgeHours: 24, idleTimeoutMs: 200, baseUrls: { rebrickableBase: `${base}/rb` },
    }),
    { message: 'download failed: parts timeout' },
  );
  assert.ok(!(await readdir(cacheDir)).some((n) => n.endsWith('.part')));
});

test('idle timeout also covers a stalled commit API call', async (t) => {
  const s = await setup(t);
  const stall: Server = createServer((_req, res) => { res.writeHead(200); res.write('{'); });
  await new Promise<void>((r) => stall.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => { stall.closeAllConnections(); stall.close(() => r()); }));
  const stallBase = `http://127.0.0.1:${(stall.address() as { port: number }).port}`;
  await assert.rejects(
    fetchSources(s.cacheDir, {
      refresh: true, maxAgeHours: 24, idleTimeoutMs: 200,
      baseUrls: { ...s.baseUrls, ldcadCommitApi: `${stallBase}/commits/main` },
    }),
    { message: 'download failed: ldcad-commit timeout' },
  );
});

test('an archive that extracts to zero files is rejected and not cached', async (t) => {
  const s = await setup(t);
  const empty = join(s.dir, 'empty.zip');
  await writeFile(empty, zipSync({ 'ldraw/readme.txt': new TextEncoder().encode('hi') }));
  const mid: Server = createServer(async (req, res) => {
    if (req.url === '/ldraw/complete.zip') { res.end(await readFile(empty)); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((r) => mid.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => { mid.closeAllConnections(); mid.close(() => r()); }));
  const midBase = `http://127.0.0.1:${(mid.address() as { port: number }).port}`;
  await assert.rejects(
    fetchSources(s.cacheDir, {
      refresh: false, maxAgeHours: 24, baseUrls: { ...s.baseUrls, ldrawZip: `${midBase}/ldraw/complete.zip` },
    }),
    { message: 'extraction produced no files: ldraw' },
  );
  const extractDir = join(s.cacheDir, 'extract');
  const left = await readdir(extractDir).catch(() => [] as string[]);
  assert.deepEqual(left, []);
});
