import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BOX_W, BOX_X, COL_GAP, COL_W, ITEM_H, ITEM_W, PAD, ROW_GAP, ROW_H, STRIP_ITEM_H, STRIP_ITEM_W, planCell,
} from './cell-plan.ts';
import { PARTS_PER_PAGE, placeCells, type Cell, type Page } from './layout.ts';
import {
  calloutShotName, DEFAULT_SHOT_SIZES, iconShotName, PIXEL_RATIO, stepDigits, stepShotName, type ShotResult,
} from './render-steps.ts';
import type { Section, Step, StepModel } from './steps.ts';

const ICON = 0.38;
const STRIP_ICON = 0.3;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

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
  const plan = planCell(step, cell.span);
  const { w, h } = plan;
  const parts: string[] = [];
  const over: string[] = [];
  const id = `a${step.number}`;

  parts.push(`<div class="num" style="left:${n(PAD)}in;top:0">${step.number}</div>`);
  if (plan.groups.length > 0) {
    const items = plan.groups.map((c) =>
      `<div class="item" style="width:${n(ITEM_W)}in">${icon(ctx, c.part, c.color, ICON)}<span class="pq">${c.count}x</span></div>`).join('');
    parts.push(box(BOX_X, 0.08, BOX_W, plan.partsBoxH, 'partsbox', items));
  }

  // Step image: a fixed 4:3 area; the picture is centred inside it (object-fit: contain).
  const shot = ctx.shots.get(stepShotName(step.number, ctx.digits));
  const [pw, ph] = shot ? pngSize(shot.png, [DEFAULT_SHOT_SIZES.step[0] * PIXEL_RATIO, DEFAULT_SHOT_SIZES.step[1] * PIXEL_RATIO]) : [4, 3];
  const im = plan.img;
  parts.push(`<div class="stepimg" style="left:${n(im.x)}in;top:${n(im.y)}in;width:${n(im.w)}in;height:${n(im.h)}in">${img(shot, 'shot')}</div>`);
  if (step.rotated) parts.push(`<div class="rot" style="left:${n(im.x + im.w - 0.5)}in;top:${n(im.y + 0.05)}in">${ROTATE_ICON}</div>`);
  const fit = Math.min(im.w / pw, im.h / ph);
  const shown = { w: pw * fit, h: ph * fit };
  const origin = { x: im.x + (im.w - shown.w) / 2, y: im.y + (im.h - shown.h) / 2 };

  const attachMarks = shot?.marks ?? [];
  let markIx = 0;
  for (const b of plan.boxes) {
    let inner = b.qty > 1 ? `<span class="qty" style="left:${n(b.gap)}in;top:0.02in">${b.qty}x</span>` : '';
    if (b.kind === 'callout') {
      if (b.strip > 0) {
        const items = b.groups.map((c) =>
          `<div class="item" style="width:${n(STRIP_ITEM_W)}in;height:${n(STRIP_ITEM_H)}in">${icon(ctx, c.part, c.color, STRIP_ICON)}<span class="pq">${c.count}x</span></div>`).join('');
        inner += `<div class="strip" style="left:${n(b.gap)}in;top:${n(b.gap + b.head)}in;width:${n(b.w - 2 * b.gap)}in;height:${n(b.strip)}in">${items}</div>`;
      }
      const top = b.gap + b.head + (b.strip > 0 ? b.strip + b.gap : 0);
      for (let k = 0; k < b.count; k++) {
        const m = ctx.shots.get(calloutShotName(step.number, ctx.digits, b.i + 1, k + 1));
        const cx = b.gap + (k % b.cols) * (b.mw + b.gap);
        const cy = top + Math.floor(k / b.cols) * (b.mh + b.gap);
        inner += `<div class="mini" style="left:${n(cx)}in;top:${n(cy)}in;width:${n(b.mw)}in;height:${n(b.mh)}in">${img(m, 'shot')}`
          + (b.count > 1 ? `<span class="mn">${k + 1}</span>` : '') + '</div>';
      }
    } else {
      const sec = ctx.model.sections.find((s) => s.id === step.inserts[b.i]!.sectionId);
      inner += `<div class="mini" style="left:${n(b.gap)}in;top:${n(b.gap + b.head)}in;width:${n(b.mw)}in;height:${n(b.mh)}in">${img(lastShot(ctx, sec), 'shot')}</div>`;
    }
    parts.push(box(b.x, b.y, b.w, b.h, `callout${b.kind === 'insert' ? ' insert' : ''}`, inner));
    if (b.kind === 'callout') {
      const count = step.callouts[b.i]!.attach.length;
      for (let j = 0; j < count; j++) {
        const mark = attachMarks[markIx++];
        if (!mark) continue;
        // A mark outside the picture (an attach point off camera) is pulled to the picture's edge.
        const ex = clamp(origin.x + mark[0] / pw * shown.w, origin.x, origin.x + shown.w);
        const ey = clamp(origin.y + mark[1] / ph * shown.h, origin.y, origin.y + shown.h);
        const [sx, sy] = plan.side ? [b.x, b.y + b.h * (j + 1) / (count + 1)] : [b.x + b.w * (j + 1) / (count + 1), b.y];
        over.push(`<line class="arrow" x1="${n(sx)}" y1="${n(sy)}" x2="${n(ex)}" y2="${n(ey)}" marker-end="url(#${id})"/>`);
      }
    }
  }

  const svg = `<svg class="over" viewBox="0 0 ${n(w)} ${n(h)}" preserveAspectRatio="none"><defs>`
    + `<marker id="${id}" markerWidth="0.16" markerHeight="0.16" refX="0.14" refY="0.08" orient="auto" markerUnits="userSpaceOnUse">`
    + '<path d="M0 0L0.16 0.08L0 0.16z" fill="#333"/></marker></defs>' + over.join('') + '</svg>';
  const cols = cell.span === 3 ? '1 / span 3' : String(at.col + 1);
  const style = `grid-row:${at.row + 1} / span ${at.rows};grid-column:${cols};width:${n(w)}in;height:${n(h)}in`;
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
.cell { position: relative; }
.cell > div, .cell > svg { position: absolute; }
.num { font-size: 0.55in; font-weight: 800; line-height: 0.65in; }
.partsbox { display: flex; flex-wrap: wrap; align-content: flex-start; padding: 0.05in; background: #fff7e0; border: 0.02in solid #c8b27a; border-radius: 0.06in; }
.item { display: flex; flex-direction: column; align-items: center; height: ${ITEM_H}in; }
.icon { object-fit: contain; }
.pq { font-size: 0.15in; font-weight: 700; line-height: 0.18in; }
.mini { position: absolute; }
.strip { position: absolute; display: flex; flex-wrap: wrap; align-content: flex-start; }
.strip .pq { font-size: 0.12in; line-height: 0.14in; }
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
