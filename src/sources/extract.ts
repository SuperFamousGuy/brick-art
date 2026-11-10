import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { posix } from 'node:path';
import { Unzip, UnzipInflate } from 'fflate';
import type { UnzipFile } from 'fflate';

/** Returns a safe relative path, or null when the entry must be skipped. */
function safeRelative(name: string, stripPrefix: RegExp): string | null {
  const stripped = name.replaceAll('\\', '/').replace(stripPrefix, '');
  if (stripped === '' || stripped.endsWith('/')) return null;
  if (stripped.startsWith('/') || /^[A-Za-z]:/.test(stripped)) return null;
  if (stripped.split('/').includes('..')) return null;
  const normalized = posix.normalize(stripped);
  if (normalized.startsWith('..') || posix.isAbsolute(normalized)) return null;
  return normalized;
}

/**
 * Streams a zip file and writes the entries accepted by `keep` (tested against
 * the path after `stripPrefix` is removed) under `destDir`. Returns the number
 * of files written.
 */
export async function extractZip(
  zipFile: string,
  destDir: string,
  keep: (path: string) => boolean,
  stripPrefix: RegExp,
): Promise<number> {
  let written = 0;
  let pending: Promise<void>[] = [];
  let failure: unknown = null;

  const unzip = new Unzip((file: UnzipFile) => {
    const rel = safeRelative(file.name, stripPrefix);
    if (rel === null || !keep(rel)) return;
    const chunks: Uint8Array[] = [];
    file.ondata = (err, chunk, final) => {
      if (err) { failure ??= err; return; }
      chunks.push(chunk);
      if (!final) return;
      const target = join(destDir, ...rel.split('/'));
      pending.push(
        mkdir(dirname(target), { recursive: true })
          .then(() => writeFile(target, Buffer.concat(chunks)))
          .then(() => { written++; }),
      );
    };
    file.start();
  });
  unzip.register(UnzipInflate);

  for await (const chunk of createReadStream(zipFile)) {
    unzip.push(chunk as Uint8Array);
    if (failure) throw failure;
    await Promise.all(pending);
    pending = [];
  }
  unzip.push(new Uint8Array(0), true);
  if (failure) throw failure;
  await Promise.all(pending);
  return written;
}
