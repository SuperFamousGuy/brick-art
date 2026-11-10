import { readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { extractUpdateTag } from './parse.ts';

/** Maps normalized relative path (`parts/3001.dat`) to a lazy reader. */
type FileIndex = Map<string, () => string>;

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
      index.set(key, () => readFileSync(abs, 'utf8'));
    }
  }
  return index;
}

function fromMap(map: Map<string, string>): FileIndex {
  const index: FileIndex = new Map();
  for (const [k, v] of map) index.set(k, () => v);
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

  /** Largest `YYYY-RR` update tag among LDraw files read so far. */
  releaseName(): string | null {
    return this.#release;
  }

  #lookup(index: FileIndex, ref: string): string | null {
    const n = this.normalize(ref);
    const reader = index.get(`parts/${n}`) ?? index.get(`p/${n}`);
    return reader ? reader() : null;
  }
}
