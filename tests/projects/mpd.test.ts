import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRef, parseModel } from '../../src/projects/mpd.ts';
import { MPD_10001_MINI, MPD_BMODEL } from '../helpers/models.ts';

test('parseModel reads files, steps, authors, and licenses', () => {
  const m = parseModel(MPD_10001_MINI, '10001-1.mpd');
  assert.equal(m.main, '10001 - main.ldr');
  assert.equal(m.files.size, 2);
  const main = m.files.get(m.main)!;
  assert.equal(main.name, '10001 - main.ldr');
  assert.equal(main.stepCount, 2);
  assert.equal(main.lines.length, 2);
  assert.deepEqual(main.lines.map((l) => l.step), [1, 2]);
  assert.equal(main.author, 'Test Builder');
  assert.equal(main.license, 'Licensed under CC BY 4.0 : see CAreadme.txt');
  assert.equal(main.lines[1]!.ref, '10001 - CAB.LDR');
  assert.deepEqual(main.lines[1]!.pos, [0, -24, 0]);
  assert.deepEqual(main.lines[1]!.matrix, [0, 0, 1, 0, 1, 0, -1, 0, 0]);
});

test('parseModel keeps color codes and raw refs', () => {
  const m = parseModel(MPD_10001_MINI, '10001-1.mpd');
  const cab = m.files.get('10001 - cab.ldr')!;
  assert.equal(cab.author, 'Cab Builder');
  const plate = cab.lines.find((l) => normalizeRef(l.ref) === '3023.dat')!;
  assert.equal(plate.color, 16);
  assert.equal(plate.ref, '3023.dat');
  assert.deepEqual(plate.pos, [10, 0, 0]);
  assert.deepEqual(cab.lines.map((l) => l.seq), [0, 1, 2]);
});

test('normalizeRef trims, lowercases, and flips separators', () => {
  assert.equal(normalizeRef('S\\3001S01.DAT'), 's/3001s01.dat');
  assert.equal(normalizeRef('  A.dat '), 'a.dat');
});

test('a plain ldr without 0 FILE is one file named after the file name', () => {
  const m = parseModel('0 Author: X\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n', 'Some Model.LDR');
  assert.equal(m.main, 'some model.ldr');
  assert.equal(m.files.size, 1);
  assert.equal(m.files.get(m.main)!.lines.length, 1);
  assert.equal(m.files.get(m.main)!.stepCount, 1);
});

test('b-model has no license line', () => {
  const m = parseModel(MPD_BMODEL, 'x.mpd');
  assert.equal(m.files.get(m.main)!.license, null);
  assert.equal(m.files.get(m.main)!.lines[0]!.color, 72);
});

test('file names with spaces survive and CRLF is handled', () => {
  const m = parseModel('0 FILE a.ldr\r\n1 1 0 0 0 1 0 0 0 1 0 0 0 1 sub  model x.ldr\r\n0 STEP\r\n', 'a.ldr');
  assert.equal(m.files.get('a.ldr')!.lines[0]!.ref, 'sub model x.ldr');
});
