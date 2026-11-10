import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SeedState {
  status: 'idle' | 'seeding' | 'ready' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  failures: number;
}

const code = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;

/** True when the lock file names no live process. */
function isStale(lockPath: string): boolean {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
  } catch (err) {
    return code(err) === 'ENOENT';
  }
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return code(err) === 'ESRCH'; // EPERM means the process exists
  }
}

/** Creates the lock exclusively and writes this pid. Replaces a lock whose pid is dead. */
export function acquireLock(lockPath: string): boolean {
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return true;
    } catch (err) {
      if (code(err) !== 'EEXIST') throw err;
      if (!isStale(lockPath)) return false;
      rmSync(lockPath, { force: true });
    }
  }
  return false;
}

export function releaseLock(lockPath: string): void {
  rmSync(lockPath, { force: true });
}

const IDLE: SeedState = { status: 'idle', startedAt: null, finishedAt: null, lastError: null, failures: 0 };

/** Reads the state file; a missing or unreadable file is `idle`. */
export function readState(statePath: string): SeedState {
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<SeedState> | null;
    if (raw === null || typeof raw !== 'object') return { ...IDLE };
    return {
      status: raw.status ?? 'idle',
      startedAt: raw.startedAt ?? null,
      finishedAt: raw.finishedAt ?? null,
      lastError: raw.lastError ?? null,
      failures: typeof raw.failures === 'number' ? raw.failures : 0,
    };
  } catch {
    return { ...IDLE };
  }
}

export function writeState(statePath: string, state: SeedState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const tmp = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, statePath);
}
