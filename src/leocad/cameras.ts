import type { GeometrySource } from '../instructions/geometry.ts';
import type { Placement } from '../instructions/steps.ts';
import { DEFAULT_VIEWS, type RenderView } from '../render/render.ts';
import type { Bounds, Vec3 } from '../types.ts';

/** LeoCAD camera names for the render views (DEFAULT_VIEWS in src/render/render.ts). */
export const CAMERA_NAMES: Record<string, string> = { front: 'Front', angle: 'Three-quarter' };
export const CAMERA_FOV = 30;

/** Half-extent of a 1x1 brick footprint and height, used when a part has no geometry. */
const FALLBACK: Bounds = { min: [-10, -12, -10], max: [10, 12, 10] };

/** World bounding box of the placed parts: each part's local box, transformed by rot and pos. */
export function worldBounds(parts: Placement[], geom: GeometrySource): Bounds {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const b = geom.get(p.part)?.bounds ?? FALLBACK;
    for (let i = 0; i < 8; i++) {
      const c = [i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]];
      for (let r = 0; r < 3; r++) {
        const w = p.rot[r * 3] * c[0] + p.rot[r * 3 + 1] * c[1] + p.rot[r * 3 + 2] * c[2] + p.pos[r];
        if (w < min[r]) min[r] = w;
        if (w > max[r]) max[r] = w;
      }
    }
  }
  return { min, max };
}

/** Rounds to 2 decimals and prints 0 for -0. */
const num = (n: number): string => String(Math.round(n * 100) / 100 + 0);

/**
 * LeoCAD stores POSITION, TARGET_POSITION, and UP_VECTOR in its own z-up axes, with no LDraw
 * conversion (lcCamera::SaveLDraw and ParseLDrawLine in common/camera.cpp; Save and Load in
 * common/lc_objectproperty.cpp). lcVector3LDrawToLeoCAD in common/lc_math.h maps LDraw (x, y, z)
 * to (x, z, -y), and LeoCAD's default camera up vector is (0, 0, 1).
 */
const toLeoCAD = (v: number[]): number[] => [v[0], v[2], -v[1]];

/** Z (LeoCAD up) with its component along the view direction removed, so it is perpendicular to it. */
function upVector(pos: number[], target: number[]): number[] {
  const len = Math.hypot(...target.map((t, i) => t - pos[i]));
  const fz = (target[2]! - pos[2]!) / len;
  const front = target.map((t, i) => (t - pos[i]!) / len);
  const up = [-fz * front[0]!, -fz * front[1]!, 1 - fz * front[2]!];
  const n = Math.hypot(...up);
  return up.map((v) => v / n);
}

/** One `0 !LEOCAD CAMERA` line per view, aimed at the box center. Computed in LDraw space (y points down). */
export function cameraLines(bounds: Bounds, views: RenderView[] = DEFAULT_VIEWS): string[] {
  const center = bounds.min.map((v, i) => (v + bounds.max[i]) / 2);
  const radius = Math.hypot(...bounds.min.map((v, i) => bounds.max[i] - v)) / 2;
  const dist = (1.15 * radius) / Math.sin((CAMERA_FOV / 2) * (Math.PI / 180));
  return views.map((v) => {
    const yaw = (v.yaw * Math.PI) / 180;
    const pitch = (v.pitch * Math.PI) / 180;
    const dir = [Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
    const pos = toLeoCAD(center.map((c, i) => c + dir[i] * dist));
    const target = toLeoCAD(center);
    const up = upVector(pos, target);
    return (
      `0 !LEOCAD CAMERA FOV ${CAMERA_FOV} POSITION ${pos.map(num).join(' ')} ` +
      `TARGET_POSITION ${target.map(num).join(' ')} UP_VECTOR ${up.map(num).join(' ')} NAME ${CAMERA_NAMES[v.name] ?? v.name}`
    );
  });
}
