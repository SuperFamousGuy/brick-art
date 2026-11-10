import type { DatabaseSync } from 'node:sqlite';
import type { ConnectionType, Grid, Vec3 } from '../types.ts';

export interface PartDetail {
  partNum: string;
  name: string;
  categoryId: number | null;
  categoryName: string | null;
  ldrawFile: string | null;
  geometryFrom: string | null;
  widthStuds: number | null;
  depthStuds: number | null;
  heightPlates: number | null;
  minX: number | null; minY: number | null; minZ: number | null;
  maxX: number | null; maxY: number | null; maxZ: number | null;
  grid: Grid | null;
  slopeAngle: number | null;
  basicKind: string | null;
  setCount: number;
  firstYear: number | null;
  lastYear: number | null;
  license: string | null;
  hasGeometry: boolean;
  hasConnections: boolean;
  hasGrid: boolean;
  isComplete: boolean;
  isPrint: boolean;
  basePartNum: string | null;
  traits: string[];
  connections: {
    type: ConnectionType; position: Vec3; direction: Vec3;
    angleMin: number | null; angleMax: number | null; source: string;
  }[];
  colors: { id: number; name: string; rgb: string | null; setCount: number; lastYear: number | null }[];
  relationships: { relType: string; child: string; parent: string }[];
  creativeUses: { represents: string; note: string | null; status: 'reviewed' | 'suggestion' }[];
}

type Row = Record<string, any>;

/** Full detail for one part, or null when unknown. Applies no default exclusions. */
export function getPart(db: DatabaseSync, partNum: string): PartDetail | null {
  const p = db.prepare('SELECT * FROM parts WHERE part_num = ?').get(partNum) as Row | undefined;
  if (!p) return null;
  const all = (sql: string): Row[] => db.prepare(sql).all(partNum) as Row[];

  return {
    partNum: p.part_num, name: p.name, categoryId: p.category_id, categoryName: p.category_name,
    ldrawFile: p.ldraw_file, geometryFrom: p.geometry_from,
    widthStuds: p.width_studs, depthStuds: p.depth_studs, heightPlates: p.height_plates,
    minX: p.min_x, minY: p.min_y, minZ: p.min_z, maxX: p.max_x, maxY: p.max_y, maxZ: p.max_z,
    grid: p.grid === null || p.grid === undefined ? null : (JSON.parse(p.grid) as Grid),
    slopeAngle: p.slope_angle, basicKind: p.basic_kind,
    setCount: p.set_count ?? 0, firstYear: p.first_year, lastYear: p.last_year, license: p.license,
    hasGeometry: p.has_geometry === 1, hasConnections: p.has_connections === 1, hasGrid: p.has_grid === 1,
    isComplete: p.is_complete === 1, isPrint: p.is_print === 1, basePartNum: p.base_part_num,
    traits: all('SELECT trait FROM part_traits WHERE part_num = ? ORDER BY trait').map((r) => r.trait),
    connections: all('SELECT * FROM connections WHERE part_num = ? ORDER BY id').map((r) => ({
      type: r.type, position: [r.x, r.y, r.z] as Vec3, direction: [r.dx, r.dy, r.dz] as Vec3,
      angleMin: r.angle_min, angleMax: r.angle_max, source: r.source,
    })),
    colors: all(
      `SELECT c.id, c.name, c.rgb, pc.set_count, pc.last_year FROM part_colors pc
       JOIN colors c ON c.id = pc.color_id
       WHERE pc.part_num = ? AND c.is_placeholder = 0
       ORDER BY pc.set_count DESC, pc.last_year DESC, c.id ASC`,
    ).map((r) => ({ id: r.id, name: r.name, rgb: r.rgb, setCount: r.set_count ?? 0, lastYear: r.last_year })),
    relationships: (db
      .prepare(
        `SELECT rel_type, child_part_num, parent_part_num FROM part_relationships
         WHERE child_part_num = ? OR parent_part_num = ? ORDER BY rel_type, child_part_num, parent_part_num`,
      )
      .all(partNum, partNum) as Row[]).map((r) => ({
      relType: r.rel_type, child: r.child_part_num, parent: r.parent_part_num,
    })),
    creativeUses: all('SELECT represents, note, reviewed FROM creative_uses WHERE part_num = ? ORDER BY represents').map(
      (r) => ({ represents: r.represents, note: r.note, status: r.reviewed === 1 ? 'reviewed' : 'suggestion' }),
    ),
  };
}
