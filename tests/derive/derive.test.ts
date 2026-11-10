import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LDrawLibrary } from '../../src/ldraw/library.ts';
import { resolvePart } from '../../src/ldraw/resolve.ts';
import { loadRebrickable, type RebrickableData } from '../../src/sources/rebrickable.ts';
import { matchParts, matchRateTop } from '../../src/derive/match.ts';
import { computeAvailability } from '../../src/derive/availability.ts';
import { deriveTraits } from '../../src/derive/traits.ts';
import { writeFixtureSources } from '../helpers/fixtures.ts';

let dir: string;
let lib: LDrawLibrary;
let rb: RebrickableData;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'derive-'));
  const fx = await writeFixtureSources(dir);
  lib = await LDrawLibrary.fromDirs(fx.ldrawRoot, fx.shadowRoot);
  rb = await loadRebrickable(fx.rebrickableDir);
});
after(() => rm(dir, { recursive: true, force: true }));

const has = (f: string) => lib.has(f);

test('matchParts matches by file, then by one-hop relationship', () => {
  const m = matchParts(rb, has);
  assert.deepEqual(m.get('3001'), { ldrawFile: '3001.dat', geometryFrom: '3001' });
  assert.equal(m.get('3009b')!.geometryFrom, '3009');
  assert.equal(m.get('3009b')!.ldrawFile, '3009.dat');
  assert.equal(m.has('3001pr0001'), false);
  assert.equal(m.has('003383'), false);
});

test('computeAvailability counts distinct non-spare sets', () => {
  const a = computeAvailability(rb);
  assert.deepEqual(a.parts.get('3001'), { setCount: 3, firstYear: 2020, lastYear: 2024 });
  assert.equal(a.partColors.get('3001')!.get(4)!.setCount, 3);
  assert.deepEqual(a.partColors.get('3001')!.get(2), { setCount: 0, lastYear: null, inElements: true });
  assert.equal(a.partColors.get('3001')!.get(0)!.inElements, false);
  assert.deepEqual(a.parts.get('33085'), { setCount: 1, firstYear: 1998, lastYear: 1998 });
  assert.equal(a.parts.get('99999')?.firstYear ?? null, null);
});

test('deriveTraits', () => {
  const slope = deriveTraits({ name: 'Slope 45° 2 x 2', categoryName: 'Bricks Sloped', connections: [], colorsTrans: [] });
  assert.ok(slope.traits.includes('slope'));
  assert.equal(slope.slopeAngle, 45);
  assert.equal(slope.basicKind, null);
  const brick = deriveTraits({ name: 'Brick 1 x 6', categoryName: 'Bricks', connections: [], colorsTrans: [false] });
  assert.equal(brick.basicKind, 'brick');
  assert.deepEqual(brick.traits, []);
  const side = deriveTraits({
    name: 'Brick Special 1 x 1 with Stud on 1 Side', categoryName: 'Bricks Special',
    connections: resolvePart(lib, '87087.dat').connections, colorsTrans: [],
  });
  assert.ok(side.traits.includes('side-stud'));
  const misc = deriveTraits({ name: 'Tile Round 2 x 2 Inverted Curved Wedge', categoryName: 'Tiles', connections: [], colorsTrans: [false, true] });
  assert.deepEqual(misc.traits, ['curved', 'inverted', 'round', 'tile', 'transparent-capable', 'wedge']);
  const hinge = deriveTraits({ name: 'Hinge Brick 1 x 2 Base', categoryName: 'Hinges', connections: [], colorsTrans: [] });
  assert.deepEqual(hinge.traits, ['hinge']);
});

test('matchRateTop ranks by set count', () => {
  const m = matchParts(rb, has);
  const counts = new Map([...computeAvailability(rb).parts].map(([k, v]) => [k, v.setCount]));
  assert.equal(matchRateTop(rb, m, counts, 3), 1);
  assert.equal(matchRateTop(rb, m, counts, 0), 0);
  assert.equal(matchRateTop(rb, new Map(), counts, 3), 0);
});
