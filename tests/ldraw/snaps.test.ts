import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapParseError, expandSnap, gridOffsets, parseSnapLine, snapPosOri } from '../../src/ldraw/snaps.ts';

const expand = (line: string) => expandSnap(parseSnapLine(line), line);
const fgr = (g: string) =>
  `0 !LDCAD SNAP_FGR [group=hgBrC] [genderOfs=${g}] [seq=18 4 18] [radius=4] [pos=0 10 0] [ori=0 -1 0 1 0 0 0 0 1]`;

test('stud line', () => {
  const pts = expand('0 !LDCAD SNAP_CYL [ID=studC] [gender=M] [caps=one] [secs=R 6 4]');
  assert.equal(pts.length, 1);
  assert.equal(pts[0]!.type, 'stud');
  assert.deepEqual(pts[0]!.position, [0, 0, 0]);
  assert.deepEqual(pts[0]!.direction, [0, -1, 0]);
  assert.equal(pts[0]!.snapId, 'studC');
  assert.equal(pts[0]!.source, 'ldcad');
  assert.equal(pts[0]!.angleMin, null);
});

test('3001s01 grid expands to 8 stud receptors', () => {
  const pts = expand('0 !LDCAD SNAP_CYL [gender=F] [caps=one] [secs=R 6 20] [pos=0 24 0] [grid=C 4 C 2 20 20]');
  assert.equal(pts.length, 8);
  assert.ok(pts.every((p) => p.type === 'stud_receptor' && p.position[1] === 24));
  assert.ok(pts.every((p) => p.direction.join() === '0,1,0'));
  assert.deepEqual(new Set(pts.map((p) => p.position[0])), new Set([-30, -10, 10, 30]));
  assert.deepEqual(new Set(pts.map((p) => p.position[2])), new Set([-10, 10]));
});

test('60478 bar faces +z', () => {
  const pts = expand('0 !LDCAD SNAP_CYL [gender=M] [caps=none] [secs=R 4 16] [pos=0 4 -30] [ori=1 0 0 0 0 1 0 -1 0]');
  assert.equal(pts.length, 1);
  assert.equal(pts[0]!.type, 'bar');
  assert.deepEqual(pts[0]!.direction, [0, 0, 1]);
  assert.deepEqual(pts[0]!.position, [0, 4, -30]);
});

test('3937 CYL with uncentered count yields 2 receptors at x +-10', () => {
  const pts = expand('0 !LDCAD SNAP_CYL [gender=F] [caps=one] [secs=S 6 4] [pos=0 24 0] [grid=C 2 1 20 0]');
  assert.equal(pts.length, 2);
  assert.ok(pts.every((p) => p.type === 'stud_receptor'));
  assert.deepEqual(pts.map((p) => p.position[0]).sort((a, b) => a - b), [-10, 10]);
});

test('FGR lines classify by genderOfs', () => {
  assert.equal(expand(fgr('F'))[0]!.type, 'hinge_f');
  assert.equal(expand(fgr('M'))[0]!.type, 'hinge_m');
});

test('pin_hole, axle_hole, other kinds', () => {
  assert.equal(expand('0 !LDCAD SNAP_CYL [secs=R 8 2 R 6 16 R 8 2] [caps=none] [gender=F]')[0]!.type, 'pin_hole');
  assert.equal(expand('0 !LDCAD SNAP_CYL [secs=A 6 20] [gender=F]')[0]!.type, 'axle_hole');
  assert.equal(expand('0 !LDCAD SNAP_CYL [secs=A 6 20]')[0]!.type, 'axle');
  assert.equal(expand('0 !LDCAD SNAP_CYL [secs=R 6 20] [caps=none]')[0]!.type, 'pin');
  assert.equal(expand('0 !LDCAD SNAP_CYL [secs=R 10 20]')[0]!.type, 'other');
  assert.equal(expand('0 !LDCAD SNAP_CLP [radius=4] [length=8] [pos=0 -6 0]')[0]!.type, 'clip');
  assert.equal(expand('0 !LDCAD SNAP_SPH [gender=F] [radius=4]')[0]!.type, 'socket');
  assert.equal(expand('0 !LDCAD SNAP_SPH [radius=4]')[0]!.type, 'ball');
  assert.equal(expand('0 !LDCAD SNAP_GEN [gender=F]')[0]!.type, 'other');
});

test('INCL and CLEAR expand to nothing; params are case-insensitive', () => {
  assert.deepEqual(expand('0 !LDCAD SNAP_INCL [ref=stud.dat] [pos=0 0 0]'), []);
  assert.deepEqual(expand('0 !LDCAD SNAP_CLEAR [id=studC]'), []);
  assert.equal(parseSnapLine('0 !LDCAD SNAP_CYL [ID=a] [id2=b]').params.id, 'a');
});

test('snapPosOri defaults and gridOffsets', () => {
  const d = snapPosOri(parseSnapLine('0 !LDCAD SNAP_CYL'));
  assert.deepEqual(d.pos, [0, 0, 0]);
  assert.deepEqual(d.ori, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.deepEqual(gridOffsets(undefined), [[0, 0, 0]]);
  assert.deepEqual(gridOffsets('3 2 10 5'), [[0, 0, 0], [0, 0, 5], [10, 0, 0], [10, 0, 5], [20, 0, 0], [20, 0, 5]]);
});

test('malformed input throws SnapParseError naming the parameter and line', () => {
  const cases: [string, RegExp][] = [
    ['0 !LDCAD SNAP_CYL [secs=R 6 4] [pos=0 24]', /pos.*0 24.*in line: 0 !LDCAD SNAP_CYL/],
    ['0 !LDCAD SNAP_CYL [secs=R 6 4] [ori=1 0 0 0 1 0]', /ori/],
    ['0 !LDCAD SNAP_CYL [secs=R 6 4] [grid=C 4 x 20 20]', /grid/],
    ['0 !LDCAD SNAP_CYL [secs=R 6 4] [grid=C 4 C 2 20]', /grid/],
    ['0 !LDCAD SNAP_CYL [secs=R 6]', /secs/],
    ['0 !LDCAD SNAP_CYL [secs=R six 4]', /secs/],
    ['0 !LDCAD SNAP_FOO [pos=0 0 0]', /kind/],
    ['0 !LDCAD SNAP_CYL [grid=101 1 20 20]', /exceeds 100/],
    ['0 !LDCAD SNAP_CYL [grid=C 1 C 101 20 20]', /exceeds 100/],
  ];
  for (const [line, re] of cases) {
    assert.throws(() => parseSnapLine(line), (e) => e instanceof SnapParseError && re.test(e.message), line);
  }
  assert.throws(() => gridOffsets('1e9 1 20 20'), SnapParseError);
  assert.equal(gridOffsets('100 1 20 20').length, 100);
  assert.throws(() => expandSnap({ kind: 'CYL', params: { pos: 'a b c' } }, 'RAW'), /RAW/);
});
