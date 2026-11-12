import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CALLOUT_MAX_PARTS, DEFAULT_VIEW, parseSteps } from '../../src/instructions/steps.ts';
import { tallyModel } from '../../src/render/tally.ts';
import type { ZipIndex } from '../../src/render/zip-index.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const part = (color: number, x = 0, y = 0, z = 0, file = '3001.dat', m = '1 0 0 0 1 0 0 0 1') =>
  `1 ${color} ${x} ${y} ${z} ${m} ${file}`;
const isLibraryPart = (f: string) => f.endsWith('.dat');

function write(files: Record<string, string[]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'steps-'));
  dirs.push(dir);
  for (const [name, lines] of Object.entries(files)) writeFileSync(join(dir, name), lines.join('\n') + '\n');
  return join(dir, 'model.ldr');
}
const parse = (files: Record<string, string[]>) => parseSteps(write(files), { isLibraryPart });

test('three steps from STEP lines', () => {
  const m = parse({ 'model.ldr': [part(4), '0 STEP', part(4, 0, -24), '0 STEP', part(4, 0, -48)] });
  assert.equal(m.sections.length, 1);
  assert.deepEqual(m.sections[0]!.steps.map((s) => s.number), [1, 2, 3]);
  assert.ok(m.sections[0]!.steps.every((s) => s.loose.length === 1));
});

test('no STEP lines gives one step', () => {
  const m = parse({ 'model.ldr': [part(4), part(4, 0, -24)] });
  assert.equal(m.sections[0]!.steps.length, 1);
  assert.equal(m.sections[0]!.steps[0]!.added.length, 2);
});

test('empty steps are dropped', () => {
  const m = parse({ 'model.ldr': [part(4), '0 STEP', '0 STEP', part(4, 0, -24), '0 STEP'] });
  assert.deepEqual(m.sections[0]!.steps.map((s) => s.number), [1, 2]);
});

test('step text and accepted flag', () => {
  const m = parse({ 'model.ldr': ['0 // put the red brick on top', '0 !BRICKART CONNECTED', part(4), part(4, 0, -24)] });
  const step = m.sections[0]!.steps[0]!;
  assert.equal(step.text, 'put the red brick on top');
  assert.equal(step.added[0]!.accepted, true);
  assert.equal(step.added[1]!.accepted, false);
  assert.deepEqual(step.added[0]!.source, { file: 'model.ldr', line: 3 });
});

const wheel = ['0 wheel', part(0, 0, 0, 0, '3001.dat'), part(0, 0, -24, 0, '3001.dat')];

test('small submodel becomes a callout with world transform', () => {
  const m = parse({ 'model.ldr': [part(4, 40, 0, 0, 'wheel.ldr'), part(4, -40, 0, 0, 'wheel.ldr')], 'wheel.ldr': wheel });
  const step = m.sections[0]!.steps[0]!;
  assert.equal(step.callouts.length, 1);
  const c = step.callouts[0]!;
  assert.equal(c.quantity, 2);
  assert.deepEqual(c.attach, [[40, 0, 0], [-40, 0, 0]]);
  assert.equal(c.instances[0]![0]!.pos[0], 40);
  assert.equal(c.miniSteps.flat().length, 2);
  assert.equal(step.loose.length, 0);
  assert.equal(step.added.length, 4);
});

test('callout quantity is per step', () => {
  const m = parse({
    'model.ldr': [part(4, 0, 0, 0, 'wheel.ldr'), '0 STEP', part(4, 40, 0, 0, 'wheel.ldr'), part(4, -40, 0, 0, 'wheel.ldr')],
    'wheel.ldr': wheel,
  });
  const steps = m.sections[0]!.steps;
  assert.deepEqual(steps.map((s) => s.callouts[0]!.quantity), [1, 2]);
  assert.equal(m.parts.find((p) => p.part === '3001')!.count, 6);
});

test('large submodel becomes its own section first', () => {
  const hull = ['0 hull', ...Array.from({ length: CALLOUT_MAX_PARTS + 1 }, (_, i) => part(7, i * 20)), '0 STEP', part(7, 0, -24)];
  const m = parse({ 'model.ldr': [part(4, 0, 0, 0, 'hull.ldr'), '0 STEP', part(4, 0, -24)], 'hull.ldr': hull });
  assert.deepEqual(m.sections.map((s) => s.id), ['hull', 'model']);
  assert.equal(m.sections[1]!.steps[0]!.inserts[0]!.sectionId, 'hull');
  assert.equal(m.sections[0]!.quantity, 1);
  assert.deepEqual(m.sections.flatMap((s) => s.steps.map((st) => st.number)), [1, 2, 3, 4]);
});

test('section quantity counts every instance', () => {
  const hull = Array.from({ length: CALLOUT_MAX_PARTS + 1 }, (_, i) => part(7, i * 20));
  const m = parse({ 'model.ldr': [part(4, 0, 0, 0, 'hull.ldr'), part(4, 200, 0, 0, 'Hull.ldr')], 'hull.ldr': hull });
  assert.equal(m.sections[0]!.quantity, 2);
  assert.equal(m.sections[1]!.steps[0]!.inserts[0]!.quantity, 2);
});

