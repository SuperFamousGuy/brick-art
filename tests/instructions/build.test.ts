import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { addStepSizeFindings, buildInstructions, stepRows } from '../../src/instructions/build.ts';
import { parseSteps } from '../../src/instructions/steps.ts';
import type { GeometrySource, PartGeom } from '../../src/instructions/geometry.ts';
import { findBrowser } from '../../src/render/browser.ts';
import { ZipIndex } from '../../src/render/zip-index.ts';
import { planCell } from '../../src/instructions/cell-plan.ts';
import type { Finding } from '../../src/instructions/check.ts';
import { fakeModel, fakeStep, section } from '../helpers/fake-steps.ts';
import { writeLibrary } from '../helpers/ldraw-fixture.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const browser = findBrowser();
const noBrowser = browser === null ? 'no Chromium-based browser installed' : false;

const BOX: PartGeom = {
  bounds: { min: [-10, 0, -10], max: [10, 24, 10] },
  grid: [[[1]], [[1]], [[1]]],
  connections: [
    { type: 'stud', position: [0, 0, 0], direction: [0, -1, 0] },
    { type: 'stud_receptor', position: [0, 24, 0], direction: [0, -1, 0] },
  ],
};
const geometry: GeometrySource = { get: (f) => (f === 'box.dat' ? BOX : null), compatible: () => true };

