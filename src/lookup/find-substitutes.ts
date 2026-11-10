import type { DatabaseSync } from 'node:sqlite';
import { ORDER_BY, buildPartWhere, type SummaryRow } from './common.ts';

export interface FindSubstitutesArgs {
  partNum: string;
  color: number;
  limit?: number;
}

export interface Substitute {
  kind: 'related' | 'combination';
  parts: string[];
  note: string;
}

const DEFAULT_SUBSTITUTE_LIMIT = 10;
const REL_NAMES: Record<string, string> = { M: 'alternate mold', A: 'alternate' };

interface Candidate {
  partNum: string;
  length: number;
  setCount: number;
}

function relatedOptions(db: DatabaseSync, partNum: string, color: number): Substitute[] {
  const { sql, params } = buildPartWhere({ color });
  const rows = db
    .prepare(
      `SELECT l.rel_type, p.part_num FROM (
         SELECT rel_type, parent_part_num AS other FROM part_relationships WHERE child_part_num = ?
         UNION
         SELECT rel_type, child_part_num AS other FROM part_relationships WHERE parent_part_num = ?
       ) l JOIN parts p ON p.part_num = l.other
       WHERE l.rel_type IN ('M', 'A') AND ${sql}
       ORDER BY ${ORDER_BY}, l.rel_type`,
    )
    .all(partNum, partNum, ...params) as { rel_type: string; part_num: string }[];
  const seen = new Set<string>();
  const out: Substitute[] = [];
  for (const r of rows) {
    const key = `${r.rel_type}:${r.part_num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: 'related', parts: [r.part_num], note: `${REL_NAMES[r.rel_type]} of ${partNum}` });
  }
  return out;
}

function combinationOptions(db: DatabaseSync, partNum: string, color: number): Substitute[] {
  const src = db
    .prepare('SELECT basic_kind, width_studs, depth_studs, height_plates FROM parts WHERE part_num = ?')
    .get(partNum) as
    | { basic_kind: string | null; width_studs: number | null; depth_studs: number | null; height_plates: number | null }
    | undefined;
  if (!src || !src.basic_kind || src.width_studs === null || src.depth_studs === null || src.height_plates === null) {
    return [];
  }
  const width = Math.min(src.width_studs, src.depth_studs);
  const length = Math.max(src.width_studs, src.depth_studs);

  const { sql, params } = buildPartWhere({ color });
  const rows = db
    .prepare(
      `SELECT p.part_num, p.width_studs, p.depth_studs, p.set_count FROM parts p
       WHERE ${sql} AND p.basic_kind = ? AND p.height_plates = ?
         AND MIN(p.width_studs, p.depth_studs) = ? AND MAX(p.width_studs, p.depth_studs) < ?
       ORDER BY p.part_num ASC`,
    )
    .all(...params, src.basic_kind, src.height_plates, width, length) as unknown as (SummaryRow & {
    width_studs: number;
    depth_studs: number;
  })[];
  const cands: Candidate[] = rows.map((r) => ({
    partNum: r.part_num,
    length: Math.max(r.width_studs, r.depth_studs),
    setCount: r.set_count ?? 0,
  }));

  const combos: Candidate[][] = [];
  for (let i = 0; i < cands.length; i++) {
    for (let j = i; j < cands.length; j++) {
      const sum2 = cands[i]!.length + cands[j]!.length;
      if (sum2 === length) combos.push([cands[i]!, cands[j]!]);
      for (let k = j; k < cands.length; k++) {
        if (sum2 + cands[k]!.length === length) combos.push([cands[i]!, cands[j]!, cands[k]!]);
      }
    }
  }

  const options = combos.map((c) => ({
    parts: c.map((x) => x.partNum),
    count: c.length,
    sets: c.reduce((s, x) => s + x.setCount, 0),
    note: `${c.length} parts: ${c.map((x) => `${width}x${x.length}`).join(' + ')}`,
  }));
  options.sort(
    (a, b) => a.count - b.count || b.sets - a.sets || (a.parts.join(',') < b.parts.join(',') ? -1 : a.parts.join(',') > b.parts.join(',') ? 1 : 0),
  );
  return options.map((o) => ({ kind: 'combination', parts: o.parts, note: o.note }));
}

/** Suggests ways to get a part in a color it does not come in: alternates, or shorter parts that add up. */
export function findSubstitutes(db: DatabaseSync, args: FindSubstitutesArgs): Substitute[] {
  const { partNum, color } = args;
  const exists = db.prepare('SELECT 1 FROM parts WHERE part_num = ?').get(partNum);
  if (!exists) return [];
  const available = db
    .prepare('SELECT 1 FROM part_colors WHERE part_num = ? AND color_id = ?')
    .get(partNum, color);
  if (available) return [];

  const limit = Number.isFinite(args.limit)
    ? Math.min(200, Math.max(1, Math.trunc(args.limit as number)))
    : DEFAULT_SUBSTITUTE_LIMIT;
  return [...relatedOptions(db, partNum, color), ...combinationOptions(db, partNum, color)].slice(0, limit);
}
