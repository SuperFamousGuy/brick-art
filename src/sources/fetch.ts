import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { extractZip } from './extract.ts';

export interface SourceUrls {
  rebrickableBase: string;
  ldrawZip: string;
  ldcadCommitApi: string;
  ldcadArchiveBase: string;
}

export const DEFAULT_SOURCE_URLS: SourceUrls = {
  rebrickableBase: 'https://cdn.rebrickable.com/media/downloads',
  ldrawZip: 'https://library.ldraw.org/library/updates/complete.zip',
  ldcadCommitApi: 'https://api.github.com/repos/RolandMelkert/LDCadShadowLibrary/commits/main',
  ldcadArchiveBase: 'https://codeload.github.com/RolandMelkert/LDCadShadowLibrary/zip',
};

export interface SourceRecord {
  name: string;
  url: string;
  downloadedAt: string;
  bytes: number;
  sha256: string;
  lastModified: string | null;
}

export interface FetchedSources {
  rebrickableDir: string;
  ldrawRoot: string;
  shadowRoot: string;
  ldcadCommit: string;
  records: SourceRecord[];
}

export interface FetchOptions {
  refresh: boolean;
  maxAgeHours: number;
  baseUrls?: Partial<SourceUrls>;
}

const REBRICKABLE_TABLES = [
  'parts', 'part_categories', 'part_relationships', 'colors',
  'elements', 'inventory_parts', 'inventories', 'sets',
];
const USER_AGENT = 'brick-art-seed';

async function download(url: string, dest: string, name: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers } });
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`download failed: ${name} ${res.status}`);
  }
  const part = `${dest}.part`;
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) { hash.update(chunk); bytes += chunk.length; cb(null, chunk); },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as WebReadableStream), meter, createWriteStream(part));
    await rename(part, dest);
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
  return { bytes, sha256: hash.digest('hex'), lastModified: res.headers.get('last-modified') };
}

type StoredRecord = SourceRecord & { commit?: string };

async function readFresh(
  cacheDir: string, name: string, file: string, opts: FetchOptions,
): Promise<StoredRecord | null> {
  if (opts.refresh) return null;
  try {
    const meta = JSON.parse(await readFile(join(cacheDir, `${name}.meta.json`), 'utf8')) as StoredRecord;
    await stat(join(cacheDir, file));
    const ageMs = Date.now() - Date.parse(meta.downloadedAt);
    return ageMs < opts.maxAgeHours * 3_600_000 ? meta : null;
  } catch {
    return null;
  }
}

async function fetchOne(
  cacheDir: string, name: string, file: string, url: string, extra: Partial<StoredRecord> = {},
  headers?: Record<string, string>,
): Promise<StoredRecord> {
  const info = await download(url, join(cacheDir, file), name, headers);
  const record: StoredRecord = {
    name, url, downloadedAt: new Date().toISOString(), ...info, ...extra,
  };
  await writeFile(join(cacheDir, `${name}.meta.json`), JSON.stringify(record, null, 2));
  return record;
}

function publicRecord({ commit: _commit, ...record }: StoredRecord): SourceRecord {
  return record;
}

async function ensureExtracted(
  cacheDir: string, prefix: string, zipFile: string, sha256: string,
  keep: (path: string) => boolean, strip: RegExp,
): Promise<string> {
  const extractDir = join(cacheDir, 'extract');
  const target = join(extractDir, `${prefix}-${sha256}`);
  const exists = await stat(target).then((s) => s.isDirectory(), () => false);
  if (!exists) {
    const tmp = `${target}.tmp-${process.pid}`;
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    try {
      await extractZip(zipFile, tmp, keep, strip);
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { recursive: true, force: true });
      throw err;
    }
  }
  try {
    for (const entry of await readdir(extractDir)) {
      if (entry.startsWith(`${prefix}-`) && entry !== `${prefix}-${sha256}`) {
        await rm(join(extractDir, entry), { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch { /* cleanup is best effort */ }
  return target;
}

export async function fetchSources(cacheDir: string, opts: FetchOptions): Promise<FetchedSources> {
  const urls: SourceUrls = { ...DEFAULT_SOURCE_URLS, ...opts.baseUrls };
  await mkdir(cacheDir, { recursive: true });
  const records: StoredRecord[] = [];

  for (const name of REBRICKABLE_TABLES) {
    const file = `${name}.csv.gz`;
    records.push(
      (await readFresh(cacheDir, name, file, opts)) ??
        (await fetchOne(cacheDir, name, file, `${urls.rebrickableBase}/${name}.csv.gz`)),
    );
  }

  const ldraw = (await readFresh(cacheDir, 'ldraw', 'ldraw.zip', opts)) ??
    (await fetchOne(cacheDir, 'ldraw', 'ldraw.zip', urls.ldrawZip));
  records.push(ldraw);

  let ldcad = await readFresh(cacheDir, 'ldcad', 'ldcad.zip', opts);
  if (!ldcad?.commit) {
    const res = await fetch(urls.ldcadCommitApi, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`download failed: ldcad-commit ${res.status}`);
    }
    const sha = ((await res.json()) as { sha?: unknown }).sha;
    if (typeof sha !== 'string' || sha === '') throw new Error('download failed: ldcad-commit no sha');
    ldcad = await fetchOne(cacheDir, 'ldcad', 'ldcad.zip', `${urls.ldcadArchiveBase}/${sha}`, { commit: sha });
  }
  records.push(ldcad);

  const ldrawRoot = await ensureExtracted(
    cacheDir, 'ldraw', join(cacheDir, 'ldraw.zip'), ldraw.sha256,
    (p) => /^(parts|p)\//.test(p), /^ldraw\//,
  );
  const shadowRoot = await ensureExtracted(
    cacheDir, 'ldcad', join(cacheDir, 'ldcad.zip'), ldcad.sha256,
    (p) => /^(parts|p)\//.test(p), /^[^/]+\//,
  );

  return {
    rebrickableDir: cacheDir,
    ldrawRoot,
    shadowRoot,
    ldcadCommit: ldcad.commit as string,
    records: records.map(publicRecord),
  };
}
