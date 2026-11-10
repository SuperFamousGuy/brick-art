import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRebrickable } from '../../src/sources/rebrickable.ts';
import { buildSetProjects } from '../../src/projects/sets.ts';
import { writeFixtureSources } from '../helpers/fixtures.ts';

async function build(t: import('node:test').TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'brick-art-sets-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fx = await writeFixtureSources(dir);
  return buildSetProjects(await loadRebrickable(fx.rebrickableDir), 100);
}

test('buildSetProjects makes one official project per set with sequential ids', async (t) => {
  const { projects } = await build(t);
  assert.equal(projects.length, 4);
  assert.deepEqual(projects.map((p) => p.id), [100, 101, 102, 103]);
  assert.ok(projects.every((p) => !p.sourceKey.startsWith('fig-')));
  const s1 = projects.find((p) => p.sourceKey === 'S1-1')!;
  assert.equal(s1.theme, 'Harbor');
  assert.equal(s1.parentTheme, 'Town');
  assert.equal(s1.source, 'rebrickable');
  assert.equal(s1.kind, 'official');
  assert.equal(s1.url, 'https://rebrickable.com/sets/S1-1/');
  assert.equal(s1.hasPositions, false);
  assert.equal(s1.license, null);
  assert.equal(s1.author, null);
  assert.equal(s1.baseProjectId, null);
});

test('buildSetProjects uses only the highest-version inventory', async (t) => {
  const { projects, parts } = await build(t);
  const s3 = projects.find((p) => p.sourceKey === 'S3-1')!;
  const rows = parts.filter((r) => r.projectId === s3.id);
  assert.deepEqual(rows, [
    { projectId: s3.id, partNum: '3001', colorId: 4, quantity: 1, isSpare: false, fromMinifig: false },
  ]);
});

test('buildSetProjects adds minifig parts multiplied by quantity', async (t) => {
  const { projects, parts } = await build(t);
  const s1 = projects.find((p) => p.sourceKey === 'S1-1')!;
  const row = parts.find((r) => r.projectId === s1.id && r.partNum === '33085' && r.colorId === 4);
  assert.equal(row?.quantity, 2);
  assert.equal(row?.fromMinifig, true);
  assert.equal(row?.isSpare, false);
});

test('buildSetProjects flags spares and excludes them from partCount', async (t) => {
  const { projects, parts } = await build(t);
  const s4 = projects.find((p) => p.sourceKey === 'S4-1')!;
  const spare = parts.find((r) => r.projectId === s4.id && r.partNum === '3001' && r.isSpare);
  assert.ok(spare);
  const nonSpare = parts
    .filter((r) => r.projectId === s4.id && !r.isSpare)
    .reduce((n, r) => n + r.quantity, 0);
  assert.equal(s4.partCount, nonSpare);
});
