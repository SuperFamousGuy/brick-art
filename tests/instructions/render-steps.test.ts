import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parseSteps, type Placement } from '../../src/instructions/steps.ts';
import { flattenLdr, planShots, renderShots } from '../../src/instructions/render-steps.ts';
import { findBrowser } from '../../src/render/browser.ts';
import { ZipIndex } from '../../src/render/zip-index.ts';
import { writeLibrary } from '../helpers/ldraw-fixture.ts';

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const browser = findBrowser();
const noBrowser = browser === null ? 'no Chromium-based browser installed' : false;
const PNG_SIGNATURE = '89504e470d0a1a0a';
const SIZES = { step: [320, 240] as [number, number], mini: [160, 120] as [number, number], icon: [80, 80] as [number, number] };

const line = (color: number, x: number, y: number, z: number, file: string) => `1 ${color} ${x} ${y} ${z} 1 0 0 0 1 0 0 0 1 ${file}`;

function write(files: Record<string, string[]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'render-steps-'));
  dirs.push(dir);
  for (const [name, lines] of Object.entries(files)) writeFileSync(join(dir, name), lines.join('\n') + '\n');
  return dir;
}
const parse = (dir: string) => parseSteps(join(dir, 'model.ldr'), { isLibraryPart: (f) => f.endsWith('.dat') });

const placement = (part: string, color: number, pos: Placement['pos'], rot: Placement['rot']): Placement => ({
  part, color, pos, rot, source: { file: 'model.ldr', line: 1 }, accepted: false,
});

test('flattenLdr writes world lines in order', () => {
  const text = flattenLdr([
    placement('3001.dat', 4, [10, -24, 0.5], [1, 0, 0, 0, 1, 0, 0, 0, 1]),
    placement('3023.dat', 1, [-20, 0, 40], [0, 0, 1, 0, 1, 0, -1, 0, 6.123e-17]),
  ]);
  assert.deepEqual(text.trim().split('\n').filter((l) => l.startsWith('1 ')), [
    '1 4 10 -24 0.5 1 0 0 0 1 0 0 0 1 3001.dat',
    '1 1 -20 0 40 0 0 1 0 1 0 -1 0 0 3023.dat',
  ]);
});

test('planShots frames the whole section', () => {
  const dir = write({ 'model.ldr': [line(4, 0, 0, 0, 'box.dat'), '0 STEP', line(4, 0, -20, 0, 'box.dat'), '0 STEP', line(4, 0, -40, 0, 'box.dat')] });
  const { models, shots } = planShots(parse(dir), SIZES);
  const steps = shots.filter((s) => s.name.startsWith('step-'));
  assert.deepEqual(steps.map((s) => s.name), ['step-01', 'step-02', 'step-03']);
  assert.ok(steps.every((s) => s.frame[0] === 0 && s.frame[1] === 3));
  assert.deepEqual(steps.map((s) => s.visible), [[0, 1], [0, 2], [0, 3]]);
  assert.deepEqual(steps.map((s) => s.watch), [[0, 1], [1, 2], [2, 3]]);
  assert.ok(models.has(steps[0]!.model));
  assert.ok(steps.every((s) => s.width === 320 && s.height === 240));
});

test('planShots makes one icon per part and color', () => {
  const dir = write({ 'model.ldr': [line(4, 0, 0, 0, 'box.dat'), line(1, 0, -20, 0, 'box.dat'), line(4, 0, -40, 0, 'box.dat')] });
  const { shots } = planShots(parse(dir), SIZES);
  const icons = shots.filter((s) => s.name.startsWith('part-')).map((s) => s.name).sort();
  assert.deepEqual(icons, ['part-box-1', 'part-box-4']);
});

test('planShots names callout mini-steps and pads step numbers to 3 digits from 100 steps', () => {
  const many = Array.from({ length: 100 }, (_, i) => [line(4, 0, -20 * i, 0, 'box.dat'), '0 STEP']).flat();
  const dir = write({
    'model.ldr': [line(4, 0, 0, 0, 'pair.ldr'), '0 STEP', ...many],
    'pair.ldr': [line(16, 0, 0, 0, 'box.dat'), '0 STEP', line(16, 20, 0, 0, 'box.dat')],
  });
  const { shots } = planShots(parse(dir), SIZES);
  const names = shots.map((s) => s.name);
  assert.ok(names.includes('step-001') && names.includes('step-101'));
  assert.ok(names.includes('callout-001-1-1') && names.includes('callout-001-1-2'));
  const step1 = shots.find((s) => s.name === 'step-001')!;
  assert.deepEqual(step1.marks, [[0, 0, 0]]);
});

