import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { bookletHtml } from '../../src/instructions/booklet-html.ts';
import { planCell } from '../../src/instructions/cell-plan.ts';
import { layoutBooklet } from '../../src/instructions/layout.ts';
import { calloutShotName, iconShotName, stepDigits, stepShotName, type ShotResult } from '../../src/instructions/render-steps.ts';
import type { StepModel } from '../../src/instructions/steps.ts';
import { findBrowser } from '../../src/render/browser.ts';
import { printToPdf } from '../../src/render/pdf.ts';
import { fakeModel, fakeStep, section } from '../helpers/fake-steps.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const browser = findBrowser();
const noBrowser = browser === null ? 'no Chromium-based browser installed' : false;

function shotsFor(model: StepModel): Map<string, ShotResult> {
  const shots = new Map<string, ShotResult>();
  const add = (name: string, marks: [number, number][] = []) => shots.set(name, { name, png: `/tmp/x/${name}.png`, marks, hiddenParts: [] });
  const digits = stepDigits(model);
  for (const s of model.sections) {
    for (const step of s.steps) {
      add(stepShotName(step.number, digits), step.callouts.flatMap((c) => c.attach.map((): [number, number] => [700, 500])));
      step.callouts.forEach((c, ci) => c.miniSteps.forEach((_, mi) => add(calloutShotName(step.number, digits, ci + 1, mi + 1))));
    }
  }
  for (const p of model.parts) add(iconShotName(p.part, p.color));
  return shots;
}
const names = new Map([[4, 'Red <b>']]);
const build = (model: StepModel, checked = true) =>
  bookletHtml({ model, pages: layoutBooklet(model), shots: shotsFor(model), checked, colorNames: names });

test('bookletHtml has every step number and no step text', () => {
  const steps = Array.from({ length: 8 }, (_, i) => fakeStep(i + 1, { callouts: i === 2 ? 1 : 0 }));
  steps[0]!.text = 'secret instruction';
  const model = fakeModel([section('test', steps)]);
  const html = build(model);
  for (let n = 1; n <= 8; n++) assert.ok(html.includes(`>${n}<`), `step ${n}`);
  assert.ok(!html.includes('0 //'));
  assert.ok(!html.includes('secret instruction'));
  assert.ok(!/lego/i.test(html));
});

test('connections not checked appears only when unchecked', () => {
  const model = fakeModel([section('test', [fakeStep(1)])]);
  assert.ok(!build(model, true).includes('connections not checked'));
  assert.ok(build(model, false).includes('connections not checked'));
});

test('bookletHtml escapes model text and colour names', () => {
  const model = fakeModel([section('test', [fakeStep(1)])]);
  model.title = '<script>alert(1)</script>';
  const html = build(model);
  assert.ok(!html.includes('<script>alert'));
  assert.ok(!html.includes('Red <b>'));
  assert.ok(html.includes('Red &lt;b&gt;'));
});

test('parts page totals match the model', () => {
  const model = fakeModel([section('test', [fakeStep(1)])], 30);
  model.parts.forEach((p, i) => { p.count = i + 2; });
  model.totalParts = model.parts.reduce((n, p) => n + p.count, 0);
  const html = build(model);
  const pagesHtml = html.split('<section').filter((s) => s.includes('class="page parts"'));
  assert.equal(pagesHtml.length, 2);
  const sum = pagesHtml.join('').match(/class="qty">(\d+)x</g)!.reduce((n, m) => n + Number(/(\d+)x/.exec(m)![1]), 0);
  assert.equal(sum, model.totalParts);
});

test('callouts get an arrow to the attach mark and an Nx label', () => {
  const step = fakeStep(1, { callouts: 1 });
  step.callouts[0]!.quantity = 2;
  const html = build(fakeModel([section('test', [step])]));
  assert.match(html, /<line [^>]*class="arrow"/);
  assert.ok(html.includes('>2x<'));
});

test('printToPdf writes a PDF', { skip: noBrowser, timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdf-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'a.html'), '<!doctype html><title>t</title><p>hello');
  await printToPdf({ htmlPath: join(dir, 'a.html'), pdfPath: join(dir, 'a.pdf'), browser: browser! });
  assert.equal(readFileSync(join(dir, 'a.pdf')).subarray(0, 4).toString(), '%PDF');
});