const line = (color: number, x: number, y: number, z: number) => `1 ${color} ${x} ${y} ${z} 1 0 0 0 1 0 0 0 1 box.dat`;
function setup(lines: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'build-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'model.ldr'), lines.join('\n') + '\n');
  const library = ZipIndex.open(writeLibrary(dir), /^ldraw\//);
  return { dir, library, modelPath: join(dir, 'model.ldr') };
}

test('blocked model renders nothing', async () => {
  const { dir, library, modelPath } = setup([line(4, 0, 0, 0), '0 STEP', line(4, 500, -300, 500)]);
  const r = await buildInstructions({ modelPath, browser: 'unused', library, geometry });
  assert.equal(r.status, 'blocked');
  assert.equal(r.checked, true);
  assert.equal(r.pdf, null);
  assert.ok(r.findings.some((f) => f.blocking));
  assert.ok(r.steps.every((s) => s.png === null));
  assert.equal(r.totalParts, 2);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.png') || f.endsWith('.pdf')), []);
});

test('a blocked run removes a stale PDF from an earlier run', async () => {
  const { dir, library, modelPath } = setup([line(4, 0, 0, 0), '0 STEP', line(4, 500, -300, 500)]);
  const stale = join(dir, 'model-instructions.pdf');
  writeFileSync(stale, '%PDF-1.4 old');
  const r = await buildInstructions({ modelPath, browser: 'unused', library, geometry });
  assert.equal(r.status, 'blocked');
  assert.equal(existsSync(stale), false);
});

test('per-step parts count loose and callout parts once, and list inserted sections', () => {
  // main: a loose box, a 2-part callout placed twice, then a 9-part section inserted whole.
  const tower = Array.from({ length: 9 }, (_, i) => [line(1, 0, -24 * i, 0), '0 STEP']).flat();
  const { dir, library, modelPath } = setup([
    line(4, 0, 0, 0), '0 STEP',
    '1 14 0 -24 0 1 0 0 0 1 0 0 0 1 pair.ldr', '1 14 40 -24 0 1 0 0 0 1 0 0 0 1 pair.ldr', '0 STEP',
    '1 2 0 -72 0 1 0 0 0 1 0 0 0 1 tower.ldr',
  ]);
  writeFileSync(join(dir, 'pair.ldr'), [line(16, 0, 0, 0), '0 STEP', line(16, 0, -24, 0)].join('\n') + '\n');
  writeFileSync(join(dir, 'tower.ldr'), tower.join('\n') + '\n');
  const model = parseSteps(modelPath, { isLibraryPart: (f) => library.has(`parts/${f}`) || f.endsWith('.dat') });
  const rows = stepRows(model, new Map(), null);
  const sum = rows.reduce((n, r) => n + r.sectionQuantity * r.parts.reduce((m, p) => m + p.count, 0), 0);
  assert.equal(model.totalParts, 1 + 4 + 9);
  assert.equal(sum, model.totalParts);
  const callout = rows.find((r) => r.section === 'model' && r.parts.some((p) => p.color === 14))!;
  assert.deepEqual(callout.parts.map((p) => p.count), [4]);
  const insert = rows.find((r) => r.inserts.length > 0)!;
  assert.deepEqual(insert.inserts, [{ section: 'tower', quantity: 1 }]);
  assert.deepEqual(insert.parts, []);
});

test('per-step parts times section quantity equal the total for a section built twice', () => {
  const tower = Array.from({ length: 9 }, (_, i) => [line(1, 0, -24 * i, 0), '0 STEP']).flat();
  const { dir, library, modelPath } = setup([
    line(4, 0, 0, 0), '0 STEP', '1 2 0 -24 0 1 0 0 0 1 0 0 0 1 tower.ldr', '1 2 100 -24 0 1 0 0 0 1 0 0 0 1 tower.ldr',
  ]);
  writeFileSync(join(dir, 'tower.ldr'), tower.join('\n') + '\n');
  const model = parseSteps(modelPath, { isLibraryPart: (f) => library.has(`parts/${f}`) || f.endsWith('.dat') });
  const rows = stepRows(model, new Map(), null);
  assert.equal(rows.find((r) => r.section === 'tower')!.sectionQuantity, 2);
  assert.deepEqual(rows.find((r) => r.inserts.length > 0)!.inserts, [{ section: 'tower', quantity: 2 }]);
  const sum = rows.reduce((n, r) => n + r.sectionQuantity * r.parts.reduce((m, p) => m + p.count, 0), 0);
  assert.equal(sum, model.totalParts);
  assert.equal(model.totalParts, 19);
});

test('a step adding more than 8 parts warns, without the database too', () => {
  const { library, modelPath } = setup([line(4, 0, 0, 0), '0 STEP', ...Array.from({ length: 9 }, (_, i) => line(4, 0, -24 * (i + 1), 0))]);
  const model = parseSteps(modelPath, { isLibraryPart: (f) => library.has(`parts/${f}`) || f.endsWith('.dat') });
  const findings: Finding[] = [];
  addStepSizeFindings(model, findings);
  assert.deepEqual(findings.map((f) => [f.kind, f.blocking, f.step]), [['large-step', false, 2]]);
  assert.match(findings[0]!.message, /adds 9 parts \(more than 8\)/);
});

test('inserted section parts do not count toward a large step', () => {
  const tower = Array.from({ length: 9 }, (_, i) => [line(1, 0, -24 * i, 0), '0 STEP']).flat();
  const { dir, library, modelPath } = setup([line(4, 0, 0, 0), '0 STEP', '1 2 0 -24 0 1 0 0 0 1 0 0 0 1 tower.ldr', line(4, 0, -240, 0)]);
  writeFileSync(join(dir, 'tower.ldr'), tower.join('\n') + '\n');
  const model = parseSteps(modelPath, { isLibraryPart: (f) => library.has(`parts/${f}`) || f.endsWith('.dat') });
  const findings: Finding[] = [];
  addStepSizeFindings(model, findings);
  assert.deepEqual(findings, []);
});

test('no database means checked false', { skip: noBrowser, timeout: 240_000 }, async () => {
  const { library, modelPath } = setup([line(4, 0, 0, 0), '0 STEP', line(4, 0, -24, 0)]);
  const r = await buildInstructions({ modelPath, browser: browser!, library, geometry: null });
  assert.equal(r.status, 'built');
  assert.equal(r.checked, false);
  assert.ok(r.pdf && existsSync(r.pdf));
  assert.ok(r.steps.length === 2 && r.steps.every((s) => s.png !== null && existsSync(s.png)));
});

test('step parts match the model', { skip: noBrowser, timeout: 240_000 }, async () => {
  const { library, modelPath } = setup([line(4, 0, 0, 0), line(1, 40, 0, 0), '0 STEP', line(4, 0, -24, 0)]);
  const r = await buildInstructions({ modelPath, browser: browser!, library, geometry: null });
  const total = r.steps.flatMap((s) => s.parts).reduce((n, p) => n + p.count, 0);
  assert.equal(total, r.totalParts);
  assert.equal(r.steps[0]!.parts[0]!.part, 'box');
});

function crowdedStep() {
  const step = fakeStep(1, { callouts: 20 });
  for (const c of step.callouts) c.miniSteps = Array.from({ length: 6 }, () => c.miniSteps[0]!);
  return step;
}

test('a crowded step yields exactly one large-step finding', () => {
  const step = crowdedStep();
  assert.equal(planCell(step, 3).fits, false);
  const model = fakeModel([section('test', [step])]);
  const none: Finding[] = [];
  addStepSizeFindings(model, none);
  assert.equal(none.length, 1);
  assert.equal(none[0]!.kind, 'large-step');
  assert.equal(none[0]!.blocking, false);
  // One loose part and 20 one-part callouts: both reasons, in one finding.
  assert.match(none[0]!.message, /adds 21 parts \(more than 8\) and is too crowded to fit one page/);
});

test('a step that fits adds no finding', () => {
  const none: Finding[] = [];
  addStepSizeFindings(fakeModel([section('test', [fakeStep(1)])]), none);
  assert.deepEqual(none, []);
});

test('hidden loose parts are reported, hidden insert parts are not', { skip: noBrowser, timeout: 240_000 }, async () => {
  const big = (c: number, x: number, y: number, z: number, f: string) => `1 ${c} ${x} ${y} ${z} 1 0 0 0 1 0 0 0 1 ${f}`;
  // Loose: a box inside big.dat.
  const a = setup([big(4, 0, 0, 0, 'big.dat'), '0 STEP', big(1, 0, -20, 0, 'box.dat')]);
  const ra = await buildInstructions({ modelPath: a.modelPath, browser: browser!, library: a.library, geometry: null });
  const hidden = ra.findings.filter((f) => f.kind === 'unverified');
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0]!.blocking, false);
  assert.match(hidden[0]!.message, /hidden from the camera/);
  // Insert: a 9-part sub-assembly added in step 2; its part hidden inside the inserted group is not reported.
  // The box is visible in the sub-assembly's own section but sits inside the main model's big.dat.
  const sub = [big(1, 0, -20, 0, 'box.dat'), ...Array.from({ length: 8 }, (_, i) => big(4, 200 + i * 40, 0, 0, 'box.dat'))];
  const b = setup([big(4, 0, 0, 0, 'big.dat'), '0 STEP', big(4, 0, 0, 0, 'sub.ldr')]);
  writeFileSync(join(b.dir, 'sub.ldr'), sub.join('\n') + '\n');
  const rb = await buildInstructions({ modelPath: b.modelPath, browser: browser!, library: b.library, geometry: null });
  assert.deepEqual(rb.findings.filter((f) => f.kind === 'unverified'), []);
});
