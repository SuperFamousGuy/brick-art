import { planCell, type Span } from './cell-plan.ts';
import type { Section, Step, StepModel } from './steps.ts';

/**
 * span 1 = one slot of the 3 x 2 grid; 2 = a full column (both rows); 4 = two full columns, for a
 * step whose callouts do not fit in one; 3 = the whole page, when they do not fit in two either.
 */
export interface Cell { step: number; span: Span }
export interface Page { kind: 'cover' | 'section' | 'steps' | 'parts'; sectionId?: string; cells?: Cell[] }

export const GRID_COLS = 3;
export const GRID_ROWS = 2;
/** Part icons per parts page (6 columns by 4 rows). */
export const PARTS_PER_PAGE = 24;
const BIG_LOOSE = 4;

export interface Placed { row: number; col: number; rows: number; cols: number }

/**
 * Places cells on the grid in reading order: each cell goes in the first free spot at or after the
 * previous cell. A span-2 cell needs a whole free column and a span-4 cell two side by side, so both
 * can only start in the top row. Returns null when the cells do not all fit on one page.
 */
export function placeCells(spans: Span[]): Placed[] | null {
  const taken = Array.from({ length: GRID_ROWS }, () => new Array<boolean>(GRID_COLS).fill(false));
  const out: Placed[] = [];
  let cursor = 0; // row-major index of the next candidate spot
  for (const span of spans) {
    if (span === 3) {
      if (out.length > 0) return null;
      taken.forEach((r) => r.fill(true));
      out.push({ row: 0, col: 0, rows: 2, cols: GRID_COLS });
      cursor = GRID_ROWS * GRID_COLS;
      continue;
    }
    let at = -1;
    for (let i = cursor; i < GRID_ROWS * GRID_COLS; i++) {
      const row = Math.floor(i / GRID_COLS);
      const col = i % GRID_COLS;
      const cols = span === 4 ? 2 : 1;
      if (col + cols > GRID_COLS || (span !== 1 && row !== 0)) continue;
      // A slot cell needs its own spot free; a column cell needs both rows of each of its columns.
      const free = (c: number) => span === 1 ? !taken[row]![c] : !taken[0]![c] && !taken[1]![c];
      if (!free(col) || (cols === 2 && !free(col + 1))) continue;
      at = i;
      break;
    }
    if (at < 0) return null;
    const row = Math.floor(at / GRID_COLS);
    const col = at % GRID_COLS;
    const cols = span === 4 ? 2 : 1;
    for (let c = col; c < col + cols; c++) {
      taken[row]![c] = true;
      if (span !== 1) taken[1]![c] = true;
    }
    out.push({ row, col, rows: span === 1 ? 1 : 2, cols });
    cursor = at + 1;
  }
  return out;
}

export function cellSpan(step: Step): Span {
  if (step.callouts.length === 0 && step.inserts.length === 0 && step.loose.length <= BIG_LOOSE) return 1;
  if (planCell(step, 2).fits) return 2;
  return planCell(step, 4).fits ? 4 : 3;
}

function stepPages(section: Section): Page[] {
  const pages: Page[] = [];
  let cells: Cell[] = [];
  for (const step of section.steps) {
    const cell: Cell = { step: step.number, span: cellSpan(step) };
    if (cells.length > 0 && !placeCells([...cells.map((c) => c.span), cell.span])) {
      pages.push({ kind: 'steps', sectionId: section.id, cells });
      cells = [];
    }
    cells.push(cell);
  }
  if (cells.length > 0) pages.push({ kind: 'steps', sectionId: section.id, cells });
  return pages;
}

/** The booklet's pages: cover, then each section (a divider page when there are several) with its steps, then the parts pages. */
export function layoutBooklet(model: StepModel): Page[] {
  const pages: Page[] = [{ kind: 'cover' }];
  for (const section of model.sections) {
    if (model.sections.length > 1) pages.push({ kind: 'section', sectionId: section.id });
    pages.push(...stepPages(section));
  }
  const partPages = Math.max(1, Math.ceil(model.parts.length / PARTS_PER_PAGE));
  for (let i = 0; i < partPages; i++) pages.push({ kind: 'parts' });
  return pages;
}
