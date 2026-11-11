import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seedFixture } from '../helpers/seeded.ts';
import { getSubmodel } from '../../src/lookup/get-submodel.ts';
import { databaseStatus } from '../../src/lookup/status.ts';
import type { UpdateState } from '../../src/release/download.ts';
import type { SeedState } from '../../src/seed/lock.ts';

let tmp: string;
let std: DatabaseSync;
let fallback: DatabaseSync;
let big: DatabaseSync;
let mainId: number;
let cabId: number;
let bigId: number;
const closers: (() => Promise<void>)[] = [];

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'brick-art-submodel-'));
  const a = await seedFixture(join(tmp, 'std'), 'standard');
  const b = await seedFixture(join(tmp, 'fb'), 'fallback');
  closers.push(a.close, b.close);
  std = new DatabaseSync(a.dbFile, { readOnly: true });
  fallback = new DatabaseSync(b.dbFile, { readOnly: true });
  const sub = (name: string) =>
    (std.prepare('SELECT id FROM submodels WHERE name = ?').get(name) as { id: number }).id;
  mainId = sub('10001 - main.ldr');
  cabId = sub('10001 - cab.ldr');

  const copy = join(tmp, 'big.db');
  await copyFile(a.dbFile, copy);
  big = new DatabaseSync(copy);
  bigId = 900000;
  big.prepare('INSERT INTO submodels (id, project_id, name, is_main, step_count, part_count) VALUES (?,?,?,?,?,?)')
    .run(bigId, 1, 'big.ldr', 0, 50, 1000);
  const ins = big.prepare(
    `INSERT INTO placements (submodel_id, step, seq, part_num, ldraw_file, ldraw_color, color_id, child_submodel_id, x, y, z, matrix)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (let s = 1; s <= 50; s++) {
    for (let q = 0; q < 20; q++) ins.run(bigId, s, q, '3001', '3001.dat', 4, 4, null, q, 0, 0, '[1,0,0,0,1,0,0,0,1]');
  }
});

after(async () => {
  std.close();
  fallback.close();
  big.close();
  for (const c of closers) await c();
  await rm(tmp, { recursive: true, force: true });
});

test('unflattened main shows two steps and the child by name', () => {
  const r = getSubmodel(std, { submodelId: mainId })!;
  assert.equal(r.submodel.name, '10001 - main.ldr');
  assert.equal(r.steps.length, 2);
  assert.equal(r.nextStep, null);
  assert.equal(r.steps[0]!.placements[0]!.partNum, '3001');
  const child = r.steps[1]!.placements;
  assert.equal(child.length, 1);
  assert.equal(child[0]!.submodel, '10001 - cab.ldr');
  assert.equal(child[0]!.partNum, null);
});

test('flatten composes transforms and inherits color 16, keeping unmatched references', () => {
  const r = getSubmodel(std, { submodelId: mainId, flatten: true })!;
  assert.equal(r.steps.length, 2);
  const flat = r.steps[1]!.placements;
  assert.equal(flat.length, 3);
  assert.ok(flat.every((p) => p.submodel === null));
  const p = flat.find((x) => x.partNum === '3023')!;
  assert.equal(p.colorId, 4);
  assert.ok(p.colorName !== null);
  assert.deepEqual(p.pos, [0, -24, -10]);
  assert.deepEqual(p.matrix, [0, 0, 1, 0, 1, 0, -1, 0, 0]);
  assert.ok(flat.some((x) => x.partNum === null && x.ldrawFile === 'missing.ldr'));
  assert.ok(flat.some((x) => x.partNum === null && x.ldrawFile === '9999x.dat'));
});

test('color 16 at the top level keeps a null color', () => {
  const r = getSubmodel(std, { submodelId: cabId, flatten: true })!;
  assert.equal(r.steps.flatMap((s) => s.placements).find((x) => x.partNum === '3023')!.colorId, null);
});

test('paging returns whole steps up to maxPlacements and continues from nextStep', () => {
  const first = getSubmodel(big, { submodelId: bigId, maxPlacements: 300 })!;
  assert.equal(first.steps.length, 15);
  assert.equal(first.nextStep, 16);
  const next = getSubmodel(big, { submodelId: bigId, maxPlacements: 300, fromStep: 16 })!;
  assert.equal(next.steps[0]!.step, 16);
  assert.equal(getSubmodel(big, { submodelId: bigId, maxPlacements: 5000, fromStep: 1 })!.steps.length, 50);
  const tiny = getSubmodel(big, { submodelId: bigId, maxPlacements: 1 })!;
  assert.equal(tiny.steps.length, 1);
  assert.equal(tiny.nextStep, 2);
  assert.equal(getSubmodel(big, { submodelId: bigId, fromStep: 51 })!.steps.length, 0);
});

test('unknown submodel returns null', () => {
  assert.equal(getSubmodel(std, { submodelId: 999999 }), null);
});

const ready: SeedState = { status: 'ready', startedAt: null, finishedAt: null, lastError: null, failures: 0 };
const update: UpdateState = {
  lastCheckedAt: null, releaseTag: 'data-3-20261117', variant: 'standard', origin: 'release', lastError: null,
};

test('status on a fallback database warns and reports update origin', () => {
  const s = databaseStatus(fallback, ready, false, { ...update, variant: 'fallback', origin: 'local' });
  assert.equal(s.variant, 'fallback');
  assert.equal(s.origin, 'local');
  assert.equal(s.releaseTag, 'data-3-20261117');
  assert.ok(s.warnings.includes('positions not downloaded (fallback database)'));
  assert.equal(s.placementMatchRate, null);
  assert.deepEqual(s.failedSources, []);
});

test('status on a standard database reports counts and release info without the warning', () => {
  const s = databaseStatus(std, ready, false, update);
  assert.equal(s.variant, 'standard');
  assert.equal(s.origin, 'release');
  assert.ok(!s.warnings.some((w) => w.includes('fallback')));
  assert.ok((s.counts.projects_official ?? 0) > 0);
});

test('status parses failed_sources and the placement match rate', () => {
  big.prepare("INSERT OR REPLACE INTO manifest (key, value) VALUES ('failed_sources', 'a, b')").run();
  big.prepare("INSERT OR REPLACE INTO manifest (key, value) VALUES ('placement_match_rate', '0.99')").run();
  const s = databaseStatus(big, ready, false, update);
  assert.deepEqual(s.failedSources, ['a', 'b']);
  assert.equal(s.placementMatchRate, 0.99);
  big.prepare("UPDATE manifest SET value = '' WHERE key IN ('failed_sources','placement_match_rate')").run();
  const t = databaseStatus(big, ready, false, update);
  assert.deepEqual(t.failedSources, []);
  assert.equal(t.placementMatchRate, null);
});
