import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { zipSync } from 'fflate';
import type { FanSource } from '../../src/curated/load.ts';
import { buildFanProjects, fetchFanSource, globToRegExp } from '../../src/sources/fan.ts';
import { startFakeOmr } from '../helpers/models.ts';

const CC = '0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt';
const TOWN = ['0 Author: Mayor', CC, '1 4 0 0 0 1 0 0 0 1 0 0 0 1 house.ldr', '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat', ''].join('\n');
const HOUSE = ['0 Author: Builder', CC, '1 16 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat', ''].join('\n');
const SHED = ['0 Author: Nobody', '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat', ''].join('\n');
const maps = { parts: new Map([['3001.dat', '3001']]), colors: new Map([[4, 4]]) };
const counter = () => { let n = 1; return () => n++; };

const src = (over: Partial<FanSource> = {}): FanSource => ({
  id: 'demo', name: 'Demo', homepage: 'https://example.com',
  fetch: { kind: 'github', repo: 'o/r', paths: ['models/**/*.ldr'] },
  designer: 'Demo people', defaultLicense: null, ...over,
});

async function tree(entries: Record<string, string>): Promise<{ root: string; files: string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'fan-tree-'));
  for (const [name, text] of Object.entries(entries)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), text);
  }
  return { root, files: Object.keys(entries).sort() };
}

test('globToRegExp handles *, **, and the zero-folder case', () => {
  const re = globToRegExp('models/**/*.ldr');
  assert.ok(re.test('models/a.ldr'));
  assert.ok(re.test('models/x/y/a.ldr'));
  assert.ok(!re.test('models/a.mpd'));
  assert.ok(!re.test('other/a.ldr'));
  assert.ok(!globToRegExp('m/*.ldr').test('m/x/a.ldr'));
  assert.ok(globToRegExp('a.b').test('a.b') && !globToRegExp('a.b').test('axb'));
});

test('fetchFanSource downloads a github archive and filters files by paths', async () => {
  const sha = 'abc123def456';
  const zip = zipSync({
    [`r-${sha}/models/town.ldr`]: new TextEncoder().encode(TOWN),
    [`r-${sha}/models/sub/house.ldr`]: new TextEncoder().encode(HOUSE),
    [`r-${sha}/models/notes.txt`]: new TextEncoder().encode('x'),
    [`r-${sha}/other/skip.ldr`]: new TextEncoder().encode(SHED),
  });
  const server = await startFakeOmr(new Map<string, string | Buffer>([
    ['/repos/o/r/commits/HEAD', JSON.stringify({ sha })],
    [`/o/r/zip/${sha}`, Buffer.from(zip)],
  ]));
  const cache = await mkdtemp(join(tmpdir(), 'fan-cache-'));
  try {
    const opts = { githubApi: server.url, codeload: server.url };
    const r = await fetchFanSource(cache, src(), opts);
    assert.equal(r.commit, sha);
    assert.deepEqual(r.files, ['models/sub/house.ldr', 'models/town.ldr']);
    // A second call within the cache window reuses the download.
    const again = await fetchFanSource(cache, src(), opts);
    assert.equal(again.root, r.root);
    assert.equal(server.hits.get(`/o/r/zip/${sha}`), 1);
    assert.equal(server.hits.get('/repos/o/r/commits/HEAD'), 1);
  } finally {
    await server.close();
    await rm(cache, { recursive: true, force: true });
  }
});

