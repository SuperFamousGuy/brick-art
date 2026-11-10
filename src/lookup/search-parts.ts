import type { DatabaseSync } from 'node:sqlite';
import {
  ORDER_BY, SUMMARY_COLUMNS, buildPartWhere, clampLimit, toSummaries,
  type PartFilter, type PartSummary, type SummaryRow,
} from './common.ts';

export type SearchPartsArgs = PartFilter & { limit?: number };

/** Searches parts, ranked by set_count then last_year, excluding incomplete and printed parts by default. */
export function searchParts(db: DatabaseSync, args: SearchPartsArgs): PartSummary[] {
  const { limit, ...filter } = args;
  const { sql, params } = buildPartWhere(filter);
  const rows = db
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM parts p WHERE ${sql} ORDER BY ${ORDER_BY} LIMIT ?`)
    .all(...params, clampLimit(limit)) as unknown as SummaryRow[];
  return toSummaries(db, rows);
}
