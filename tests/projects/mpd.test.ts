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

const L = (c: number, ref: string) => `1 ${c} 0 0 0 1 0 0 0 1 0 0 0 1 ${ref}`;

test('lines outside FILE blocks never create files or set main', () => {
  const text = [
    '0 Author: Header', '0 !LICENSE CC0', L(1, 'stray.dat'),
    '0 FILE a.ldr', L(4, '3001.dat'), '0 NOFILE',
    '0 Author: After', L(2, 'stray2.dat'),
    '0 FILE b.ldr', L(4, '3023.dat'), '0 NOFILE', '',
  ].join('\n');
  const m = parseModel(text, 'container.mpd');
  assert.equal(m.main, 'a.ldr');
  assert.deepEqual([...m.files.keys()], ['a.ldr', 'b.ldr']);
  assert.equal(m.files.get('a.ldr')!.author, null);
  assert.equal(m.files.get('a.ldr')!.lines.length, 1);
});

test('plain file header metadata applies to the implicit file', () => {
  const m = parseModel(['0 Author: X', '0 !LICENSE CC0', L(4, '3001.dat')].join('\n'), 'p.ldr');
  assert.equal(m.files.size, 1);
  assert.equal(m.files.get('p.ldr')!.author, 'X');
  assert.equal(m.files.get('p.ldr')!.license, 'CC0');
});

test('ROTSTEP ends a step and empty or repeated STEP lines make no empty steps', () => {
  const text = ['0 FILE a.ldr', '0 STEP', L(4, 'a.dat'), '0 ROTSTEP', '0 STEP', '0 STEP', L(4, 'b.dat'), '0 NOFILE'].join('\n');
  const f = parseModel(text, 'a.ldr').files.get('a.ldr')!;
  assert.equal(f.stepCount, 2);
  assert.deepEqual(f.lines.map((l) => l.step), [1, 2]);
});

test('NOFILE ends a file', () => {
  const m = parseModel(['0 FILE a.ldr', L(4, 'a.dat'), '0 NOFILE', L(4, 'x.dat'), '0 FILE b.ldr', L(4, 'b.dat')].join('\n'), 'm.mpd');
  assert.equal(m.files.get('a.ldr')!.lines.length, 1);
  assert.equal(m.files.get('b.ldr')!.lines.length, 1);
});

test('MPD_10001_MINI fixture shape', () => {
  const m = parseModel(MPD_10001_MINI, 'x.mpd');
  const first = m.files.get(m.main)!.lines[0]!;
  assert.equal(first.color, 4);
  assert.deepEqual(first.matrix, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const refs = m.files.get('10001 - cab.ldr')!.lines.map((l) => l.ref);
  assert.ok(refs.includes('9999x.dat') && refs.includes('missing.ldr'));
});
