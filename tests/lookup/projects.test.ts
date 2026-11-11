import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seedFixture } from '../helpers/seeded.ts';
import { searchProjects } from '../../src/lookup/search-projects.ts';
import { getProject } from '../../src/lookup/get-project.ts';

let tmp: string;
let std: DatabaseSync;
let fallback: DatabaseSync;
const closers: (() => Promise<void>)[] = [];

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'brick-art-projects-'));
  const a = await seedFixture(join(tmp, 'std'), 'standard');
  const b = await seedFixture(join(tmp, 'fb'), 'fallback');
  closers.push(a.close, b.close);
  std = new DatabaseSync(a.dbFile, { readOnly: true });
  fallback = new DatabaseSync(b.dbFile, { readOnly: true });
});

after(async () => {
  std.close();
  fallback.close();
  for (const c of closers) await c();
  await rm(tmp, { recursive: true, force: true });
});

test('usesPart and usesColor rank the project with positions first', () => {
  const { results, note } = searchProjects(std, { usesPart: '3001', usesColor: 4 });
  assert.equal(results[0]!.sourceKey, 'S1-1');
  assert.equal(results[0]!.hasPositions, true);
  assert.deepEqual(results[0]!.submodels, ['10001 - main.ldr', '10001 - cab.ldr']);
  assert.equal(note, null);
});

test('theme matches the parent theme, and usesColor alone filters by color', () => {
  assert.equal(searchProjects(std, { theme: 'town' }).results.length, 4);
  assert.equal(searchProjects(std, { theme: 'harbor' }).results.length, 4);
  const byColor = searchProjects(std, { usesColor: 4 }).results;
  assert.ok(byColor.length > 0);
  assert.equal(searchProjects(std, { usesColor: 4, limit: 1 }).results.length, 1);
});

test('an exact name match outranks substring matches', () => {
  const all = searchProjects(std, {}).results;
  const last = all[all.length - 1]!;
  const first = searchProjects(std, { nameContains: last.name.toLowerCase() }).results[0]!;
  assert.equal(first.name.toLowerCase(), last.name.toLowerCase());
});

test('getProject lists the minifig part and the submodels', () => {
  const id = searchProjects(std, { nameContains: '' }).results.find((r) => r.sourceKey === 'S1-1')!.id;
  const p = getProject(std, id)!;
  assert.equal(p.submodels.length, 2);
  assert.equal(p.submodels[0]!.isMain, true);
  const banana = p.parts.find((x) => x.name?.toLowerCase().includes('banana'));
  assert.equal(banana?.fromMinifig, true);
  assert.ok(p.parts.every((x) => x.colorName !== undefined));
  assert.equal(p.note, null);
  assert.equal(getProject(std, 999999), null);
});

test('a project without positions carries the no-OMR note', () => {
  const noPos = searchProjects(std, { hasPositions: false }).results[0]!;
  assert.equal(getProject(std, noPos.id)!.note, 'This project has no positions in the LDraw model repository.');
});

test('fallback database sets the note', () => {
  const { results, note } = searchProjects(fallback, {});
  assert.equal(note, 'Build positions are not downloaded yet; they arrive with the next published release.');
  assert.equal(getProject(fallback, results[0]!.id)!.note, note);
});
