import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cameraLines, worldBounds } from '../../src/leocad/cameras.ts';
import type { GeometrySource } from '../../src/instructions/geometry.ts';
import type { Placement } from '../../src/instructions/steps.ts';
import type { Bounds } from '../../src/types.ts';

const geom = (b: Bounds | null): GeometrySource => ({
  get: () => (b ? { bounds: b, grid: null, connections: null } : null),
  compatible: () => false,
});
const part = (pos: [number, number, number], rot: Placement['rot']): Placement => ({
  part: '3001.dat', color: 4, pos, rot, source: { file: 'm.ldr', line: 1 }, accepted: false,
});
const I: Placement['rot'] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

test('worldBounds transforms part bounds', () => {
  const g = geom({ min: [-10, -4, -10], max: [10, 24, 10] });
  const rotY90: Placement['rot'] = [0, 0, 1, 0, 1, 0, -1, 0, 0];
  const b = worldBounds([part([100, 0, 0], rotY90)], g);
  assert.deepEqual(b, { min: [90, -4, -10], max: [110, 24, 10] });
});

test('worldBounds falls back for unknown parts', () => {
  const b = worldBounds([part([0, 0, 0], I)], geom(null));
  assert.deepEqual(b, { min: [-10, -12, -10], max: [10, 12, 10] });
});

const box: Bounds = { min: [-50, -50, -50], max: [50, 50, 50] };

test('cameraLines writes two named cameras', () => {
  const lines = cameraLines({ min: [0, 0, 0], max: [20, 40, 60] });
  assert.equal(lines.length, 2);
  for (const [i, name] of ['Front', 'Three-quarter'].entries()) {
    assert.match(
      lines[i],
      new RegExp(`^0 !LEOCAD CAMERA FOV 30 POSITION \\S+ \\S+ \\S+ TARGET_POSITION \\S+ \\S+ \\S+ UP_VECTOR 0 -1 0 NAME ${name}$`),
    );
    assert.match(lines[i], /TARGET_POSITION 10 20 30 /);
  }
  assert.ok(!lines.join('').includes('-0 '));
});

test('front camera looks from -z', () => {
  const [front] = cameraLines(box);
  const m = front.match(/POSITION (\S+) (\S+) (\S+) TARGET/)!;
  const [x, y, z] = [Number(m[1]), Number(m[2]), Number(m[3])];
  assert.ok(Math.abs(x) < 1e-6);
  assert.ok(y < 0);
  assert.ok(z < 0);
  const radius = Math.hypot(100, 100, 100) / 2;
  assert.ok(Math.hypot(x, y, z) >= radius / Math.sin((15 * Math.PI) / 180) - 0.05);
});
