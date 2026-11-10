import type { ConnectionPoint, Mat3, Triangle, Vec3 } from '../types.ts';
import { LDrawLibrary } from './library.ts';
import { parseLDraw } from './parse.ts';
import type { ParsedFile } from './parse.ts';
import { SnapParseError, expandSnap, gridOffsets, parseSnapLine, snapPosOri } from './snaps.ts';

export interface ResolvedPart {
  triangles: Triangle[];
  bodyTriangles: Triangle[];
  connections: ConnectionPoint[];
  license: string | null;
  missingRefs: string[];
  cyclic: boolean;
  /** Messages for malformed snap metadata that was skipped. */
  errors: string[];
}

/** One file resolved in its own frame (before the parent's placement is applied). */
interface Local {
  /** Flat x,y,z * 3 per triangle, in this file's frame. */
  triangles: Float64Array;
  /** Same array as `triangles` when the subtree has no stud primitive. */
  bodyTriangles: Float64Array;
  license: string | null;
  snaps: ConnectionPoint[];
  inferred: ConnectionPoint[];
  /** True when any LDCad snap existed in the tree, even if a SNAP_CLEAR later dropped it. */
  sawSnaps: boolean;
  missingRefs: string[];
  errors: string[];
  cyclic: boolean;
}

interface Memo { local: Map<string, Local> }

const memos = new WeakMap<LDrawLibrary, Memo>();
const STUD_BODY_RE = /^(p\/)?(stud[0-9a-z]*|stu2[0-9a-z]*)\.dat$/;
const INFER_STUD = new Set(['stud.dat', 'stud2.dat', 'stud2a.dat']);
const INFER_RECEPTOR = new Set(['stud3.dat', 'stud4.dat', 'stud4a.dat']);
const MAX_INCL_DEPTH = 8;

function memoFor(lib: LDrawLibrary): Memo {
  let m = memos.get(lib);
  if (!m) { m = { local: new Map() }; memos.set(lib, m); }
  return m;
}

function mulVec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2] + 0,
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2] + 0,
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2] + 0,
  ];
}

function unit(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len === 0 ? v : [v[0] / len + 0, v[1] / len + 0, v[2] / len + 0];
}

function place(pos: Vec3, m: Mat3, p: Vec3): Vec3 {
  const r = mulVec(m, p);
  return [pos[0] + r[0] + 0, pos[1] + r[1] + 0, pos[2] + r[2] + 0];
}

function placePoint(pt: ConnectionPoint, pos: Vec3, m: Mat3): ConnectionPoint {
  return { ...pt, position: place(pos, m, pt.position), direction: unit(mulVec(m, pt.direction)) };
}

/** Append `src` (flat vertices) placed by pos/m to `out`. */
function placeFlat(src: ArrayLike<number>, pos: Vec3, m: Mat3, out: number[]): void {
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i]!, y = src[i + 1]!, z = src[i + 2]!;
    out.push(
      pos[0] + m[0] * x + m[1] * y + m[2] * z + 0,
      pos[1] + m[3] * x + m[4] * y + m[5] * z + 0,
      pos[2] + m[6] * x + m[7] * y + m[8] * z + 0,
    );
  }
}

function parseFile(lib: LDrawLibrary, name: string): ParsedFile | null {
  const text = lib.read(name);
  return text === null ? null : parseLDraw(text);
}

/** Expand the snaps of one shadow file (own lines and INCL targets), in that file's frame. */
function shadowSnaps(
  lib: LDrawLibrary, name: string, errors: string[], clears: Array<string | null>, depth: number,
): ConnectionPoint[] {
  const text = lib.readShadow(name);
  if (text === null) return [];
  const out: ConnectionPoint[] = [];
  const inclusions: Array<{ ref: string; pos: Vec3; ori: Mat3; offsets: Vec3[] }> = [];
  for (const line of parseLDraw(text).snapLines) {
    try {
      const spec = parseSnapLine(line);
      if (spec.kind === 'CLEAR') {
        clears.push(spec.params.id ?? null);
      } else if (spec.kind === 'INCL') {
        const ref = spec.params.ref;
        if (!ref) throw new SnapParseError(`SNAP_INCL without ref in line: ${line}`);
        const { pos, ori } = snapPosOri(spec);
        inclusions.push({ ref, pos, ori, offsets: gridOffsets(spec.params.grid) });
      } else {
        out.push(...expandSnap(spec, line));
      }
    } catch (e) {
      if (!(e instanceof SnapParseError)) throw e;
      errors.push(e.message);
    }
  }
  if (depth < MAX_INCL_DEPTH) {
    for (const inc of inclusions) {
      const inner = shadowSnaps(lib, inc.ref, errors, [], depth + 1);
      for (const off of inc.offsets) {
        const at = place(inc.pos, inc.ori, off);
        for (const pt of inner) out.push(placePoint(pt, at, inc.ori));
      }
    }
  }
  return out;
}

const NO_TRIS = new Float64Array(0);

