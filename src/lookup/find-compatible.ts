import type { DatabaseSync } from 'node:sqlite';
import type { ConnectionType } from '../types.ts';
import {
  ORDER_BY, SUMMARY_COLUMNS, buildPartWhere, clampLimit, toSummaries,
  type PartFilter, type PartSummary, type SummaryRow,
} from './common.ts';

export type FindCompatibleArgs = PartFilter & {
  connectionType?: ConnectionType;
  partNum?: string;
  connectionIndex?: number;
  limit?: number;
};

export interface CompatibleMatch {
  part: PartSummary;
  matchingTypes: ConnectionType[];
}

function sourceTypes(db: DatabaseSync, a: FindCompatibleArgs): string[] {
  if (a.connectionType !== undefined) return [a.connectionType];
  const partNum = a.partNum as string;
  if (a.connectionIndex === undefined) {
    const rows = db
      .prepare('SELECT DISTINCT type FROM connections WHERE part_num = ?')
      .all(partNum) as { type: string }[];
    return rows.map((r) => r.type);
  }
  if (!Number.isInteger(a.connectionIndex) || a.connectionIndex < 0) return [];
  const row = db
    .prepare('SELECT type FROM connections WHERE part_num = ? ORDER BY id LIMIT 1 OFFSET ?')
    .get(partNum, a.connectionIndex) as { type: string } | undefined;
  return row ? [row.type] : [];
}

/** Finds parts with a connection that mates with the given connection type, or with a part's connections. */
export function findCompatible(db: DatabaseSync, args: FindCompatibleArgs): CompatibleMatch[] {
  if ((args.connectionType === undefined) === (args.partNum === undefined)) {
    throw new Error('give connectionType or partNum');
  }
  const sources = sourceTypes(db, args);
  if (sources.length === 0) return [];

  const marks = sources.map(() => '?').join(',');
  const targets = (
    db.prepare(`SELECT DISTINCT b FROM connection_compat WHERE a IN (${marks})`).all(...sources) as { b: string }[]
  ).map((r) => r.b);
  if (targets.length === 0) return [];

  const tmarks = targets.map(() => '?').join(',');
  const { connectionType: _t, partNum: _p, connectionIndex: _i, limit, ...filter } = args;
  const { sql, params } = buildPartWhere(filter);
  const rows = db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM parts p
       WHERE ${sql} AND EXISTS (SELECT 1 FROM connections c WHERE c.part_num = p.part_num AND c.type IN (${tmarks}))
       ORDER BY ${ORDER_BY} LIMIT ?`,
    )
    .all(...params, ...targets, clampLimit(limit)) as unknown as SummaryRow[];
  if (rows.length === 0) return [];

  const pmarks = rows.map(() => '?').join(',');
  const found = db
    .prepare(
      `SELECT DISTINCT part_num, type FROM connections
       WHERE part_num IN (${pmarks}) AND type IN (${tmarks}) ORDER BY type`,
    )
    .all(...rows.map((r) => r.part_num), ...targets) as { part_num: string; type: string }[];
  const types = new Map<string, ConnectionType[]>();
  for (const f of found) {
    const list = types.get(f.part_num);
    if (list) list.push(f.type as ConnectionType);
    else types.set(f.part_num, [f.type as ConnectionType]);
  }
  const summaries = toSummaries(db, rows);
  return rows.map((r, i) => ({ part: summaries[i]!, matchingTypes: types.get(r.part_num) ?? [] }));
}
