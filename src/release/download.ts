import { createHash } from 'node:crypto';
import {
  appendFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { createGunzip } from 'node:zlib';
import { readPointer, writePointer } from '../db/open.ts';
import { SEED_VERSION } from '../db/schema.ts';
import { dataPaths } from '../paths.ts';
import type { Variant } from '../projects/types.ts';
import { acquireLock, readState, releaseLock, writeState } from '../seed/lock.ts';
import { runSeed, uniqueDbFile } from '../seed/seed.ts';
import type { SeedOptions } from '../seed/seed.ts';
import { idleGuard } from '../sources/fetch.ts';

const REPO = 'SuperFamousGuy/brick-art';
const USER_AGENT = 'brick-art-seed';
const IDLE_TIMEOUT_MS = 60_000;
const TAG = /^data-(\d+)-(\d{8})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DOWNLOAD_PART = 'download.part';

export class RateLimited extends Error {
  constructor(status: number) {
    super(`release API rate limited (${status})`);
    this.name = 'RateLimited';
  }
}

export interface ReleaseInfo {
  tag: string;
  /** Asset name → download URL. */
  assets: Map<string, string>;
}

export interface UpdateState {
  lastCheckedAt: string | null;
  /** The release last installed by the updater; it describes the database only while that is a CI build. */
  releaseTag: string | null;
  variant: Variant | null;
  /** What the updater last did. Informational: the database's origin comes from its manifest (`originOf`). */
  origin: 'release' | 'local' | null;
  lastError: string | null;
}

/**
 * Where a database came from, by its manifest's `built_by`: `ci` is a published release, `local` a
 * local seed (including `/reseed --local`), anything else unknown. update.json can lag behind a local
 * reseed, so it never decides this.
 */
export function originOf(builtBy: string | null | undefined): 'release' | 'local' | null {
  return builtBy === 'ci' ? 'release' : builtBy === 'local' ? 'local' : null;
}

export interface UpdateOptions {
  dataDir: string;
  repoRoot: string;
  variant: 'standard' | 'full';
  force?: boolean;
  apiBase?: string;
  /** Merged into the fallback `runSeed` call. */
  seed?: Partial<SeedOptions>;
  /** Test hook: replaces `runSeed` for the local fallback. */
  runSeedImpl?: typeof runSeed;
}
export interface UpdateResult {
  outcome: 'updated' | 'current' | 'fallback_seeded' | 'kept' | 'busy';
  tag: string | null;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Runs `fn` under an idle timeout; a timeout surfaces as `download failed: <what> timeout`. */
async function guarded<T>(what: string, fn: (guard: ReturnType<typeof idleGuard>) => Promise<T>): Promise<T> {
  const guard = idleGuard(IDLE_TIMEOUT_MS);
  try {
    return await fn(guard);
  } catch (err) {
    if (guard.timedOut) throw new Error(`download failed: ${what} timeout`);
    throw err;
  } finally {
    guard.stop();
  }
}

async function get(url: string, signal: AbortSignal, accept?: string): Promise<Response> {
  return fetch(url, { headers: { 'User-Agent': USER_AGENT, ...(accept ? { Accept: accept } : {}) }, signal });
}

async function fail(res: Response, what: string): Promise<never> {
  await res.body?.cancel().catch(() => {});
  throw new Error(`download failed: ${what} ${res.status}`);
}

/** The newest release tagged `data-<schemaVersion>-YYYYMMDD`, or null when there is none. */
export async function findRelease(
  schemaVersion: number,
  apiBase: string = process.env.BRICK_ART_RELEASE_API || 'https://api.github.com',
): Promise<ReleaseInfo | null> {
  const url = `${apiBase.replace(/\/+$/, '')}/repos/${REPO}/releases?per_page=50`;
  const list = await guarded('releases', async (guard) => {
    const res = await get(url, guard.signal, 'application/vnd.github+json');
    if (res.status === 403 || res.status === 429) {
      await res.body?.cancel().catch(() => {});
      throw new RateLimited(res.status);
    }
    if (!res.ok) return fail(res, 'releases');
    return (await res.json()) as unknown;
  });
  if (!Array.isArray(list)) throw new Error('release API did not return a list');
  let best: ReleaseInfo | null = null;
  let bestDate = '';
  for (const r of list as { tag_name?: unknown; draft?: unknown; assets?: unknown }[]) {
    const m = typeof r?.tag_name === 'string' ? TAG.exec(r.tag_name) : null;
    if (m === null || Number(m[1]) !== schemaVersion || r.draft === true) continue;
    if (best !== null && m[2]! <= bestDate) continue;
    const assets = new Map<string, string>();
    for (const a of Array.isArray(r.assets) ? r.assets as { name?: unknown; browser_download_url?: unknown }[] : []) {
      if (typeof a?.name === 'string' && typeof a.browser_download_url === 'string') {
        assets.set(a.name, a.browser_download_url);
      }
    }
    best = { tag: m[0], assets };
    bestDate = m[2]!;
  }
  return best;
}

const updatePath = (dataDir: string) => join(dataDir, 'update.json');
const EMPTY: UpdateState = { lastCheckedAt: null, releaseTag: null, variant: null, origin: null, lastError: null };

/** Reads `<dataDir>/update.json`; a missing or unreadable file is the empty state. */
export function readUpdateState(dataDir: string): UpdateState {
  try {
    const raw = JSON.parse(readFileSync(updatePath(dataDir), 'utf8')) as Partial<UpdateState> | null;
    if (raw === null || typeof raw !== 'object') return { ...EMPTY };
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    const variant = str(raw.variant);
    const origin = str(raw.origin);
    return {
      lastCheckedAt: str(raw.lastCheckedAt),
      releaseTag: str(raw.releaseTag),
      variant: variant === 'fallback' || variant === 'standard' || variant === 'full' ? variant : null,
      origin: origin === 'release' || origin === 'local' ? origin : null,
      lastError: str(raw.lastError),
    };
  } catch {
    return { ...EMPTY };
  }
}

/** Writes `<dataDir>/update.json` atomically (temp file plus rename). */
export function writeUpdateState(dataDir: string, state: UpdateState): void {
  mkdirSync(dataDir, { recursive: true });
  const file = updatePath(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, file);
}

/** The manifest of `file`, or null when the file does not exist. Open and read errors throw. */
function readManifest(file: string): Map<string, string> | null {
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare('SELECT key, value FROM manifest').all() as { key: string; value: string }[];
    return new Map(rows.map((r) => [r.key, r.value]));
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

/** True for node:sqlite errors that will recur on every open: not a database, corrupt, or no manifest table. */
function isPermanentDbError(err: unknown): boolean {
  const e = err as { code?: unknown; errcode?: unknown; message?: unknown };
  if (e?.code !== 'ERR_SQLITE_ERROR' || typeof e.errcode !== 'number') return false;
  const primary = e.errcode & 0xff; // extended result codes keep the primary code in the low byte
  if (primary === SQLITE_CORRUPT || primary === SQLITE_NOTADB) return true;
  return typeof e.message === 'string' && /no such table: manifest\b/.test(e.message);
}

/**
 * `usable` when the pointer names an existing database built for this SEED_VERSION; `unusable` when
 * the pointer or file is missing, the schema differs, or the file is not a readable SQLite database
 * with a manifest; `unknown` for errors that may be transient (busy, locked, I/O, permissions), so
 * the database must not be replaced by a local seed.
 */
type DbStatus = 'usable' | 'unusable' | 'unknown';
function dbStatus(dataDir: string): DbStatus {
  try {
    const name = readPointer(dataDir);
    if (name === null) return 'unusable';
    return readManifest(join(dataDir, name))?.get('seed_version') === String(SEED_VERSION) ? 'usable' : 'unusable';
  } catch (err) {
    return isPermanentDbError(err) ? 'unusable' : 'unknown';
  }
}

/** The origin of the database the pointer names, or null when it cannot be read. */
function installedOrigin(dataDir: string): 'release' | 'local' | null {
  try {
    const name = readPointer(dataDir);
    return name === null ? null : originOf(readManifest(join(dataDir, name))?.get('built_by'));
  } catch {
    return null;
  }
}

/** Deletes the downloader's partial files; failures are ignored. */
function removeParts(dataDir: string): void {
  try {
    for (const name of readdirSync(dataDir)) {
      if (name === DOWNLOAD_PART || /^parts-.*\.db\.part$/.test(name)) {
        try { rmSync(join(dataDir, name), { force: true }); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

interface VariantMeta { file: string; gzSha256: string; gzBytes: number; dbSha256: string; dbBytes: number }

function variantMeta(text: string, tag: string, variant: string): VariantMeta {
  const meta = JSON.parse(text) as { tag?: unknown; schemaVersion?: unknown; variants?: Record<string, unknown> };
  if (meta?.tag !== tag) throw new Error(`release.json names tag ${String(meta?.tag)}, expected ${tag}`);
  if (meta.schemaVersion !== SEED_VERSION) {
    throw new Error(`release.json schema ${String(meta.schemaVersion)}, expected ${SEED_VERSION}`);
  }
  const v = meta.variants?.[variant] as Partial<VariantMeta> | undefined;
  const size = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
  if (v === undefined || typeof v.file !== 'string' || basename(v.file) !== v.file ||
    typeof v.gzSha256 !== 'string' || !SHA256.test(v.gzSha256) || !size(v.gzBytes) ||
    typeof v.dbSha256 !== 'string' || !SHA256.test(v.dbSha256) || !size(v.dbBytes)) {
    throw new Error(`release.json has no valid entry for ${variant}`);
  }
  return v as VariantMeta;
}

/** A pass-through stream that hashes, counts, and refuses more than `maxBytes`. */
function meter(what: string, maxBytes: number, touch?: () => void) {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      touch?.();
      bytes += chunk.length;
      if (bytes > maxBytes) {
        cb(new Error(`${what}: more than the expected ${maxBytes} bytes`));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  const verify = (sha256: string) => {
    if (bytes !== maxBytes) throw new Error(`${what}: ${bytes} bytes, expected ${maxBytes}`);
    if (hash.digest('hex') !== sha256) throw new Error(`${what}: sha256 mismatch`);
  };
  return { stream, verify };
}

/**
 * Downloads and verifies `variant` of `release`, then points the data dir at it.
 * On any failure the partial files and the unpointed database are removed.
 */
async function installRelease(
  dataDir: string, release: ReleaseInfo, variant: string, log: (msg: string) => void,
): Promise<void> {
  const asset = (name: string) => {
    const url = release.assets.get(name);
    if (url === undefined) throw new Error(`release ${release.tag} has no ${name}`);
    return url;
  };
  const gzPart = join(dataDir, DOWNLOAD_PART);
  let dbFile: string | null = null;
  try {
    const meta = variantMeta(await guarded('release.json', async (guard) => {
      const res = await get(asset('release.json'), guard.signal);
      if (!res.ok) return fail(res, 'release.json');
      return res.text();
    }), release.tag, variant);

    await guarded(meta.file, async (guard) => {
      const res = await get(asset(meta.file), guard.signal);
      if (!res.ok || !res.body) return fail(res, meta.file);
      const m = meter(meta.file, meta.gzBytes, guard.touch);
      await pipeline(Readable.fromWeb(res.body as WebReadableStream), m.stream, createWriteStream(gzPart));
      m.verify(meta.gzSha256);
    });

    dbFile = uniqueDbFile(dataDir, new Date());
    const dbPart = `${dbFile}.part`;
    const m = meter(`${meta.file} (gunzipped)`, meta.dbBytes);
    await pipeline(createReadStream(gzPart), createGunzip(), m.stream, createWriteStream(dbPart));
    m.verify(meta.dbSha256);
    renameSync(dbPart, dbFile);

    const manifest = readManifest(dbFile);
    if (manifest?.get('seed_version') !== String(SEED_VERSION)) {
      throw new Error(`downloaded database has seed_version ${manifest?.get('seed_version') ?? 'unreadable'}`);
    }
    if (manifest.get('variant') !== variant) {
      throw new Error(`downloaded database has variant ${manifest.get('variant') ?? 'missing'}, expected ${variant}`);
    }
    writePointer(dataDir, basename(dbFile));
  } catch (err) {
    removeParts(dataDir);
    try {
      if (dbFile !== null && readPointer(dataDir) !== basename(dbFile)) rmSync(dbFile, { force: true });
    } catch { /* best effort */ }
    throw err;
  }
  // The new database is live from here on: nothing below may fail the update.
  try { rmSync(gzPart, { force: true }); } catch { /* removed at the next run's start */ }
  try {
    for (const name of readdirSync(dataDir)) {
      if (!/^parts-.*\.db$/.test(name) || name === basename(dbFile)) continue;
      try {
        rmSync(join(dataDir, name), { force: true });
      } catch (err) {
        log(`could not remove old database ${name}: ${(err as NodeJS.ErrnoException).code ?? err}`);
      }
    }
  } catch { /* best effort */ }
  log(`installed ${variant} from ${release.tag}: ${basename(dbFile)}`);
}

/**
 * Brings the data dir's database up to the newest published release of `variant`, holding the seed
 * lock throughout. Without a release, a usable database is kept; with none, a fallback is seeded locally.
 */
export async function runUpdate(opts: UpdateOptions): Promise<UpdateResult> {
  const { dataDir } = opts;
  const paths = dataPaths(dataDir);
  mkdirSync(dataDir, { recursive: true });
  const log = (msg: string) => {
    try { appendFileSync(paths.log, `${new Date().toISOString()} update: ${msg}\n`); } catch { /* ignore */ }
  };

  if (!acquireLock(paths.lock)) {
    log('seed or update already running; skipping');
    return { outcome: 'busy', tag: null };
  }

  const startedAt = new Date().toISOString();
  const prior = readState(paths.state);
  const next = readUpdateState(dataDir);
  /** False once the fallback seed has taken over the seed state. */
  let ownsState = true;
  /** Bookkeeping only: a failure is logged and never changes the outcome. */
  const finishState = (ok: boolean, failures: number, lastError: string | null) => {
    try {
      writeState(paths.state, {
        status: ok ? 'ready' : 'failed', startedAt, finishedAt: new Date().toISOString(), lastError, failures,
      });
    } catch (err) {
      log(`could not write seed state: ${errText(err)}`);
    }
  };
  /** Final seed state for a run that ends without installing: never `ready` for an unreadable database. */
  const finishWithout = (status: DbStatus, lastError: string) => {
    if (status === 'usable') finishState(true, prior.failures, null);
    else if (status === 'unusable') finishState(false, prior.failures + 1, lastError);
    else {
      try {
        writeState(paths.state, prior.status === 'seeding' ? { ...prior, status: 'failed', lastError } : prior);
      } catch (err) {
        log(`could not write seed state: ${errText(err)}`);
      }
    }
  };
  try {
    removeParts(dataDir);
    writeState(paths.state, { status: 'seeding', startedAt, finishedAt: null, lastError: null, failures: prior.failures });

    let result: UpdateResult | null = null;
    let error = '';
    try {
      const release = await findRelease(SEED_VERSION, opts.apiBase);
      if (release === null) throw new Error(`no published release for schema ${SEED_VERSION}`);
      if (!opts.force && release.tag === next.releaseTag && next.variant === opts.variant &&
        dbStatus(dataDir) === 'usable' && installedOrigin(dataDir) === 'release') {
        result = { outcome: 'current', tag: release.tag };
      } else {
        log(`downloading ${opts.variant} from ${release.tag}`);
        await installRelease(dataDir, release, opts.variant, log);
        Object.assign(next, { releaseTag: release.tag, variant: opts.variant, origin: 'release' });
        result = { outcome: 'updated', tag: release.tag };
      }
    } catch (err) {
      error = errText(err);
      log(`update failed: ${error}`);
    }
    if (result !== null) {
      next.lastError = null;
      finishState(true, 0, null);
      return result;
    }

    next.lastError = error;
    const status = dbStatus(dataDir);
    if (status !== 'unusable') {
      // An unreadable database may be a transient error: keep it rather than replace it.
      if (status === 'unknown') next.lastError = `${error}; current database could not be read`;
      log('keeping the current database');
      finishWithout(status, next.lastError);
      return { outcome: 'kept', tag: null };
    }
    log('no usable database; seeding the fallback locally');
    ownsState = false;
    await (opts.runSeedImpl ?? runSeed)({
      refresh: false, ...opts.seed, dataDir, repoRoot: opts.repoRoot, variant: 'fallback', skipLock: true,
    });
    Object.assign(next, { releaseTag: null, variant: 'fallback', origin: 'local' });
    return { outcome: 'fallback_seeded', tag: null };
  } catch (err) {
    next.lastError = errText(err);
    log(`update failed: ${next.lastError}`);
    if (ownsState) finishWithout(dbStatus(dataDir), next.lastError);
    throw err;
  } finally {
    next.lastCheckedAt = new Date().toISOString();
    try { writeUpdateState(dataDir, next); } catch (err) { log(`could not write update.json: ${errText(err)}`); }
    try { releaseLock(paths.lock); } catch { /* ignore */ }
  }
}
