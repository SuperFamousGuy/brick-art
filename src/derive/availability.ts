import type { RebrickableData } from '../sources/rebrickable.ts';

export interface PartAvailability { setCount: number; firstYear: number | null; lastYear: number | null }
export interface PartColorAvailability { setCount: number; lastYear: number | null; inElements: boolean }

export interface Availability {
  parts: Map<string, PartAvailability>;
  partColors: Map<string, Map<number, PartColorAvailability>>;
}

/**
 * Count distinct sets per part and per part/color through non-spare inventory rows.
 * Only inventories of sets listed in sets.csv count, so minifig (`fig-*`) inventories are skipped.
 * `partColors` is the union of inventory combinations and elements.
 */
export function computeAvailability(rb: RebrickableData): Availability {
  const partSets = new Map<string, Set<string>>();
  const colorSets = new Map<string, Map<number, Set<string>>>();

  for (const row of rb.inventoryParts) {
    if (row.isSpare) continue;
    const setNum = rb.inventories.get(row.inventoryId);
    if (setNum === undefined || !rb.setYears.has(setNum)) continue;
    let sets = partSets.get(row.partNum);
    if (!sets) partSets.set(row.partNum, (sets = new Set()));
    sets.add(setNum);
    let byColor = colorSets.get(row.partNum);
    if (!byColor) colorSets.set(row.partNum, (byColor = new Map()));
    let cs = byColor.get(row.colorId);
    if (!cs) byColor.set(row.colorId, (cs = new Set()));
    cs.add(setNum);
  }

  const years = (sets: Set<string>): number[] => {
    const ys: number[] = [];
    for (const s of sets) {
      const y = rb.setYears.get(s);
      if (y !== undefined) ys.push(y);
    }
    return ys;
  };
  const maxOf = (ys: number[]) => (ys.length ? ys.reduce((a, b) => Math.max(a, b)) : null);
  const minOf = (ys: number[]) => (ys.length ? ys.reduce((a, b) => Math.min(a, b)) : null);

  const parts = new Map<string, PartAvailability>();
  for (const [partNum, sets] of partSets) {
    const ys = years(sets);
    parts.set(partNum, { setCount: sets.size, firstYear: minOf(ys), lastYear: maxOf(ys) });
  }

  const partColors = new Map<string, Map<number, PartColorAvailability>>();
  for (const [partNum, byColor] of colorSets) {
    const m = new Map<number, PartColorAvailability>();
    for (const [colorId, sets] of byColor) {
      m.set(colorId, { setCount: sets.size, lastYear: maxOf(years(sets)), inElements: false });
    }
    partColors.set(partNum, m);
  }
  for (const el of rb.elements) {
    let m = partColors.get(el.partNum);
    if (!m) partColors.set(el.partNum, (m = new Map()));
    const existing = m.get(el.colorId);
    if (existing) existing.inElements = true;
    else m.set(el.colorId, { setCount: 0, lastYear: null, inElements: true });
  }

  return { parts, partColors };
}
