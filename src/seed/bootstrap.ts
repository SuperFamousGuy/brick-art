import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { curatedDir, loadCurated } from '../curated/load.ts';
import { readPointer } from '../db/open.ts';
import { SEED_VERSION } from '../db/schema.ts';
import { dataPaths } from '../paths.ts';
import { readUpdateState } from '../release/download.ts';
import type { UpdateState } from '../release/download.ts';
import { isLockHeld, readState } from './lock.ts';
import { readOptions, variantFor, writeOptions } from './options.ts';

export type UpdateReason = 'running' | 'missing' | 'schema' | 'variant' | 'fallback' | 'curated' | 'check_due' | 'ok';
type Chosen = 'standard' | 'full';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Reads the manifest of the current database, or null when it is absent or unopenable. */
function readManifest(dataDir: string): Record<string, string> | null {
  const name = readPointer(dataDir);
  if (name === null) return null;
  const file = join(dataDir, name);
  if (!existsSync(file)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare('SELECT key, value FROM manifest').all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** True when the last update check is missing, unparsable, or older than 24 hours. */
function checkDue(lastCheckedAt: string | null, now: Date): boolean {
  const t = lastCheckedAt === null ? NaN : Date.parse(lastCheckedAt);
  return !Number.isFinite(t) || now.getTime() - t > DAY_MS;
}

interface Evaluation { reason: UpdateReason; manifest: Record<string, string> | null; update: UpdateState }

async function evaluate(dataDir: string, repoRoot: string, variant: Chosen, now: Date): Promise<Evaluation> {
  const update = readUpdateState(dataDir);
  const manifest = readManifest(dataDir);
  const result = (reason: UpdateReason): Evaluation => ({ reason, manifest, update });
  if (isLockHeld(dataPaths(dataDir).lock)) return result('running');
  if (manifest === null) return result('missing');
  if (manifest.seed_version !== String(SEED_VERSION)) return result('schema');
  const due = checkDue(update.lastCheckedAt, now);
  // A fallback is never the chosen variant; it is replaced by the next check that finds a release.
  if (manifest.variant === 'fallback') return result(due ? 'fallback' : 'ok');
  if (manifest.variant !== variant) return result('variant');
  if (!due) return result('ok');
  // Seeded before update.json existed: no update state, built locally.
  const local = update.origin === 'local' || (update.origin === null && manifest.built_by === 'local');
  if (local && manifest.curated_hash !== (await loadCurated(curatedDir(repoRoot))).hash) return result('curated');
  return result('check_due');
}

/** Whether the background update should run, and why. Never more than one check per 24 hours unless the variant or schema changed. */
export async function needsUpdate(
  dataDir: string,
  repoRoot: string,
  variant: Chosen,
  now = new Date(),
): Promise<{ needed: boolean; reason: UpdateReason }> {
  const { reason } = await evaluate(dataDir, repoRoot, variant, now);
  return { needed: reason !== 'running' && reason !== 'ok', reason };
}

/** The first line of an error, trimmed and capped, so the hook prints one short line. */
const firstLine = (err: string | null): string =>
  (err ?? '').split(/\r?\n/, 1)[0]!.trim().slice(0, 200) || 'unknown error';

const FIRST_INSTALL = 'brick-art: installing the standard database in the background. Fan-made designs are off; turn them on in /plugin → brick-art → Configure options.';
const installing = (variant: Chosen) => `brick-art: installing the ${variant} database in the background.`;

function readyLine(manifest: Record<string, string>, update: UpdateState): string {
  const source = update.origin === 'release' && update.releaseTag ? update.releaseTag : 'local build';
  const line = `brick-art: database ready (${manifest.variant ?? '?'}, ${manifest.count_parts ?? '?'} parts, ` +
    `${manifest.count_projects_official ?? '?'} sets, ${source}).`;
  return manifest.variant === 'fallback' ? `${line} Build positions arrive with the next published release.` : line;
}

/**
 * Returns the line for the hook to print; starts a background update of the chosen variant through
 * spawnUpdate when one is needed. Options set through the environment are saved for /reseed.
 */
export async function bootstrap(
  dataDir: string,
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  spawnUpdate: (variant: Chosen) => void,
): Promise<string> {
  try {
    const options = readOptions(env, dataDir);
    if (options.source === 'env' || options.source === 'plugin') {
      try { writeOptions(dataDir, options); } catch { /* the hook still runs; /reseed uses the saved value */ }
    }
    const variant = variantFor(options);
    const { reason, manifest, update } = await evaluate(dataDir, repoRoot, variant, new Date());
    const usable = manifest !== null && manifest.seed_version === String(SEED_VERSION);
    if (reason === 'running') return usable ? readyLine(manifest, update) : installing(variant);
    if (reason === 'ok') return readyLine(manifest!, update);
    const state = readState(dataPaths(dataDir).state);
    spawnUpdate(variant);
    if (reason === 'missing' || reason === 'schema') {
      if (state.status === 'failed') {
        return `brick-art: last parts database build failed: ${firstLine(state.lastError)}. Retrying in the background.`;
      }
      return reason === 'missing' && options.source === 'default' ? FIRST_INSTALL : installing(variant);
    }
    if (reason === 'variant') return `brick-art: switching to the ${variant} database in the background.`;
    return readyLine(manifest!, update);
  } catch (err) {
    return `brick-art: setup check failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Node arguments for the update: a local fallback seed needs more heap than Node's default. */
export function updateArgs(repoRoot: string, variant: Chosen): string[] {
  return ['--max-old-space-size=3072', join(repoRoot, 'src', 'entry', 'update.mjs'), '--variant', variant];
}

/** Starts src/entry/update.mjs as a detached process that logs to the data dir and outlives the session hook. */
export function spawnDetachedUpdate(dataDir: string, repoRoot: string, variant: Chosen): void {
  mkdirSync(dataDir, { recursive: true });
  const fd = openSync(dataPaths(dataDir).log, 'a');
  try {
    const child = spawn(process.execPath, updateArgs(repoRoot, variant), {
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      env: { ...process.env, BRICK_ART_DATA: dataDir },
    });
    child.on('error', () => {});
    child.unref();
  } finally {
    closeSync(fd);
  }
}
