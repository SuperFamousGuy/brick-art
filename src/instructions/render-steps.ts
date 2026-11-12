import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPage } from '../render/serve.ts';
import type { ZipIndex } from '../render/zip-index.ts';
import type { Vec3 } from '../types.ts';
import { DEFAULT_VIEW, type Placement, type StepModel } from './steps.ts';

export interface Shot {
  name: string;               // output file stem, e.g. 'step-03', 'callout-03-1-2', 'part-3001-4'
  model: string;              // flattened .ldr name served under /model/
  visible: [number, number];  // half-open index range of top-level parts to show
  frame: [number, number];    // index range the camera fits to (the whole section, so framing never jumps)
  view: { yaw: number; pitch: number };
  marks: Vec3[];              // world points to project (callout attach points)
  watch: [number, number];    // index range of new parts whose visible pixels to count
  width: number; height: number;
}
/**
 * One rendered shot. `marks` are the projected `Shot.marks`, in PNG pixels (the PNG is twice the
 * shot's width and height), origin top-left. `hiddenParts` are offsets into the shot's `watch`
 * range, so for a step shot index i is `step.added[i]`.
 */
export interface ShotResult { name: string; png: string; marks: [number, number][]; hiddenParts: number[] /* indices in watch with 0 visible pixels */ }

export type ShotSizes = { step: [number, number]; mini: [number, number]; icon: [number, number] };
/** Shot sizes in CSS pixels; the page renders at pixel ratio 2. */
export const DEFAULT_SHOT_SIZES: ShotSizes = { step: [720, 540], mini: [320, 240], icon: [120, 120] };
export const PIXEL_RATIO = 2;

const PAGE = fileURLToPath(new URL('../render/instructions.html', import.meta.url));
const SHOT_NAME = /^[A-Za-z0-9_-]{1,70}$/;

function num(n: number): string {
  const r = Number(n.toFixed(6));
  return String(Object.is(r, -0) ? 0 : r);
}

/** One `1 <color> <pos> <rot> <part>` line per placement, in order. */
export function flattenLdr(parts: Placement[]): string {
  const lines = ['0 brick-art instruction model'];
  for (const p of parts) lines.push(['1', String(p.color), ...p.pos.map(num), ...p.rot.map(num), p.part].join(' '));
  return lines.join('\n') + '\n';
}

/** Digits in step numbers: 2, or 3 when the booklet has 100 or more steps. */
export function stepDigits(model: StepModel): number {
  const total = model.sections.reduce((n, s) => n + s.steps.length, 0);
  return total >= 100 ? 3 : 2;
}
export const stepShotName = (step: number, digits: number) => `step-${String(step).padStart(digits, '0')}`;
export const calloutShotName = (step: number, digits: number, callout: number, mini: number) =>
  `callout-${String(step).padStart(digits, '0')}-${callout}-${mini}`;
