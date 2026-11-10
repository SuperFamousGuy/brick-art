import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface OmrFile { setNum: string; fileName: string; path: string; url: string; isBModel: boolean }

export interface OmrOptions {
  baseUrl?: string;
  concurrency?: number;
  retries?: number;
  backoffMs?: number;
}

export interface OmrResult { files: OmrFile[]; fetched: number; fromCache: number; failed: number; bytes: number }

const DEFAULT_BASE_URL = 'https://library.ldraw.org';
const USER_AGENT = 'brick-art-seed';
const REQUEST_TIMEOUT_MS = 60_000;

// Absolute or relative hrefs both match; only the captured path is ever requested, from baseUrl.
const SET_LINK = /\/omr\/sets\/(\d+)(?=["'?#\s>])/g;
const FILE_LINK = /(\/media\/omr_models\/\d+\/([^"'\s<>?\/]+)\.(?:mpd|ldr))\?v=([^"'\s<>&]+)/gi;

class HttpStatusError extends Error {
  status: number;
  constructor(status: number, url: string) {
    super(`request failed: ${url} ${status}`);
    this.status = status;
  }
}

const retryable = (err: unknown) =>
  !(err instanceof HttpStatusError) || err.status >= 500 || err.status === 429;

/** Runs at most `limit` tasks at once. */
function limiter(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    while (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

type IndexEntry = { v: string; file: string };

export async function fetchOmr(cacheDir: string, opts: OmrOptions = {}): Promise<OmrResult> {
  const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 1000;
  const slot = limiter(Math.max(1, opts.concurrency ?? 4));
  const omrDir = join(cacheDir, 'omr');
  await mkdir(omrDir, { recursive: true });

  // Each attempt holds a slot; waiting between attempts does not.
  async function getBytes(target: string): Promise<Buffer> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await slot(async () => {
          const res = await fetch(`${base}${target}`, {
            headers: { 'User-Agent': USER_AGENT },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          if (!res.ok) {
            await res.body?.cancel().catch(() => {});
            throw new HttpStatusError(res.status, target);
          }
          return Buffer.from(await res.arrayBuffer());
        });
      } catch (err) {
        if (attempt >= retries || !retryable(err)) throw err;
        await new Promise((resolve) => setTimeout(resolve, backoffMs * 2 ** attempt));
      }
    }
  }
  const getText = async (target: string) => (await getBytes(target)).toString('utf8');

  // Crawl list pages until one adds no new set links.
  const setIds = new Set<string>();
  for (let page = 1; ; page++) {
    let html: string;
    try {
      html = await getText(`/omr/sets?page=${page}`);
    } catch (err) {
      if (err instanceof HttpStatusError && err.status === 404 && page > 1) break;
      throw err;
    }
    const before = setIds.size;
    for (const m of html.matchAll(SET_LINK)) setIds.add(m[1]);
    if (setIds.size === before) break;
  }

  // Collect file links from every set page. A set page that fails is skipped.
  let failed = 0;
  const links = new Map<string, { path: string; name: string; v: string }>();
  await Promise.all([...setIds].map(async (id) => {
    try {
      const html = await getText(`/omr/sets/${id}`);
      for (const m of html.matchAll(FILE_LINK)) links.set(m[1], { path: m[1], name: m[2], v: m[3] });
    } catch {
      failed++;
    }
  }));

  const indexPath = join(omrDir, 'index.json');
  let index: Record<string, IndexEntry> = {};
  try {
    index = JSON.parse(await readFile(indexPath, 'utf8')) as Record<string, IndexEntry>;
  } catch { /* no usable index: start empty */ }

  const files: OmrFile[] = [];
  let fetched = 0;
  let fromCache = 0;
  let bytes = 0;
  await Promise.all([...links.values()].sort((a, b) => a.path.localeCompare(b.path)).map(async (link) => {
    const ext = link.path.slice(link.path.lastIndexOf('.'));
    const fileName = `${safeDecode(link.name)}${ext}`;
    const dest = join(omrDir, link.path.split('/')[3], fileName.replace(/[\\/:]/g, '_'));
    const cached = index[link.path];
    const fresh = cached?.v === link.v && await stat(dest).then((s) => s.isFile(), () => false);
    if (!fresh) {
      try {
        const body = await getBytes(`${link.path}?v=${link.v}`);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(`${dest}.part`, body);
        await rename(`${dest}.part`, dest);
        index[link.path] = { v: link.v, file: dest.slice(omrDir.length + 1) };
        fetched++;
        bytes += body.length;
      } catch {
        failed++;
        return;
      }
    } else fromCache++;
    const stem = safeDecode(link.name);
    const num = /^([0-9A-Za-z]+-\d+)/.exec(stem);
    if (!num) return;
    files.push({
      setNum: num[1],
      fileName,
      path: dest,
      url: `${base}${link.path}?v=${link.v}`,
      isBModel: stem.length > num[1].length,
    });
  }));

  await writeFile(indexPath, JSON.stringify(index, null, 2));
  files.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return { files, fetched, fromCache, failed, bytes };
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}
