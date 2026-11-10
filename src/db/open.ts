import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataPaths } from '../paths.ts';

/** Returns the database file name current.json points to, or null if absent or unreadable. */
export function readPointer(dataDir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(dataPaths(dataDir).pointer, 'utf8'));
    const file = (parsed as { file?: unknown } | null)?.file;
    return typeof file === 'string' && file.length > 0 && path.basename(file) === file ? file : null;
  } catch {
    return null;
  }
}

/** Atomically points current.json at dbFileName (temp file plus rename). */
export function writePointer(dataDir: string, dbFileName: string): void {
  const { pointer } = dataPaths(dataDir);
  mkdirSync(dataDir, { recursive: true });
  const tmp = `${pointer}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ file: dbFileName }));
  renameSync(tmp, pointer);
}

/** Read-only handle on the database named by the pointer; reopens when the pointer changes. */
export class CurrentDb {
  #dataDir: string;
  #db: DatabaseSync | null = null;
  #openName: string | null = null;

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
  }

  get(): DatabaseSync | null {
    const name = readPointer(this.#dataDir);
    if (name === null) {
      this.close();
      return null;
    }
    if (this.#db !== null && this.#openName === name) return this.#db;
    this.close();
    const file = path.join(this.#dataDir, name);
    if (!existsSync(file)) return null;
    try {
      this.#db = new DatabaseSync(file, { readOnly: true });
      this.#openName = name;
    } catch {
      this.#db = null;
      this.#openName = null;
    }
    return this.#db;
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
    this.#openName = null;
  }
}
