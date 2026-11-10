import type { PlacementRow, SubmodelRow } from '../db/write.ts';
import { normalizeRef } from './mpd.ts';
import type { ProjectPartRow } from './sets.ts';
import type { ModelFile } from './types.ts';

export interface AssembledProject {
  submodels: Omit<SubmodelRow, 'projectId'>[];
  placements: PlacementRow[];
  parts: Omit<ProjectPartRow, 'projectId'>[];
  stats: { placements: number; resolved: number };
  licenses: (string | null)[];
  authors: string[];
}

const INHERIT = 16;

/** Turns a parsed model tree into submodel, placement, and flattened part rows. */
export function assembleProject(
  root: string,
  files: Map<string, ModelFile>,
  maps: { parts: Map<string, string>; colors: Map<number, number> },
  nextSubmodelId: () => number,
): AssembledProject {
  const submodels: Omit<SubmodelRow, 'projectId'>[] = [];
  const placements: PlacementRow[] = [];
  const ids = new Map<string, number>();
  const stack = new Set<string>();
  const licenses: (string | null)[] = [];
  const authors = new Set<string>();
  let resolved = 0;

  const visit = (name: string, isMain: boolean): number => {
    const file = files.get(name)!;
    const id = nextSubmodelId();
    ids.set(name, id);
    stack.add(name);
    const sub = { id, name, isMain, stepCount: file.stepCount, partCount: 0 };
    submodels.push(sub);
    licenses.push(file.license);
    if (file.author) authors.add(file.author);
    for (const line of file.lines) {
      const ref = normalizeRef(line.ref);
      const colorId = line.color === INHERIT ? null : (maps.colors.get(line.color) ?? null);
      const colorOk = line.color === INHERIT || colorId !== null;
      let childSubmodelId: number | null = null;
      let partNum: string | null = null;
      let ldrawFile: string | null = ref;
      if (files.has(ref) && !stack.has(ref)) {
        childSubmodelId = ids.get(ref) ?? visit(ref, false);
        ldrawFile = null;
      } else if (!files.has(ref)) {
        partNum = maps.parts.get(ref) ?? null;
      }
      if (childSubmodelId === null) sub.partCount++;
      if (colorOk && (partNum !== null || childSubmodelId !== null)) resolved++;
      placements.push({
        submodelId: id, step: line.step, seq: line.seq, partNum, ldrawFile, ldrawColor: line.color,
        colorId, childSubmodelId, pos: line.pos, matrix: line.matrix,
      });
    }
    stack.delete(name);
    return id;
  };
  if (files.has(root)) visit(root, true);

  // Flatten parts: color 16 inherits from the referencing line, counts multiply down the tree.
  const bySub = new Map<number, PlacementRow[]>();
  for (const p of placements) {
    const list = bySub.get(p.submodelId) ?? [];
    list.push(p);
    bySub.set(p.submodelId, list);
  }
  const memo = new Map<string, Map<string, number>>();
  const flatten = (subId: number, color: number): Map<string, number> => {
    const key = `${subId}:${color}`;
    const hit = memo.get(key);
    if (hit) return hit;
    const out = new Map<string, number>();
    const add = (k: string, n: number) => out.set(k, (out.get(k) ?? 0) + n);
    for (const p of bySub.get(subId) ?? []) {
      const eff = p.ldrawColor === INHERIT ? color : p.ldrawColor;
      if (p.childSubmodelId !== null) {
        for (const [k, n] of flatten(p.childSubmodelId, eff)) add(k, n);
      } else if (p.partNum !== null) {
        const mapped = eff === INHERIT ? undefined : maps.colors.get(eff);
        if (mapped !== undefined) add(`${p.partNum}\t${mapped}`, 1);
      }
    }
    memo.set(key, out);
    return out;
  };
  const parts: Omit<ProjectPartRow, 'projectId'>[] = [];
  if (submodels.length > 0) {
    for (const [k, quantity] of flatten(submodels[0]!.id, INHERIT)) {
      const [partNum, color] = k.split('\t');
      parts.push({ partNum: partNum!, colorId: Number(color), quantity, isSpare: false, fromMinifig: false });
    }
  }
  return {
    submodels, placements, parts, stats: { placements: placements.length, resolved },
    licenses, authors: [...authors],
  };
}
