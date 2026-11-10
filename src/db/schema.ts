import type { DatabaseSync } from 'node:sqlite';

export const SEED_VERSION = 2;

// Pairs are listed once; createSchema stores both directions.
const COMPAT_PAIRS: [string, string][] = [
  ['stud', 'stud_receptor'],
  ['bar', 'clip'],
  ['bar', 'bar_holder'],
  ['pin', 'pin_hole'],
  ['axle', 'axle_hole'],
  ['axle', 'pin_hole'],
  ['ball', 'socket'],
  ['hinge_m', 'hinge_f'],
];

const DDL = `
CREATE TABLE manifest (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE sources (
  name TEXT PRIMARY KEY, url TEXT, downloaded_at TEXT, bytes INTEGER, sha256 TEXT, last_modified TEXT
);
CREATE TABLE parts (
  part_num TEXT PRIMARY KEY, name TEXT, category_id INTEGER, category_name TEXT,
  ldraw_file TEXT, geometry_from TEXT,
  width_studs INTEGER, depth_studs INTEGER, height_plates INTEGER,
  min_x REAL, min_y REAL, min_z REAL, max_x REAL, max_y REAL, max_z REAL,
  grid TEXT, slope_angle REAL, basic_kind TEXT,
  set_count INTEGER, first_year INTEGER, last_year INTEGER, license TEXT,
  has_geometry INTEGER, has_connections INTEGER, has_grid INTEGER,
  is_complete INTEGER, is_print INTEGER, base_part_num TEXT, is_system INTEGER
);
CREATE TABLE part_traits (part_num TEXT, trait TEXT, PRIMARY KEY (part_num, trait));
CREATE TABLE connections (
  id INTEGER PRIMARY KEY, part_num TEXT, type TEXT,
  x REAL, y REAL, z REAL, dx REAL, dy REAL, dz REAL,
  angle_min REAL, angle_max REAL, source TEXT, raw TEXT
);
CREATE TABLE connection_compat (a TEXT, b TEXT);
CREATE TABLE colors (
  id INTEGER PRIMARY KEY, name TEXT, rgb TEXT, is_trans INTEGER, family TEXT, is_placeholder INTEGER
);
CREATE TABLE part_colors (
  part_num TEXT, color_id INTEGER, set_count INTEGER, last_year INTEGER, in_elements INTEGER,
  PRIMARY KEY (part_num, color_id)
);
CREATE TABLE part_relationships (rel_type TEXT, child_part_num TEXT, parent_part_num TEXT);
CREATE TABLE creative_uses (part_num TEXT, represents TEXT, note TEXT, reviewed INTEGER, source TEXT);
CREATE INDEX idx_parts_complete_sets ON parts(is_complete, set_count);
CREATE INDEX idx_parts_dims ON parts(width_studs, depth_studs, height_plates);
CREATE INDEX idx_connections_part ON connections(part_num);
CREATE INDEX idx_connections_type ON connections(type);
CREATE INDEX idx_part_colors_color ON part_colors(color_id);
CREATE INDEX idx_creative_uses_represents ON creative_uses(represents);
`;

export function createSchema(db: DatabaseSync): void {
  db.exec(DDL);
  const ins = db.prepare('INSERT INTO connection_compat (a, b) VALUES (?, ?)');
  db.exec('BEGIN');
  try {
    for (const [a, b] of COMPAT_PAIRS) {
      ins.run(a, b);
      ins.run(b, a);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
