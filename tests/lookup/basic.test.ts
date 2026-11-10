import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runSeed } from '../../src/seed/seed.ts';
import { readPointer } from '../../src/db/open.ts';
import type { SeedState } from '../../src/seed/lock.ts';
import { fixtureFetched, writeFixtureSources } from '../helpers/fixtures.ts';
import { searchParts } from '../../src/lookup/search-parts.ts';
import { getPart } from '../../src/lookup/get-part.ts';
import { listColors } from '../../src/lookup/list-colors.ts';
import { databaseStatus } from '../../src/lookup/status.ts';
import { clampLimit } from '../../src/lookup/common.ts';

const repoRoot = resolve(import.meta.dirname, '..', '..');
let tmp: string;
let db: DatabaseSync;

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'brick-art-lookup-'));
  const fx = await writeFixtureSources(join(tmp, 'fx'));
  const dataDir = join(tmp, 'data');
  await runSeed({ dataDir, repoRoot, refresh: false, sources: fixtureFetched(fx) });
  db = new DatabaseSync(join(dataDir, readPointer(dataDir)!), { readOnly: true });
});

after(async () => {
  db.close();
  await rm(tmp, { recursive: true, force: true });
});

const nums = (rows: { partNum: string }[]) => rows.map((r) => r.partNum);

test('searchParts width 1 height 3 ranks by set_count and excludes incomplete and prints', () => {
  const rows = searchParts(db, { width: 1, height: 3 });
  const n = nums(rows);
  assert.ok(n.length > 0);
  assert.ok(!n.includes('99999'));
  assert.ok(!n.includes('3001pr0001'));
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1]!.setCount >= rows[i]!.setCount);
  const top = Math.max(...rows.map((r) => r.setCount));
  assert.equal(rows[0]!.setCount, top);
});

test('searchParts matches width/depth in either orientation', () => {
  assert.ok(nums(searchParts(db, { width: 4, depth: 2 })).includes('3001'));
  assert.ok(nums(searchParts(db, { width: 2, depth: 4 })).includes('3001'));
  assert.ok(nums(searchParts(db, { width: 4 })).includes('3001'));
  assert.ok(nums(searchParts(db, { depth: 4 })).includes('3001'));
  assert.ok(nums(searchParts(db, { width: [3, 5], depth: [1, 2] })).includes('3001'));
});

test('searchParts color filter uses part_colors', () => {
  const n = nums(searchParts(db, { color: 2 }));
  assert.ok(n.includes('3001'));
  assert.ok(n.includes('3010'));
});

test('searchParts traits filter and summary traits', () => {
  const rows = searchParts(db, { traits: ['slope'] });
  assert.deepEqual(nums(rows), ['3039']);
  assert.ok(rows[0]!.traits.includes('slope'));
  assert.deepEqual(rows[0]!.traits, [...rows[0]!.traits].sort());
});

test('searchParts include flags, nameContains, and limit', () => {
  assert.ok(nums(searchParts(db, { includeIncomplete: true })).includes('99999'));
  assert.ok(nums(searchParts(db, { includePrints: true, includeIncomplete: true })).includes('3001pr0001'));
  assert.ok(nums(searchParts(db, { nameContains: 'SLOPE' })).includes('3039'));
  assert.deepEqual(searchParts(db, { nameContains: '%' }), []);
  assert.equal(searchParts(db, { limit: 2 }).length, 2);
  assert.equal(clampLimit(), 25);
  assert.equal(clampLimit(9999), 200);
  assert.equal(clampLimit(0), 1);
});

test('getPart returns detail', () => {
  const p = getPart(db, '3001')!;
  assert.equal(p.connections.length, 16);
  assert.deepEqual(p.colors.map((c) => c.id).sort((a, b) => a - b), [0, 2, 4]);
  assert.equal(p.widthStuds, 4);
  assert.equal(p.isComplete, true);
  assert.ok(Array.isArray(p.grid));
  assert.equal(p.connections[0]!.position.length, 3);
  assert.equal(getPart(db, 'nope'), null);
  assert.equal(getPart(db, '99999')!.isComplete, false);
});

test('getPart labels unreviewed creative uses as suggestion', () => {
  const p = getPart(db, '33085')!;
  assert.equal(p.creativeUses[0]!.status, 'suggestion');
});

test('listColors excludes placeholders and filters by part', () => {
  const ids = listColors(db, {}).map((c) => c.id);
  assert.ok(!ids.includes(-1));
  assert.ok(!ids.includes(9999));
  assert.deepEqual(listColors(db, { partNum: '3001' }).map((c) => c.id).sort((a, b) => a - b), [0, 2, 4]);
});

test('databaseStatus', () => {
  const failed: SeedState = { status: 'failed', startedAt: null, finishedAt: null, lastError: 'boom', failures: 1 };
  const s = databaseStatus(null, failed);
  assert.equal(s.state, 'failed');
  assert.equal(s.lastError, 'boom');
  assert.equal(s.seededAt, null);
  const ready: SeedState = { status: 'ready', startedAt: null, finishedAt: null, lastError: null, failures: 0 };
  const r = databaseStatus(db, ready);
  assert.equal(r.state, 'ready');
  assert.equal(r.counts.parts, 19);
  assert.equal(r.ldrawRelease, '2026-10');
  assert.equal(databaseStatus(db, { ...ready, status: 'seeding' }).state, 'seeding');
});
