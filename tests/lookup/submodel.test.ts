import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seedFixture } from '../helpers/seeded.ts';
import { EXPANSION_LIMIT, WORK_LIMIT, getSubmodel, submodelWork } from '../../src/lookup/get-submodel.ts';
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
  assert.equal(r.steps[0]!.placements[0]!.kind, 'part');
  const child = r.steps[1]!.placements;
  assert.equal(child.length, 1);
  assert.equal(child[0]!.submodel, '10001 - cab.ldr');
  assert.equal(child[0]!.kind, 'submodel');
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
  assert.ok(flat.some((x) => x.kind === 'unmatched' && x.partNum === null && x.ldrawFile === 'missing.ldr'));
  assert.ok(flat.some((x) => x.kind === 'unmatched' && x.partNum === null && x.ldrawFile === '9999x.dat'));
  assert.equal(p.kind, 'part');
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
  lastCheckedAt: null, releaseTag: 'data-3-20261117', variant: 'standard', origin: 'release', installedSha256: null, lastError: null,
};

test('status on a fallback database warns and reports a local origin without a release tag', () => {
  const s = databaseStatus(fallback, ready, false, { ...update, variant: 'fallback', origin: 'local' });
  assert.equal(s.variant, 'fallback');
  assert.equal(s.origin, 'local');
  assert.equal(s.releaseTag, null);
  assert.ok(s.warnings.includes('positions not downloaded (fallback database)'));
  assert.equal(s.placementMatchRate, null);
  assert.deepEqual(s.failedSources, []);
});

test('status on a standard database reports counts and release info without the warning', () => {
  big.prepare("UPDATE manifest SET value = 'ci' WHERE key = 'built_by'").run();
  try {
    const s = databaseStatus(big, ready, false, update);
    assert.equal(s.variant, 'standard');
    assert.equal(s.origin, 'release');
    assert.equal(s.releaseTag, 'data-3-20261117');
    assert.ok(!s.warnings.some((w) => w.includes('fallback')));
    assert.ok((s.counts.projects_official ?? 0) > 0);
  } finally {
    big.prepare("UPDATE manifest SET value = 'local' WHERE key = 'built_by'").run();
  }
});

test('status credits every source the database uses', () => {
  const s = databaseStatus(std, ready, false, update);
  assert.equal(s.credits.length, 4);
  assert.match(s.credits[0]!, /^Data sourced from Rebrickable \(rebrickable\.com\), downloaded 2026-11-09\.$/);
  assert.match(s.credits[1]!, /LDraw Parts Library 2026-10 .*CC BY 4\.0/);
  assert.match(s.credits[2]!, /LDCad shadow library abc123 .*CC BY-SA 4\.0/);
  assert.match(s.credits[3]!, /LDraw Official Model Repository .*CCAL 2\.0/);
  const f = databaseStatus(fallback, ready, false, update);
  assert.equal(f.credits.length, 3);
  assert.deepEqual(databaseStatus(null, ready, false, update).credits, ['Data sourced from Rebrickable (rebrickable.com).']);
  big.prepare("INSERT INTO projects (id, source, source_key, kind, name, url) VALUES (900001, 'town', 't.ldr', 'fan', 't', 'https://example.test/town')").run();
  big.prepare("INSERT INTO manifest (key, value) VALUES ('fan_commit_town', 'f00dfacef00dface')").run();
  try {
    assert.equal(databaseStatus(big, ready, false, update).credits.at(-1),
      'Fan models from town (https://example.test/town), commit f00dfacef00d, license per file.');
  } finally {
    big.prepare('DELETE FROM projects WHERE id = 900001').run();
    big.prepare("DELETE FROM manifest WHERE key = 'fan_commit_town'").run();
  }
});

