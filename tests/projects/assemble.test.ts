import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleProject } from '../../src/projects/assemble.ts';
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
  assert.deepEqual(a.stats, { placements: 5, resolved: 3 });
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
  assert.deepEqual(a.stats, { placements: 2, resolved: 1 });
  assert.deepEqual(a.parts, []);
});
