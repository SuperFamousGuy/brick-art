import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { inflateSync } from 'fflate';

interface ZipEntry { method: number; compressedSize: number; localHeaderOffset: number }

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const EOCD_MIN = 22;
const EOCD_SEARCH = EOCD_MIN + 0xffff;

/**
 * Random-access reader for a zip file: reads the central directory once, then
 * inflates single entries on demand. Keys are lowercased paths with `stripPrefix` removed.
 * Zip64 archives are not supported.
 */
export class ZipIndex {
  #fd: number;
  #entries = new Map<string, ZipEntry>();

  private constructor(fd: number) {
    this.#fd = fd;
  }

  static open(zipFile: string, stripPrefix: RegExp = /^$/): ZipIndex {
    const fd = openSync(zipFile, 'r');
    try {
      const index = new ZipIndex(fd);
      index.#readDirectory(stripPrefix);
      return index;
    } catch (err) {
      closeSync(fd);
      throw err;
    }
  }

  #read(position: number, length: number): Buffer {
    const buf = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const n = readSync(this.#fd, buf, done, length - done, position + done);
      if (n === 0) throw new Error('zip: unexpected end of file');
      done += n;
    }
    return buf;
  }

  #readDirectory(stripPrefix: RegExp): void {
    const size = fstatSync(this.#fd).size;
    const tailLen = Math.min(size, EOCD_SEARCH);
    const tail = this.#read(size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tailLen - EOCD_MIN; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('zip: end of central directory not found');
    const count = tail.readUInt16LE(eocd + 10);
    const dirSize = tail.readUInt32LE(eocd + 12);
    const dirOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || dirOffset === 0xffffffff) throw new Error('zip: zip64 archives are not supported');
    const dir = this.#read(dirOffset, dirSize);
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (dir.readUInt32LE(p) !== CDH_SIG) throw new Error('zip: bad central directory entry');
      const method = dir.readUInt16LE(p + 10);
      const compressedSize = dir.readUInt32LE(p + 20);
      const nameLen = dir.readUInt16LE(p + 28);
      const extraLen = dir.readUInt16LE(p + 30);
      const commentLen = dir.readUInt16LE(p + 32);
      const localHeaderOffset = dir.readUInt32LE(p + 42);
      const name = dir.toString('utf8', p + 46, p + 46 + nameLen).replaceAll('\\', '/');
      p += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith('/')) continue;
      const key = name.replace(stripPrefix, '').toLowerCase();
      if (key !== '' && !this.#entries.has(key)) this.#entries.set(key, { method, compressedSize, localHeaderOffset });
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  has(path: string): boolean {
    return this.#entries.has(path.toLowerCase());
  }

  /** Returns the entry's bytes, or null when the path is not in the archive. */
  get(path: string): Uint8Array | null {
    const entry = this.#entries.get(path.toLowerCase());
    if (!entry) return null;
    const header = this.#read(entry.localHeaderOffset, 30);
    if (header.readUInt32LE(0) !== LFH_SIG) throw new Error('zip: bad local file header');
    const dataStart = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const raw = this.#read(dataStart, entry.compressedSize);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return inflateSync(raw);
    throw new Error(`zip: unsupported compression method ${entry.method}`);
  }

  close(): void {
    closeSync(this.#fd);
  }
}
