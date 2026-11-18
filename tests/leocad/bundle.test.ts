import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleModel, contentHash, mpdText, storedHash } from '../../src/leocad/bundle.ts';

let tmp: string;
let n = 0;
before(async () => { tmp = await mkdtemp(join(tmpdir(), 'bundle-')); });
after(() => rm(tmp, { recursive: true, force: true }));

const BRICK = '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat';
const ref = (name: string) => `1 16 0 0 0 1 0 0 0 1 0 0 0 1 ${name}`;
const isLib = (r: string) => r.endsWith('.dat');

/** Writes files into a fresh folder and returns the path of the first one. */
async function fixture(files: Record<string, string>): Promise<string> {
  const dir = join(tmp, `m${n++}`);
  await mkdir(dir);
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  return join(dir, Object.keys(files)[0]!);
}

const names = (text: string) => text.split('\n').filter((l) => l.startsWith('0 FILE ')).map((l) => l.slice(7));

test('bundles a plain model as one FILE block', async () => {
  const path = await fixture({ 'house.ldr': ['0 House', BRICK, '0 STEP', '0 ROTSTEP 0 45 0 ABS', '0 // Add the roof.', BRICK, '0 STEP', ''].join('\n') });
  const text = mpdText(bundleModel(path, isLib), []);
  const lines = text.split('\n');
  assert.equal(lines[0], '0 FILE house.ldr');
  assert.equal(lines.at(-2), '0 NOFILE');
  const order = ['0 STEP', '0 ROTSTEP 0 45 0 ABS', '0 // Add the roof.'].map((l) => lines.indexOf(l));
  assert.ok(order[0]! > 0 && order[0]! < order[1]! && order[1]! < order[2]!);
});

test('inlines nested submodels once each, in first-reference order', async () => {
  const path = await fixture({
    'house.ldr': [ref('wall.ldr'), ref('wall.ldr')].join('\n'),
    'wall.ldr': [ref('window.ldr'), BRICK].join('\n'),
    'window.ldr': BRICK,
  });
  assert.deepEqual(names(mpdText(bundleModel(path, isLib), [])), ['house.ldr', 'wall.ldr', 'window.ldr']);
});

test('matches submodel names case-insensitively and keeps the first spelling', async () => {
  const path = await fixture({ 'house.ldr': [ref('Wall.ldr'), ref('WALL.ldr')].join('\n'), 'wall.ldr': BRICK });
  assert.deepEqual(names(mpdText(bundleModel(path, isLib), [])), ['house.ldr', 'Wall.ldr']);
});

test('throws when a submodel includes the main model', async () => {
  const path = await fixture({ 'house.ldr': ref('wall.ldr'), 'wall.ldr': [BRICK, ref('House.ldr')].join('\n') });
  assert.throws(() => bundleModel(path, isLib), /includes itself/);
});

test('throws when a submodel includes itself', async () => {
  const path = await fixture({ 'house.ldr': ref('wall.ldr'), 'wall.ldr': [BRICK, ref('wall.ldr')].join('\n') });
  assert.throws(() => bundleModel(path, isLib), /includes itself/);
});

test('throws when the main model includes itself', async () => {
  const path = await fixture({ 'house.ldr': [BRICK, ref('house.ldr')].join('\n') });
  assert.throws(() => bundleModel(path, isLib), /includes itself/);
});

test('uses only the main block of a submodel that is itself an MPD', async () => {
  const path = await fixture({
    'house.ldr': ref('wall.ldr'),
    'wall.ldr': ['0 FILE wall.ldr', BRICK, '0 NOFILE', '0 FILE other.ldr', BRICK, '0 NOFILE'].join('\n'),
  });
  assert.deepEqual(names(mpdText(bundleModel(path, isLib), [])), ['house.ldr', 'wall.ldr']);
});

test('throws for a missing reference', async () => {
  const path = await fixture({ 'house.ldr': ref('ghost.ldr') });
  assert.throws(() => bundleModel(path, isLib), /ghost\.ldr/);
});

test('writes MODEL lines from the header', async () => {
  const path = await fixture({ 'house.ldr': ['0 Small House', '0 Name: house.ldr', '0 Author: brick-art', BRICK].join('\n') });
  const lines = mpdText(bundleModel(path, isLib), ['0 // cam']).split('\n');
  assert.deepEqual(lines.slice(1, 7), [
    '0 Small House', '0 Name: house.ldr', '0 Author: brick-art',
    '0 !LEOCAD MODEL NAME house', '0 !LEOCAD MODEL AUTHOR brick-art', '0 !LEOCAD MODEL DESCRIPTION Small House',
  ]);
  assert.equal(lines[7], '0 // cam');
  assert.match(lines[8]!, /^0 !BRICKART LEOCAD_FILE [0-9a-f]{64}$/);
});

test('a header without Name or Author gives NAME only', async () => {
  const path = await fixture({ 'house.ldr': [BRICK].join('\n') });
  const text = mpdText(bundleModel(path, isLib), []);
  assert.ok(text.includes('0 !LEOCAD MODEL NAME house\n'));
  assert.ok(!text.includes('MODEL AUTHOR'));
  assert.ok(!text.includes('MODEL DESCRIPTION'));
});

test('a title that starts with a field word still becomes DESCRIPTION', async () => {
  const path = await fixture({ 'house.ldr': ['0 Model T Ford', BRICK].join('\n') });
  assert.ok(mpdText(bundleModel(path, isLib), []).includes('0 !LEOCAD MODEL DESCRIPTION Model T Ford\n'));
});

test('a first header line that is a field gives no DESCRIPTION', async () => {
  const path = await fixture({ 'house.ldr': ['0 Name: x.ldr', BRICK].join('\n') });
  assert.ok(!mpdText(bundleModel(path, isLib), []).includes('MODEL DESCRIPTION'));
});

test('strips CR', async () => {
  const path = await fixture({ 'house.ldr': ['0 House', BRICK, '0 STEP', ''].join('\r\n') });
  assert.ok(!mpdText(bundleModel(path, isLib), []).includes('\r'));
});

test('hash round-trips and detects edits', async () => {
  const path = await fixture({ 'house.ldr': ['0 House', BRICK, '0 STEP', BRICK].join('\n') });
  const text = mpdText(bundleModel(path, isLib), []);
  assert.equal(storedHash(text), contentHash(text));
  assert.notEqual(storedHash(text.replace('0 STEP', '0 // step')), contentHash(text.replace('0 STEP', '0 // step')));
  assert.equal(storedHash('0 FILE a.ldr\n'), null);
});
