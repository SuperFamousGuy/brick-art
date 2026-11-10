import type { DatabaseSync } from 'node:sqlite';

export interface PartSummary {
  partNum: string;
  name: string;
  category: string | null;
  widthStuds: number | null;
  depthStuds: number | null;
  heightPlates: number | null;
  setCount: number;
  lastYear: number | null;
  traits: string[];
}

export type Range = number | [number, number];

export interface PartFilter {
  category?: string;
  width?: Range;
  depth?: Range;
  height?: Range;
  color?: number;
  colorFamily?: string;
  traits?: string[];
  slopeAngle?: number;
  minSetCount?: number;
  nameContains?: string;
  includeIncomplete?: boolean;
  includePrints?: boolean;
  /** Include parts of non-System lines such as Duplo, Modulex, and Fabuland. */
  includeNonSystem?: boolean;
}

export const ORDER_BY = 'p.set_count DESC, p.last_year DESC, p.part_num ASC';

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 200;

export function clampLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

const bounds = (r: Range): [number, number] => (typeof r === 'number' ? [r, r] : r);

/** SQL fragment matching `col` inside the inclusive range, pushing params. */
function inRange(col: string, r: Range, params: (string | number)[]): string {
  const [min, max] = bounds(r);
  params.push(min, max);
  return `${col} BETWEEN ? AND ?`;
}

export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

/** WHERE clause for the filter against `parts` aliased as `p`. Parameterized. */
export function buildPartWhere(f: PartFilter): { sql: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (!f.includeIncomplete) where.push('p.is_complete = 1');
  if (!f.includePrints) where.push('p.is_print = 0');
  if (!f.includeNonSystem) where.push('p.is_system = 1');
  if (f.category !== undefined) {
    where.push('LOWER(p.category_name) = LOWER(?)');
    params.push(f.category);
  }

  const { width, depth } = f;
  if (width !== undefined && depth !== undefined) {
    const a: (string | number)[] = [];
    const b: (string | number)[] = [];
    const sql =
      `((${inRange('p.width_studs', width, a)} AND ${inRange('p.depth_studs', depth, a)})` +
      ` OR (${inRange('p.width_studs', depth, b)} AND ${inRange('p.depth_studs', width, b)}))`;
    where.push(sql);
    params.push(...a, ...b);
  } else if (width !== undefined || depth !== undefined) {
    const r = (width ?? depth) as Range;
    const a: (string | number)[] = [];
    const b: (string | number)[] = [];
    where.push(`(${inRange('p.width_studs', r, a)} OR ${inRange('p.depth_studs', r, b)})`);
    params.push(...a, ...b);
  }
  if (f.height !== undefined) where.push(inRange('p.height_plates', f.height, params));

  if (f.color !== undefined) {
    where.push(
      `EXISTS (SELECT 1 FROM part_colors pc JOIN colors c ON c.id = pc.color_id
        WHERE pc.part_num = p.part_num AND pc.color_id = ? AND c.is_placeholder = 0)`,
    );
    params.push(f.color);
  }
  if (f.colorFamily !== undefined) {
    where.push(
      `EXISTS (SELECT 1 FROM part_colors pc JOIN colors c ON c.id = pc.color_id
        WHERE pc.part_num = p.part_num AND LOWER(c.family) = LOWER(?) AND c.is_placeholder = 0)`,
    );
    params.push(f.colorFamily);
  }
  for (const trait of new Set(f.traits ?? [])) {
    where.push('EXISTS (SELECT 1 FROM part_traits t WHERE t.part_num = p.part_num AND t.trait = ?)');
    params.push(trait);
  }
  if (f.slopeAngle !== undefined) {
    where.push('ABS(p.slope_angle - ?) < 0.5');
    params.push(f.slopeAngle);
  }
  if (f.minSetCount !== undefined) {
    where.push('p.set_count >= ?');
    params.push(f.minSetCount);
  }
  if (f.nameContains !== undefined && f.nameContains !== '') {
    where.push("LOWER(p.name) LIKE '%' || LOWER(?) || '%' ESCAPE '\\'");
    params.push(escapeLike(f.nameContains));
  }

  return { sql: where.length > 0 ? where.join(' AND ') : '1 = 1', params };
}

export interface SummaryRow {
  part_num: string;
  name: string;
  category_name: string | null;
  width_studs: number | null;
  depth_studs: number | null;
  height_plates: number | null;
  set_count: number | null;
  last_year: number | null;
}

export const SUMMARY_COLUMNS =
  'p.part_num, p.name, p.category_name, p.width_studs, p.depth_studs, p.height_plates, p.set_count, p.last_year';

/** Converts rows to summaries, loading all traits with one extra query. */
export function toSummaries(db: DatabaseSync, rows: SummaryRow[]): PartSummary[] {
  const traits = new Map<string, string[]>();
  if (rows.length > 0) {
    const marks = rows.map(() => '?').join(',');
    const found = db
      .prepare(`SELECT part_num, trait FROM part_traits WHERE part_num IN (${marks}) ORDER BY trait`)
      .all(...rows.map((r) => r.part_num)) as { part_num: string; trait: string }[];
    for (const t of found) {
      const list = traits.get(t.part_num);
      if (list) list.push(t.trait);
      else traits.set(t.part_num, [t.trait]);
    }
  }
  return rows.map((r) => ({
    partNum: r.part_num,
    name: r.name,
    category: r.category_name,
    widthStuds: r.width_studs,
    depthStuds: r.depth_studs,
    heightPlates: r.height_plates,
    setCount: r.set_count ?? 0,
    lastYear: r.last_year,
    traits: traits.get(r.part_num) ?? [],
  }));
}
