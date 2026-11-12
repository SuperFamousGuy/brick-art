import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PARTS_PER_PAGE, placeCells, type Cell, type Page } from './layout.ts';
import {
  calloutShotName, DEFAULT_SHOT_SIZES, iconShotName, PIXEL_RATIO, stepDigits, stepShotName, type ShotResult,
} from './render-steps.ts';
import type { Section, Step, StepModel } from './steps.ts';

// Page geometry, in inches. The sheet is 11 x 8.5 with 0.4in margins (as padding, so the background covers the whole sheet), so the content area is 10.2 x 7.7.
const PAGE_H = 7.7;
const COL_W = 3.3;
const COL_GAP = 0.15;
const ROW_H = 3.8;
const ROW_GAP = 0.1;
const PAD = 0.1;
const IMG_W = COL_W - 2 * PAD;
const BOX_X = 0.95;       // parts box left edge (right of the step number)
const BOX_W = COL_W - BOX_X - PAD;
const ICON = 0.38;
const ITEM_W = 0.52;
const ITEM_H = 0.6;

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const n = (v: number) => String(Number(v.toFixed(3)));

export interface BookletOptions {
  model: StepModel; pages: Page[]; shots: Map<string, ShotResult>; checked: boolean; colorNames: Map<number, string>;
}

/** Pixel size of a PNG from its header, or the default step shot size when it cannot be read. */
function pngSize(path: string, fallback: [number, number]): [number, number] {
  try {
    const head = readFileSync(path).subarray(0, 24);
    if (head.length === 24 && head.toString('latin1', 12, 16) === 'IHDR') return [head.readUInt32BE(16), head.readUInt32BE(20)];
  } catch { /* the file may not exist yet */ }
  return fallback;
}

const url = (png: string) => pathToFileURL(resolve(png)).href;
const img = (shot: ShotResult | undefined, cls: string, style = '') =>
  shot ? `<img class="${cls}" src="${esc(url(shot.png))}" alt=""${style ? ` style="${style}"` : ''}>` : '';
const box = (x: number, y: number, w: number, h: number, cls: string, inner: string) =>
  `<div class="${cls}" style="left:${n(x)}in;top:${n(y)}in;width:${n(w)}in;height:${n(h)}in">${inner}</div>`;

interface Ctx {
  model: StepModel; shots: Map<string, ShotResult>; colorNames: Map<number, string>; digits: number;
}

function icon(ctx: Ctx, part: string, color: number, size: number): string {
  return img(ctx.shots.get(iconShotName(part.replace(/\.dat$/, ''), color)), 'icon', `width:${n(size)}in;height:${n(size)}in`);
}

const ROTATE_ICON = '<svg class="rotate" viewBox="0 0 24 24"><path d="M12 4a8 8 0 1 0 7.5 5.2" fill="none" stroke="#333" stroke-width="2" stroke-linecap="round"/>'
  + '<path d="M20 3v7h-7z" fill="#333"/></svg>';

function lastShot(ctx: Ctx, section: Section | undefined): ShotResult | undefined {
  const last = section?.steps[section.steps.length - 1];
  return last ? ctx.shots.get(stepShotName(last.number, ctx.digits)) : undefined;
}

