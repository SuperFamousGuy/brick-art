import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runSeed } from '../../src/seed/seed.ts';
import { readPointer } from '../../src/db/open.ts';
import { fixtureFetched, writeFixtureSources } from '../helpers/fixtures.ts';
import { findByUse } from '../../src/lookup/find-by-use.ts';
import { findCompatible } from '../../src/lookup/find-compatible.ts';
import { findSubstitutes } from '../../src/lookup/find-substitutes.ts';

const repoRoot = resolve(import.meta.dirname, '..', '..');
let tmp: string;
let db: DatabaseSync;

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'brick-art-advanced-'));
  const fx = await writeFixtureSources(join(tmp, 'fx'));
  const dataDir = join(tmp, 'data');
  await runSeed({ dataDir, repoRoot, refresh: false, sources: fixtureFetched(fx) });
  db = new DatabaseSync(join(dataDir, readPointer(dataDir)!), { readOnly: true });
});

after(async () => {
  db.close();
  await rm(tmp, { recursive: true, force: true });
});

const nums = (rows: { part: { partNum: string } }[]) => rows.map((r) => r.part.partNum);

test('findByUse matches substring case-insensitively and labels suggestions', () => {
  const rows = findByUse(db, { represents: 'PETAL' });
  assert.equal(rows[0]!.part.partNum, '33085');
  assert.equal(rows[0]!.represents, 'flower petal');
  assert.equal(rows[0]!.status, 'suggestion');
  assert.deepEqual(findByUse(db, { represents: '' }), []);
  assert.deepEqual(findByUse(db, { represents: '%' }), []);
  assert.deepEqual(findByUse(db, { represents: 'petal', color: 2 }), []);
  assert.equal(findByUse(db, { represents: 'petal', color: 4 }).length, 1);
});

test('findCompatible by connection type', () => {
  const stud = nums(findCompatible(db, { connectionType: 'stud' }));
  assert.ok(stud.includes('3001'));
  assert.ok(!stud.includes('33085'));
  const m = findCompatible(db, { connectionType: 'stud' }).find((r) => r.part.partNum === '3001')!;
  assert.ok(m.matchingTypes.includes('stud_receptor'));
  assert.ok(nums(findCompatible(db, { connectionType: 'bar' })).includes('15712'));
  assert.ok(nums(findCompatible(db, { connectionType: 'hinge_m' })).includes('3937'));
});

test('findCompatible by part and connection index', () => {
  const all = findCompatible(db, { partNum: '3937' });
  assert.ok(all.length > 0);
  assert.deepEqual(findCompatible(db, { partNum: 'nope' }), []);
  assert.deepEqual(findCompatible(db, { partNum: '3937', connectionIndex: 999 }), []);
  assert.deepEqual(findCompatible(db, { partNum: '3937', connectionIndex: -1 }), []);
  assert.ok(findCompatible(db, { partNum: '3937', connectionIndex: 0 }).length > 0);
  assert.throws(() => findCompatible(db, {}), /give connectionType or partNum/);
  assert.throws(
    () => findCompatible(db, { connectionType: 'stud', partNum: '3001' }),
    /give connectionType or partNum/,
  );
});

test('findSubstitutes combinations', () => {
  const rows = findSubstitutes(db, { partNum: '3009', color: 2 });
  const keys = rows.map((r) => `${r.kind}:${r.parts.join(',')}`);
  assert.ok(keys.includes('combination:3622,3622'));
  assert.ok(keys.includes('combination:3004,3010'));
  assert.equal(rows.find((r) => r.parts.join() === '3622,3622')!.note, '2 parts: 1x3 + 1x3');
  const firstThree = rows.findIndex((r) => r.parts.length === 3);
  const lastTwo = rows.map((r) => r.parts.length).lastIndexOf(2);
  if (firstThree >= 0) assert.ok(lastTwo < firstThree);
  assert.ok(rows.every((r) => r.parts.join() === [...r.parts].sort().join()));
  assert.ok(rows.length <= 10);
  assert.equal(findSubstitutes(db, { partNum: '3009', color: 2, limit: 1 }).length, 1);
});

test('findSubstitutes returns [] when available, unknown, or nothing applies', () => {
  assert.deepEqual(findSubstitutes(db, { partNum: '3009', color: 4 }), []);
  assert.deepEqual(findSubstitutes(db, { partNum: 'nope', color: 2 }), []);
  assert.deepEqual(findSubstitutes(db, { partNum: '33085', color: 2 }), []);
});

test('findByUse and findCompatible apply the shared part filters', () => {
  assert.equal(findByUse(db, { represents: 'petal', nameContains: 'banana', minSetCount: 1 }).length, 1);
  assert.deepEqual(findByUse(db, { represents: 'petal', traits: ['slope'] }), []);
  assert.deepEqual(findByUse(db, { represents: 'petal', width: 4 }), []);

  assert.deepEqual(nums(findCompatible(db, { connectionType: 'stud', width: 4, depth: 2 })), ['3001']);
  const recv = nums(findCompatible(db, { connectionType: 'stud_receptor' }));
  assert.ok(recv.includes('3001'));
  assert.ok(!recv.includes('3437'));
  assert.ok(nums(findCompatible(db, { connectionType: 'stud_receptor', includeNonSystem: true })).includes('3437'));
  assert.deepEqual(nums(findCompatible(db, { connectionType: 'stud_receptor', category: 'plates' })), ['3023']);
});
