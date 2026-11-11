import type { DatabaseSync } from 'node:sqlite';
import type { SeedState } from '../seed/lock.ts';
import type { UpdateState } from '../release/download.ts';

export interface DatabaseStatus {
  state: string;
  seededAt: string | null;
  ldrawRelease: string | null;
  ldcadCommit: string | null;
  matchRateTop1000: number | null;
  counts: Record<string, number>;
  variant: string | null;
  origin: 'release' | 'local' | null;
  releaseTag: string | null;
  placementMatchRate: number | null;
  failedSources: string[];
  lastError: string | null;
  warnings: string[];
}

/**
 * Summarizes the seeded database and seed state. The state is "seeding" only while the
 * seed lock is held; a "seeding" state left by a crashed seed falls back to what exists.
 */
export function databaseStatus(
  db: DatabaseSync | null,
  state: SeedState,
  lockHeld: boolean,
  update: UpdateState,
): DatabaseStatus {
  const base = {
    lastError: state.lastError, warnings: [] as string[], origin: update.origin, releaseTag: update.releaseTag,
  };
  const seeding = state.status === 'seeding' && lockHeld;
  if (db === null) {
    const fallback = state.status !== 'seeding' ? state.status : state.lastError !== null ? 'failed' : 'idle';
    return {
      ...base, state: seeding ? 'seeding' : fallback, seededAt: null, ldrawRelease: null, ldcadCommit: null,
      matchRateTop1000: null, counts: {}, variant: update.variant, placementMatchRate: null, failedSources: [],
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
  const placementRate = (m.get('placement_match_rate') ?? '') !== '' && Number.isFinite(Number(m.get('placement_match_rate')))
    ? Number(m.get('placement_match_rate')) : null;
  const variant = m.get('variant') ?? update.variant;
  if (variant === 'fallback') base.warnings.push('positions not downloaded (fallback database)');
  return {
    ...base,
    variant,
    placementMatchRate: placementRate,
    failedSources: (m.get('failed_sources') ?? '').split(',').map((x) => x.trim()).filter((x) => x !== ''),
    state: seeding ? 'seeding' : 'ready',
    seededAt: m.get('finished_at') ?? null,
    ldrawRelease: m.get('ldraw_release') ?? null,
    ldcadCommit: m.get('ldcad_commit') ?? null,
    matchRateTop1000: rate,
    counts,
  };
}
