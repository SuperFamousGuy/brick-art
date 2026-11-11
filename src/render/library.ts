import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { dataPaths } from '../paths.ts';
import { DEFAULT_SOURCE_URLS, fetchOne } from '../sources/fetch.ts';
import { ZipIndex } from './zip-index.ts';

const LDRAW_PREFIX = /^ldraw\//i;

let cached: { zipFile: string; index: ZipIndex } | null = null;
let pending: Promise<ZipIndex> | null = null;

/**
 * Opens the LDraw parts library zip for rendering, downloading it into the data cache
 * when absent. The local seed keeps the same file, so a seeded install never downloads it twice.
 * BRICK_ART_LDRAW_ZIP points at another copy.
 */
export async function openLDrawLibrary(dataDir: string, env: NodeJS.ProcessEnv = process.env): Promise<ZipIndex> {
  const { cacheDir } = dataPaths(dataDir);
  const zipFile = env.BRICK_ART_LDRAW_ZIP || join(cacheDir, 'ldraw.zip');
  if (cached?.zipFile === zipFile) return cached.index;
  pending ??= (async () => {
    const present = await stat(zipFile).then((s) => s.isFile(), () => false);
    if (!present) {
      if (env.BRICK_ART_LDRAW_ZIP) throw new Error(`BRICK_ART_LDRAW_ZIP not found: ${zipFile}`);
      await mkdir(cacheDir, { recursive: true });
      await fetchOne(cacheDir, 'ldraw', 'ldraw.zip', DEFAULT_SOURCE_URLS.ldrawZip, {}, 60_000);
    }
    const index = ZipIndex.open(zipFile, LDRAW_PREFIX);
    if (!index.has('LDConfig.ldr')) {
      index.close();
      throw new Error(`not an LDraw library zip (no LDConfig.ldr): ${zipFile}`);
    }
    cached?.index.close();
    cached = { zipFile, index };
    return index;
  })().finally(() => { pending = null; });
  return pending;
}
