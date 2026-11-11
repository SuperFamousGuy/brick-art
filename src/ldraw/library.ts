import { readdir } from 'node:fs/promises';
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { extractUpdateTag } from './parse.ts';

/**
 * Lazy readers for one file: `read` returns the whole text, `head` returns lines from the start
 * up to and including the first one `stop` accepts (or all lines), reading no further than needed.
 */
interface Entry { read: () => string; head: (stop: (line: string) => boolean) => string[] }

/** Maps normalized relative path (`parts/3001.dat`) to its lazy readers. */
type FileIndex = Map<string, Entry>;

const HEAD_CHUNK = 1024;

function headOfText(text: string, stop: (line: string) => boolean): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    out.push(line);
    if (stop(line)) break;
  }
  return out;
}

function headOfFile(abs: string, stop: (line: string) => boolean): string[] {
  const fd = openSync(abs, 'r');
  try {
    const out: string[] = [];
    const buf = Buffer.alloc(HEAD_CHUNK);
    const decoder = new StringDecoder('utf8');
    let pending = '';
    for (;;) {
      const n = readSync(fd, buf, 0, HEAD_CHUNK, null);
      pending += n === 0 ? decoder.end() : decoder.write(buf.subarray(0, n));
      const lines = pending.split('\n');
      pending = n === 0 ? '' : lines.pop()!;
      for (const raw of lines) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        out.push(line);
        if (stop(line)) return out;
      }
      if (n === 0) return out;
    }
  } finally {
    closeSync(fd);
  }
}

async function indexTree(root: string): Promise<FileIndex> {
  const index: FileIndex = new Map();
  for (const sub of ['parts', 'p']) {
    let entries;
    try {
      entries = await readdir(join(root, sub), { recursive: true, withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const abs = join(e.parentPath, e.name);
      const key = relative(root, abs).split(sep).join('/').toLowerCase();
      index.set(key, { read: () => readFileSync(abs, 'utf8'), head: (stop) => headOfFile(abs, stop) });
    }
  }
  return index;
}

function fromMap(map: Map<string, string>): FileIndex {
  const index: FileIndex = new Map();
  for (const [k, v] of map) index.set(k, { read: () => v, head: (stop) => headOfText(v, stop) });
  return index;
}

/**
 * Lazy view over an LDraw library and an optional LDCad shadow library.
 * Only an index of paths is held in memory; file text is read on demand.
 */
export class LDrawLibrary {
  #ldraw: FileIndex;
  #shadow: FileIndex;
  #release: string | null = null;

  private constructor(ldraw: FileIndex, shadow: FileIndex) {
    this.#ldraw = ldraw;
    this.#shadow = shadow;
  }

  static async fromDirs(ldrawRoot: string, shadowRoot: string | null): Promise<LDrawLibrary> {
    const ldraw = await indexTree(ldrawRoot);
    const shadow = shadowRoot ? await indexTree(shadowRoot) : new Map();
    return new LDrawLibrary(ldraw, shadow);
  }

  static fromMaps(ldraw: Map<string, string>, shadow: Map<string, string>): LDrawLibrary {
    return new LDrawLibrary(fromMap(ldraw), fromMap(shadow));
  }

  normalize(ref: string): string {
    return ref.trim().replaceAll('\\', '/').toLowerCase();
  }

  read(ref: string): string | null {
    const text = this.#lookup(this.#ldraw, ref);
    if (text !== null) {
      const tag = extractUpdateTag(text);
      if (tag !== null && (this.#release === null || tag > this.#release)) this.#release = tag;
    }
    return text;
  }

  readShadow(ref: string): string | null {
    return this.#lookup(this.#shadow, ref);
  }

  /** True when `parts/<partFile>` exists. Never consults `p/`. */
  has(partFile: string): boolean {
    return this.#ldraw.has(`parts/${this.normalize(partFile)}`);
  }

  /** Names of the files directly in `parts/` (not its sub-folders), such as `3001.dat`. */
  partFiles(): string[] {
    const out: string[] = [];
    for (const key of this.#ldraw.keys()) {
      if (key.startsWith('parts/') && !key.includes('/', 'parts/'.length)) out.push(key.slice('parts/'.length));
    }
    return out;
  }

  /** Which library folder holds `ref`: `parts/` first, then `p/`, as `read` looks. Null when neither does. */
  where(ref: string): 'parts' | 'p' | null {
    const n = this.normalize(ref);
    if (this.#ldraw.has(`parts/${n}`)) return 'parts';
    return this.#ldraw.has(`p/${n}`) ? 'p' : null;
  }

  /**
   * Lines of `ref` from the start through the first line `stop` accepts (or the whole file), read
   * without loading the rest. Looks in `parts/`, then `p/`; null when the file does not exist.
   * Does not affect `releaseName`.
   */
  head(ref: string, stop: (line: string) => boolean): string[] | null {
    const n = this.normalize(ref);
    const entry = this.#ldraw.get(`parts/${n}`) ?? this.#ldraw.get(`p/${n}`);
    return entry ? entry.head(stop) : null;
  }

  /** Largest `YYYY-RR` update tag among LDraw files read so far. */
  releaseName(): string | null {
    return this.#release;
  }

  #lookup(index: FileIndex, ref: string): string | null {
    const n = this.normalize(ref);
    const entry = index.get(`parts/${n}`) ?? index.get(`p/${n}`);
    return entry ? entry.read() : null;
  }
}
