import type { DatabaseSync } from 'node:sqlite';
import type { Bounds, ConnectionType, Grid, Vec3 } from '../types.ts';

export interface PartGeom {
  /** Part-local LDU. */
  bounds: Bounds;
  /** [layer][z][x]; layer 0 = top (min y); cell = 20 x 8 x 20 LDU, anchored at bounds.min. */
  grid: Grid | null;
  /** Null when the part has no connection data. */
  connections: { type: ConnectionType; position: Vec3; direction: Vec3 }[] | null;
}

export interface GeometrySource {
  /** Null when the part is unknown or has no geometry. */
  get(ldrawFile: string): PartGeom | null;
  compatible(a: ConnectionType, b: ConnectionType): boolean;
}

type Row = Record<string, any>;

export function dbGeometry(db: DatabaseSync): GeometrySource {
  const byFile = db.prepare('SELECT * FROM parts WHERE lower(ldraw_file) = ?');
  const byNum = db.prepare('SELECT * FROM parts WHERE part_num = ?');
  const conns = db.prepare('SELECT type, x, y, z, dx, dy, dz FROM connections WHERE part_num = ? ORDER BY id');
  const compat = new Set(
    (db.prepare('SELECT a, b FROM connection_compat').all() as Row[]).map((r) => `${r.a}|${r.b}`),
  );
  const cache = new Map<string, PartGeom | null>();

  function load(key: string): PartGeom | null {
    const p = ((byFile.get(key) ?? byNum.get(key.replace(/\.dat$/, ''))) as Row | undefined);
    if (!p || p.min_x == null || p.max_x == null) return null;
    return {
      bounds: { min: [p.min_x, p.min_y, p.min_z], max: [p.max_x, p.max_y, p.max_z] },
      grid: p.grid == null ? null : (JSON.parse(p.grid) as Grid),
      connections:
        p.has_connections === 1
          ? (conns.all(p.part_num) as Row[]).map((r) => ({
              type: r.type as ConnectionType,
              position: [r.x, r.y, r.z] as Vec3,
              direction: [r.dx, r.dy, r.dz] as Vec3,
            }))
          : null,
    };
  }

  return {
    get(ldrawFile) {
      const key = ldrawFile.toLowerCase();
      if (!cache.has(key)) cache.set(key, load(key));
      return cache.get(key)!;
    },
    compatible: (a, b) => compat.has(`${a}|${b}`),
  };
}
