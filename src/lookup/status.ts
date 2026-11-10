import type { DatabaseSync } from 'node:sqlite';
import type { SeedState } from '../seed/lock.ts';

export interface DatabaseStatus {
  state: string;
  seededAt: string | null;
  ldrawRelease: string | null;
  ldcadCommit: string | null;
  matchRateTop1000: number | null;
  counts: Record<string, number>;
  lastError: string | null;
  warnings: string[];
}

/** Summarizes the seeded database and seed state. */
export function databaseStatus(db: DatabaseSync | null, state: SeedState): DatabaseStatus {
  const base = { lastError: state.lastError, warnings: [] as string[] };
  if (db === null) {
    return {
      ...base, state: state.status, seededAt: null, ldrawRelease: null, ldcadCommit: null,
      matchRateTop1000: null, counts: {},
    };
  }
  const m = new Map(
    (db.prepare('SELECT key, value FROM manifest').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]),
  );
  const counts: Record<string, number> = {};
  for (const [k, v] of m) {
    if (k.startsWith('count_') && Number.isFinite(Number(v))) counts[k.slice('count_'.length)] = Number(v);
  }
  const rate = m.has('match_rate_top1000') && Number.isFinite(Number(m.get('match_rate_top1000')))
    ? Number(m.get('match_rate_top1000')) : null;
  if (rate !== null && rate < 0.95) base.warnings.push('match rate below 95%');
  return {
    ...base,
    state: state.status === 'seeding' ? 'seeding' : 'ready',
    seededAt: m.get('finished_at') ?? null,
    ldrawRelease: m.get('ldraw_release') ?? null,
    ldcadCommit: m.get('ldcad_commit') ?? null,
    matchRateTop1000: rate,
    counts,
  };
}
