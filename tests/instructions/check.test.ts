import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { checkModel } from '../../src/instructions/check.ts';
import type { GeometrySource, PartGeom } from '../../src/instructions/geometry.ts';
import { parseSteps } from '../../src/instructions/steps.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const BOX: PartGeom = {
  bounds: { min: [-10, 0, -10], max: [10, 24, 10] },
  grid: [[[1]], [[1]], [[1]]],
  connections: [
    { type: 'stud', position: [0, 0, 0], direction: [0, -1, 0] },
    { type: 'stud_receptor', position: [0, 24, 0], direction: [0, -1, 0] },
  ],
};
// Bounds include the stud, like real LDraw parts, so stacked copies share one grid layer.
const STUDDED: PartGeom = { ...BOX, bounds: { min: [-10, -4, -10], max: [10, 24, 10] }, grid: [[[1]], [[1]], [[1]], [[1]]] };
const BLOB: PartGeom = { ...BOX, connections: null };
// The parts DB's convention: studs point up (-y) and receptors point down (+y), so a real mate is anti-parallel.
const OUTWARD: PartGeom = {
  ...STUDDED,
  connections: [
    { type: 'stud', position: [0, 0, 0], direction: [0, -1, 0] },
    { type: 'stud_receptor', position: [0, 24, 0], direction: [0, 1, 0] },
  ],
};
const PARTS: Record<string, PartGeom> = { 'box.dat': BOX, 'studded.dat': STUDDED, 'blob.dat': BLOB, 'outward.dat': OUTWARD };
const geom: GeometrySource = {
  get: (f) => PARTS[f] ?? null,
  compatible: (a, b) => (a === 'stud' && b === 'stud_receptor') || (a === 'stud_receptor' && b === 'stud'),
};

const ROT_Y = '0 0 1 0 1 0 -1 0 0';
const box = (x = 0, y = 0, z = 0, m = '1 0 0 0 1 0 0 0 1', file = 'box.dat') => `1 4 ${x} ${y} ${z} ${m} ${file}`;

function check(files: Record<string, string[]>) {
  const dir = mkdtempSync(join(tmpdir(), 'check-'));
  dirs.push(dir);
  for (const [name, lines] of Object.entries(files)) writeFileSync(join(dir, name), lines.join('\n') + '\n');
  const model = parseSteps(join(dir, 'model.ldr'), { isLibraryPart: (f) => f.endsWith('.dat') });
  return checkModel(model, geom);
}
const two = (second: string, extra: string[] = []) => check({ 'model.ldr': [box(), '0 STEP', ...extra, second] });

test('stacked brick connects', () => {
  const r = two(box(0, -24));
  assert.deepEqual(r.findings, []);
  assert.equal(r.blocked, false);
});

test('floating brick is blocking', () => {
  const r = two(box(0, -100));
  assert.equal(r.findings.length, 1);
  const f = r.findings[0]!;
  assert.equal(f.kind, 'floating');
  assert.equal(f.blocking, true);
  assert.equal(f.step, 2);
  assert.match(f.message, /box\.dat/);
  assert.match(f.message, /-100/);
  assert.equal(r.blocked, true);
});

test('half-stud shift is off-grid', () => {
  const r = two(box(10, -24));
  assert.deepEqual(r.findings.map((f) => f.kind), ['off-grid']);
  assert.equal(r.findings[0]!.blocking, true);
  assert.equal(r.blocked, true);
});

test('brick inside brick is overlap', () => {
  const r = two(box());
  assert.ok(r.findings.some((f) => f.kind === 'overlap' && f.blocking && f.step === 2));
  assert.equal(r.blocked, true);
});

test('same-step chain connects', () => {
  const r = check({ 'model.ldr': [box(), '0 STEP', box(0, -48), box(0, -24)] });
  assert.deepEqual(r.findings, []);
});

test('rotated part connects', () => {
  const r = two(box(0, -24, 0, ROT_Y));
  assert.deepEqual(r.findings, []);
});

