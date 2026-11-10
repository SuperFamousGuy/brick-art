import type { DatabaseSync } from 'node:sqlite';
import {
  ORDER_BY, SUMMARY_COLUMNS, buildPartWhere, clampLimit, escapeLike, toSummaries,
  type PartFilter, type PartSummary, type SummaryRow,
} from './common.ts';

export type FindByUseArgs = PartFilter & {
  represents: string;
  limit?: number;
};

export interface UseMatch {
  part: PartSummary;
  represents: string;
  note: string | null;
  status: 'reviewed' | 'suggestion';
}

type UseRow = SummaryRow & { represents: string; note: string | null; reviewed: number };

/** Finds parts by what they can represent. Reviewed uses rank first; unreviewed ones are suggestions. */
export function findByUse(db: DatabaseSync, args: FindByUseArgs): UseMatch[] {
  const { represents, limit, ...filter } = args;
  if (represents === '') return [];
  const { sql, params } = buildPartWhere(filter);
  const rows = db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS}, cu.represents, cu.note, cu.reviewed
       FROM creative_uses cu JOIN parts p ON p.part_num = cu.part_num
       WHERE LOWER(cu.represents) LIKE '%' || LOWER(?) || '%' ESCAPE '\\' AND ${sql}
       ORDER BY cu.reviewed DESC, ${ORDER_BY}, cu.represents ASC LIMIT ?`,
    )
    .all(escapeLike(represents), ...params, clampLimit(limit)) as unknown as UseRow[];
  const summaries = toSummaries(db, rows);
  return rows.map((r, i) => ({
    part: summaries[i]!,
    represents: r.represents,
    note: r.note,
    status: r.reviewed ? 'reviewed' : 'suggestion',
  }));
}
