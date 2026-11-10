import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LDrawLibrary } from '../../src/ldraw/library.ts';
import { resolvePart } from '../../src/ldraw/resolve.ts';
import { writeFixtureSources } from '../helpers/fixtures.ts';

let dir: string;
let lib: LDrawLibrary;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'resolve-'));
  const fx = await writeFixtureSources(dir);
  lib = await LDrawLibrary.fromDirs(fx.ldrawRoot, fx.shadowRoot);
});
after(() => rm(dir, { recursive: true, force: true }));

const near = (a: number[], b: number[]) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]!) < 1e-9, `${a} vs ${b}`));
const count = (r: ReturnType<typeof resolvePart>, type: string) => r.connections.filter((c) => c.type === type).length;
const studStud = '1 16 0 0 0 1 0 0 0 1 0 0 0 1 stud.dat';

test('3001 has 8 studs and 8 receptors from ldcad', () => {
  const r = resolvePart(lib, '3001.dat');
  assert.equal(count(r, 'stud'), 8);
  assert.equal(count(r, 'stud_receptor'), 8);
  assert.ok(r.connections.every((c) => c.source === 'ldcad'));
  assert.deepEqual(r.missingRefs, []);
  assert.match(r.license ?? '', /CC BY 4\.0/);
  assert.ok(r.bodyTriangles.length < r.triangles.length);
});

test('87087 side stud is transformed by the ref matrix', () => {
  const side = resolvePart(lib, '87087.dat').connections
    .find((c) => c.type === 'stud' && c.position[1] === 12)!;
  near(side.position, [0, 12, -10]);
  near(side.direction, [0, 0, -1]);
});

test('3005 infers one stud', () => {
  const r = resolvePart(lib, '3005.dat');
  assert.equal(r.connections.length, 1);
  assert.equal(r.connections[0]!.type, 'stud');
  assert.equal(r.connections[0]!.source, 'inferred');
  assert.equal(r.connections[0]!.raw, 'stud2.dat');
});

test('99999 records missing refs', () => {
  assert.deepEqual(resolvePart(lib, '99999.dat').missingRefs, ['s/missing.dat']);
});

test('cycles return with cyclic flag', () => {
  const l = LDrawLibrary.fromMaps(new Map([
    ['parts/a.dat', '1 16 0 0 0 1 0 0 0 1 0 0 0 1 b.dat\n'],
    ['parts/b.dat', '1 16 0 0 0 1 0 0 0 1 0 0 0 1 a.dat\n'],
  ]), new Map());
  assert.equal(resolvePart(l, 'a.dat').cyclic, true);
  assert.equal(resolvePart(l, 'b.dat').cyclic, true);
});

test('SNAP_INCL places included snaps on a grid', () => {
  const l = LDrawLibrary.fromMaps(
    new Map([['p/stud.dat', ''], ['parts/x.dat', '']]),
    new Map([
      ['p/stud.dat', '0 !LDCAD SNAP_CYL [ID=studC] [gender=M] [caps=one] [secs=R 6 4]\n'],
      ['parts/x.dat', '0 !LDCAD SNAP_INCL [ref=stud.dat] [pos=0 0 0] [grid=2 1 20 0]\n'],
    ]));
  const r = resolvePart(l, 'x.dat');
  assert.equal(count(r, 'stud'), 2);
  assert.deepEqual(r.connections.map((c) => c.position[0]).sort(), [0, 20]);
});

const studShadow = '0 !LDCAD SNAP_CYL [ID=studC] [gender=M] [caps=one] [secs=R 6 4]\n';
const clearLib = (clear: string) => LDrawLibrary.fromMaps(
  new Map([['p/stud.dat', ''], ['parts/y.dat', `${studStud}\n`]]),
  new Map([['p/stud.dat', studShadow], ['parts/y.dat', `${clear}\n`]]));

test('SNAP_CLEAR with id drops matching child snaps', () => {
  assert.equal(count(resolvePart(clearLib('0 !LDCAD SNAP_CLEAR [id=studC]'), 'y.dat'), 'stud'), 0);
  assert.equal(count(resolvePart(clearLib('0 !LDCAD SNAP_CLEAR [id=other]'), 'y.dat'), 'stud'), 1);
  assert.equal(count(resolvePart(clearLib('0 !LDCAD SNAP_CLEAR'), 'y.dat'), 'stud'), 0);
});

test('malformed snap line is reported and skipped', () => {
  const l = LDrawLibrary.fromMaps(
    new Map([['parts/z.dat', '']]),
    new Map([['parts/z.dat', '0 !LDCAD SNAP_CYL [pos=1 2]\n' + studShadow]]));
  const r = resolvePart(l, 'z.dat');
  assert.equal(r.errors.length, 1);
  assert.equal(count(r, 'stud'), 1);
});

test('repeated resolution reuses the memo for shared primitives', () => {
  const a = resolvePart(lib, '3001.dat');
  const b = resolvePart(lib, '3001.dat');
  assert.deepEqual(a.connections, b.connections);
  assert.equal(a.triangles.length, b.triangles.length);
});

test('duplicate snap errors are reported once', () => {
  const l = LDrawLibrary.fromMaps(
    new Map([['parts/w.dat', `${studStud}\n${studStud}\n`], ['p/stud.dat', '']]),
    new Map([['p/stud.dat', '0 !LDCAD SNAP_CYL [pos=1 2]\n']]));
  assert.equal(resolvePart(l, 'w.dat').errors.length, 1);
});

test('mutating a result does not affect later resolutions', () => {
  const a = resolvePart(lib, '3001.dat');
  const n = a.connections.length;
  const first = a.triangles[0]![0][0];
  a.connections[0]!.position[0] = 9999;
  a.triangles[0]![0][0] = 9999;
  a.connections.length = 0;
  a.bodyTriangles.length = 0;
  const b = resolvePart(lib, '3001.dat');
  assert.equal(b.connections.length, n);
  assert.equal(b.triangles[0]![0][0], first);
  assert.ok(b.bodyTriangles.length > 0);
  assert.notEqual(b.connections[0]!.position[0], 9999);
});
