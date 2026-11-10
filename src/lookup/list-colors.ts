import type { DatabaseSync } from 'node:sqlite';

export interface ColorInfo {
  id: number;
  name: string;
  rgb: string | null;
  isTrans: boolean;
  family: string | null;
}

/** Lists non-placeholder colors, optionally by family or by the colors a part comes in. */
export function listColors(db: DatabaseSync, args: { family?: string; partNum?: string }): ColorInfo[] {
  const where = ['c.is_placeholder = 0'];
  const params: string[] = [];
  if (args.family !== undefined) {
    where.push('c.family = ?');
    params.push(args.family);
  }
  if (args.partNum !== undefined) {
    where.push('EXISTS (SELECT 1 FROM part_colors pc WHERE pc.color_id = c.id AND pc.part_num = ?)');
    params.push(args.partNum);
  }
  const rows = db
    .prepare(`SELECT c.id, c.name, c.rgb, c.is_trans, c.family FROM colors c WHERE ${where.join(' AND ')} ORDER BY c.id`)
    .all(...params) as { id: number; name: string; rgb: string | null; is_trans: number; family: string | null }[];
  return rows.map((r) => ({ id: r.id, name: r.name, rgb: r.rgb, isTrans: r.is_trans === 1, family: r.family }));
}
