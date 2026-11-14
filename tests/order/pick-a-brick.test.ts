import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../../src/db/schema.ts';
import { writeColors, writeElements, writeParts, writeRelationships, type PartRow } from '../../src/db/write.ts';
import {
  PICK_A_BRICK_URL, dbElementLookup, defaultElement, planPickABrick, searchUrls, toCsv, writePickABrickList,
  type Candidate, type ElementLookup,
} from '../../src/order/pick-a-brick.ts';
import { ZipIndex } from '../../src/render/zip-index.ts';
import type { TallyRow } from '../../src/render/tally.ts';
import { LDCONFIG, writeLibrary } from '../helpers/ldraw-fixture.ts';

let tmp: string;
before(async () => { tmp = await mkdtemp(join(tmpdir(), 'pab-')); });
after(() => rm(tmp, { recursive: true, force: true }));

const cand = (elementId: string, designId = 'd'): Candidate => ({ elementId, partNum: 'p', designId });
const row = (part: string, color: number, count: number): TallyRow => ({ part, color, colorName: null, count });

test('defaultElement prefers the newest element that is not a recent reissue', () => {
  assert.equal(defaultElement([]), null);
  assert.equal(defaultElement([cand('300401'), cand('4613964'), cand('6548257')]), '4613964');
  assert.equal(defaultElement([cand('4256096'), cand('6136606'), cand('6495613')]), '6495613');
  assert.equal(defaultElement([cand('6548255'), cand('6552096')]), '6552096');
});

test('planPickABrick applies overrides, sums shared elements, and reports unused overrides', () => {
  const elements: Record<string, Candidate[]> = {
    'a:4': [cand('100', 'A'), cand('200', 'A')],
    'b:4': [cand('300', 'B')],
    'c:4': [cand('400', 'C')],
  };
  const lookup: ElementLookup = {
    partFor: (p) => (p === 'zzz' ? null : p),
    colorFor: (c) => c,
    elementsFor: (p, c) => elements[`${p}:${c}`] ?? [],
  };
  const plan = planPickABrick(
    [row('a', 4, 2), row('b', 4, 3), row('c', 4, 1), row('d', 4, 5), row('zzz', 4, 1)],
    lookup,
    [
      { part: 'B', color: 4, elementId: '200' },
      { part: 'c', color: 4, elementId: null },
      { part: 'a', color: 1, elementId: '999' },
    ],
  );
  assert.deepEqual(plan.rows.map((r) => [r.part, r.elementId, r.source]), [
    ['a', '200', 'guess'],
    ['b', '200', 'checked'],
    ['c', null, 'not-sold'],
    ['d', null, 'no-element'],
    ['zzz', null, 'no-element'],
  ]);
  assert.equal(plan.rows[4]!.partNum, null);
  assert.deepEqual(plan.lines, [{ elementId: '200', quantity: 5 }]);
  assert.deepEqual(plan.unusedOverrides, [{ part: 'a', color: 1, elementId: '999' }]);
  assert.equal(plan.searchUrls.length, 1);
  assert.equal(plan.searchUrls[0], `${PICK_A_BRICK_URL}?query=100%20200%20300%20400`);
});

test('searchUrls keeps rows that share a design apart and caps each search at 60 IDs', () => {
  const ids = (n: number, from: number, design: string) =>
    Array.from({ length: n }, (_, i) => cand(String(from + i), design));
  const urls = searchUrls([
    { candidates: [cand('1', 'X')] },
    { candidates: [cand('2', 'X')] },
    { candidates: [cand('3', 'Y')] },
    { candidates: ids(58, 1000, 'Z') },
  ]);
  const queries = urls.map((u) => u.slice(u.indexOf('=') + 1).split('%20'));
  assert.deepEqual(queries.map((q) => q.length), [60, 1]);
  assert.deepEqual(queries[0]!.slice(0, 2), ['1', '3']);
  assert.deepEqual(queries[1], ['2']);
});

test('toCsv writes the Pick a Brick header and CRLF lines', () => {
  assert.equal(toCsv([{ elementId: '300121', quantity: 3 }]), 'elementId,quantity\r\n300121,3\r\n');
  assert.equal(toCsv([]), 'elementId,quantity\r\n');
});

