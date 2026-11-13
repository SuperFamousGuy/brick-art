import type { Placement, Step } from './steps.ts';

// Geometry of a step cell, in inches. The content area of a sheet is 10.2 x 7.7.
export const PAGE_W = 10.2;
export const PAGE_H = 7.7;
export const COL_W = 3.3;
export const COL_GAP = 0.15;
export const ROW_H = 3.8;
export const ROW_GAP = 0.1;
export const PAD = 0.1;
export const IMG_W = COL_W - 2 * PAD;
export const IMG_H = IMG_W * 0.75;
export const BOX_X = 0.95;
export const BOX_W = COL_W - BOX_X - PAD;
export const ITEM_W = 0.52;
export const ITEM_H = 0.6;
/** A callout's parts strip: one instance's parts, smaller than the step's parts box. */
export const STRIP_ITEM_W = 0.42;
export const STRIP_ITEM_H = 0.48;
const GAP = 0.08;
const HEAD = 0.28;
const BETWEEN = 0.1;
const MIN_SCALE = 0.55;

export interface Group { part: string; color: number; count: number }
export interface CalloutBox {
  kind: 'callout' | 'insert'; i: number; qty: number; count: number; cols: number; rows: number;
  x: number; y: number; w: number; h: number; mw: number; mh: number; head: number; gap: number;
  groups: Group[];   // a callout's parts for one instance, shown in a strip under the head (empty for an insert)
  strip: number;     // height of that strip, 0 without one
}
export interface CellPlan {
  w: number; h: number; groups: Group[]; partsBoxH: number;
  img: { x: number; y: number; w: number; h: number };
  boxes: CalloutBox[]; side: boolean; bottom: number; fits: boolean;
}

/**
 * Cell kinds: 1 = one grid slot, 2 = a full column, 4 = two full columns, 3 = the whole page.
 * Kinds 4 and 3 put the image on the left and the callouts to its right (one lane, or two).
 */
export type Span = 1 | 2 | 3 | 4;

export function cellSize(span: Span): { w: number; h: number } {
  const w = span === 3 ? PAGE_W : span === 4 ? 2 * COL_W + COL_GAP : COL_W;
  return { w, h: span === 1 ? ROW_H : PAGE_H };
}

export function groupLoose(step: Step): Group[] {
  return groupParts(step.loose);
}

/** Parts counted by part and colour, in first-seen order. */
export function groupParts(parts: Placement[]): Group[] {
  const counts = new Map<string, Group>();
  for (const p of parts) {
    const key = `${p.part}\u0000${p.color}`;
    const row = counts.get(key) ?? { part: p.part, color: p.color, count: 0 };
    row.count++;
    counts.set(key, row);
  }
  return [...counts.values()];
}

interface Item { kind: 'callout' | 'insert'; i: number; qty: number; n: number; groups: Group[] }

/** Lays out one step's parts box, image, and callout boxes in a cell, shrinking callout images (and gaps) until they fit. */
export function planCell(step: Step, span: Span): CellPlan {
  const { w, h } = cellSize(span);
  const groups = groupLoose(step);
  let partsBoxH = 0;
  let boxBottom = 0.65;
  if (groups.length > 0) {
    const perRow = Math.max(1, Math.floor((BOX_W - 0.1) / ITEM_W));
    partsBoxH = Math.ceil(groups.length / perRow) * ITEM_H + 0.1;
    boxBottom = Math.max(boxBottom, 0.08 + partsBoxH + 0.08);
  }
  const img = { x: PAD, y: boxBottom, w: IMG_W, h: IMG_H };
  const items: Item[] = [
    ...step.callouts.map((c, i): Item => ({
      kind: 'callout', i, qty: c.quantity, n: Math.max(1, c.miniSteps.length), groups: groupParts(c.instances[0] ?? c.miniSteps.flat()),
    })),
    ...step.inserts.map((c, i): Item => ({ kind: 'insert', i, qty: c.quantity, n: 1, groups: [] })),
  ];
  const side = span === 3 || span === 4;
  const lanes = span === 3 ? 2 : 1;
  const colW = side ? (w - COL_W - 0.1 - 0.1 * lanes) / lanes : IMG_W;
  const x0 = side ? COL_W + 0.1 : PAD;
  const top0 = side ? 0.1 : img.y + img.h + 0.12;
  const avail = h - top0 - PAD;

  /** `extra` widens each callout's mini-step grid by that many columns (fewer, smaller rows). */
  const dims = (it: Item, s: number, extra: number) => {
    const cols = it.kind === 'insert' ? 1 : Math.min(it.n, (it.n <= 2 ? it.n : it.n <= 4 ? 2 : 3) + extra);
    const rows = Math.ceil(it.n / cols);
    const gap = GAP * s;
    const mw = Math.min(1.5, (colW - 2 * gap - (cols - 1) * gap) / cols) * s;
    const head = it.qty > 1 ? HEAD : 0;
    const perRow = Math.max(1, Math.floor((colW - 2 * GAP) / STRIP_ITEM_W));
    const strip = it.groups.length > 0 ? Math.ceil(it.groups.length / perRow) * STRIP_ITEM_H : 0;
    const bh = 2 * gap + head + (strip ? strip + gap : 0) + rows * mw * 0.75 + (rows - 1) * gap;
    return { cols, rows, gap, mw, mh: mw * 0.75, head, strip, bh };
  };
  /** Column assignment and total height at a scale. */
  const arrange = (s: number, extra: number) => {
    const heights = new Array<number>(lanes).fill(0);
    const placed = items.map((it) => {
      const lane = heights.indexOf(Math.min(...heights));
      const d = dims(it, s, extra);
      const y = top0 + heights[lane]!;
      heights[lane]! += d.bh + BETWEEN;
      return { it, d, lane, y };
    });
    return { placed, used: Math.max(0, ...heights) - (items.length ? BETWEEN : 0) };
  };
  // Shrink the mini-step images until the callouts fit. In a wide cell, if they still do not at
  // MIN_SCALE, lay each callout's mini-steps out in more columns and try again (a single column is
  // too narrow for that to stay readable).
  let arr = arrange(1, 0);
  for (let extra = 0; extra <= (side ? 2 : 0); extra++) {
    let scale = 1;
    arr = arrange(scale, extra);
    while (arr.used > avail && scale > MIN_SCALE) {
      scale = Math.max(MIN_SCALE, scale - 0.05);
      arr = arrange(scale, extra);
    }
    if (arr.used <= avail) break;
  }
  const boxes: CalloutBox[] = arr.placed.map(({ it, d, lane, y }) => ({
    kind: it.kind, i: it.i, qty: it.qty, count: it.n, cols: d.cols, rows: d.rows,
    x: x0 + lane * (colW + 0.1), y, w: colW, h: d.bh, mw: d.mw, mh: d.mh, head: d.head, gap: d.gap,
    groups: it.groups, strip: d.strip,
  }));
  const bottom = Math.max(img.y + img.h, items.length ? top0 + arr.used : 0);
  return { w, h, groups, partsBoxH, img, boxes, side, bottom, fits: bottom + PAD <= h + 1e-6 };
}
