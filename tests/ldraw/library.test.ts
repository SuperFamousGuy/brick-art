import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { readFile } from 'node:fs/promises';
import { LDrawLibrary } from '../../src/ldraw/library.ts';
import { writeFixtureSources } from '../helpers/fixtures.ts';

async function fixtureLibrary(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'brick-art-ld-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const src = await writeFixtureSources(dir);
  return { src, lib: await LDrawLibrary.fromDirs(src.ldrawRoot, src.shadowRoot) };
}

test('read resolves refs case- and slash-insensitively against parts/ then p/', async (t) => {
  const { lib } = await fixtureLibrary(t);
  const a = lib.read('S\\3001S01.DAT');
  assert.ok(a);
  assert.equal(a, lib.read('s/3001s01.dat'));
  assert.ok(lib.read('stud.dat')?.includes('0 !LDRAW_ORG'));
  assert.equal(lib.read('nope.dat'), null);
});

test('readShadow returns shadow text, null when absent', async (t) => {
  const { lib } = await fixtureLibrary(t);
  assert.ok(lib.readShadow('stud.dat')?.includes('SNAP_CYL'));
  assert.equal(lib.readShadow('stud2.dat'), null);
  assert.ok(lib.readShadow('3937.dat')?.includes('SNAP_FGR'));
});

test('has checks only parts/, never p/', async (t) => {
  const { lib } = await fixtureLibrary(t);
  assert.equal(lib.has('3001.dat'), true);
  assert.equal(lib.has('3001.DAT'), true);
  assert.equal(lib.has('stud.dat'), false);
  assert.equal(lib.has('9.dat'), false);
});

test('normalize lowercases, converts backslashes and trims', () => {
  const lib = LDrawLibrary.fromMaps(new Map(), new Map());
  assert.equal(lib.normalize('  S\\3001S01.DAT '), 's/3001s01.dat');
});

test('releaseName is the largest update tag among files read so far', async (t) => {
  const { lib } = await fixtureLibrary(t);
  assert.equal(lib.releaseName(), null);
  lib.read('3005.dat');
  assert.equal(lib.releaseName(), '2025-03');
  lib.read('3001.dat');
  assert.equal(lib.releaseName(), '2026-10');
});

test('fromMaps serves normalized keys', () => {
  const lib = LDrawLibrary.fromMaps(
    new Map([['parts/3001.dat', '0 x\n'], ['p/stud.dat', '0 y\n']]),
    new Map([['p/stud.dat', '0 !LDCAD SNAP_CYL\n']]),
  );
  assert.equal(lib.read('3001.dat'), '0 x\n');
  assert.equal(lib.read('STUD.dat'), '0 y\n');
  assert.equal(lib.has('stud.dat'), false);
  assert.equal(lib.readShadow('stud.dat'), '0 !LDCAD SNAP_CYL\n');
});

test('fromDirs with null shadow root has no shadow files', async (t) => {
  const { src } = await fixtureLibrary(t);
  const lib = await LDrawLibrary.fromDirs(src.ldrawRoot, null);
  assert.equal(lib.readShadow('stud.dat'), null);
  assert.ok(lib.read('stud.dat'));
});

test('fixture zips have the expected prefixes', async (t) => {
  const { src } = await fixtureLibrary(t);
  const ld = Object.keys(unzipSync(new Uint8Array(await readFile(src.ldrawZip))));
  assert.ok(ld.includes('ldraw/parts/3001.dat'));
  assert.ok(ld.includes('ldraw/p/stud.dat'));
  const sh = Object.keys(unzipSync(new Uint8Array(await readFile(src.ldcadZip))));
  assert.ok(sh.includes('LDCadShadowLibrary-abc123/parts/33085.dat'));
});
