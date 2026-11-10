import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LDrawLibrary } from '../../src/ldraw/library.ts';
import { parseLDraw } from '../../src/ldraw/parse.ts';
import { writeFixtureSources } from '../helpers/fixtures.ts';

test('parseLDraw on fixture 3001.dat', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'brick-art-ld-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const src = await writeFixtureSources(dir);
  const lib = await LDrawLibrary.fromDirs(src.ldrawRoot, null);
  const parsed = parseLDraw(lib.read('3001.dat')!);
  assert.equal(parsed.refs.length, 9);
  assert.ok(parsed.refs.some((r) => r.file === 'S\\3001S01.DAT'));
  assert.ok(parsed.license?.startsWith('Licensed under CC BY 4.0'));
  assert.equal(parsed.description, 'Brick  2 x  4');
  assert.equal(parsed.updateTag, '2026-10');
  assert.equal(parsed.tris.length, 0);
});

test('a type 4 quad yields two triangles', () => {
  const p = parseLDraw('4 16 0 0 0 1 0 0 1 1 0 0 1 0\n');
  assert.equal(p.tris.length, 2);
  assert.deepEqual(p.tris[0], [[0, 0, 0], [1, 0, 0], [1, 1, 0]]);
  assert.deepEqual(p.tris[1], [[0, 0, 0], [1, 1, 0], [0, 1, 0]]);
});

test('type 3 triangles parse; type 2 and 5 lines are ignored', () => {
  const p = parseLDraw('3 16 0 0 0 1 0 0 1 1 0\n2 24 0 0 0 1 1 1\n5 24 0 0 0 1 1 1 2 2 2 3 3 3\n');
  assert.equal(p.tris.length, 1);
});

test('type 1 lines parse position, row-major matrix and file name with spaces', () => {
  const p = parseLDraw('1 16 0 12 -10 1 0 0 0 0 -1 0 1 0 my part.dat\r\n');
  assert.deepEqual(p.refs, [
    { file: 'my part.dat', pos: [0, 12, -10], matrix: [1, 0, 0, 0, 0, -1, 0, 1, 0] },
  ]);
});

test('snap lines are collected; commented-out ones are ignored', () => {
  const live = parseLDraw('0 !LDCAD SNAP_CYL [gender=M]\n0 !LDCAD GENERATED\n');
  assert.deepEqual(live.snapLines, ['0 !LDCAD SNAP_CYL [gender=M]']);
  const dead = parseLDraw('0 //!LDCAD SNAP_CYL [gender=M]\n');
  assert.equal(dead.snapLines.length, 0);
});

test('missing header yields empty defaults', () => {
  const p = parseLDraw('');
  assert.deepEqual(p, { description: '', license: null, updateTag: null, refs: [], tris: [], snapLines: [] });
});