function stepCell(ctx: Ctx, step: Step, cell: Cell, at: { row: number; col: number; rows: number }): string {
  const w = COL_W;
  const h = cell.span === 2 ? PAGE_H : ROW_H;
  const parts: string[] = [];
  const over: string[] = [];
  const id = `a${step.number}`;

  parts.push(`<div class="num" style="left:${n(PAD)}in;top:0">${step.number}</div>`);

  // Parts box: one icon per part and color, with its count.
  const counts = new Map<string, { part: string; color: number; count: number }>();
  for (const p of step.loose) {
    const key = `${p.part}\u0000${p.color}`;
    const row = counts.get(key) ?? { part: p.part, color: p.color, count: 0 };
    row.count++;
    counts.set(key, row);
  }
  let boxBottom = 0.65;
  if (counts.size > 0) {
    const perRow = Math.max(1, Math.floor((BOX_W - 0.1) / ITEM_W));
    const rows = Math.ceil(counts.size / perRow);
    const boxH = rows * ITEM_H + 0.1;
    const items = [...counts.values()].map((c) =>
      `<div class="item" style="width:${n(ITEM_W)}in">${icon(ctx, c.part, c.color, ICON)}<span class="pq">${c.count}x</span></div>`).join('');
    parts.push(box(BOX_X, 0.08, BOX_W, boxH, 'partsbox', items));
    boxBottom = Math.max(boxBottom, 0.08 + boxH + 0.08);
  }

  // Step image.
  const shot = ctx.shots.get(stepShotName(step.number, ctx.digits));
  const [pw, ph] = shot ? pngSize(shot.png, [DEFAULT_SHOT_SIZES.step[0] * PIXEL_RATIO, DEFAULT_SHOT_SIZES.step[1] * PIXEL_RATIO]) : [4, 3];
  const imgH = IMG_W * ph / pw;
  const imgY = boxBottom;
  parts.push(`<div class="stepimg" style="left:${n(PAD)}in;top:${n(imgY)}in;width:${n(IMG_W)}in;height:${n(imgH)}in">${img(shot, 'shot')}</div>`);
  if (step.rotated) parts.push(`<div class="rot" style="left:${n(COL_W - PAD - 0.5)}in;top:${n(imgY + 0.05)}in">${ROTATE_ICON}</div>`);

  // Callouts and inserts below the image.
  type Item = { kind: 'callout'; i: number; n: number; qty: number } | { kind: 'insert'; i: number; qty: number };
  const items: Item[] = [
    ...step.callouts.map((c, i): Item => ({ kind: 'callout', i, n: c.miniSteps.length, qty: c.quantity })),
    ...step.inserts.map((c, i): Item => ({ kind: 'insert', i, qty: c.quantity })),
  ];
  const GAP = 0.08;
  const HEAD = 0.28;
  const dims = (it: Item) => {
    const count = it.kind === 'callout' ? Math.max(1, it.n) : 1;
    const cols = it.kind === 'insert' ? 1 : count <= 2 ? count : count <= 4 ? 2 : 3;
    const rows = Math.ceil(count / cols);
    const mw = Math.min(1.5, (IMG_W - 2 * GAP - (cols - 1) * GAP) / cols);
    return { count, cols, rows, mw, mh: mw * 0.75, head: it.qty > 1 ? HEAD : 0 };
  };
  const heightOf = (it: Item, s: number) => { const d = dims(it); return 2 * GAP + d.head + d.rows * d.mh * s + (d.rows - 1) * GAP; };
  const top0 = imgY + imgH + 0.12;
  const avail = h - top0 - PAD;
  const fixed = items.reduce((t, it) => { const d = dims(it); return t + 2 * GAP + d.head + (d.rows - 1) * GAP + 0.1; }, 0);
  const flex = items.reduce((t, it) => { const d = dims(it); return t + d.rows * d.mh; }, 0);
  const scale = fixed + flex > avail ? Math.max(0.4, (avail - fixed) / Math.max(0.01, flex)) : 1;
  const attachMarks = shot?.marks ?? [];
  let markIx = 0;
  let y = top0;
  for (const it of items) {
    const d = dims(it);
    const bh = heightOf(it, scale);
    const mw = d.mw * scale;
    const mh = d.mh * scale;
    let inner = it.qty > 1 ? `<span class="qty" style="left:${n(GAP)}in;top:0.02in">${it.qty}x</span>` : '';
    if (it.kind === 'callout') {
      for (let k = 0; k < d.count; k++) {
        const m = ctx.shots.get(calloutShotName(step.number, ctx.digits, it.i + 1, k + 1));
        const cx = GAP + (k % d.cols) * (mw + GAP);
        const cy = GAP + d.head + Math.floor(k / d.cols) * (mh + GAP);
        inner += `<div class="mini" style="left:${n(cx)}in;top:${n(cy)}in;width:${n(mw)}in;height:${n(mh)}in">${img(m, 'shot')}`
          + (d.count > 1 ? `<span class="mn">${k + 1}</span>` : '') + '</div>';
      }
    } else {
      const sec = ctx.model.sections.find((s) => s.id === step.inserts[it.i]!.sectionId);
      const iw = 1.5 * scale;
      inner += `<div class="mini" style="left:${n(GAP)}in;top:${n(GAP + d.head)}in;width:${n(iw)}in;height:${n(iw * 0.75)}in">${img(lastShot(ctx, sec), 'shot')}</div>`;
    }
    parts.push(box(PAD, y, IMG_W, bh, `callout${it.kind === 'insert' ? ' insert' : ''}`, inner));
    if (it.kind === 'callout') {
      const count = step.callouts[it.i]!.attach.length;
      for (let j = 0; j < count; j++) {
        const mark = attachMarks[markIx++];
        if (!mark) continue;
        const ex = PAD + mark[0] / pw * IMG_W;
        const ey = imgY + mark[1] / ph * imgH;
        const sx = PAD + IMG_W * (j + 1) / (count + 1);
        over.push(`<line class="arrow" x1="${n(sx)}" y1="${n(y)}" x2="${n(ex)}" y2="${n(ey)}" marker-end="url(#${id})"/>`);
      }
    }
    y += bh + 0.1;
  }

  const svg = `<svg class="over" viewBox="0 0 ${n(w)} ${n(h)}" preserveAspectRatio="none"><defs>`
    + `<marker id="${id}" markerWidth="0.16" markerHeight="0.16" refX="0.14" refY="0.08" orient="auto" markerUnits="userSpaceOnUse">`
    + '<path d="M0 0L0.16 0.08L0 0.16z" fill="#333"/></marker></defs>' + over.join('') + '</svg>';
  const style = `grid-row:${at.row + 1} / span ${at.rows};grid-column:${at.col + 1};height:${n(h)}in`;
  return `<div class="cell" style="${style}">${parts.join('')}${svg}</div>`;
}

