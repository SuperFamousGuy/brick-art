import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seedFixture } from '../helpers/seeded.ts';
import { searchProjects } from '../../src/lookup/search-projects.ts';
import { getProject } from '../../src/lookup/get-project.ts';

let tmp: string;
let std: DatabaseSync;
let fallback: DatabaseSync;
let extra: DatabaseSync;
const closers: (() => Promise<void>)[] = [];

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'brick-art-projects-'));
  const a = await seedFixture(join(tmp, 'std'), 'standard');
  const b = await seedFixture(join(tmp, 'fb'), 'fallback');
  closers.push(a.close, b.close);
  std = new DatabaseSync(a.dbFile, { readOnly: true });
  fallback = new DatabaseSync(b.dbFile, { readOnly: true });
  // A writable copy with extra rows for ranking, kind, and wildcard cases.
  const copy = join(tmp, 'extra.db');
  await copyFile(a.dbFile, copy);
  extra = new DatabaseSync(copy);
  const ins = extra.prepare(
    'INSERT INTO projects (id, source, source_key, kind, name, year, theme, part_count, has_positions) VALUES (?,?,?,?,?,?,?,?,?)',
  );
  ins.run(10, 'fixture_fan', 'f-tower', 'fan', 'Tower', 2010, 'Fan', 100, 0);
  ins.run(11, 'rebrickable', 'X-1', 'official', 'Big Tower', 2015, 'Fan', 200, 0);
  ins.run(12, 'fixture_fan', 'f-pct', 'fan', '50% off_sale', 2011, 'Fan', 5, 0);
  ins.run(13, 'fixture_fan', 'f-pct2', 'fan', '50xx offYsale', 2012, 'Fan', 5, 0);
});

after(async () => {
  std.close();
  fallback.close();
  extra.close();
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

test('theme matches the parent theme', () => {
  assert.equal(searchProjects(std, { theme: 'town' }).results.length, 4);
  assert.equal(searchProjects(std, { theme: 'harbor' }).results.length, 4);
  assert.equal(searchProjects(std, { theme: 'nothing' }).results.length, 0);
});

test('usesColor alone keeps exactly the projects with a part in that color', () => {
  const ids = (c: number) => searchProjects(std, { usesColor: c }).results.map((r) => r.id).sort();
  for (const color of [4, 2]) {
    const expected = (std
      .prepare('SELECT DISTINCT project_id FROM project_parts WHERE color_id = ? ORDER BY project_id')
      .all(color) as { project_id: number }[]).map((r) => r.project_id);
    assert.deepEqual(ids(color), expected);
  }
  assert.deepEqual(ids(2), [2]);
  assert.ok(!ids(2).includes(1));
  assert.equal(searchProjects(std, { usesColor: 4, limit: 1 }).results.length, 1);
});

test('an exact name match outranks a substring match with a later-sorting year', () => {
  const names = searchProjects(extra, { nameContains: 'tower' }).results.map((r) => r.name);
  assert.deepEqual(names, ['Tower', 'Big Tower']);
  const sub = searchProjects(extra, { nameContains: 'tow' }).results.map((r) => r.name);
  assert.deepEqual(sub, ['Big Tower', 'Tower']);
});

test('year, kind, partCount, and hasPositions filters', () => {
  const names = (f: Parameters<typeof searchProjects>[1]) => searchProjects(std, f).results.map((r) => r.name);
  assert.deepEqual(names({ year: 2022 }), ['Set Two']);
  assert.deepEqual(names({ year: [2020, 2022] }), ['Set One', 'Set Two']);
  assert.deepEqual(names({ partCount: [6, 14] }), ['Set One', 'Set Two']);
  assert.deepEqual(names({ partCount: 14 }), ['Set Two']);
  assert.deepEqual(names({ hasPositions: true }), ['Set One']);
  assert.equal(names({ hasPositions: false }).length, 3);
  assert.equal(names({ kind: 'official' }).length, 4);
  assert.deepEqual(names({ kind: 'fan' }), []);
  const fan = searchProjects(extra, { kind: 'fan', nameContains: 'tower' }).results;
  assert.deepEqual(fan.map((r) => r.name), ['Tower']);
});

test('nameContains treats % and _ literally', () => {
  const names = (q: string) => searchProjects(extra, { nameContains: q }).results.map((r) => r.name);
  assert.deepEqual(names('0% off_s'), ['50% off_sale']);
  assert.deepEqual(names('%'), ['50% off_sale']);
  assert.deepEqual(names('_'), ['50% off_sale']);
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
