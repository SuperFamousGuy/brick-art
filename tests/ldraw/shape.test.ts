import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LDrawLibrary } from '../../src/ldraw/library.ts';
import { resolvePart } from '../../src/ldraw/resolve.ts';
import { computeShape } from '../../src/ldraw/shape.ts';
import { writeFixtureSources } from '../helpers/fixtures.ts';

let dir: string;
let lib: LDrawLibrary;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'shape-'));
  const fx = await writeFixtureSources(dir);
  lib = await LDrawLibrary.fromDirs(fx.ldrawRoot, fx.shadowRoot);
});
after(() => rm(dir, { recursive: true, force: true }));

const shapeOf = (file: string) => computeShape(resolvePart(lib, file).bodyTriangles);

test('3001 bounds, dimensions and fully filled grid', () => {
  const s = shapeOf('3001.dat')!;
  assert.deepEqual(s.bounds, { min: [-40, 0, -20], max: [40, 24, 20] });
  assert.deepEqual([s.widthStuds, s.depthStuds, s.heightPlates], [4, 2, 3]);
  assert.equal(s.grid.length, 3);
  for (const layer of s.grid) {
    assert.equal(layer.length, 2);
    for (const row of layer) assert.deepEqual(row, [1, 1, 1, 1]);
  }
});

test('3023 is 2 x 1 x 1', () => {
  const s = shapeOf('3023.dat')!;
  assert.deepEqual([s.widthStuds, s.depthStuds, s.heightPlates], [2, 1, 1]);
});

test('3039 slope: front top row is empty, back row is filled in all layers', () => {
  const s = shapeOf('3039.dat')!;
  assert.deepEqual([s.widthStuds, s.depthStuds, s.heightPlates], [2, 2, 3]);
  assert.deepEqual(s.grid[0]![0], [0, 0]);
  for (const layer of s.grid) assert.deepEqual(layer[1], [1, 1]);
});

test('no triangles returns null', () => {
  assert.equal(computeShape([]), null);
});
