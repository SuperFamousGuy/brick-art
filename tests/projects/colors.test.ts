import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildColorMap, buildPartMap } from '../../src/projects/colors.ts';
import type { RbColor } from '../../src/sources/rebrickable.ts';
import { writeFixtureSources } from '../helpers/fixtures.ts';
import { tmpdir } from 'node:os';

const RB: RbColor[] = [
  { id: -1, name: '[Unknown]', rgb: '0033B2', isTrans: false },
  { id: 0, name: 'Black', rgb: '05131D', isTrans: false },
  { id: 2, name: 'Green', rgb: '237841', isTrans: false },
  { id: 4, name: 'Red', rgb: 'C91A09', isTrans: false },
  { id: 47, name: 'Trans-Clear', rgb: 'FCFCFC', isTrans: true },
  { id: 288, name: 'Dark Green', rgb: '184632', isTrans: false },
  { id: 9999, name: '[No Color/Any Color]', rgb: 'DA70D6', isTrans: false },
];

test('buildColorMap maps by id, name, and RGB, and reports the rate', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'brick-art-colors-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fx = await writeFixtureSources(dir);
  const ldconfig = await readFile(join(fx.ldrawRoot, 'LDConfig.ldr'), 'utf8');
  const { map, rate } = buildColorMap(ldconfig, RB);
  assert.equal(map.get(0), 0);
  assert.equal(map.get(4), 4);
  assert.equal(map.get(47), 47);
  assert.equal(map.has(72), false);
  assert.equal(rate, 0.8);
});

test('buildColorMap falls back to a unique name or RGB with a different id', () => {
  const rb: RbColor[] = [
    { id: 71, name: 'Light Bluish Gray', rgb: 'A0A5A9', isTrans: false },
    { id: 90, name: 'Other', rgb: '112233', isTrans: false },
  ];
  const cfg = [
    '0 !COLOUR Light_Bluish_Grey CODE 71 VALUE #AAAAAA EDGE #000000',
    '0 !COLOUR Mystery CODE 5 VALUE #112233 EDGE #000000 ALPHA 128',
  ].join('\n');
  const { map, rate } = buildColorMap(cfg, rb);
  assert.deepEqual([...map], [[71, 71], [5, 90]]);
  assert.equal(rate, 1);
});

test('buildColorMap treats hyphens and underscores alike in names', () => {
  const rb: RbColor[] = [{ id: 47, name: 'Trans-Clear', rgb: 'FCFCFC', isTrans: true }];
  const cfg = '0 !COLOUR Trans_Clear CODE 99 VALUE #000001 EDGE #000000';
  assert.deepEqual([...buildColorMap(cfg, rb).map], [[99, 47]]);
});

test('buildPartMap prefers the part that owns the geometry', () => {
  const m = buildPartMap([
    { partNum: '3009b', ldrawFile: '3009.dat', geometryFrom: '3009' },
    { partNum: '3009', ldrawFile: '3009.dat', geometryFrom: '3009' },
    { partNum: '3001pr1', ldrawFile: '3001.DAT', geometryFrom: '3001' },
    { partNum: '3001a', ldrawFile: '3001.dat', geometryFrom: '3001' },
    { partNum: 'x', ldrawFile: null, geometryFrom: null },
  ]).parts;
  assert.equal(m.get('3009.dat'), '3009');
  assert.equal(m.get('3001.dat'), '3001a');
  assert.equal(m.size, 2);
});

test('buildPartMap maps an unmatched variant file to its base part; exact matches win', () => {
  const { parts, suffixed } = buildPartMap([
    { partNum: '3023', ldrawFile: '3023.dat', geometryFrom: '3023' },
    { partNum: '3001', ldrawFile: '3001.dat', geometryFrom: '3001' },
    { partNum: '3626', ldrawFile: '3626.dat', geometryFrom: '3626' },
    { partNum: '3626c', ldrawFile: '3626c.dat', geometryFrom: '3626c' },
    { partNum: '3709', ldrawFile: null, geometryFrom: null },
    { partNum: '4092a', ldrawFile: null, geometryFrom: null },
    { partNum: '4092', ldrawFile: '4092.dat', geometryFrom: '4092' },
  ], ['3023b.dat', '3001.dat', '3626c.dat', '3709B.DAT', '4092a.dat', '9999x.dat', '3023bb.dat', '3023.dat']);
  assert.equal(parts.get('3023b.dat'), '3023');
  assert.equal(parts.get('3001.dat'), '3001');
  assert.equal(parts.get('3626c.dat'), '3626c');
  assert.equal(parts.get('3709b.dat'), '3709');
  // 4092a is a Rebrickable part of its own (unmatched to a file), so the file is not mapped to 4092.
  assert.equal(parts.has('4092a.dat'), false);
  assert.equal(parts.has('9999x.dat'), false);
  assert.equal(parts.has('3023bb.dat'), false);
  assert.deepEqual([...suffixed].sort(), ['3023b.dat', '3709b.dat']);
});