test('rotated overlap is caught', () => {
  const r = two(box(0, 0, 0, ROT_Y));
  assert.ok(r.findings.some((f) => f.kind === 'overlap' && f.blocking && f.step === 2));
});

test('unknown part is unverified, not blocking', () => {
  const r = two(box(0, -24, 0, undefined, 'mystery.dat'));
  assert.deepEqual(r.findings.map((f) => f.kind), ['unverified']);
  assert.equal(r.findings[0]!.blocking, false);
  assert.equal(r.findings[0]!.part, 'mystery.dat');
  assert.equal(r.blocked, false);
});

test('accepted part is skipped', () => {
  const r = two(box(0, -100), ['0 !BRICKART CONNECTED']);
  assert.deepEqual(r.findings, []);
  assert.equal(r.accepted.length, 1);
  assert.deepEqual(r.accepted[0]!.pos, [0, -100, 0]);
});

test('large step warns', () => {
  const r = check({ 'model.ldr': [box(), '0 STEP', ...Array.from({ length: 9 }, (_, i) => box(0, -24 * (i + 1)))] });
  assert.deepEqual(r.findings.map((f) => f.kind), ['large-step']);
  assert.equal(r.findings[0]!.blocking, false);
  assert.equal(r.findings[0]!.step, 2);
  assert.equal(r.blocked, false);
});

test('callout group connects through any member', () => {
  const r = check({
    'model.ldr': [box(), '0 STEP', '1 4 0 -24 0 1 0 0 0 1 0 0 0 1 pair.ldr'],
    'pair.ldr': [box(0, -24), '0 STEP', box(0, 0)],
  });
  assert.equal(r.findings.length, 0, JSON.stringify(r.findings));
});

test('floating callout is one blocking finding', () => {
  const r = check({
    'model.ldr': [box(), '0 STEP', '1 4 0 -200 0 1 0 0 0 1 0 0 0 1 pair.ldr'],
    'pair.ldr': [box(0, 0), '0 STEP', box(0, -24)],
  });
  assert.deepEqual(r.findings.map((f) => [f.kind, f.step]), [['floating', 2]]);
});

test('floating part inside a callout mini-step is caught in the local frame', () => {
  const r = check({
    'model.ldr': [box(), '0 STEP', '1 4 0 -24 0 1 0 0 0 1 0 0 0 1 pair.ldr'],
    'pair.ldr': [box(0, 0), '0 STEP', box(0, -100)],
  });
  const f = r.findings.filter((x) => x.kind === 'floating');
  assert.equal(f.length, 1);
  assert.equal(f[0]!.source.file, 'pair.ldr');
  assert.deepEqual(f[0]!.pos, [0, -100, 0]);
});

test('section steps are checked locally and the insert as a group', () => {
  const tower = Array.from({ length: 9 }, (_, i) => [box(0, -24 * i), '0 STEP']).flat();
  const r = check({
    'model.ldr': [box(), '0 STEP', '1 4 0 -24 0 1 0 0 0 1 0 0 0 1 tower.ldr'],
    'tower.ldr': tower,
  });
  assert.deepEqual(r.findings, []);
  const bad = check({
    'model.ldr': [box(), '0 STEP', '1 4 0 -500 0 1 0 0 0 1 0 0 0 1 tower.ldr'],
    'tower.ldr': tower,
  });
  assert.deepEqual(bad.findings.map((f) => [f.kind, f.section]), [['floating', 'model']]);
});

test('inserted section parts do not count toward a large step', () => {
  const tower = Array.from({ length: 9 }, (_, i) => [box(0, -24 * i), '0 STEP']).flat();
  const r = check({
    'model.ldr': [box(), '0 STEP', '1 4 0 -24 0 1 0 0 0 1 0 0 0 1 tower.ldr', box(0, -240)],
    'tower.ldr': tower,
  });
  assert.deepEqual(r.findings, []);
});