test('fetchFanSource takes a url source: a zip is extracted, a plain file is kept', async () => {
  const zip = zipSync({ 'a/town.ldr': new TextEncoder().encode(TOWN), 'readme.txt': new TextEncoder().encode('x') });
  const server = await startFakeOmr(new Map<string, string | Buffer>([
    ['/pack.zip', Buffer.from(zip)],
    ['/one.ldr', TOWN],
  ]));
  const cache = await mkdtemp(join(tmpdir(), 'fan-cache-'));
  try {
    const z = await fetchFanSource(cache, src({ id: 'z', fetch: { kind: 'url', url: `${server.url}/pack.zip`, paths: ['**/*.ldr'] } }));
    assert.equal(z.commit, null);
    assert.deepEqual(z.files, ['a/town.ldr']);
    const one = await fetchFanSource(cache, src({ id: 'one', fetch: { kind: 'url', url: `${server.url}/one.ldr`, paths: ['*.ldr'] } }));
    assert.deepEqual(one.files, ['one.ldr']);
  } finally {
    await server.close();
    await rm(cache, { recursive: true, force: true });
  }
});

test('fetchFanSource rejects when the commit lookup fails', async () => {
  const server = await startFakeOmr(new Map());
  const cache = await mkdtemp(join(tmpdir(), 'fan-cache-'));
  try {
    await assert.rejects(fetchFanSource(cache, src(), { githubApi: server.url, codeload: server.url }), /download failed/);
  } finally {
    await server.close();
    await rm(cache, { recursive: true, force: true });
  }
});

test('buildFanProjects keeps licensed top-level models and skips unlicensed ones', async () => {
  const { root, files } = await tree({ 'town.ldr': TOWN, 'house.ldr': HOUSE, 'shed.ldr': SHED });
  try {
    const r = buildFanProjects(src(), root, files, maps, counter());
    assert.equal(r.projects.length, 1);
    assert.equal(r.skipped, 1);
    const p = r.projects[0]!;
    assert.equal(p.root, 'town.ldr');
    assert.deepEqual(p.submodels.map((s) => [s.name, s.isMain]), [['town.ldr', true], ['house.ldr', false]]);
    assert.deepEqual(p.parts.map((x) => [x.partNum, x.colorId, x.quantity]), [['3001', 4, 2]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a default license admits files with no license line', async () => {
  const { root, files } = await tree({ 'town.ldr': TOWN, 'house.ldr': HOUSE, 'shed.ldr': SHED });
  try {
    const r = buildFanProjects(src({ defaultLicense: 'CC0' }), root, files, maps, counter());
    assert.deepEqual(r.projects.map((p) => p.root).sort(), ['shed.ldr', 'town.ldr']);
    assert.equal(r.skipped, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('one non-redistributable file skips the whole project', async () => {
  const bad = ['0 Author: X', '0 !LICENSE Not redistributable : see NonCAreadme.txt', '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat', ''].join('\n');
  const { root, files } = await tree({ 'town.ldr': TOWN, 'house.ldr': bad });
  try {
    const r = buildFanProjects(src({ defaultLicense: 'CC0' }), root, files, maps, counter());
    assert.equal(r.projects.length, 0);
    assert.equal(r.skipped, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a multi-file mpd contributes its sub-files, and its main is a top-level model', async () => {
  const mpd = [
    '0 FILE big.mpd', CC, '1 4 0 0 0 1 0 0 0 1 0 0 0 1 part.ldr',
    '0 NOFILE', '0 FILE part.ldr', CC, '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat', '0 NOFILE', '',
  ].join('\n');
  const { root, files } = await tree({ 'big.mpd': mpd, 'z.ldr': TOWN.replace('house.ldr', 'part.ldr') });
  try {
    const r = buildFanProjects(src(), root, files, maps, counter());
    assert.deepEqual(r.projects.map((p) => p.root).sort(), ['big.mpd', 'z.ldr']);
    assert.equal(r.projects.find((p) => p.root === 'z.ldr')!.submodels.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('with duplicate file names the first path in sorted order wins', async () => {
  const other = HOUSE.replace('3001.dat', 'missing.dat');
  const { root, files } = await tree({ 'a/house.ldr': HOUSE, 'b/house.ldr': other, 'town.ldr': TOWN });
  try {
    const r = buildFanProjects(src(), root, files, maps, counter());
    assert.equal(r.projects.length, 1);
    assert.deepEqual(r.projects[0]!.parts.map((x) => [x.partNum, x.quantity]), [['3001', 2]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