function resolveLocal(lib: LDrawLibrary, memo: Memo, name: string, path: Set<string>, top: boolean): Local {
  const cached = memo.local.get(name);
  if (cached) return cached;

  const result: Local = {
    triangles: NO_TRIS, bodyTriangles: NO_TRIS, license: null, snaps: [], inferred: [], sawSnaps: false,
    missingRefs: [], errors: [], cyclic: false,
  };
  const parsed = parseFile(lib, name);
  if (parsed === null) {
    result.missingRefs.push(name);
    memo.local.set(name, result);
    return result;
  }

  result.license = parsed.license;
  const isStud = STUD_BODY_RE.test(name);
  let hasStud = isStud;
  const tris: number[] = [];
  const body: number[] = [];
  for (const t of parsed.tris) {
    for (const v of t) tris.push(v[0], v[1], v[2]);
  }
  if (!isStud) for (const v of tris) body.push(v); // no spread: arrays can exceed the argument limit

  const clears: Array<string | null> = [];
  result.snaps.push(...shadowSnaps(lib, name, result.errors, clears, 0));

  if (result.snaps.length > 0) result.sawSnaps = true;
  path.add(name);
  const childSnaps: ConnectionPoint[] = [];
  for (const ref of parsed.refs) {
    const child = lib.normalize(ref.file);
    if (path.has(child)) { result.cyclic = true; continue; }
    const base = child.replace(/^p\//, '');
    if (INFER_STUD.has(base)) {
      result.inferred.push(inferred('stud', [0, -1, 0], ref.pos, ref.matrix, child));
    } else if (INFER_RECEPTOR.has(base)) {
      result.inferred.push(inferred('stud_receptor', [0, 1, 0], ref.pos, ref.matrix, child));
    }
    const sub = resolveLocal(lib, memo, child, path, false);
    placeFlat(sub.triangles, ref.pos, ref.matrix, tris);
    if (sub.bodyTriangles !== sub.triangles) hasStud = true;
    if (!isStud) placeFlat(sub.bodyTriangles, ref.pos, ref.matrix, body);
    for (const s of sub.snaps) childSnaps.push(placePoint(s, ref.pos, ref.matrix));
    for (const s of sub.inferred) result.inferred.push(placePoint(s, ref.pos, ref.matrix));
    result.missingRefs.push(...sub.missingRefs);
    result.errors.push(...sub.errors);
    if (sub.sawSnaps) result.sawSnaps = true;
    if (sub.cyclic) result.cyclic = true;
  }
  path.delete(name);
  result.triangles = Float64Array.from(tris);
  result.bodyTriangles = hasStud ? Float64Array.from(body) : result.triangles;

  const clearAll = clears.includes(null);
  const clearIds = new Set(clears.filter((c): c is string => c !== null));
  for (const s of childSnaps) {
    if (clearAll || (s.snapId !== null && clearIds.has(s.snapId))) continue;
    result.snaps.push(s);
  }

  // A cycle skip makes the result depend on the current path, so it must not be reused.
  // The top-level part is not stored either: it is rarely a child, and keeping every
  // part's full geometry for a whole-library seed would hold the entire library in memory.
  if (!result.cyclic && !top) memo.local.set(name, result);
  return result;
}

function inferred(
  type: 'stud' | 'stud_receptor', dir: Vec3, pos: Vec3, m: Mat3, raw: string,
): ConnectionPoint {
  return {
    type, position: [pos[0] + 0, pos[1] + 0, pos[2] + 0], direction: unit(mulVec(m, dir)),
    angleMin: null, angleMax: null, source: 'inferred', raw, snapId: null,
  };
}

/**
 * Resolve a part file into world-frame geometry and connection points.
 * Falls back to inferring studs from stud primitives when no LDCad snaps exist.
 */
export function resolvePart(lib: LDrawLibrary, file: string): ResolvedPart {
  const memo = memoFor(lib);
  const name = lib.normalize(file);
  const local = resolveLocal(lib, memo, name, new Set(), true);
  const uniq = (xs: string[]): string[] => [...new Set(xs)];
  // Everything returned is a fresh copy so callers cannot corrupt the memo.
  const toTris = (flat: Float64Array): Triangle[] => {
    const out: Triangle[] = [];
    for (let i = 0; i < flat.length; i += 9) {
      out.push([
        [flat[i]!, flat[i + 1]!, flat[i + 2]!],
        [flat[i + 3]!, flat[i + 4]!, flat[i + 5]!],
        [flat[i + 6]!, flat[i + 7]!, flat[i + 8]!],
      ]);
    }
    return out;
  };
  const triangles = toTris(local.triangles);
  const points = local.sawSnaps ? local.snaps : local.inferred;
  return {
    triangles,
    bodyTriangles: toTris(local.bodyTriangles),
    connections: points.map((c) => ({ ...c, position: [...c.position], direction: [...c.direction] })),
    license: local.license,
    missingRefs: uniq(local.missingRefs),
    cyclic: local.cyclic,
    errors: uniq(local.errors),
  };
}