test('parts that mate with each other are exempt from overlap', () => {
  const r = check({ 'model.ldr': [box(0, 0, 0, undefined, 'studded.dat'), '0 STEP', box(0, -24, 0, undefined, 'studded.dat')] });
  assert.deepEqual(r.findings, []);
});

test('a small shared volume is a possible overlap, not blocking', () => {
  const r = two(box(0, -16));
  assert.ok(!r.findings.some((f) => f.kind === 'overlap'), JSON.stringify(r.findings));
  const possible = r.findings.filter((f) => f.kind === 'unverified' && /possible overlap/.test(f.message));
  assert.equal(possible.length, 1);
  assert.equal(possible[0]!.blocking, false);
  assert.equal(possible[0]!.step, 2);
});

test('a part resting on an unknown part is unverified, not floating', () => {
  const r = check({ 'model.ldr': [box(0, 0, 0, undefined, 'mystery.dat'), '0 STEP', box(0, -24), '0 STEP', box(0, -48)] });
  assert.ok(!r.findings.some((f) => f.kind === 'floating'), JSON.stringify(r.findings));
  assert.deepEqual(r.findings.filter((f) => f.step === 2).map((f) => f.kind), ['unverified']);
  assert.deepEqual(r.findings.filter((f) => f.step === 3), []);
  assert.equal(r.blocked, false);
});

test('a part resting on a part without connections is unverified, not floating', () => {
  const r = check({ 'model.ldr': [box(0, 0, 0, undefined, 'blob.dat'), '0 STEP', box(0, -24)] });
  assert.deepEqual(r.findings.map((f) => [f.kind, f.step]), [['unverified', 1], ['unverified', 2]]);
  assert.match(r.findings[1]!.message, /touches blob\.dat/);
  assert.equal(r.blocked, false);
});

test('an accepted part inside a callout does not free the callout', () => {
  const r = check({
    'model.ldr': [box(), '0 STEP', '1 4 0 -500 0 1 0 0 0 1 0 0 0 1 pair.ldr'],
    'pair.ldr': [box(0, 0), '0 STEP', '0 !BRICKART CONNECTED', box(0, -24)],
  });
  assert.ok(r.findings.some((f) => f.kind === 'floating' && f.blocking && f.step === 2), JSON.stringify(r.findings));
  assert.equal(r.blocked, true);
});

test('a part inverted onto its mate is still an overlap', () => {
  const r = two(box(0, 24, 0, '1 0 0 0 -1 0 0 0 -1'));
  assert.ok(r.findings.some((f) => f.kind === 'overlap' && f.blocking && f.step === 2), JSON.stringify(r.findings));
});

test('CONNECTED before a callout reference frees the callout', () => {
  const r = check({
    'model.ldr': [box(), '0 STEP', '0 !BRICKART CONNECTED', '1 4 0 -500 0 1 0 0 0 1 0 0 0 1 pair.ldr'],
    'pair.ldr': [box(0, 0), '0 STEP', box(0, -24)],
  });
  assert.ok(!r.findings.some((f) => f.blocking), JSON.stringify(r.findings));
  assert.equal(r.blocked, false);
  assert.equal(r.accepted.length, 2);
});

test('mating exemption works with outward-pointing (anti-parallel) connection data', () => {
  const ok = check({ 'model.ldr': [box(0, 0, 0, undefined, 'outward.dat'), '0 STEP', box(0, -24, 0, undefined, 'outward.dat')] });
  assert.deepEqual(ok.findings, []);
  const flipped = check({ 'model.ldr': [box(0, 0, 0, undefined, 'outward.dat'), '0 STEP', box(0, 24, 0, '1 0 0 0 -1 0 0 0 -1', 'outward.dat')] });
  assert.ok(flipped.findings.some((f) => f.kind === 'overlap' && f.blocking), JSON.stringify(flipped.findings));
});
