import type { DatabaseSync } from 'node:sqlite';
import type { RefKind } from '../db/write.ts';
import type { Mat3, Vec3 } from '../types.ts';
import type { Row } from './search-projects.ts';

export interface PlacementOut {
  /** `part`, `submodel`, `primitive` (an LDraw primitive), `segment` (a flexible segment or sub-part), or `unmatched`. */
  kind: RefKind;
  partNum: string | null;
  ldrawFile: string | null;
  colorId: number | null;
  colorName: string | null;
  /** The child sub-assembly's name for an unflattened child reference, otherwise null. */
  submodel: string | null;
  pos: Vec3;
  matrix: Mat3;
}

export interface SubmodelResult {
  submodel: { id: number; projectId: number; name: string; stepCount: number | null };
  steps: { step: number; placements: PlacementOut[] }[];
  nextStep: number | null;
  /** True when expansion hit the work budget or the depth limit, so some placements are missing. */
  truncated: boolean;
}

const DEFAULT_MAX = 300;
const CAP_MAX = 1000;
const MAX_DEPTH = 32;
/** Hard cap on placements emitted for one response, applied during expansion. */
export const EXPANSION_LIMIT = 5000;

interface Budget { count: number; limit: number; truncated: boolean }
const INHERIT = 16;

const mul = (a: Mat3, b: Mat3): Mat3 => {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
    }
  }
  return out as Mat3;
};

const apply = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * Placements of one sub-assembly, grouped by step and paged by emitted placement count.
 * With `flatten`, child references are replaced by their expanded contents. Returns null
 * for an unknown id.
 */
export function getSubmodel(
  db: DatabaseSync,
  a: { submodelId: number; flatten?: boolean; fromStep?: number; maxPlacements?: number },
): SubmodelResult | null {
  const sm = db.prepare('SELECT * FROM submodels WHERE id = ?').get(a.submodelId) as Row | undefined;
  if (!sm) return null;
  const requested = a.maxPlacements !== undefined && Number.isFinite(a.maxPlacements) ? a.maxPlacements : DEFAULT_MAX;
  const max = Math.min(CAP_MAX, Math.max(1, Math.trunc(requested)));
  const fromStep = a.fromStep ?? 1;
  const flatten = a.flatten === true;

  const colorNames = new Map(
    (db.prepare('SELECT id, name FROM colors').all() as { id: number; name: string }[]).map((c) => [c.id, c.name]),
  );
  const names = new Map<number, string>();
  const nameOf = (id: number): string | null => {
    if (!names.has(id)) {
      const r = db.prepare('SELECT name FROM submodels WHERE id = ?').get(id) as { name: string } | undefined;
      if (r) names.set(id, r.name);
    }
    return names.get(id) ?? null;
  };
  const childSteps = db.prepare('SELECT DISTINCT step FROM placements WHERE submodel_id = ? ORDER BY step');
  const rowsOf = db.prepare('SELECT * FROM placements WHERE submodel_id = ? AND step = ? ORDER BY seq');

  const emit = (
    out: PlacementOut[], budget: Budget, row: Row, parentColor: number | null, parentPos: Vec3, parentMatrix: Mat3, depth: number,
  ): void => {
    if (budget.count >= budget.limit) {
      budget.truncated = true;
      return;
    }
    const local = JSON.parse(row.matrix) as Mat3;
    const rel = apply(parentMatrix, [row.x, row.y, row.z]);
    const pos: Vec3 = [parentPos[0] + rel[0], parentPos[1] + rel[1], parentPos[2] + rel[2]];
    const matrix = mul(parentMatrix, local);
    const colorId: number | null = row.color_id ?? (row.ldraw_color === INHERIT ? parentColor : null);
    if (flatten && row.child_submodel_id !== null && depth >= MAX_DEPTH) budget.truncated = true;
    if (flatten && row.child_submodel_id !== null && depth < MAX_DEPTH) {
      for (const step of childSteps.all(row.child_submodel_id) as { step: number }[]) {
        for (const child of rowsOf.all(row.child_submodel_id, step.step) as Row[]) {
          emit(out, budget, child, colorId, pos, matrix, depth + 1);
        }
      }
      return;
    }
    budget.count++;
    out.push({
      kind: row.ref_kind, partNum: row.part_num, ldrawFile: row.ldraw_file, colorId,
      colorName: colorId === null ? null : (colorNames.get(colorId) ?? null),
      submodel: row.child_submodel_id === null ? null : nameOf(row.child_submodel_id),
      pos, matrix,
    });
  };

  const stepNums = db
    .prepare('SELECT DISTINCT step FROM placements WHERE submodel_id = ? AND step >= ? ORDER BY step')
    .all(a.submodelId, fromStep) as { step: number }[];
  const steps: SubmodelResult['steps'] = [];
  let total = 0;
  let nextStep: number | null = null;
  let truncated = false;
  for (let i = 0; i < stepNums.length; i++) {
    const { step } = stepNums[i]!;
    const placements: PlacementOut[] = [];
    const budget: Budget = { count: 0, limit: EXPANSION_LIMIT - total, truncated: false };
    for (const row of rowsOf.all(a.submodelId, step) as Row[]) {
      emit(placements, budget, row, null, [0, 0, 0], IDENTITY, 0);
    }
    if (steps.length > 0 && total + placements.length > max) {
      nextStep = step;
      break;
    }
    steps.push({ step, placements });
    total += placements.length;
    if (budget.truncated) {
      truncated = true;
      nextStep = stepNums[i + 1]?.step ?? null;
      break;
    }
  }
  return {
    submodel: { id: sm.id, projectId: sm.project_id, name: sm.name, stepCount: sm.step_count },
    steps,
    nextStep,
    truncated,
  };
}
