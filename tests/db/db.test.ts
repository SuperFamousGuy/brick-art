import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSchema, SEED_VERSION } from '../../src/db/schema.ts';
import {
  writeManifest, writeParts, writePart, writeConnections, writeTraits, writeColors,
  writePartColors, writeRelationships, writeCreativeUses, writeSources,
  writeProjects, writeProjectParts, writeSubmodels, writePlacements,
} from '../../src/db/write.ts';
import type { PartRow } from '../../src/db/write.ts';
import { CurrentDb, readPointer, writePointer } from '../../src/db/open.ts';
import { dataPaths } from '../../src/paths.ts';

let dir: string;
before(async () => { dir = await mkdtemp(join(tmpdir(), 'db-')); });
after(() => rm(dir, { recursive: true, force: true }));

function names(db: DatabaseSync, type: string): string[] {
  return (db.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').all(type) as { name: string }[])
    .map((r) => r.name);
}

function makeDb(file: string, seedVersion: number): void {
  const db = new DatabaseSync(file);
  createSchema(db);
  writeManifest(db, { seed_version: seedVersion });
  db.close();
}

const part = (n: string, over: Partial<PartRow> = {}): PartRow => ({
  partNum: n, name: `Brick ${n}`, categoryId: 11, categoryName: 'Bricks', ldrawFile: `${n}.dat`,
  geometryFrom: `${n}.dat`, widthStuds: 2, depthStuds: 4, heightPlates: 3,
  minX: -40, minY: -24, minZ: -20, maxX: 40, maxY: 0, maxZ: 20, grid: [[[1]]], slopeAngle: null,
  basicKind: 'brick', setCount: 10, firstYear: 1970, lastYear: 2024, license: 'CC BY 4.0',
  hasGeometry: true, hasConnections: true, hasGrid: true, isComplete: true, isPrint: false,
  basePartNum: null, isSystem: true, ...over,
});

test('createSchema creates all 14 tables and symmetric compat rows', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  assert.deepEqual(names(db, 'table'), [
    'colors', 'connection_compat', 'connections', 'creative_uses', 'manifest',
    'part_colors', 'part_relationships', 'part_traits', 'parts', 'placements',
    'project_parts', 'projects', 'sources', 'submodels',
  ]);
  assert.equal(names(db, 'index').filter((n) => !n.startsWith('sqlite_')).length, 13);
  const has = (a: string, b: string) =>
    db.prepare('SELECT 1 AS x FROM connection_compat WHERE a = ? AND b = ?').get(a, b) !== undefined;
  assert.ok(has('stud', 'stud_receptor') && has('stud_receptor', 'stud'));
  assert.ok(has('axle', 'pin_hole') && has('pin_hole', 'axle'));
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM connection_compat').get() as { n: number }).n, 16);
  assert.equal(SEED_VERSION, 3);
  db.close();
});

test('writers store rows with exact column names', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  writeParts(db, [part('3001'), part('3002', { grid: null, hasGrid: false, isComplete: false })]);
  writePart(db, part('3003'));
  const p = db.prepare('SELECT * FROM parts WHERE part_num = ?').get('3001') as Record<string, unknown>;
  assert.equal(p.width_studs, 2);
  assert.equal(p.is_complete, 1);
  assert.equal(p.is_print, 0);
  assert.equal(p.grid, '[[[1]]]');
  assert.equal((db.prepare('SELECT grid FROM parts WHERE part_num = ?').get('3002') as { grid: unknown }).grid, null);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM parts').get() as { n: number }).n, 3);

  writeConnections(db, [{
    partNum: '3001', type: 'stud', position: [1, 2, 3], direction: [0, -1, 0],
    angleMin: null, angleMax: null, source: 'ldcad', raw: 'raw', snapId: null,
  }]);
  const c = db.prepare('SELECT * FROM connections').get() as Record<string, unknown>;
  assert.deepEqual([c.part_num, c.type, c.x, c.y, c.z, c.dx, c.dy, c.dz, c.angle_min, c.source, c.raw],
    ['3001', 'stud', 1, 2, 3, 0, -1, 0, null, 'ldcad', 'raw']);

  writeTraits(db, [{ partNum: '3001', trait: 'studded' }]);
  writeColors(db, [{ id: 4, name: 'Red', rgb: 'C91A09', isTrans: false, family: 'red', isPlaceholder: false }]);
  writePartColors(db, [{ partNum: '3001', colorId: 4, setCount: 5, lastYear: 2020, inElements: true }]);
  writeRelationships(db, [{ relType: 'M', childPartNum: '3002', parentPartNum: '3001' }]);
  writeCreativeUses(db, [{ partNum: '3001', represents: 'wall', note: null, reviewed: true, source: 'curated' }]);
  writeSources(db, [{ name: 'parts', url: 'http://x', downloadedAt: '2026-01-01', bytes: 5, sha256: 'ab', lastModified: null }]);
  writeManifest(db, { seed_version: 1, curated_hash: 'h' });
  const one = (sql: string) => db.prepare(sql).get() as Record<string, unknown>;
  assert.equal(one('SELECT in_elements AS v FROM part_colors').v, 1);
  assert.equal(one('SELECT is_placeholder AS v FROM colors').v, 0);
  assert.equal(one('SELECT reviewed AS v FROM creative_uses').v, 1);
  assert.equal(one('SELECT bytes AS v FROM sources').v, 5);
  assert.equal(one('SELECT child_part_num AS v FROM part_relationships').v, '3002');
  assert.equal(one("SELECT value AS v FROM manifest WHERE key = 'seed_version'").v, '1');
  db.close();
});

