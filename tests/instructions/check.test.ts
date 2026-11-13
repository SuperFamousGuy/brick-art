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
// Centred axial mate, like LDCad center=true snaps: each connection point sits on its part's own midplane.
const HOLED: PartGeom = { ...BOX, connections: [{ type: 'pin_hole', position: [0, 10, 0], direction: [0, 0, -1] }] };
const PIN: PartGeom = {
  bounds: { min: [-4, -4, -20], max: [4, 4, 20] },
  grid: [[[1], [1]]],
  connections: [{ type: 'pin', position: [0, 0, 0], direction: [0, 0, 1] }],
};
// A beam with a hole on its middle plane, and a pin whose connection point sits at its own middle,
// so a seated pin's point is 10 LDU along the axis from the hole's.
const BEAM: PartGeom = {
  bounds: { min: [-10, -10, -10], max: [10, 10, 10] }, grid: null,
  connections: [{ type: 'pin_hole', position: [0, 0, 0], direction: [0, 0, 1] }],
};
const LONGPIN: PartGeom = {
  bounds: { min: [-6, -6, -20], max: [6, 6, 20] }, grid: null,
  connections: [{ type: 'pin', position: [0, 0, 0], direction: [0, 0, 1] }],
};
// An 8-stud axle whose single connection point sits at its middle and slides 80 LDU each way.
const AXLE8: PartGeom = {
  bounds: { min: [-3, -3, -80], max: [3, 3, 80] }, grid: null,
  connections: [{ type: 'pin', position: [0, 0, 0], direction: [0, 0, 1], span: 80 }],
};
// Two receptors 100 LDU apart, to bridge two separate studs.
const BRIDGE: PartGeom = {
  bounds: { min: [-10, 0, -10], max: [110, 24, 10] }, grid: null,
  connections: [
    { type: 'stud_receptor', position: [0, 24, 0], direction: [0, -1, 0] },
    { type: 'stud_receptor', position: [100, 24, 0], direction: [0, -1, 0] },
  ],
};
const PARTS: Record<string, PartGeom> = {
  'box.dat': BOX, 'studded.dat': STUDDED, 'blob.dat': BLOB, 'outward.dat': OUTWARD, 'holed.dat': HOLED, 'pin.dat': PIN,
  'beam.dat': BEAM, 'longpin.dat': LONGPIN, 'bridge.dat': BRIDGE, 'axle8.dat': AXLE8,
};
const MATES = new Set(['stud|stud_receptor', 'stud_receptor|stud', 'pin|pin_hole', 'pin_hole|pin']);
const geom: GeometrySource = {
  get: (f) => PARTS[f] ?? null,
  compatible: (a, b) => MATES.has(`${a}|${b}`),
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
  assert.match(f.message, /never joins the finished model/);
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

test('the check leaves step size to the booklet builder', () => {
  const r = check({ 'model.ldr': [box(), '0 STEP', ...Array.from({ length: 9 }, (_, i) => box(0, -24 * (i + 1)))] });
  assert.deepEqual(r.findings, []);
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

test('a centred axial mate (pin in a hole) is exempt from overlap', () => {
  const r = check({ 'model.ldr': [box(0, 0, 0, undefined, 'holed.dat'), '0 STEP', box(0, 10, 0, undefined, 'pin.dat')] });
  assert.ok(!r.findings.some((f) => f.blocking), JSON.stringify(r.findings));
  assert.deepEqual(r.findings, []);
});

test('a part without connection data far from the model is floating', () => {
  const r = check({ 'model.ldr': [box(), '0 STEP', box(0, -300, 0, undefined, 'blob.dat')] });
  assert.deepEqual(r.findings.map((f) => [f.kind, f.blocking, f.part]), [['floating', true, 'blob.dat']]);
  assert.equal(r.blocked, true);
});

test('a part without connection data touching the model is unverified', () => {
  const r = check({ 'model.ldr': [box(), '0 STEP', box(0, -24, 0, undefined, 'blob.dat')] });
  assert.deepEqual(r.findings.map((f) => [f.kind, f.blocking]), [['unverified', false]]);
  assert.match(r.findings[0]!.message, /no connection data but touches box\.dat/);
  assert.equal(r.blocked, false);
});

test('accepted members do not free a callout far from the model', () => {
  const r = check({
    'model.ldr': [box(), '0 STEP', '1 4 300 0 0 1 0 0 0 1 0 0 0 1 pair.ldr'],
    'pair.ldr': ['0 !BRICKART CONNECTED', box(0, 0), '0 STEP', '0 !BRICKART CONNECTED', box(0, -24)],
  });
  const floating = r.findings.filter((f) => f.kind === 'floating');
  assert.equal(floating.length, 1, JSON.stringify(r.findings));
  assert.equal(floating[0]!.blocking, true);
  assert.equal(floating[0]!.step, 2);
  assert.match(floating[0]!.message, /2 parts \(in callout pair\.ldr\) do not connect/);
  assert.equal(r.blocked, true);
});

test('a pin seated in a hole with its point 10 LDU along the axis connects without overlap', () => {
  const r = check({ 'model.ldr': [box(0, 0, 0, undefined, 'beam.dat'), '0 STEP', box(0, 0, 10, undefined, 'longpin.dat')] });
  assert.deepEqual(r.findings, []);
});

test('a pin 1 LDU off the hole axis does not connect', () => {
  const r = check({ 'model.ldr': [box(0, 0, 0, undefined, 'beam.dat'), '0 STEP', box(1, 0, 10, undefined, 'longpin.dat')] });
  assert.ok(r.findings.some((f) => f.kind === 'floating' && f.blocking), JSON.stringify(r.findings));
  assert.equal(r.blocked, true);
});

test('a pin more than one stud along the hole axis does not connect', () => {
  const r = check({ 'model.ldr': [box(0, 0, 0, undefined, 'beam.dat'), '0 STEP', box(0, 0, 30, undefined, 'longpin.dat')] });
  assert.ok(r.findings.some((f) => f.kind === 'floating'), JSON.stringify(r.findings));
});

test('floating parts that join each other are one finding naming the step they join in', () => {
  const r = check({ 'model.ldr': [box(), box(100, 0), box(100, 24), '0 STEP', box(0, -24, 0, undefined, 'bridge.dat')] });
  assert.equal(r.findings.length, 1, JSON.stringify(r.findings));
  const f = r.findings[0]!;
  assert.equal(f.kind, 'floating');
  assert.equal(f.blocking, true);
  assert.equal(f.step, 1);
  assert.deepEqual(f.pos, [100, 0, 0]);
  assert.match(f.message, /^Step 1: 2 parts do not connect to the model: box\.dat \(color 4\) at \(100, 0, 0\), box\.dat \(color 4\) at \(100, 24, 0\)/);
  assert.match(f.message, /first joins the model in step 2 via bridge\.dat \(color 4\) at \(0, -24, 0\)/);
});

test('separate floating parts in one step are separate findings', () => {
  const r = check({ 'model.ldr': [box(), '0 STEP', box(0, -300), box(300, 0)] });
  assert.deepEqual(r.findings.map((f) => [f.kind, f.step]), [['floating', 2], ['floating', 2]]);
  assert.ok(r.findings.every((f) => /^Step 2: 1 part does not connect/.test(f.message)));
});

test('a floating cluster lists at most five parts', () => {
  const column = Array.from({ length: 7 }, (_, i) => box(300, -24 * i));
  const r = check({ 'model.ldr': [box(), '0 STEP', ...column] });
  assert.equal(r.findings.length, 1, JSON.stringify(r.findings));
  assert.match(r.findings[0]!.message, /^Step 2: 7 parts do not connect/);
  assert.match(r.findings[0]!.message, /, and 2 more; this group never joins the finished model\.$/);
});

test('a hole far along a sliding axle connects, in either placement order', () => {
  const beamOnAxle = check({ 'model.ldr': [box(0, 0, 0, undefined, 'axle8.dat'), '0 STEP', box(0, 0, 60, undefined, 'beam.dat')] });
  assert.deepEqual(beamOnAxle.findings, []);
  const axleInBeam = check({ 'model.ldr': [box(0, 0, 60, undefined, 'beam.dat'), '0 STEP', box(0, 0, 0, undefined, 'axle8.dat')] });
  assert.deepEqual(axleInBeam.findings, []);
});

test('a hole past the end of a sliding axle does not connect', () => {
  const r = check({ 'model.ldr': [box(0, 0, 0, undefined, 'axle8.dat'), '0 STEP', box(0, 0, 100, undefined, 'beam.dat')] });
  assert.ok(r.findings.some((f) => f.kind === 'floating' && f.blocking), JSON.stringify(r.findings));
});

test('a part that never joins its section says so for the sub-assembly, not the model', () => {
  const hull = ['0 hull', ...Array.from({ length: 9 }, (_, i) => box(0, -24 * i)), '0 STEP', box(0, -500)];
  const r = check({ 'model.ldr': [box(0, 0, 0, undefined, 'hull.ldr')], 'hull.ldr': hull });
  const f = r.findings.find((x) => x.kind === 'floating')!;
  assert.ok(f, JSON.stringify(r.findings));
  assert.match(f.message, /do not connect to sub-assembly hull|does not connect to sub-assembly hull/);
  assert.match(f.message, /never joins the finished sub-assembly hull\.$/);
});

test('a callout part that never joins says so for the callout', () => {
  const r = check({ 'model.ldr': [box(), '0 STEP', box(0, -24, 0, undefined, 'pair.ldr')], 'pair.ldr': ['0 pair', box(), '0 STEP', box(0, -500)] });
  const f = r.findings.find((x) => /mini-step/.test(x.message) || /callout pair\.ldr;|finished callout/.test(x.message));
  assert.ok(f, JSON.stringify(r.findings));
  assert.match(f!.message, /never joins the finished callout pair\.ldr\.$/);
});