function stepsPage(ctx: Ctx, page: Page): string {
  const section = ctx.model.sections.find((s) => s.id === page.sectionId);
  const cells = page.cells ?? [];
  const placed = placeCells(cells.map((c) => c.span)) ?? [];
  const byNumber = new Map(section?.steps.map((s) => [s.number, s]));
  const html = cells.map((c, i) => stepCell(ctx, byNumber.get(c.step)!, c, placed[i]!)).join('');
  return `<section class="page steps"><div class="grid">${html}</div></section>`;
}

function coverPage(ctx: Ctx, checked: boolean): string {
  const main = ctx.model.sections[ctx.model.sections.length - 1];
  return '<section class="page cover">'
    + `<div class="hero">${img(lastShot(ctx, main), 'shot')}</div>`
    + `<h1>${esc(ctx.model.title)}</h1><p class="meta">${ctx.model.totalParts} parts</p>`
    + (checked ? '' : '<p class="warn">connections not checked</p>') + '</section>';
}

function sectionPage(ctx: Ctx, page: Page): string {
  const section = ctx.model.sections.find((s) => s.id === page.sectionId);
  return '<section class="page divider">'
    + `<div class="hero">${img(lastShot(ctx, section), 'shot')}</div>`
    + `<h2>${esc(section?.title ?? '')}</h2>${section && section.quantity > 1 ? `<p class="meta big">${section.quantity}x</p>` : ''}</section>`;
}

function partsPage(ctx: Ctx, index: number): string {
  const slice = ctx.model.parts.slice(index * PARTS_PER_PAGE, (index + 1) * PARTS_PER_PAGE);
  const items = slice.map((p) => {
    const name = ctx.colorNames.get(p.color) ?? `Color ${p.color}`;
    return `<div class="pitem">${icon(ctx, p.part, p.color, 1.1)}<span class="qty">${p.count}x</span><span class="cname">${esc(name)}</span></div>`;
  }).join('');
  return `<section class="page parts"><div class="pgrid">${items}</div></section>`;
}

