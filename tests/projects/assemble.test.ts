import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LDrawLibrary } from '../../src/ldraw/library.ts';
import { assembleProject } from '../../src/projects/assemble.ts';
import { refClassifier } from '../../src/projects/classify.ts';
import { parseModel } from '../../src/projects/mpd.ts';
import { MPD_10001_MINI } from '../helpers/models.ts';

const maps = {
  parts: new Map([['3001.dat', '3001'], ['3023.dat', '3023']]),
  colors: new Map([[0, 0], [4, 4]]),
};
const counter = () => { let n = 100; return () => n++; };

test('assembleProject builds submodels, placements, and parts', () => {
  const m = parseModel(MPD_10001_MINI, '10001-1.mpd');
  const a = assembleProject(m.main, m.files, maps, counter());
  assert.equal(a.submodels.length, 2);
  assert.deepEqual(a.submodels[0], { id: 100, name: '10001 - main.ldr', isMain: true, stepCount: 2, partCount: 1 });
  assert.equal(a.submodels[1]!.isMain, false);
  const byFile = (f: string) => a.placements.find((p) => p.ldrawFile === f)!;
  assert.equal(byFile('9999x.dat').partNum, null);
  assert.equal(byFile('missing.ldr').partNum, null);
  assert.equal(byFile('missing.ldr').childSubmodelId, null);
  const child = a.placements.find((p) => p.childSubmodelId !== null)!;
  assert.equal(child.childSubmodelId, 101);
  assert.equal(child.submodelId, 100);
  assert.equal(child.colorId, 4);
  const plate = a.placements.find((p) => p.partNum === '3023')!;
  assert.equal(plate.colorId, null);
  assert.equal(plate.ldrawColor, 16);
  assert.deepEqual(plate.pos, [10, 0, 0]);
  assert.deepEqual(a.parts, [
    { partNum: '3001', colorId: 4, quantity: 1, isSpare: false, fromMinifig: false },
    { partNum: '3023', colorId: 4, quantity: 1, isSpare: false, fromMinifig: false },
  ]);
  assert.deepEqual(a.stats, { placements: 5, resolved: 3, primitives: 0, segments: 0, aliases: 0 });
  assert.deepEqual(a.placements.map((p) => p.refKind), ['part', 'part', 'unmatched', 'unmatched', 'submodel']);
  assert.deepEqual(a.authors, ['Test Builder', 'Cab Builder']);
  assert.equal(a.licenses.length, 2);
});

test('assembleProject visits a repeatedly referenced file once and sums quantities', () => {
  const text = [
    '0 FILE m.ldr',
    '1 4 0 0 0 1 0 0 0 1 0 0 0 1 s.ldr',
    '1 0 0 0 0 1 0 0 0 1 0 0 0 1 s.ldr',
    '0 FILE s.ldr',
    '1 16 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
  ].join('\n');
  const m = parseModel(text, 'm.mpd');
  const a = assembleProject(m.main, m.files, maps, counter());
  assert.equal(a.submodels.length, 2);
  assert.deepEqual(a.parts.map((p) => [p.partNum, p.colorId, p.quantity]), [['3001', 4, 1], ['3001', 0, 1]]);
});

test('assembleProject cuts cycles', () => {
  const text = [
    '0 FILE a.ldr', '1 4 0 0 0 1 0 0 0 1 0 0 0 1 b.ldr',
    '0 FILE b.ldr', '1 4 0 0 0 1 0 0 0 1 0 0 0 1 a.ldr',
  ].join('\n');
  const m = parseModel(text, 'a.mpd');
  const a = assembleProject(m.main, m.files, maps, counter());
  assert.equal(a.submodels.length, 2);
  const cut = a.placements.find((p) => p.submodelId === 101)!;
  assert.equal(cut.childSubmodelId, null);
  assert.equal(cut.ldrawFile, 'a.ldr');
  assert.equal(cut.refKind, 'unmatched');
  assert.deepEqual(a.stats, { placements: 2, resolved: 1, primitives: 0, segments: 0, aliases: 0 });
  assert.deepEqual(a.parts, []);
});

