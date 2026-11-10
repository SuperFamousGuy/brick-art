import type { ConnectionPoint, ConnectionType, Mat3, Vec3 } from '../types.ts';

export type SnapKind = 'CYL' | 'CLP' | 'FGR' | 'SPH' | 'GEN' | 'INCL' | 'CLEAR';
export interface SnapSpec { kind: SnapKind; params: Record<string, string> }

export class SnapParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapParseError';
  }
}

const MAX_GRID_COUNT = 100;
const KINDS: readonly string[] = ['CYL', 'CLP', 'FGR', 'SPH', 'GEN', 'INCL', 'CLEAR'];
const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const KIND_RE = /^\s*0\s+!LDCAD\s+SNAP_([A-Za-z]+)/;
const PARAM_RE = /\[\s*([^=\]\s]+)\s*=([^\]]*)\]/g;

/** Parse a `0 !LDCAD SNAP_xxx [name=value] ...` line. Parameter names are lowercased. */
export function parseSnapLine(line: string): SnapSpec {
  const m = KIND_RE.exec(line);
  const kind = m?.[1]?.toUpperCase();
  if (!kind || !KINDS.includes(kind)) throw new SnapParseError(`Unrecognised snap kind in line: ${line}`);
  const params: Record<string, string> = {};
  for (const p of line.matchAll(PARAM_RE)) params[p[1]!.toLowerCase()] = p[2]!.trim();
  const spec = { kind: kind as SnapKind, params };
  withLine(line, () => { snapPosOri(spec); gridOffsets(params.grid); parseSecs(params.secs); });
  return spec;
}

/** Re-throw a SnapParseError with the raw line appended. */
function withLine<T>(line: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof SnapParseError) throw new SnapParseError(`${e.message} in line: ${line}`);
    throw e;
  }
}

function numList(name: string, s: string | undefined, count: number): number[] | null {
  if (s === undefined) return null;
  const parts = s.trim().split(/\s+/).map(Number);
  if (parts.length !== count || !parts.every((n) => Number.isFinite(n))) {
    throw new SnapParseError(`Malformed ${name} "${s}" (expected ${count} numbers)`);
  }
  return parts;
}

/** Position and orientation of the snap in its file's frame (defaults: origin, identity). */
export function snapPosOri(spec: SnapSpec): { pos: Vec3; ori: Mat3 } {
  const pos = (numList('pos', spec.params.pos, 3) ?? [0, 0, 0]) as Vec3;
  const ori = (numList('ori', spec.params.ori, 9) ?? IDENTITY) as Mat3;
  return { pos, ori };
}

/** Expand a `grid` value such as `C 4 C 2 20 20` into offsets `(gx, 0, gz)`. */
export function gridOffsets(grid: string | undefined): Vec3[] {
  if (grid === undefined) return [[0, 0, 0]];
  const bad = (why: string): SnapParseError => new SnapParseError(`Malformed grid "${grid}" (${why})`);
  if (grid.trim() === '') throw bad('empty');
  const tokens = grid.trim().split(/\s+/);
  let i = 0;
  const axis = (): { count: number; centered: boolean } => {
    let centered = false;
    if (tokens[i]?.toUpperCase() === 'C') { centered = true; i++; }
    const count = Number(tokens[i++]);
    if (!Number.isInteger(count) || count < 1) throw bad('count must be a positive integer');
    if (count > MAX_GRID_COUNT) throw bad(`count ${count} exceeds ${MAX_GRID_COUNT}`);
    return { count, centered };
  };
  const x = axis();
  const z = axis();
  const stepX = Number(tokens[i]);
  const stepZ = Number(tokens[i + 1]);
  if (tokens.length !== i + 2 || !Number.isFinite(stepX) || !Number.isFinite(stepZ)) {
    throw bad('expected counts followed by two steps');
  }
  const at = (idx: number, a: { count: number; centered: boolean }, step: number): number =>
    (a.centered ? idx - (a.count - 1) / 2 : idx) * step + 0; // + 0 turns -0 into 0
  const out: Vec3[] = [];
  for (let ix = 0; ix < x.count; ix++) {
    for (let iz = 0; iz < z.count; iz++) out.push([at(ix, x, stepX), 0, at(iz, z, stepZ)]);
  }
  return out;
}

