import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { FanSource } from '../curated/load.ts';
import { assembleProject } from '../projects/assemble.ts';
import type { AssembledProject } from '../projects/assemble.ts';
import { licenseAllowed } from '../projects/license.ts';
import { normalizeRef, parseModel } from '../projects/mpd.ts';
import type { ModelFile } from '../projects/types.ts';
import { ensureExtracted, fetchCommitSha, fetchOne, readFresh } from './fetch.ts';

export interface FanFetchOptions {
  githubApi?: string;
  codeload?: string;
  idleTimeoutMs?: number;
}

const DEFAULT_GITHUB_API = 'https://api.github.com';
const DEFAULT_CODELOAD = 'https://codeload.github.com';
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const MAX_AGE_HOURS = 24;

/** Converts a glob with `*` (within a folder), `**` (across folders), and `?` to a RegExp. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*';
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

async function listFiles(root: string, dir = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await listFiles(root, rel)));
    else out.push(rel);
  }
  return out;
}

const sha1Short = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 8);

/**
 * Downloads a fan source into `cacheDir` and returns the extracted root plus the model files
 * matching its `paths`, relative to the root and sorted. Reuses a download younger than 24 hours.
 */
export async function fetchFanSource(
  cacheDir: string, src: FanSource, opts: FanFetchOptions = {},
): Promise<{ root: string; commit: string | null; files: string[] }> {
  await mkdir(cacheDir, { recursive: true });
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const name = `fan-${src.id}`;
  const matchers = src.fetch.paths.map(globToRegExp);
  const wanted = (path: string): boolean => matchers.some((re) => re.test(path));
  // The key suffix versions the keep predicate so that changed paths never reuse an older extraction.
  const keySuffix = `-${sha1Short(JSON.stringify(src.fetch.paths))}`;
  const freshOpts = { refresh: false, maxAgeHours: MAX_AGE_HOURS };

  let root: string;
  let commit: string | null = null;
  if (src.fetch.kind === 'github') {
    const file = `${name}.zip`;
    let rec = await readFresh(cacheDir, name, file, freshOpts);
    if (!rec?.commit) {
      const sha = await fetchCommitSha(
        `${opts.githubApi ?? DEFAULT_GITHUB_API}/repos/${src.fetch.repo}/commits/HEAD`, idleMs,
      );
      rec = await fetchOne(
        cacheDir, name, file, `${opts.codeload ?? DEFAULT_CODELOAD}/${src.fetch.repo}/zip/${sha}`,
        { commit: sha }, idleMs,
      );
    }
    commit = rec.commit as string;
    root = await ensureExtracted(cacheDir, name, join(cacheDir, file), rec.sha256, wanted, /^[^/]+\//, keySuffix);
  } else {
    const url = src.fetch.url;
    const isZip = /\.zip$/i.test(new URL(url).pathname);
    const file = `${name}.download`;
    const rec = (await readFresh(cacheDir, name, file, freshOpts)) ??
      (await fetchOne(cacheDir, name, file, url, {}, idleMs));
    if (isZip) {
      root = await ensureExtracted(cacheDir, name, join(cacheDir, file), rec.sha256, wanted, /^\.\//, keySuffix);
    } else {
      root = join(cacheDir, 'extract', `${name}-${rec.sha256}${keySuffix}`);
      if (!(await stat(root).then((s) => s.isDirectory(), () => false))) {
        const tmp = `${root}.tmp-${process.pid}`;
        await rm(tmp, { recursive: true, force: true });
        await mkdir(tmp, { recursive: true });
        try {
          await copyFile(join(cacheDir, file), join(tmp, basename(new URL(url).pathname)));
          await rename(tmp, root);
        } catch (err) {
          await rm(tmp, { recursive: true, force: true });
          throw err;
        }
      }
    }
  }
  const files = (await listFiles(root)).filter(wanted).sort();
  return { root, commit, files };
}

type Maps = { parts: Map<string, string>; colors: Map<number, number> };

/**
 * Parses every model file, finds the top-level models (those no file references), and assembles one
 * project per top-level model. A project is skipped when any file it uses has a license that is not allowed.
 */
export function buildFanProjects(
  src: FanSource, root: string, files: string[], maps: Maps, nextSubmodelId: () => number,
): { projects: (AssembledProject & { root: string })[]; skipped: number } {
  const shared = new Map<string, ModelFile>();
  const referenced = new Set<string>();
  const candidates: string[] = [];
  for (const path of [...files].sort()) {
    const parsed = parseModel(readFileSync(join(root, path), 'utf8'), basename(path));
    for (const [key, file] of parsed.files) {
      if (!shared.has(key)) shared.set(key, file);
      for (const line of file.lines) referenced.add(normalizeRef(line.ref));
    }
    if (!candidates.includes(parsed.main)) candidates.push(parsed.main);
  }
  const projects: (AssembledProject & { root: string })[] = [];
  let skipped = 0;
  for (const main of candidates) {
    if (referenced.has(main) || !shared.has(main)) continue;
    const assembled = assembleProject(main, shared, maps, nextSubmodelId);
    if (assembled.licenses.every((l) => licenseAllowed(l, src.defaultLicense))) {
      projects.push({ ...assembled, root: main });
    } else skipped++;
  }
  return { projects, skipped };
}