test('assembleProject passes color 16 down through nested submodels', () => {
  const text = [
    '0 FILE m.ldr', '1 4 0 0 0 1 0 0 0 1 0 0 0 1 a.ldr',
    '0 FILE a.ldr', '1 16 0 0 0 1 0 0 0 1 0 0 0 1 b.ldr',
    '0 FILE b.ldr', '1 16 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat',
  ].join('\n');
  const m = parseModel(text, 'm.mpd');
  const a = assembleProject(m.main, m.files, maps, counter());
  assert.deepEqual(a.parts.map((p) => [p.partNum, p.colorId, p.quantity]), [['3001', 4, 1]]);
  assert.deepEqual(a.stats, { placements: 3, resolved: 3, primitives: 0, segments: 0, aliases: 0 });
});

const line1 = (file: string) => `1 16 0 0 0 1 0 0 0 1 0 0 0 1 ${file}`;
const lib = LDrawLibrary.fromMaps(new Map([
  ['p/4-4cyli.dat', '0 Cylinder 1.0\n0 Name: 4-4cyli.dat\n'],
  ['parts/3001.dat', '0 Brick  2 x  4\n0 Name: 3001.dat\n'],
  ['parts/3023.dat', '0 Plate  1 x  2\n'],
  ['parts/77.dat', '0 ~Technic Flex-System Hose Segment\n0 Name: 77.dat\n'],
  ['parts/166.dat', `0 ~Moved to 3001\n0 Name: 166.dat\n0 !LDRAW_ORG Part Alias\n\n${line1('3001.dat')}\n`],
  ['parts/50746.dat', `0 =Plate  1 x  2 Alias\n0 Name: 50746.dat\n${line1('3023.dat')}\n`],
  ['parts/9.dat', `0 ~Moved to 166\n${line1('166.dat')}\n`],
  ['parts/a.dat', `0 ~Moved to b\n${line1('b.dat')}\n`],
  ['parts/b.dat', `0 ~Moved to a\n${line1('a.dat')}\n`],
  ['parts/2436a.dat', '0 Bracket  1 x  2 -  1 x  4\n'],
]), new Map());
const classified = { ...maps, classify: refClassifier(lib) };
const mpd = (...refs: string[]) => parseModel(['0 FILE m.ldr', ...refs.map((r) => `1 4 0 0 0 1 0 0 0 1 0 0 0 1 ${r}`)].join('\n'), 'm.mpd');

test('assembleProject classifies primitives, segments, and aliases', () => {
  const m = mpd('4-4cyli.dat', '77.dat', '166.dat', '50746.dat', '9.dat');
  const a = assembleProject(m.main, m.files, classified, counter());
  assert.deepEqual(a.placements.map((p) => [p.refKind, p.partNum, p.ldrawFile]), [
    ['primitive', null, '4-4cyli.dat'],
    ['segment', null, '77.dat'],
    ['part', '3001', '166.dat'],
    ['part', '3023', '50746.dat'],
    ['part', '3001', '9.dat'],
  ]);
  assert.deepEqual(a.stats, { placements: 5, resolved: 3, primitives: 1, segments: 1, aliases: 3 });
  assert.deepEqual(a.parts.map((p) => [p.partNum, p.colorId, p.quantity]), [['3001', 4, 2], ['3023', 4, 1]]);
});

test('assembleProject counts primitives and segments apart from unmatched parts', () => {
  const m = mpd('3001.dat', '3023.dat', '4-4cyli.dat', '77.dat', '2436a.dat');
  const a = assembleProject(m.main, m.files, classified, counter());
  assert.deepEqual(a.placements.map((p) => p.refKind), ['part', 'part', 'primitive', 'segment', 'unmatched']);
  const { placements, resolved, primitives, segments } = a.stats;
  assert.equal(resolved / (placements - primitives - segments), 2 / 3);
});

test('assembleProject stops at an alias cycle and leaves it unmatched', () => {
  const m = mpd('a.dat');
  const a = assembleProject(m.main, m.files, classified, counter());
  assert.equal(a.placements[0]!.refKind, 'unmatched');
  assert.equal(a.placements[0]!.partNum, null);
  assert.equal(a.placements[0]!.ldrawFile, 'a.dat');
});