test('status after a local reseed reports a local origin even when update.json names a release', () => {
  const s = databaseStatus(std, ready, false, update);
  assert.equal(s.origin, 'local');
  assert.equal(s.releaseTag, null);
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

const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
interface P { part?: string | null; color?: number | null; ldraw?: number; child?: number; pos?: number[]; m?: number[] }
function addSub(id: number, rows: P[][]): void {
  big.prepare('INSERT INTO submodels (id, project_id, name, is_main, step_count, part_count) VALUES (?,?,?,?,?,?)')
    .run(id, 1, `s${id}.ldr`, 0, rows.length, 0);
  const ins = big.prepare(
    `INSERT INTO placements (submodel_id, step, seq, part_num, ldraw_file, ldraw_color, color_id, child_submodel_id, x, y, z, matrix)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  rows.forEach((step, si) => step.forEach((p, q) => {
    const color = p.color === undefined ? 4 : p.color;
    const pos = p.pos ?? [0, 0, 0];
    ins.run(id, si + 1, q, p.child === undefined ? (p.part ?? '3001') : null, `${p.part ?? '3001'}.dat`,
      p.ldraw ?? color ?? 16, color, p.child ?? null, pos[0]!, pos[1]!, pos[2]!, JSON.stringify(p.m ?? I));
  }));
}

test('non-commuting parent and child matrices compose as parent times child', () => {
  const rotY = [0, 0, 1, 0, 1, 0, -1, 0, 0];
  const rotX = [1, 0, 0, 0, 0, -1, 0, 1, 0];
  addSub(910001, [[{ part: '3023', pos: [1, 2, 3], m: rotX }]]);
  addSub(910002, [[{ child: 910001, pos: [10, 20, 30], m: rotY }]]);
  const p = getSubmodel(big, { submodelId: 910002, flatten: true })!.steps[0]!.placements[0]!;
  assert.deepEqual(p.matrix, [0, 1, 0, 0, 0, -1, -1, 0, 0]);
  assert.deepEqual(p.pos, [13, 22, 29]);
});

test('color 16 inherits through two levels and an explicit child color overrides', () => {
  addSub(910011, [[{ part: '3023', color: null, ldraw: 16 }, { part: '3024', color: 1 }]]);
  addSub(910012, [[{ child: 910011, color: null, ldraw: 16 }]]);
  addSub(910013, [[{ child: 910012, color: 4 }]]);
  const out = getSubmodel(big, { submodelId: 910013, flatten: true })!.steps[0]!.placements;
  assert.equal(out.find((x) => x.partNum === '3023')!.colorId, 4);
  assert.equal(out.find((x) => x.partNum === '3024')!.colorId, 1);
});

test('repeated child references hit the expansion budget and report truncation', () => {
  addSub(910021, [[{ part: '3001' }]]);
  addSub(910022, [[...Array.from({ length: 100 }, () => ({ child: 910021 }))]]);
  addSub(910023, [[...Array.from({ length: 100 }, () => ({ child: 910022 }))], [{ part: '3001' }]]);
  const t0 = Date.now();
  const r = getSubmodel(big, { submodelId: 910023, flatten: true, maxPlacements: 1000 })!;
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(r.truncated, true);
  const total = r.steps.reduce((n, st) => n + st.placements.length, 0);
  assert.ok(total <= EXPANSION_LIMIT);
  assert.equal(r.steps.length, 1);
  assert.equal(r.nextStep, 2);
  assert.equal(getSubmodel(big, { submodelId: bigId })!.truncated, false);
});

test('nesting deeper than 32 levels reports truncation', () => {
  addSub(920000, [[{ part: '3001' }]]);
  for (let i = 1; i <= 34; i++) addSub(920000 + i, [[{ child: 920000 + i - 1 }]]);
  const r = getSubmodel(big, { submodelId: 920034, flatten: true })!;
  assert.equal(r.truncated, true);
  assert.equal(getSubmodel(big, { submodelId: 920010, flatten: true })!.truncated, false);
});

test('a non-finite maxPlacements falls back to the default', () => {
  assert.equal(getSubmodel(big, { submodelId: bigId, maxPlacements: NaN })!.steps.length, 15);
});

test('references to empty submodels consume the work budget and report truncation', () => {
  addSub(930001, []);
  addSub(930002, [[...Array.from({ length: 200 }, () => ({ child: 930001 }))]]);
  addSub(930003, [[...Array.from({ length: 200 }, () => ({ child: 930002 }))], [{ part: '3001' }]]);
  const t0 = Date.now();
  const r = getSubmodel(big, { submodelId: 930003, flatten: true })!;
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(r.truncated, true);
  assert.equal(r.nextStep, 2);
  assert.ok(submodelWork.visits <= WORK_LIMIT + 1);
  assert.ok(submodelWork.queries <= 10, `queries: ${submodelWork.queries}`);
});
