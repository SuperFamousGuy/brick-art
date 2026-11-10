import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SeedState {
  status: 'idle' | 'seeding' | 'ready' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  failures: number;
}

const code = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;

const FRESH_MS = 10_000;
/** A seed takes minutes; a lock older than this is stale even if its pid is alive (the pid may be reused). */
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EACCES']);

/** Lock content: `<pid> <ISO start time>`. Legacy content is the pid alone. */
const lockContent = (): string => `${process.pid} ${new Date().toISOString()}`;

function parseLock(text: string): { pid: number; startedMs: number | null } {
  const [pidText = '', started] = text.trim().split(/\s+/);
  const startedMs = started === undefined ? NaN : Date.parse(started);
  return { pid: Number.parseInt(pidText, 10), startedMs: Number.isFinite(startedMs) ? startedMs : null };
}

/**
 * True when the lock names no live process or is older than 2 hours.
 * An unparsable lock is live while its mtime is under 10 s.
 */
function isStale(lockPath: string): boolean {
  let pid: number;
  try {
    const lock = parseLock(readFileSync(lockPath, 'utf8'));
    pid = lock.pid;
    if (!Number.isInteger(pid) || pid <= 0) {
      return Date.now() - statSync(lockPath).mtimeMs >= FRESH_MS;
    }
    if (lock.startedMs !== null && Date.now() - lock.startedMs >= MAX_AGE_MS) return true;
  } catch (err) {
    return code(err) === 'ENOENT';
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return code(err) === 'ESRCH'; // EPERM means the process exists
  }
}

/** True when a live process holds the lock (same liveness rules as acquireLock). */
export function isLockHeld(lockPath: string): boolean {
  return !isStale(lockPath);
}

/** Creates the lock with complete content, or returns false when it is held. */
function createLock(lockPath: string): boolean {
  const tmp = `${lockPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, lockContent());
  try {
    linkSync(tmp, lockPath);
    return true;
  } catch (err) {
    const c = code(err);
    if (c === 'EEXIST') return false;
    if (c === undefined || !LINK_UNSUPPORTED.has(c)) throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
  // Filesystem without hard links: exclusive create instead.
  try {
    writeFileSync(lockPath, lockContent(), { flag: 'wx' });
    return true;
  } catch (err) {
    if (code(err) === 'EEXIST') return false;
    throw err;
  }
}

/** Creates the lock exclusively and writes this pid and start time. Replaces a stale lock. */
export function acquireLock(lockPath: string): boolean {
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    if (createLock(lockPath)) return true;
    if (!isStale(lockPath)) return false;
    // rename is atomic: only one waiter wins the takeover, the others get ENOENT and retry.
    const aside = `${lockPath}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      renameSync(lockPath, aside);
    } catch (err) {
      if (code(err) === 'ENOENT') continue;
      throw err;
    }
    if (!isStale(aside)) {
      // We moved a live lock that was created after our check; put it back.
      try { linkSync(aside, lockPath); } catch { /* another process holds the lock now */ }
      rmSync(aside, { force: true });
      return false;
    }
    rmSync(aside, { force: true });
  }
  return false;
}

/** Removes the lock only when it still names this process. */
export function releaseLock(lockPath: string): void {
  try {
    if (parseLock(readFileSync(lockPath, 'utf8')).pid !== process.pid) return;
  } catch {
    return;
  }
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