function mulVec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2] + 0,
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2] + 0,
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2] + 0,
  ];
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len === 0) return v;
  return [v[0] / len + 0, v[1] / len + 0, v[2] / len + 0];
}

interface Section { shape: string; radius: number; length: number }

function parseSecs(secs: string | undefined): Section[] {
  if (secs === undefined) return [];
  const t = secs.trim().split(/\s+/);
  const bad = (): SnapParseError => new SnapParseError(`Malformed secs "${secs}" (expected groups of shape radius length)`);
  if (secs.trim() === '' || t.length % 3 !== 0) throw bad();
  const out: Section[] = [];
  for (let i = 0; i < t.length; i += 3) {
    const shape = t[i]!.toUpperCase();
    const radius = Number(t[i + 1]);
    const length = Number(t[i + 2]);
    if (!Number.isFinite(radius) || !Number.isFinite(length)) throw bad();
    out.push({ shape: shape === 'S' || shape === 'A' ? shape : 'R', radius, length });
  }
  return out;
}

function classifyCyl(params: Record<string, string>, male: boolean): ConnectionType {
  const secs = parseSecs(params.secs);
  if (secs.some((s) => s.shape === 'A')) return male ? 'axle' : 'axle_hole';
  if (secs.length === 0) return 'other';
  const dominant = secs.reduce((a, b) => (b.length > a.length ? b : a));
  const oneCap = (params.caps ?? 'one').toLowerCase() === 'one';
  if (dominant.radius <= 4.5) return male ? 'bar' : 'bar_holder';
  if (dominant.radius <= 7) {
    if (male) {
      const total = secs.reduce((sum, s) => sum + s.length, 0);
      return oneCap && total <= 8 ? 'stud' : 'pin';
    }
    return oneCap ? 'stud_receptor' : 'pin_hole';
  }
  return 'other';
}

/** Expand a snap into connection points in its own file's frame (grid applied). INCL/CLEAR yield none. */
export function expandSnap(spec: SnapSpec, raw: string): ConnectionPoint[] {
  return withLine(raw, () => expandSnapUnchecked(spec, raw));
}

function expandSnapUnchecked(spec: SnapSpec, raw: string): ConnectionPoint[] {
  if (spec.kind === 'INCL' || spec.kind === 'CLEAR') return [];
  const p = spec.params;
  const gender = (p.gender ?? 'M').toUpperCase();
  const male = gender !== 'F';
  let type: ConnectionType;
  let faceUp = false; // true: faces +y, false: faces -y
  switch (spec.kind) {
    case 'CYL': type = classifyCyl(p, male); faceUp = !male; break;
    case 'CLP': type = 'clip'; break;
    case 'FGR': {
      const g = (p.genderofs ?? 'M').toUpperCase();
      type = g === 'F' ? 'hinge_f' : 'hinge_m';
      faceUp = g === 'F';
      break;
    }
    case 'SPH': type = male ? 'ball' : 'socket'; faceUp = !male; break;
    default: type = 'other'; faceUp = !male; break;
  }
  const { pos, ori } = snapPosOri(spec);
  const direction = normalize(mulVec(ori, [0, faceUp ? 1 : -1, 0]));
  const snapId = p.id ?? null;
  return gridOffsets(p.grid).map((off) => {
    const o = mulVec(ori, off);
    return {
      type,
      position: [pos[0] + o[0] + 0, pos[1] + o[1] + 0, pos[2] + o[2] + 0] as Vec3,
      direction: [...direction] as Vec3,
      angleMin: null, angleMax: null,
      source: 'ldcad' as const, raw, snapId,
    };
  });
}
