import type { Step } from './steps.ts';

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
const GAP = 0.08;
const HEAD = 0.28;
const BETWEEN = 0.1;
const MIN_SCALE = 0.55;

export interface Group { part: string; color: number; count: number }
export interface CalloutBox {
  kind: 'callout' | 'insert'; i: number; qty: number; count: number; cols: number; rows: number;
  x: number; y: number; w: number; h: number; mw: number; mh: number; head: number; gap: number;
}
export interface CellPlan {
  w: number; h: number; groups: Group[]; partsBoxH: number;
  img: { x: number; y: number; w: number; h: number };
  boxes: CalloutBox[]; side: boolean; bottom: number; fits: boolean;
}

/** Cell kinds: 1 = one grid slot, 2 = a full column, 3 = the whole page (image on the left, callouts on the right). */
export function cellSize(span: 1 | 2 | 3): { w: number; h: number } {
  return { w: span === 3 ? PAGE_W : COL_W, h: span === 1 ? ROW_H : PAGE_H };
}

export function groupLoose(step: Step): Group[] {
  const counts = new Map<string, Group>();
  for (const p of step.loose) {
    const key = `${p.part}\u0000${p.color}`;
    const row = counts.get(key) ?? { part: p.part, color: p.color, count: 0 };
    row.count++;
    counts.set(key, row);
  }
  return [...counts.values()];
}

interface Item { kind: 'callout' | 'insert'; i: number; qty: number; n: number }

/** Lays out one step's parts box, image, and callout boxes in a cell, shrinking callout images (and gaps) until they fit. */
export function planCell(step: Step, span: 1 | 2 | 3): CellPlan {
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
    ...step.callouts.map((c, i): Item => ({ kind: 'callout', i, qty: c.quantity, n: Math.max(1, c.miniSteps.length) })),
    ...step.inserts.map((c, i): Item => ({ kind: 'insert', i, qty: c.quantity, n: 1 })),
  ];
  const side = span === 3;
  const colW = side ? (PAGE_W - COL_W - 0.3) / 2 : IMG_W;
  const x0 = side ? COL_W + 0.1 : PAD;
  const top0 = side ? 0.1 : img.y + img.h + 0.12;
  const avail = h - top0 - PAD;

  const dims = (it: Item, s: number) => {
    const cols = it.kind === 'insert' ? 1 : it.n <= 2 ? it.n : it.n <= 4 ? 2 : 3;
    const rows = Math.ceil(it.n / cols);
    const gap = GAP * s;
    const mw = Math.min(1.5, (colW - 2 * gap - (cols - 1) * gap) / cols) * s;
    const head = it.qty > 1 ? HEAD : 0;
    return { cols, rows, gap, mw, mh: mw * 0.75, head, bh: 2 * gap + head + rows * mw * 0.75 + (rows - 1) * gap };
  };
  /** Column assignment and total height at a scale. */
  const arrange = (s: number) => {
    const lanes = side ? 2 : 1;
    const heights = new Array<number>(lanes).fill(0);
    const placed = items.map((it) => {
      const lane = heights.indexOf(Math.min(...heights));
      const d = dims(it, s);
      const y = top0 + heights[lane]!;
      heights[lane]! += d.bh + BETWEEN;
      return { it, d, lane, y };
    });
    return { placed, used: Math.max(0, ...heights) - (items.length ? BETWEEN : 0) };
  };
  let scale = 1;
  let arr = arrange(scale);
  while (arr.used > avail && scale > MIN_SCALE) {
    scale = Math.max(MIN_SCALE, scale - 0.05);
    arr = arrange(scale);
  }
  const boxes: CalloutBox[] = arr.placed.map(({ it, d, lane, y }) => ({
    kind: it.kind, i: it.i, qty: it.qty, count: it.n, cols: d.cols, rows: d.rows,
    x: x0 + lane * (colW + 0.1), y, w: colW, h: d.bh, mw: d.mw, mh: d.mh, head: d.head, gap: d.gap,
  }));
  const bottom = Math.max(img.y + img.h, items.length ? top0 + arr.used : 0);
  return { w, h, groups, partsBoxH, img, boxes, side, bottom, fits: bottom + PAD <= h + 1e-6 };
}