const CSS = `
@page { size: 11in 8.5in; margin: 0; }
* { box-sizing: border-box; }
html { background: #cfe6f5; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font-family: "Helvetica Neue", Arial, sans-serif; color: #222; background: #cfe6f5; }
.page { position: relative; width: 11in; height: 8.49in; padding: 0.4in; overflow: hidden; background: #cfe6f5; break-after: page; page-break-after: always; }
.page:last-child { break-after: auto; page-break-after: auto; }
@media screen { body { padding: 0.2in 0; } .page { margin: 0 auto 0.3in; outline: 1px solid #9ec3dc; } }
.grid { display: grid; grid-template-columns: repeat(3, ${COL_W}in); grid-template-rows: repeat(2, ${ROW_H}in); gap: ${ROW_GAP}in ${COL_GAP}in; }
.cell { position: relative; width: ${COL_W}in; }
.cell > div, .cell > svg { position: absolute; }
.num { font-size: 0.55in; font-weight: 800; line-height: 0.65in; }
.partsbox { display: flex; flex-wrap: wrap; align-content: flex-start; padding: 0.05in; background: #fff7e0; border: 0.02in solid #c8b27a; border-radius: 0.06in; }
.item { display: flex; flex-direction: column; align-items: center; height: ${ITEM_H}in; }
.icon { object-fit: contain; }
.pq { font-size: 0.15in; font-weight: 700; line-height: 0.18in; }
.mini { position: absolute; }
.stepimg, .mini { background: #fff; border-radius: 0.05in; overflow: hidden; }
.shot { width: 100%; height: 100%; object-fit: contain; display: block; }
.callout { background: #fff7e0; border: 0.02in solid #c8b27a; border-radius: 0.08in; }
.callout .mini { border: 0.01in solid #e3d7b0; }
.qty { position: absolute; font-weight: 800; font-size: 0.22in; }
.mn { position: absolute; left: 0.03in; top: 0.02in; font-size: 0.16in; font-weight: 800; }
.rot { width: 0.5in; height: 0.5in; }
.rotate { width: 100%; height: 100%; }
.over { left: 0; top: 0; width: 100%; height: 100%; pointer-events: none; }
.arrow { stroke: #333; stroke-width: 0.03; fill: none; }
.cover, .divider { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
.hero { width: 6.4in; flex: none; height: 4.8in; background: #fff; border-radius: 0.1in; overflow: hidden; }
.cover h1 { font-size: 0.5in; margin: 0.2in 0 0; }
.divider h2 { font-size: 0.45in; margin: 0.2in 0 0; }
.meta { font-size: 0.25in; margin: 0.05in 0 0; }
.meta.big { font-size: 0.5in; font-weight: 800; }
.warn { font-size: 0.2in; margin: 0.1in 0 0; color: #8a3b00; }
.pgrid { display: grid; grid-template-columns: repeat(6, 1fr); grid-template-rows: repeat(4, 1fr); gap: 0.1in; height: 100%; }
.pitem { display: flex; flex-direction: column; align-items: center; justify-content: center; background: #fff7e0; border: 0.02in solid #c8b27a; border-radius: 0.06in; }
.pitem .qty { position: static; font-size: 0.24in; }
.cname { font-size: 0.14in; text-align: center; padding: 0 0.05in; }
`;

/** The whole booklet as one self-contained HTML document. Image paths are file:// URLs. */
export function bookletHtml(opts: BookletOptions): string {
  const ctx: Ctx = { model: opts.model, shots: opts.shots, colorNames: opts.colorNames, digits: stepDigits(opts.model) };
  let partsIndex = 0;
  const body = opts.pages.map((page) => {
    switch (page.kind) {
      case 'cover': return coverPage(ctx, opts.checked);
      case 'section': return sectionPage(ctx, page);
      case 'steps': return stepsPage(ctx, page);
      case 'parts': return partsPage(ctx, partsIndex++);
    }
  }).join('\n');
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${esc(opts.model.title)}</title>`
    + `<meta name="viewport" content="width=device-width, initial-scale=1"><style>${CSS}</style></head><body>\n${body}\n</body></html>\n`;
}
