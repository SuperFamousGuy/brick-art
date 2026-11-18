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
  const g = geom({ min: [-10, -4, -10], max: [30, 24, 10] });
  const rotY90: Placement['rot'] = [0, 0, 1, 0, 1, 0, -1, 0, 0];
  // x' = z, z' = -x: local x [-10, 30] becomes world z [-30, 10]; local z [-10, 10] becomes world x [-10, 10].
  const b = worldBounds([part([100, 0, 0], rotY90)], g);
  assert.deepEqual(b, { min: [90, -4, -30], max: [110, 24, 10] });
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
      new RegExp(`^0 !LEOCAD CAMERA FOV 30 POSITION \\S+ \\S+ \\S+ TARGET_POSITION \\S+ \\S+ \\S+ UP_VECTOR \\S+ \\S+ \\S+ NAME ${name}$`),
    );
    assert.match(lines[i], /TARGET_POSITION 10 30 -20 /);
  }
  assert.ok(!lines.join('').includes('-0 '));
});

const read = (line: string) => {
  const m = line.match(/POSITION (\S+) (\S+) (\S+) TARGET_POSITION (\S+) (\S+) (\S+) /)!;
  const n = m.slice(1).map(Number);
  const up = line.match(/UP_VECTOR (\S+) (\S+) (\S+) /)!.slice(1).map(Number);
  return { pos: n.slice(0, 3), target: n.slice(3), up };
};

test('front camera is in front of and above the target, in LeoCAD axes', () => {
  const [front] = cameraLines(box);
  const { pos, target } = read(front);
  const [x, y, z] = pos.map((v, i) => v - target[i]);
  assert.ok(Math.abs(x) < 1e-6);
  assert.ok(y < 0, 'LeoCAD y < 0 is the front (LDraw -z)');
  assert.ok(z > 0, 'LeoCAD z > 0 is above');
  const radius = Math.hypot(100, 100, 100) / 2;
  assert.ok(Math.hypot(x, y, z) >= radius / Math.sin((15 * Math.PI) / 180) - 0.05);
});

test('three-quarter camera swings toward +x like render_model yaw 35', () => {
  const { pos, target } = read(cameraLines(box)[1]);
  const [x, y, z] = pos.map((v, i) => v - target[i]);
  assert.ok(x > 0);
  assert.ok(y < 0);
  assert.ok(z > 0);
  assert.ok(Math.abs(x / -y - Math.tan((35 * Math.PI) / 180)) < 0.01);
});

test('target converts LDraw (x, y, z) to LeoCAD (x, z, -y)', () => {
  const [line] = cameraLines({ min: [0, -60, 0], max: [20, 0, 10] });
  assert.match(line, /TARGET_POSITION 10 5 30 /);
  assert.ok(!line.includes('-0 '));
});

test('up vector is perpendicular to the view direction and points up', () => {
  for (const line of cameraLines(box)) {
    const { pos, target, up } = read(line);
    const front = target.map((v, i) => v - pos[i]);
    const dot = up.reduce((s, v, i) => s + v * front[i], 0);
    assert.ok(Math.abs(dot) / Math.hypot(...front) < 0.01, `up . view = ${dot}`);
    assert.ok(up[2] > 0);
    assert.ok(Math.abs(Math.hypot(...up) - 1) < 0.01);
  }
  assert.ok(!cameraLines(box).join('').includes('-0 '));
});