test('a failing batch rolls back entirely', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  assert.throws(() => writeParts(db, [part('1'), part('1')]));
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM parts').get() as { n: number }).n, 0);
  writeParts(db, [part('2')]);
  db.close();
});

test('CurrentDb returns null without a pointer', () => {
  const cur = new CurrentDb(join(dir, 'empty'));
  assert.equal(cur.get(), null);
  assert.equal(readPointer(join(dir, 'empty')), null);
  cur.close();
});

test('CurrentDb returns null when the pointed file is missing', async () => {
  const d = await mkdtemp(join(dir, 'missing-'));
  writePointer(d, 'parts-nope.db');
  const cur = new CurrentDb(d);
  assert.equal(cur.get(), null);
  cur.close();
});

test('CurrentDb follows the pointer and closes the old handle', async () => {
  const d = await mkdtemp(join(dir, 'ptr-'));
  const paths = dataPaths(d);
  makeDb(paths.dbFile('A'), 1);
  writePointer(d, 'parts-A.db');
  assert.equal(readPointer(d), 'parts-A.db');
  const cur = new CurrentDb(d);
  const a = cur.get()!;
  const val = (db: DatabaseSync) =>
    (db.prepare("SELECT value AS v FROM manifest WHERE key = 'seed_version'").get() as { v: string }).v;
  assert.equal(val(a), '1');
  assert.equal(cur.get(), a);

  makeDb(paths.dbFile('B'), 2);
  writePointer(d, 'parts-B.db');
  const b = cur.get()!;
  assert.notEqual(b, a);
  assert.equal(val(b), '2');
  assert.throws(() => a.prepare('SELECT 1'));
  assert.deepEqual((await readdir(d)).filter((f) => f.endsWith('.tmp')), []);
  cur.close();
  assert.throws(() => b.prepare('SELECT 1'));
});

test('project writers store rows and round-trip the matrix', () => {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const project = {
    id: 1, source: 'rebrickable', sourceKey: '10001-1', kind: 'official' as const, name: 'Set', year: 2020,
    theme: 'City', parentTheme: null, partCount: 5, author: null, license: null, url: null,
    hasPositions: true, baseProjectId: null,
  };
  writeProjects(db, [project]);
  writeProjectParts(db, [{ projectId: 1, partNum: '3001', colorId: 4, quantity: 2, isSpare: false, fromMinifig: true }]);
  writeSubmodels(db, [{ id: 7, projectId: 1, name: 'main.ldr', isMain: true, stepCount: 3, partCount: 5 }]);
  const matrix = [0, 0, 1, 0, 1, 0, -1, 0, 0] as const;
  writePlacements(db, [{
    submodelId: 7, step: 1, seq: 2, partNum: '3001', ldrawFile: '3001.dat', ldrawColor: 16, colorId: null,
    childSubmodelId: null, refKind: 'part', pos: [10, -24, 30], matrix: [...matrix] as never,
  }]);
  const p = db.prepare('SELECT * FROM projects').get() as Record<string, unknown>;
  assert.equal(p.source_key, '10001-1');
  assert.equal(p.has_positions, 1);
  assert.equal(p.base_project_id, null);
  const pp = db.prepare('SELECT * FROM project_parts').get() as Record<string, unknown>;
  assert.deepEqual([pp.quantity, pp.is_spare, pp.from_minifig], [2, 0, 1]);
  const sm = db.prepare('SELECT * FROM submodels').get() as Record<string, unknown>;
  assert.deepEqual([sm.id, sm.is_main, sm.step_count, sm.part_count], [7, 1, 3, 5]);
  const pl = db.prepare('SELECT * FROM placements').get() as Record<string, unknown>;
  assert.deepEqual([pl.x, pl.y, pl.z, pl.color_id, pl.child_submodel_id, pl.ref_kind], [10, -24, 30, null, null, 'part']);
  assert.deepEqual(JSON.parse(pl.matrix as string), matrix);
  assert.throws(() => writeProjects(db, [{ ...project, id: 2 }]), /UNIQUE/);
  db.close();
});