function crowdedStep(callouts = 4) {
  const step = fakeStep(1, { callouts, loose: 10 });
  step.loose.forEach((p, i) => { p.part = `300${i}.dat`; });
  for (const c of step.callouts) c.miniSteps = Array.from({ length: 4 }, () => c.miniSteps[0]!);
  return step;
}

test('a step too tall for a column gets two columns and its content fits the cell', () => {
  const step = crowdedStep();
  assert.equal(planCell(step, 2).fits, false);
  const plan = planCell(step, 4);
  assert.ok(plan.fits);
  for (const b of plan.boxes) assert.ok(b.y + b.h <= plan.h && b.x + b.w <= plan.w);
  const model = fakeModel([section('test', [step])]);
  assert.match(build(model), /grid-column:1 \/ span 2;[^"]*width:6\.75in;height:7\.7in/);
});

test('a crowded step gets a whole page and its content fits the cell', () => {
  const step = crowdedStep(9);
  assert.equal(planCell(step, 4).fits, false);
  const model = fakeModel([section('test', [step, fakeStep(2)])]);
  const pages = layoutBooklet(model).filter((p) => p.kind === 'steps');
  assert.deepEqual(pages.map((p) => p.cells!.map((c) => [c.step, c.span])), [[[1, 3]], [[2, 1]]]);
  const plan = planCell(step, 3);
  assert.ok(plan.fits);
  assert.ok(plan.bottom + 0.1 <= plan.h);
  for (const b of plan.boxes) assert.ok(b.y + b.h <= plan.h && b.x + b.w <= plan.w);
  const html = build(model);
  assert.match(html, /grid-column:1 \/ span 3;[^"]*width:10\.2in;height:7\.7in/);
});

test('a one-callout step still fits a column', () => {
  const step = fakeStep(1, { callouts: 1 });
  const plan = planCell(step, 2);
  assert.ok(plan.fits && plan.bottom + 0.1 <= plan.h);
  assert.equal(layoutBooklet(fakeModel([section('test', [step])]))[1]!.cells![0]!.span, 2);
});

test('a callout box has a parts strip with icons and counts for one instance', () => {
  const step = fakeStep(1, { callouts: 1 });
  const c = step.callouts[0]!;
  const p = c.instances[0]![0]!;
  c.instances = [[p, { ...p }, { ...p, part: '3002.dat', color: 1 }]];
  c.quantity = 2;
  const model = fakeModel([section('test', [step])]);
  model.parts = [{ part: '3001', color: 4, count: 4 }, { part: '3002', color: 1, count: 2 }];
  const plan = planCell(step, 2);
  const b = plan.boxes[0]!;
  assert.deepEqual(b.groups.map((g) => [g.part, g.color, g.count]), [['3001.dat', 4, 2], ['3002.dat', 1, 1]]);
  assert.ok(b.strip > 0);
  // The strip adds to the box height, so the box still fits the cell.
  assert.ok(b.y + b.h <= plan.h && plan.fits);
  const html = build(model);
  const strip = /<div class="strip"[^>]*>(.*?)<\/div><div class="mini"/.exec(html)?.[1] ?? '';
  assert.ok(strip.includes(`${iconShotName('3001', 4)}.png`) && strip.includes(`${iconShotName('3002', 1)}.png`), strip);
  assert.ok(strip.includes('>2x<') && strip.includes('>1x<'), strip);
});

test('an attach mark outside the picture is clamped to its edge', () => {
  const step = fakeStep(1, { callouts: 1 });
  const model = fakeModel([section('test', [step])]);
  const shots = shotsFor(model);
  const name = stepShotName(1, stepDigits(model));
  shots.set(name, { ...shots.get(name)!, marks: [[99999, -500]] });
  const html = bookletHtml({ model, pages: layoutBooklet(model), shots, checked: true, colorNames: names });
  const m = /<line class="arrow" x1="[^"]+" y1="[^"]+" x2="([^"]+)" y2="([^"]+)"/.exec(html)!;
  const im = planCell(step, 2).img;
  const [x2, y2] = [Number(m[1]), Number(m[2])];
  assert.ok(x2 <= im.x + im.w + 1e-6 && x2 >= im.x, `x2 ${x2}`);
  assert.ok(y2 >= im.y - 1e-6 && y2 <= im.y + im.h, `y2 ${y2}`);
});
