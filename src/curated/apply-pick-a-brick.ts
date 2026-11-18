import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readPointer } from '../db/open.ts';
import { writePickABrick } from '../db/write.ts';
import { curatedDir, loadCurated, validatePickABrick } from './load.ts';

export interface ApplyResult { dbFile: string; written: number; rejected: { part: string; reason: string }[] }

/**
 * Writes curated/pick-a-brick.yaml into the current parts database in `dataDir`, replacing its
 * Pick a Brick checks. This updates an installed database without a full reseed; a new data
 * release carries the same checks.
 */
export async function applyPickABrick(dataDir: string, repoRoot: string): Promise<ApplyResult> {
  const file = readPointer(dataDir);
  if (file === null) throw new Error(`no parts database in ${dataDir}`);
  const dbFile = join(dataDir, file);
  const curated = await loadCurated(curatedDir(repoRoot));
  const db = new DatabaseSync(dbFile);
  try {
    const partNums = new Set((db.prepare('SELECT part_num AS p FROM parts').all() as { p: string }[]).map((r) => r.p));
    const { accepted, rejected } = validatePickABrick(curated.pickABrick, partNums);
    writePickABrick(db, accepted.map((c) => ({ partNum: c.part, colorId: c.color, elementId: c.element, checked: c.checked })));
    return { dbFile, written: accepted.length, rejected: rejected.map((r) => ({ part: r.check.part, reason: r.reason })) };
  } finally {
    db.close();
  }
}
