import type { Bounds, Grid, Triangle, Vec3 } from '../types.ts';

export interface PartShape {
  bounds: Bounds;
  widthStuds: number;
  depthStuds: number;
  heightPlates: number;
  grid: Grid;
}

const CELL: Vec3 = [20, 8, 20];
const SHRINK = 0.5;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

// Separating-axis test between a triangle and an axis-aligned box.
function triBoxOverlap(tri: Triangle, lo: Vec3, hi: Vec3): boolean {
  const c: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const h: Vec3 = [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2];
  const v0 = sub(tri[0], c);
  const v1 = sub(tri[1], c);
  const v2 = sub(tri[2], c);
  const verts = [v0, v1, v2];

  // Box face normals.
  for (let i = 0; i < 3; i++) {
    const mn = Math.min(v0[i]!, v1[i]!, v2[i]!);
    const mx = Math.max(v0[i]!, v1[i]!, v2[i]!);
    if (mn > h[i]! || mx < -h[i]!) return false;
  }

  const e0 = sub(v1, v0);
  const e1 = sub(v2, v1);
  const e2 = sub(v0, v2);

  const separated = (axis: Vec3): boolean => {
    if (axis[0] === 0 && axis[1] === 0 && axis[2] === 0) return false;
    let mn = Infinity;
    let mx = -Infinity;
    for (const v of verts) {
      const p = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
      if (p < mn) mn = p;
      if (p > mx) mx = p;
    }
    const r = h[0]! * Math.abs(axis[0]) + h[1]! * Math.abs(axis[1]) + h[2]! * Math.abs(axis[2]);
    return mn > r || mx < -r;
  };

  // Triangle plane.
  if (separated(cross(e0, e1))) return false;
  // Edge x box-axis cross products.
  const unit: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (const e of [e0, e1, e2]) {
    for (const u of unit) if (separated(cross(e, u))) return false;
  }
  return true;
}

export function computeShape(bodyTriangles: Triangle[]): PartShape | null {
  if (bodyTriangles.length === 0) return null;

  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const tri of bodyTriangles) {
    for (const v of tri) {
      for (let i = 0; i < 3; i++) {
        if (v[i]! < min[i]!) min[i] = v[i]!;
        if (v[i]! > max[i]!) max[i] = v[i]!;
      }
    }
  }

  const widthStuds = Math.max(1, Math.round((max[0] - min[0]) / CELL[0]));
  const depthStuds = Math.max(1, Math.round((max[2] - min[2]) / CELL[2]));
  const heightPlates = Math.max(1, Math.round((max[1] - min[1]) / CELL[1]));
  const n: Vec3 = [widthStuds, heightPlates, depthStuds]; // cells along x, y, z

  const grid: Grid = Array.from({ length: heightPlates }, () =>
    Array.from({ length: depthStuds }, () => new Array<number>(widthStuds).fill(0)));

  // Cell box on one axis, shrunk on every side. Edge cells extend to the
  // bounds so geometry past the last full cell is clamped into them.
  const cellLo = (axis: number, i: number) => (i === 0 ? min[axis]! : min[axis]! + i * CELL[axis]!) + SHRINK;
  const cellHi = (axis: number, i: number) =>
    (i === n[axis]! - 1 ? Math.max(max[axis]!, min[axis]! + n[axis]! * CELL[axis]!) : min[axis]! + (i + 1) * CELL[axis]!) - SHRINK;
  const range = (axis: number, a: number, b: number): [number, number] => {
    const lo = Math.floor((Math.min(a, b) - SHRINK - min[axis]!) / CELL[axis]!);
    const hi = Math.floor((Math.max(a, b) + SHRINK - min[axis]!) / CELL[axis]!);
    return [Math.max(0, lo), Math.min(n[axis]! - 1, hi)];
  };

  const lo: Vec3 = [0, 0, 0];
  const hi: Vec3 = [0, 0, 0];
  const setBox = (axis: number, i: number) => {
    let l = cellLo(axis, i);
    let h = cellHi(axis, i);
    if (h < l) l = h = (l + h) / 2; // degenerate thin cell
    lo[axis] = l;
    hi[axis] = h;
  };

  for (const tri of bodyTriangles) {
    const [x0, x1] = range(0, Math.min(tri[0][0], tri[1][0], tri[2][0]), Math.max(tri[0][0], tri[1][0], tri[2][0]));
    const [y0, y1] = range(1, Math.min(tri[0][1], tri[1][1], tri[2][1]), Math.max(tri[0][1], tri[1][1], tri[2][1]));
    const [z0, z1] = range(2, Math.min(tri[0][2], tri[1][2], tri[2][2]), Math.max(tri[0][2], tri[1][2], tri[2][2]));
    for (let y = y0; y <= y1; y++) {
      setBox(1, y);
      for (let z = z0; z <= z1; z++) {
        setBox(2, z);
        const row = grid[y]![z]!;
        for (let x = x0; x <= x1; x++) {
          if (row[x] === 1) continue;
          setBox(0, x);
          if (triBoxOverlap(tri, lo, hi)) row[x] = 1;
        }
      }
    }
  }

  return { bounds: { min, max }, widthStuds, depthStuds, heightPlates, grid };
}
