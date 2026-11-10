import type { RebrickableData } from '../sources/rebrickable.ts';

export interface PartMatch { ldrawFile: string; geometryFrom: string }

const datFile = (partNum: string) => `${partNum.toLowerCase()}.dat`;

/**
 * Match Rebrickable parts to LDraw files. A part matches by its own file name, or else
 * through one `M` or `A` relationship hop (in either direction) to a part that does.
 * `geometryFrom` is the part number whose file was used.
 */
export function matchParts(
  rb: RebrickableData,
  has: (file: string) => boolean,
): Map<string, PartMatch> {
  const related = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    let set = related.get(a);
    if (!set) related.set(a, (set = new Set()));
    set.add(b);
  };
  for (const r of rb.relationships) {
    if (r.relType !== 'M' && r.relType !== 'A') continue;
    link(r.child, r.parent);
    link(r.parent, r.child);
  }

  const out = new Map<string, PartMatch>();
  for (const { partNum } of rb.parts) {
    if (has(datFile(partNum))) {
      out.set(partNum, { ldrawFile: datFile(partNum), geometryFrom: partNum });
      continue;
    }
    const candidates = [...(related.get(partNum) ?? [])]
      .filter((c) => has(datFile(c)))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (candidates.length > 0) {
      out.set(partNum, { ldrawFile: datFile(candidates[0]!), geometryFrom: candidates[0]! });
    }
  }
  return out;
}

/**
 * Fraction of the `n` most-used Rebrickable parts that have a match. Parts rank by set count
 * descending, ties by part number ascending. Returns 0 when `n` is 0.
 */
export function matchRateTop(
  rb: RebrickableData,
  matches: Map<string, unknown>,
  setCounts: Map<string, number>,
  n: number,
): number {
  if (n <= 0) return 0;
  const ranked = rb.parts
    .map((p) => p.partNum)
    .sort((a, b) => (setCounts.get(b) ?? 0) - (setCounts.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, n);
  return ranked.filter((p) => matches.has(p)).length / n;
}
