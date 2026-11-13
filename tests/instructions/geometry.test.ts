import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../../src/db/schema.ts';
import { dbGeometry } from '../../src/instructions/geometry.ts';

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  createSchema(db);
  const grid = [[[1, 1], [1, 1]]];
  db.prepare(
    `INSERT INTO parts (part_num, ldraw_file, min_x, min_y, min_z, max_x, max_y, max_z, grid, has_geometry, has_connections, has_grid)
     VALUES ('3001', '3001.dat', -20, -24, -10, 20, 0, 10, ?, 1, 1, 1)`,
  ).run(JSON.stringify(grid));
  db.prepare(
    `INSERT INTO parts (part_num, ldraw_file, min_x, min_y, min_z, max_x, max_y, max_z, has_geometry, has_connections, has_grid)
     VALUES ('3005', '3005.dat', -10, -24, -10, 10, 0, 10, 1, 0, 0)`,
  ).run();
  const c = db.prepare('INSERT INTO connections (part_num, type, x, y, z, dx, dy, dz) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  c.run('3001', 'stud', 10, -24, 0, 0, -1, 0);
  c.run('3001', 'stud_receptor', 10, 0, 0, 0, 1, 0);
  db.prepare(
    `INSERT INTO parts (part_num, ldraw_file, min_x, min_y, min_z, max_x, max_y, max_z, has_geometry, has_connections, has_grid)
     VALUES ('3707', '3707.dat', -80, -3, -3, 80, 3, 3, 1, 1, 0)`,
  ).run();
  db.prepare('INSERT INTO connections (part_num, type, x, y, z, dx, dy, dz, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('3707', 'axle', 0, 0, 0, 1, 0, 0, '0 !LDCAD SNAP_CYL [gender=M] [caps=none] [secs=A 6 160] [center=true] [slide=true] [ori=0 -1 0 1 0 0 0 0 1]');
  return db;
}

test('dbGeometry reads bounds, grid, and connections', () => {
  const g = dbGeometry(makeDb()).get('3001.DAT');
  assert.ok(g);
  assert.deepEqual(g.bounds, { min: [-20, -24, -10], max: [20, 0, 10] });
  assert.deepEqual(g.grid, [[[1, 1], [1, 1]]]);
  assert.equal(g.connections?.length, 2);
  assert.deepEqual(g.connections?.[0], { type: 'stud', position: [10, -24, 0], direction: [0, -1, 0] });
});

test('compatible follows connection_compat', () => {
  const s = dbGeometry(makeDb());
  assert.equal(s.compatible('stud', 'stud_receptor'), true);
  assert.equal(s.compatible('stud', 'stud'), false);
});

test('missing connections is null, unknown part is null', () => {
  const s = dbGeometry(makeDb());
  assert.equal(s.get('3005.dat')?.connections, null);
  assert.equal(s.get('nope.dat'), null);
});

test('a sliding centred connection carries its half length as span', () => {
  const g = dbGeometry(makeDb()).get('3707.dat');
  assert.deepEqual(g?.connections, [{ type: 'axle', position: [0, 0, 0], direction: [1, 0, 0], span: 80 }]);
});
