import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { buildInstructions } from '../../src/instructions/build.ts';
import type { GeometrySource, PartGeom } from '../../src/instructions/geometry.ts';
import { findBrowser } from '../../src/render/browser.ts';
import { ZipIndex } from '../../src/render/zip-index.ts';
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
