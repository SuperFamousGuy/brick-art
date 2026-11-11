import type { PlacementRow, RefKind, SubmodelRow } from '../db/write.ts';
import type { RefClassifier } from './classify.ts';
import { normalizeRef } from './mpd.ts';
import type { ProjectPartRow } from './sets.ts';
import type { ModelFile } from './types.ts';

export interface AssembledProject {
  submodels: Omit<SubmodelRow, 'projectId'>[];
  placements: PlacementRow[];
  parts: Omit<ProjectPartRow, 'projectId'>[];
  /**
   * `resolved` placements have a known part (or child) and color; `primitives` and `segments` are
   * library files that are not parts; `aliases` resolved through a `~Moved to` or `=` alias.
   */
  stats: { placements: number; resolved: number; primitives: number; segments: number; aliases: number };
  licenses: (string | null)[];
  authors: string[];
}

const INHERIT = 16;
const MAX_ALIAS_HOPS = 3;

/** Follows up to three alias hops from `ref` to a known part; null on a cycle, dead end, or no match. */
function followAlias(ref: string, parts: Map<string, string>, classify: RefClassifier): string | null {
  const seen = new Set([ref]);
  let cur = ref;
  for (let hop = 0; hop < MAX_ALIAS_HOPS; hop++) {
    const c = classify(cur);
    if (c.kind !== 'alias' || c.aliasTarget === undefined || seen.has(c.aliasTarget)) return null;
    cur = c.aliasTarget;
    seen.add(cur);
    const hit = parts.get(cur);
    if (hit !== undefined) return hit;
  }
  return null;
}

/** Turns a parsed model tree into submodel, placement, and flattened part rows. */
export function assembleProject(
  root: string,
  files: Map<string, ModelFile>,
  maps: { parts: Map<string, string>; colors: Map<number, number>; classify?: RefClassifier },
  nextSubmodelId: () => number,
): AssembledProject {
  const submodels: Omit<SubmodelRow, 'projectId'>[] = [];
  const placements: PlacementRow[] = [];
  const ids = new Map<string, number>();
  const stack = new Set<string>();
  const licenses: (string | null)[] = [];
  const authors = new Set<string>();
  let resolved = 0;
  let primitives = 0;
  let segments = 0;
  let aliases = 0;

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
      let refKind: RefKind = 'unmatched';
      if (files.has(ref) && !stack.has(ref)) {
        childSubmodelId = ids.get(ref) ?? visit(ref, false);
        ldrawFile = null;
        refKind = 'submodel';
      } else if (!files.has(ref)) {
        partNum = maps.parts.get(ref) ?? null;
        const kind = partNum === null && maps.classify ? maps.classify(ref).kind : null;
        if (kind === 'alias') {
          partNum = followAlias(ref, maps.parts, maps.classify!);
          if (partNum !== null) aliases++;
        } else if (kind === 'primitive') {
          refKind = 'primitive';
          primitives++;
        } else if (kind === 'segment') {
          refKind = 'segment';
          segments++;
        }
        if (partNum !== null) refKind = 'part';
      }
      if (childSubmodelId === null) sub.partCount++;
      if (colorOk && (partNum !== null || childSubmodelId !== null)) resolved++;
      placements.push({
        submodelId: id, step: line.step, seq: line.seq, partNum, ldrawFile, ldrawColor: line.color,
        colorId, childSubmodelId, refKind, pos: line.pos, matrix: line.matrix,
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
    submodels, placements, parts, stats: { placements: placements.length, resolved, primitives, segments, aliases },
    licenses, authors: [...authors],
  };
}
