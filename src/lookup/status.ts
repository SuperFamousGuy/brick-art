import type { DatabaseSync } from 'node:sqlite';
import type { SeedState } from '../seed/lock.ts';
import { originOf } from '../release/download.ts';
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
  /** One short credit line per source the database uses. */
  credits: string[];
}

/** Date (YYYY-MM-DD) of the newest Rebrickable download in the sources table, or null. */
export function rebrickableDate(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT max(downloaded_at) AS d FROM sources WHERE name NOT IN ('ldraw', 'ldcad')")
    .get() as { d: string | null };
  return row.d === null ? null : row.d.slice(0, 10);
}

const REBRICKABLE_CREDIT = 'Data sourced from Rebrickable (rebrickable.com).';

/** One credit line per source: Rebrickable, the LDraw library, LDCad, the OMR when used, and each fan source. */
function creditLines(db: DatabaseSync, m: Map<string, string>): string[] {
  const date = rebrickableDate(db);
  const lines = [date === null ? REBRICKABLE_CREDIT : `Data sourced from Rebrickable (rebrickable.com), downloaded ${date}.`];
  const release = m.get('ldraw_release');
  lines.push(`LDraw Parts Library${release ? ` ${release}` : ''} (ldraw.org), CC BY 4.0.`);
  const commit = m.get('ldcad_commit');
  lines.push(`LDCad shadow library${commit ? ` ${commit.slice(0, 12)}` : ''} by Roland Melkert, CC BY-SA 4.0.`);
  if (Number(m.get('count_projects_with_positions') ?? 0) > 0) {
    lines.push('LDraw Official Model Repository (library.ldraw.org/omr) and its authors, CC BY 4.0 or CCAL 2.0 per file.');
  }
  const fan = db.prepare("SELECT DISTINCT source, url FROM projects WHERE kind = 'fan' ORDER BY source")
    .all() as { source: string; url: string | null }[];
  for (const f of fan) {
    const fanCommit = m.get(`fan_commit_${f.source}`);
    lines.push(`Fan models from ${f.source}${f.url ? ` (${f.url})` : ''}${fanCommit ? `, commit ${fanCommit.slice(0, 12)}` : ''}, license per file.`);
  }
  return lines;
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
    lastError: state.lastError, warnings: [] as string[], origin: null as DatabaseStatus['origin'], releaseTag: null as string | null,
  };
  const seeding = state.status === 'seeding' && lockHeld;
  if (db === null) {
    const fallback = state.status !== 'seeding' ? state.status : state.lastError !== null ? 'failed' : 'idle';
    return {
      ...base, state: seeding ? 'seeding' : fallback, seededAt: null, ldrawRelease: null, ldcadCommit: null,
      matchRateTop1000: null, counts: {}, variant: update.variant, placementMatchRate: null, failedSources: [],
      credits: [REBRICKABLE_CREDIT],
    };
  }
  const m = new Map(
    (db.prepare('SELECT key, value FROM manifest').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]),
  );
  // The manifest says who built the database; update.json's tag describes it only for a CI build.
  base.origin = originOf(m.get('built_by'));
  if (base.origin === 'release') base.releaseTag = update.releaseTag;
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
    credits: creditLines(db, m),
  };
}
