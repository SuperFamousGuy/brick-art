import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { curatedDir, loadCurated } from '../curated/load.ts';
import { readPointer } from '../db/open.ts';
import { SEED_VERSION } from '../db/schema.ts';
import { dataPaths } from '../paths.ts';
import { isLockHeld, readState } from './lock.ts';

export type SeedReason = 'missing' | 'seed_version' | 'curated' | 'running' | 'ok';

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

export async function needsSeed(
  dataDir: string,
  repoRoot: string,
): Promise<{ needed: boolean; reason: SeedReason }> {
  if (isLockHeld(dataPaths(dataDir).lock)) return { needed: false, reason: 'running' };
  const manifest = readManifest(dataDir);
  if (manifest === null) return { needed: true, reason: 'missing' };
  if (manifest.seed_version !== String(SEED_VERSION)) return { needed: true, reason: 'seed_version' };
  const curated = await loadCurated(curatedDir(repoRoot));
  if (manifest.curated_hash !== curated.hash) return { needed: true, reason: 'curated' };
  return { needed: false, reason: 'ok' };
}

/** The first line of an error, trimmed and capped, so the hook prints one short line. */
const firstLine = (err: string | null): string =>
  (err ?? '').split(/\r?\n/, 1)[0]!.trim().slice(0, 200) || 'unknown error';

const BUILDING = 'brick-art: building the parts database in the background (first run takes a few minutes).';

/** Returns the line for the hook to print; starts a background seed through spawnSeed when one is needed. */
export async function bootstrap(dataDir: string, repoRoot: string, spawnSeed: () => void): Promise<string> {
  try {
    const { needed, reason } = await needsSeed(dataDir, repoRoot);
    if (reason === 'running') return BUILDING;
    if (needed) {
      const state = readState(dataPaths(dataDir).state);
      spawnSeed();
      return state.status === 'failed'
        ? `brick-art: last parts database build failed: ${firstLine(state.lastError)}. Retrying in the background.`
        : BUILDING;
    }
    const manifest = readManifest(dataDir);
    return `brick-art: parts database ready (${manifest?.count_parts ?? '?'} parts, seeded ${manifest?.finished_at ?? 'unknown'}).`;
  } catch (err) {
    return `brick-art: setup check failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Starts src/entry/seed.mjs as a detached process that logs to the data dir and outlives the session hook. */
export function spawnDetachedSeed(dataDir: string, repoRoot: string): void {
  mkdirSync(dataDir, { recursive: true });
  const fd = openSync(dataPaths(dataDir).log, 'a');
  try {
    const child = spawn(process.execPath, [join(repoRoot, 'src', 'entry', 'seed.mjs')], {
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
