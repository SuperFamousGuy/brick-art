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

export type FanSource = {
  id: string;
  name: string;
  homepage: string;
  fetch:
    | { kind: 'github'; repo: string; paths: string[] }
    | { kind: 'url'; url: string; paths: string[] };
  designer: string;
  defaultLicense: string | null;
};

/** One Pick a Brick check: the element sold for a part in a color, or null when it is not sold. */
export type PickABrickCheck = {
  part: string;
  /** Rebrickable color id, or null when the check holds for every color. */
  color: number | null;
  element: string | null;
  checked: string;
};

export type Curated = {
  families: Map<number, string>;
  uses: CreativeUse[];
  fanSources: FanSource[];
  pickABrick: PickABrickCheck[];
  hash: string;
};

const FAMILIES_FILE = 'color-families.yaml';
const USES_FILE = 'creative-uses.yaml';
const FAN_FILE = 'fan-sources.yaml';
const PAB_FILE = 'pick-a-brick.yaml';

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

function parseFanSources(doc: unknown): FanSource[] {
  if (!Array.isArray(doc)) throw new Error(`${FAN_FILE}: expected a top-level list`);
  const seen = new Set<string>();
  return doc.map((raw, i): FanSource => {
    const e = isRecord(raw) ? raw : {};
    const id = typeof e.id === 'string' ? e.id : '';
    const fail = (problem: string): never => {
      throw new Error(`${FAN_FILE}: ${id === '' ? `entry ${i + 1}` : id}: ${problem}`);
    };
    // The id names cache files, so it must be path-safe and must not be a hyphen-prefix of another id.
    if (!/^[a-z0-9_]+$/.test(id)) fail('id must be lowercase letters, digits, or underscores');
    if (seen.has(id)) fail('duplicate id');
    seen.add(id);
    const text = (key: string): string => {
      const v = e[key];
      if (typeof v !== 'string' || v.trim() === '') fail(`missing ${key}`);
      return v as string;
    };
    const f = isRecord(e.fetch) ? e.fetch : {};
    if (f.kind !== 'github' && f.kind !== 'url') fail('fetch.kind must be "github" or "url"');
    const paths = f.paths;
    if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => typeof p !== 'string' || p === '')) {
      fail('fetch.paths must be a non-empty list of globs');
    }
    const globs = paths as string[];
    let fetch: FanSource['fetch'];
    if (f.kind === 'github') {
      if (typeof f.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(f.repo)) fail('fetch.repo must be "owner/name"');
      fetch = { kind: 'github', repo: f.repo as string, paths: globs };
    } else {
      if (typeof f.url !== 'string' || !/^https?:\/\//.test(f.url)) fail('fetch.url must be an http(s) URL');
      fetch = { kind: 'url', url: f.url as string, paths: globs };
    }
    const dl = e.default_license;
    if (dl !== undefined && dl !== null && (typeof dl !== 'string' || dl.trim() === '')) {
      fail('default_license must be a string');
    }
    return {
      id, name: text('name'), homepage: text('homepage'), fetch, designer: text('designer'),
      defaultLicense: typeof dl === 'string' ? dl : null,
    };
  });
}

function parsePickABrick(doc: unknown): PickABrickCheck[] {
  if (doc === null || doc === undefined) return [];
  if (!Array.isArray(doc)) throw new Error(`${PAB_FILE}: expected a top-level list`);
  const seen = new Set<string>();
  return doc.map((raw, i): PickABrickCheck => {
    const e = isRecord(raw) ? raw : {};
    const fail = (problem: string): never => {
      throw new Error(`${PAB_FILE}: entry ${i + 1}${typeof e.part === 'string' ? ` (${e.part})` : ''}: ${problem}`);
    };
    if (typeof e.part !== 'string' || e.part.trim() === '') fail('part must be a quoted part number');
    const color = e.color;
    if (color !== undefined && color !== null && (typeof color !== 'number' || !Number.isInteger(color))) {
      fail('color must be an integer Rebrickable color id');
    }
    const element = e.element;
    if (element !== null && (typeof element !== 'string' || !/^\d{5,8}$/.test(element))) {
      fail('element must be a quoted element ID or null');
    }
    // An element ID names one color, so only "not sold" may apply to every color.
    if (element !== null && (color === undefined || color === null)) fail('a sold element needs a color');
    if (typeof e.checked !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.checked)) fail('checked must be a quoted YYYY-MM-DD date');
    const out = { part: e.part as string, color: (color ?? null) as number | null, element: element as string | null, checked: e.checked as string };
    const k = `${out.part}\u0000${out.color ?? '*'}`;
    if (seen.has(k)) fail(`duplicate entry for color ${out.color ?? 'any'}`);
    seen.add(k);
    return out;
  });
}

export async function loadCurated(dir: string): Promise<Curated> {
  const names = [FAMILIES_FILE, USES_FILE, FAN_FILE, PAB_FILE].sort();
  // The Pick a Brick file is optional; a missing one adds nothing to the hash.
  const optional = new Set([PAB_FILE]);
  const bytes = await Promise.all(names.map((n) => readFile(join(dir, n)).catch((err: NodeJS.ErrnoException) => {
    if (optional.has(n) && err.code === 'ENOENT') return Buffer.alloc(0);
    throw err;
  })));
  const hash = createHash('sha256');
  for (const b of bytes) hash.update(b);
  const byName = new Map(names.map((n, i) => [n, bytes[i]!.toString('utf8')]));
  return {
    families: parseFamilies(parse(byName.get(FAMILIES_FILE)!)),
    uses: parseUses(parse(byName.get(USES_FILE)!)),
    fanSources: parseFanSources(parse(byName.get(FAN_FILE)!)),
    pickABrick: parsePickABrick(parse(byName.get(PAB_FILE)!)),
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

/** Keeps the Pick a Brick checks whose part is in the database; the rest are rejected with a reason. */
export function validatePickABrick(
  checks: PickABrickCheck[],
  partNums: Set<string>,
): { accepted: PickABrickCheck[]; rejected: { check: PickABrickCheck; reason: string }[] } {
  const accepted: PickABrickCheck[] = [];
  const rejected: { check: PickABrickCheck; reason: string }[] = [];
  for (const check of checks) {
    if (partNums.has(check.part)) accepted.push(check);
    else rejected.push({ check, reason: `unknown part ${check.part}` });
  }
  return { accepted, rejected };
}