const part = (n: string, ldrawFile = `${n}.dat`): PartRow => ({
  partNum: n, name: n, categoryId: 11, categoryName: 'Bricks', ldrawFile, geometryFrom: n,
  widthStuds: 1, depthStuds: 1, heightPlates: 3, minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0,
  grid: null, slopeAngle: null, basicKind: 'brick', setCount: 1, firstYear: 2000, lastYear: 2020, license: null,
  hasGeometry: true, hasConnections: true, hasGrid: false, isComplete: true, isPrint: false, basePartNum: null, isSystem: true,
});

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  writeParts(db, [part('3001'), part('3794b'), part('15573'), part('box', 'box.dat')]);
  writeColors(db, [
    { id: 1, name: 'Blue', rgb: '0055BF', isTrans: false, family: 'blue', isPlaceholder: false },
    { id: 4, name: 'Red', rgb: 'C91A09', isTrans: false, family: 'red', isPlaceholder: false },
  ]);
  writeRelationships(db, [{ relType: 'M', childPartNum: '3794b', parentPartNum: '15573' }]);
  writeElements(db, [
    { elementId: '300121', partNum: '3001', colorId: 4, designId: '3001' },
    { elementId: '6051511', partNum: '15573', colorId: 4, designId: null },
    { elementId: '4000001', partNum: 'box', colorId: 1, designId: 'box' },
  ]);
  return db;
}

test('dbElementLookup maps LDraw parts and colors and falls back to related parts', () => {
  const db = makeDb();
  const lookup = dbElementLookup(db, LDCONFIG);
  assert.equal(lookup.partFor('3001'), '3001');
  assert.equal(lookup.partFor('BOX'), 'box');
  assert.equal(lookup.partFor('nope'), null);
  assert.equal(lookup.colorFor(4), 4);
  assert.equal(lookup.colorFor(999), null);
  assert.deepEqual(lookup.elementsFor('3001', 4), [{ elementId: '300121', partNum: '3001', designId: '3001' }]);
  assert.deepEqual(lookup.elementsFor('3794b', 4), [{ elementId: '6051511', partNum: '15573', designId: '15573' }]);
  assert.deepEqual(lookup.elementsFor('3001', 1), []);
  db.close();
});

test('dbElementLookup asks for a reseed when the database has no elements table', () => {
  const db = makeDb();
  db.exec('DROP TABLE elements');
  assert.throws(() => dbElementLookup(db, LDCONFIG), /no element IDs.*reseed/);
  db.close();
});

test('writePickABrickList writes <model>-pick-a-brick.csv from the model and its submodels', async () => {
  const db = makeDb();
  const library = ZipIndex.open(writeLibrary(tmp), /^ldraw\//);
  const dir = join(tmp, 'model');
  await mkdir(dir);
  await writeFile(join(dir, 'sub.ldr'), '1 16 0 0 0 1 0 0 0 1 0 0 0 1 box.dat\n');
  await writeFile(join(dir, 'm.ldr'), [
    '1 1 0 0 0 1 0 0 0 1 0 0 0 1 sub.ldr',
    '1 1 0 0 0 1 0 0 0 1 0 0 0 1 sub.ldr',
    '1 4 0 0 0 1 0 0 0 1 0 0 0 1 big.dat',
    '',
  ].join('\n'));
  const r = await writePickABrickList({
    modelPath: join(dir, 'm.ldr'), library, db, overrides: [{ part: 'box', color: 1, elementId: '4000002' }],
  });
  assert.equal(r.csv, join(dir, 'm-pick-a-brick.csv'));
  assert.equal(await readFile(r.csv, 'utf8'), 'elementId,quantity\r\n4000002,2\r\n');
  assert.deepEqual([r.lineCount, r.totalParts, r.partsInCsv, r.unchecked], [1, 3, 2, 0]);
  assert.deepEqual(r.rows.map((x) => [x.part, x.source]), [['big', 'no-element'], ['box', 'checked']]);
  await assert.rejects(writePickABrickList({ modelPath: join(dir, 'none.ldr'), library, db }), /not found/);
  db.close();
});