test('one file in two colours gets one section per colour', () => {
  const hull = ['0 hull', part(16), ...Array.from({ length: CALLOUT_MAX_PARTS }, (_, i) => part(7, 20 + i * 20))];
  const m = parse({ 'model.ldr': [part(4, 0, 0, 0, 'hull.ldr'), '0 STEP', part(1, 100, 0, 0, 'hull.ldr')], 'hull.ldr': hull });
  assert.deepEqual(m.sections.map((s) => s.id), ['hull-4', 'hull-1', 'model']);
  assert.deepEqual(m.sections.map((s) => s.quantity), [1, 1, 1]);
  assert.deepEqual(m.sections.slice(0, 2).map((s) => s.steps[0]!.added[0]!.color), [4, 1]);
  assert.deepEqual(m.sections[2]!.steps.map((s) => s.inserts[0]!.sectionId), ['hull-4', 'hull-1']);
});

test('nested large sections multiply quantity and order inner first', () => {
  const inner = Array.from({ length: CALLOUT_MAX_PARTS + 1 }, (_, i) => part(7, i * 20));
  const outer = [part(7, 0, 0, 0, 'inner.ldr'), part(7, 0, -24, 0, 'inner.ldr'), part(7, 0, -48, 0, 'inner.ldr')];
  const m = parse({
    'model.ldr': [part(4, 0, 0, 0, 'outer.ldr'), part(4, 200, 0, 0, 'outer.ldr')],
    'outer.ldr': outer, 'inner.ldr': inner,
  });
  assert.deepEqual(m.sections.map((s) => s.id), ['inner', 'outer', 'model']);
  assert.deepEqual(m.sections.map((s) => s.quantity), [6, 2, 1]);
});

test('color 16 inherits through callouts and sections', () => {
  const inner = ['0 inner', part(16)];
  const big = Array.from({ length: CALLOUT_MAX_PARTS + 1 }, (_, i) => part(16, i * 20));
  const m = parse({
    'model.ldr': [part(4, 0, 0, 0, 'inner.ldr'), part(4, 0, 0, 0, 'big.ldr')],
    'inner.ldr': inner, 'big.ldr': big,
  });
  const colors = m.sections.flatMap((s) => s.steps.flatMap((st) => st.added.map((p) => p.color)));
  assert.ok(colors.length > 0 && colors.every((c) => c === 4));
  assert.ok(m.parts.every((p) => p.color === 4));
});

test('ROTSTEP sets the view', () => {
  const m = parse({
    'model.ldr': [part(4), '0 ROTSTEP 0 180 0 ABS', part(4, 0, -24), '0 ROTSTEP END', part(4, 0, -48)],
  });
  const [a, b, c] = m.sections[0]!.steps;
  assert.deepEqual(a!.view, DEFAULT_VIEW);
  assert.equal(a!.rotated, false);
  assert.deepEqual(b!.view, { yaw: 145, pitch: 30 });
  assert.equal(b!.rotated, true);
  assert.deepEqual(c!.view, DEFAULT_VIEW);
  assert.equal(c!.rotated, true);
});

test('ROTSTEP REL adds to the current view', () => {
  const m = parse({ 'model.ldr': [part(4), '0 ROTSTEP 10 20 0 REL', part(4), '0 ROTSTEP 10 20 0 ADD', part(4)] });
  assert.deepEqual(m.sections[0]!.steps.map((s) => s.view.yaw), [-35, -15, 5]);
});

test('rotated parent rotates child', () => {
  const child = ['0 child', part(0, 20, 0, 0)];
  const m = parse({
    'model.ldr': [part(4, 0, 0, 0, 'child.ldr', '0 0 1 0 1 0 -1 0 0')],
    'child.ldr': child,
  });
  const p = m.sections[0]!.steps[0]!.added[0]!;
  assert.deepEqual(p.pos.map((v) => v + 0), [0, 0, -20]);
});

test('nesting that loops throws', () => {
  assert.throws(() => parse({ 'model.ldr': [part(4, 0, 0, 0, 'model.ldr')] }), /too deep/);
});

test('parts matches tallyModel', () => {
  const hull = Array.from({ length: CALLOUT_MAX_PARTS + 1 }, (_, i) => part(16, i * 20, 0, 0, i % 2 ? '3001.dat' : '3003.dat'));
  const path = write({
    'model.ldr': [part(4, 0, 0, 0, 'hull.ldr'), part(1, 0, 0, 0, 'wheel.ldr'), part(2, 0, 0, 0, '3020.dat')],
    'hull.ldr': hull, 'wheel.ldr': wheel,
  });
  const dir = path.slice(0, path.lastIndexOf('/'));
  const local = new Map(readdirSync(dir).map((f) => [f, join(dir, f)]));
  const fakeLibrary = { has: (p: string) => p.endsWith('.dat') } as unknown as ZipIndex;
  const tally = tallyModel(readFileSync(path, 'utf8'), local, fakeLibrary, new Map());
  const m = parseSteps(path, { isLibraryPart });
  assert.deepEqual(m.parts, tally.map(({ part: p, color, count }) => ({ part: p, color, count })));
  assert.equal(m.totalParts, tally.reduce((a, r) => a + r.count, 0));
});
