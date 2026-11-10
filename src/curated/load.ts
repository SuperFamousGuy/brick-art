import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

export type CreativeUse = {
  part: string;
  represents: string;
  note: string | null;
  reviewed: boolean;
};

export type Curated = {
  families: Map<number, string>;
  uses: CreativeUse[];
  hash: string;
};

const FAMILIES_FILE = 'color-families.yaml';
const USES_FILE = 'creative-uses.yaml';

export function curatedDir(repoRoot: string): string {
  return join(repoRoot, 'curated');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseFamilies(doc: unknown): Map<number, string> {
  if (!isRecord(doc) || !isRecord(doc.families)) {
    throw new Error(`${FAMILIES_FILE}: expected a top-level "families" map`);
  }
  const out = new Map<number, string>();
  for (const [family, ids] of Object.entries(doc.families)) {
    if (!Array.isArray(ids)) throw new Error(`${FAMILIES_FILE}: family "${family}" must be a list`);
    for (const id of ids) {
      if (typeof id !== 'number' || !Number.isInteger(id)) {
        throw new Error(`${FAMILIES_FILE}: family "${family}" has a non-integer color id`);
      }
      const prior = out.get(id);
      if (prior !== undefined) {
        throw new Error(`${FAMILIES_FILE}: color ${id} is listed under both "${prior}" and "${family}"`);
      }
      out.set(id, family);
    }
  }
  return out;
}

// Entry-level problems are kept in the value (not thrown) so validateUses can reject them.
function parseUses(doc: unknown): CreativeUse[] {
  if (!Array.isArray(doc)) throw new Error(`${USES_FILE}: expected a top-level list`);
  return doc.map((raw): CreativeUse => {
    const e = isRecord(raw) ? raw : {};
    const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));
    return {
      part: str(e.part),
      represents: str(e.represents),
      note: e.note === undefined || e.note === null ? null : String(e.note),
      reviewed: e.reviewed as boolean,
    };
  });
}

export async function loadCurated(dir: string): Promise<Curated> {
  const names = [FAMILIES_FILE, USES_FILE].sort();
  const bytes = await Promise.all(names.map((n) => readFile(join(dir, n))));
  const hash = createHash('sha256');
  for (const b of bytes) hash.update(b);
  const byName = new Map(names.map((n, i) => [n, bytes[i]!.toString('utf8')]));
  return {
    families: parseFamilies(parse(byName.get(FAMILIES_FILE)!)),
    uses: parseUses(parse(byName.get(USES_FILE)!)),
    hash: hash.digest('hex'),
  };
}

export function validateUses(
  uses: CreativeUse[],
  partNums: Set<string>,
): { accepted: CreativeUse[]; rejected: { use: CreativeUse; reason: string }[] } {
  const accepted: CreativeUse[] = [];
  const rejected: { use: CreativeUse; reason: string }[] = [];
  for (const use of uses) {
    let reason: string | null = null;
    if (use.part.trim() === '') reason = 'missing part';
    else if (use.represents.trim() === '') reason = 'missing represents';
    else if (typeof use.reviewed !== 'boolean') reason = 'reviewed must be a boolean';
    else if (!partNums.has(use.part)) reason = `unknown part ${use.part}`;
    if (reason === null) accepted.push(use);
    else rejected.push({ use, reason });
  }
  return { accepted, rejected };
}
