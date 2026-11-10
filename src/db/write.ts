import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { ConnectionPoint, Grid } from '../types.ts';

export interface PartRow {
  partNum: string;
  name: string | null;
  categoryId: number | null;
  categoryName: string | null;
  ldrawFile: string | null;
  geometryFrom: string | null;
  widthStuds: number | null;
  depthStuds: number | null;
  heightPlates: number | null;
  minX: number | null;
  minY: number | null;
  minZ: number | null;
  maxX: number | null;
  maxY: number | null;
  maxZ: number | null;
  grid: Grid | null;
  slopeAngle: number | null;
  basicKind: 'brick' | 'plate' | 'tile' | null;
  setCount: number | null;
  firstYear: number | null;
  lastYear: number | null;
  license: string | null;
  hasGeometry: boolean;
  hasConnections: boolean;
  hasGrid: boolean;
  isComplete: boolean;
  isPrint: boolean;
  basePartNum: string | null;
}
export interface ConnectionRow extends ConnectionPoint { partNum: string }
export interface TraitRow { partNum: string; trait: string }
export interface ColorRow {
  id: number; name: string; rgb: string | null; isTrans: boolean; family: string | null; isPlaceholder: boolean;
}
export interface PartColorRow {
  partNum: string; colorId: number; setCount: number | null; lastYear: number | null; inElements: boolean;
}
export interface RelationshipRow { relType: string; childPartNum: string; parentPartNum: string }
export interface CreativeUseRow {
  partNum: string; represents: string; note: string | null; reviewed: boolean; source: string | null;
}
export interface SourceRow {
  name: string; url: string | null; downloadedAt: string | null; bytes: number | null;
  sha256: string | null; lastModified: string | null;
}

const bit = (b: boolean): number => (b ? 1 : 0);

/** Runs one prepared INSERT per row inside a single transaction. */
function batch<T>(db: DatabaseSync, sql: string, rows: readonly T[], toParams: (row: T) => SQLInputValue[]): void {
  const stmt = db.prepare(sql);
  db.exec('BEGIN');
  try {
    for (const row of rows) stmt.run(...toParams(row));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const marks = (n: number): string => Array(n).fill('?').join(', ');

const PART_COLUMNS = [
  'part_num', 'name', 'category_id', 'category_name', 'ldraw_file', 'geometry_from',
  'width_studs', 'depth_studs', 'height_plates', 'min_x', 'min_y', 'min_z', 'max_x', 'max_y', 'max_z',
  'grid', 'slope_angle', 'basic_kind', 'set_count', 'first_year', 'last_year', 'license',
  'has_geometry', 'has_connections', 'has_grid', 'is_complete', 'is_print', 'base_part_num',
];

export function writeParts(db: DatabaseSync, rows: readonly PartRow[]): void {
  batch(db, `INSERT INTO parts (${PART_COLUMNS.join(', ')}) VALUES (${marks(PART_COLUMNS.length)})`, rows, (r) => [
    r.partNum, r.name, r.categoryId, r.categoryName, r.ldrawFile, r.geometryFrom,
    r.widthStuds, r.depthStuds, r.heightPlates, r.minX, r.minY, r.minZ, r.maxX, r.maxY, r.maxZ,
    r.grid === null ? null : JSON.stringify(r.grid), r.slopeAngle, r.basicKind, r.setCount, r.firstYear, r.lastYear,
    r.license, bit(r.hasGeometry), bit(r.hasConnections), bit(r.hasGrid), bit(r.isComplete), bit(r.isPrint),
    r.basePartNum,
  ]);
}

export function writePart(db: DatabaseSync, row: PartRow): void {
  writeParts(db, [row]);
}

export function writeConnections(db: DatabaseSync, rows: readonly ConnectionRow[]): void {
  batch(db,
    'INSERT INTO connections (part_num, type, x, y, z, dx, dy, dz, angle_min, angle_max, source, raw) VALUES (' + marks(12) + ')',
    rows, (r) => [
      r.partNum, r.type, r.position[0], r.position[1], r.position[2],
      r.direction[0], r.direction[1], r.direction[2], r.angleMin, r.angleMax, r.source, r.raw,
    ]);
}

export function writeTraits(db: DatabaseSync, rows: readonly TraitRow[]): void {
  batch(db, 'INSERT INTO part_traits (part_num, trait) VALUES (?, ?)', rows, (r) => [r.partNum, r.trait]);
}

export function writeColors(db: DatabaseSync, rows: readonly ColorRow[]): void {
  batch(db, 'INSERT INTO colors (id, name, rgb, is_trans, family, is_placeholder) VALUES (' + marks(6) + ')', rows,
    (r) => [r.id, r.name, r.rgb, bit(r.isTrans), r.family, bit(r.isPlaceholder)]);
}

export function writePartColors(db: DatabaseSync, rows: readonly PartColorRow[]): void {
  batch(db, 'INSERT INTO part_colors (part_num, color_id, set_count, last_year, in_elements) VALUES (' + marks(5) + ')',
    rows, (r) => [r.partNum, r.colorId, r.setCount, r.lastYear, bit(r.inElements)]);
}

export function writeRelationships(db: DatabaseSync, rows: readonly RelationshipRow[]): void {
  batch(db, 'INSERT INTO part_relationships (rel_type, child_part_num, parent_part_num) VALUES (?, ?, ?)', rows,
    (r) => [r.relType, r.childPartNum, r.parentPartNum]);
}

export function writeCreativeUses(db: DatabaseSync, rows: readonly CreativeUseRow[]): void {
  batch(db, 'INSERT INTO creative_uses (part_num, represents, note, reviewed, source) VALUES (' + marks(5) + ')', rows,
    (r) => [r.partNum, r.represents, r.note, bit(r.reviewed), r.source]);
}

export function writeSources(db: DatabaseSync, rows: readonly SourceRow[]): void {
  batch(db, 'INSERT INTO sources (name, url, downloaded_at, bytes, sha256, last_modified) VALUES (' + marks(6) + ')', rows,
    (r) => [r.name, r.url, r.downloadedAt, r.bytes, r.sha256, r.lastModified]);
}

export function writeManifest(db: DatabaseSync, entries: Record<string, string | number>): void {
  batch(db, 'INSERT OR REPLACE INTO manifest (key, value) VALUES (?, ?)', Object.entries(entries),
    ([k, v]) => [k, String(v)]);
}