test('renderShots writes step PNGs and attach marks', { skip: noBrowser, timeout: 180_000 }, async () => {
  const dir = write({
    'model.ldr': [line(4, 0, 0, 0, 'box.dat'), '0 STEP', line(14, 0, -20, 0, 'pair.ldr')],
    'pair.ldr': [line(16, 0, 0, 0, 'box.dat'), '0 STEP', line(1, 20, 0, 0, 'box.dat')],
  });
  const library = ZipIndex.open(writeLibrary(dir), /^ldraw\//);
  try {
    const outDir = join(dir, 'out');
    const results = await renderShots({
      model: parse(dir), outDir, stem: 'model', browser: browser!, library, modelDir: dir, sizes: SIZES,
    });
    for (const n of ['01', '02']) {
      const png = readFileSync(join(outDir, `model-step-${n}.png`));
      assert.equal(png.subarray(0, 8).toString('hex'), PNG_SIGNATURE);
      assert.equal(png.readUInt32BE(16), 640); // pixel ratio 2
      assert.equal(png.readUInt32BE(20), 480);
    }
    const step2 = results.get('step-02')!;
    assert.equal(step2.png, join(outDir, 'model-step-02.png'));
    assert.equal(step2.marks.length, 1);
    const [x, y] = step2.marks[0]!;
    assert.ok(x >= 0 && x <= 640 && y >= 0 && y <= 480, `mark ${x},${y} is inside the image`);
    assert.deepEqual(step2.hiddenParts, []);
    for (const name of ['callout-02-1-1', 'callout-02-1-2', 'part-box-1', 'part-box-4', 'part-box-14']) {
      const r = results.get(name)!;
      assert.equal(r.png, join(outDir, '.model-instructions', `${name}.png`));
      assert.ok(existsSync(r.png), name);
    }
  } finally {
    library.close();
  }
});

test('renderShots reports a hidden new part', { skip: noBrowser, timeout: 180_000 }, async () => {
  const dir = write({ 'model.ldr': [line(4, 0, 0, 0, 'big.dat'), '0 STEP', line(1, 0, -20, 0, 'box.dat')] });
  const library = ZipIndex.open(writeLibrary(dir), /^ldraw\//);
  try {
    const results = await renderShots({
      model: parse(dir), outDir: join(dir, 'out'), stem: 'model', browser: browser!, library, modelDir: dir, sizes: SIZES,
    });
    assert.deepEqual(results.get('step-01')!.hiddenParts, []);
    assert.equal(results.get('step-02')!.hiddenParts.length, 1);
  } finally {
    library.close();
  }
});

test('renderShots reports a part missing from the library', { skip: noBrowser, timeout: 180_000 }, async () => {
  const dir = write({ 'model.ldr': [line(4, 0, 0, 0, 'box.dat'), line(4, 0, -20, 0, 'nosuchpart.dat')] });
  const library = ZipIndex.open(writeLibrary(dir), /^ldraw\//);
  try {
    await assert.rejects(
      renderShots({ model: parse(dir), outDir: join(dir, 'out'), stem: 'model', browser: browser!, library, modelDir: dir, sizes: SIZES, timeoutMs: 60_000 }),
      /nosuchpart\.dat/,
    );
  } finally {
    library.close();
  }
});

test('renderShots fails when a placement does not load as its own part', { skip: noBrowser, timeout: 180_000 }, async () => {
  // LDrawLoader merges a primitive into its parent instead of adding a child, so the child count can match while the mapping is wrong.
  const dir = write({
    'model.ldr': [line(4, 0, 0, 0, 'box.dat'), line(4, 0, -20, 0, 'prim.dat')],
    'prim.dat': ['0 Test primitive', '0 !LDRAW_ORG Primitive', '3 16 0 0 0 10 0 0 0 0 10'],
  });
  const library = ZipIndex.open(writeLibrary(dir), /^ldraw\//);
  try {
    await assert.rejects(
      renderShots({ model: parse(dir), outDir: join(dir, 'out'), stem: 'model', browser: browser!, library, modelDir: dir, sizes: SIZES, timeoutMs: 60_000 }),
      /2 loaded objects for 2 placed parts; not loaded as a part: prim\.dat/,
    );
  } finally {
    library.close();
  }
});