/** `part-<part>-<color>`; characters outside [A-Za-z0-9_-] are written as `_<hex>`. */
export const iconShotName = (part: string, color: number) =>
  `part-${part.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16)}`)}-${color}`;

/**
 * The flattened models and the shot list for a booklet: one model per section (its steps' parts in
 * order), one for every callout, and one for the part icons. Step shots fit the camera to the whole
 * section, so the framing stays put while parts appear. A step shot's marks are its callouts' attach
 * points, callout by callout and instance by instance (`step.callouts.flatMap((c) => c.attach)`).
 */
export function planShots(model: StepModel, sizes: ShotSizes): { models: Map<string, string>; shots: Shot[] } {
  const models = new Map<string, string>();
  const shots: Shot[] = [];
  const digits = stepDigits(model);
  const calloutParts: Placement[] = [];
  const calloutShots: Shot[] = [];

  model.sections.forEach((section, si) => {
    const parts = section.steps.flatMap((s) => s.added);
    if (parts.length === 0) return;
    const name = `section-${si + 1}.ldr`;
    models.set(name, flattenLdr(parts));
    let end = 0;
    for (const step of section.steps) {
      const start = end;
      end += step.added.length;
      shots.push({
        name: stepShotName(step.number, digits), model: name, visible: [0, end], frame: [0, parts.length],
        view: step.view, marks: step.callouts.flatMap((c) => c.attach), watch: [start, end],
        width: sizes.step[0], height: sizes.step[1],
      });
      step.callouts.forEach((callout, ci) => {
        const base = calloutParts.length;
        const all = callout.miniSteps.flat();
        calloutParts.push(...all);
        let miniEnd = base;
        callout.miniSteps.forEach((mini, mi) => {
          miniEnd += mini.length;
          calloutShots.push({
            name: calloutShotName(step.number, digits, ci + 1, mi + 1), model: 'callouts.ldr',
            visible: [base, miniEnd], frame: [base, base + all.length], view: step.view, marks: [],
            watch: [miniEnd, miniEnd], width: sizes.mini[0], height: sizes.mini[1],
          });
        });
      });
    }
  });
  if (calloutParts.length > 0) {
    models.set('callouts.ldr', flattenLdr(calloutParts));
    shots.push(...calloutShots);
  }

  // Icons: each part and color once, at the origin, in parts-list order.
  const files = new Map<string, string>();
  for (const s of model.sections) {
    for (const step of s.steps) for (const p of step.added) files.set(`${p.part.replace(/\.dat$/, '')}\u0000${p.color}`, p.part);
  }
  const icons: Placement[] = model.parts.map((row) => ({
    part: files.get(`${row.part}\u0000${row.color}`) ?? `${row.part}.dat`, color: row.color, pos: [0, 0, 0],
    rot: [1, 0, 0, 0, 1, 0, 0, 0, 1], source: { file: '', line: 0 }, accepted: false,
  }));
  if (icons.length > 0) {
    models.set('icons.ldr', flattenLdr(icons));
    model.parts.forEach((row, i) => shots.push({
      name: iconShotName(row.part, row.color), model: 'icons.ldr', visible: [i, i + 1], frame: [i, i + 1],
      view: { ...DEFAULT_VIEW }, marks: [], watch: [i + 1, i + 1], width: sizes.icon[0], height: sizes.icon[1],
    }));
  }

  const seen = new Set<string>();
  for (const s of shots) {
    if (!SHOT_NAME.test(s.name)) throw new Error(`shot name is not usable as a file name: ${s.name}`);
    if (seen.has(s.name)) throw new Error(`two shots share the name ${s.name}`);
    seen.add(s.name);
  }
  return { models, shots };
}

/**
 * Renders every step, callout mini-step, and part icon of a booklet in the manual style. Step PNGs
 * go to `<outDir>/<stem>-step-NN.png`; callout and icon PNGs, and the flattened models, go to the
 * working folder `<outDir>/.<stem>-instructions/`. Returns the results by shot name, in shot order.
 */
export async function renderShots(opts: {
  model: StepModel; outDir: string; stem: string; browser: string; library: ZipIndex; modelDir: string;
  timeoutMs?: number; sizes?: ShotSizes;
}): Promise<Map<string, ShotResult>> {
  const outDir = resolve(opts.outDir);
  const work = join(outDir, `.${opts.stem}-instructions`);
  await mkdir(work, { recursive: true });
  const { models, shots } = planShots(opts.model, opts.sizes ?? DEFAULT_SHOT_SIZES);
  const results = new Map<string, ShotResult>();
  if (shots.length === 0) return results;

  const files = new Map<string, string>();
  for (const [name, text] of models) {
    const path = join(work, name);
    await writeFile(path, text);
    files.set(`/model/${name}`, path);
  }
  const byName = new Map(shots.map((s) => [s.name, s]));
  const pngPath = (s: Shot) => s.name.startsWith('step-') ? join(outDir, `${opts.stem}-${s.name}.png`) : join(work, `${s.name}.png`);
  const pngs = new Set<string>();
  const data = new Map<string, { marks: [number, number][]; hiddenParts: number[] }>();

  await runPage({
    page: PAGE,
    job: { pixelRatio: PIXEL_RATIO, shots },
    files,
    library: opts.library,
    modelDir: opts.modelDir,
    browser: opts.browser,
    width: Math.max(...shots.map((s) => s.width)),
    height: Math.max(...shots.map((s) => s.height)),
    timeoutMs: opts.timeoutMs ?? 600_000,
    async onResult(name, body) {
      const m = /^(.+)\.(png|json)$/.exec(name);
      const shot = m ? byName.get(m[1]!) : undefined;
      if (!m || !shot) throw new Error(`unexpected result ${name}`);
      if (m[2] === 'png') {
        await writeFile(pngPath(shot), body);
        pngs.add(shot.name);
        return;
      }
      const parsed = JSON.parse(body.toString('utf8')) as { marks?: unknown; hiddenParts?: unknown };
      const marks = Array.isArray(parsed.marks) ? parsed.marks : [];
      const hidden = Array.isArray(parsed.hiddenParts) ? parsed.hiddenParts : [];
      data.set(shot.name, {
        marks: marks.map((p) => [Number((p as number[])[0]), Number((p as number[])[1])] as [number, number]),
        hiddenParts: hidden.map(Number),
      });
    },
  });

  const missing = shots.filter((s) => !pngs.has(s.name) || !data.has(s.name)).map((s) => s.name);
  if (missing.length > 0) {
    throw new Error(`render page did not return ${missing.length} shot(s): ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', …' : ''}`);
  }
  for (const s of shots) results.set(s.name, { name: s.name, png: pngPath(s), ...data.get(s.name)! });
  return results;
}
