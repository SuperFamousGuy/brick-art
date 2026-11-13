import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ZipIndex } from '../render/zip-index.ts';
import { printToPdf } from '../render/pdf.ts';
import { ldrawColorNames } from '../render/tally.ts';
import { bookletHtml } from './booklet-html.ts';
import { planCell } from './cell-plan.ts';
import { checkModel, type Finding } from './check.ts';
import type { GeometrySource } from './geometry.ts';
import { layoutBooklet } from './layout.ts';
import { renderShots, stepDigits, stepShotName } from './render-steps.ts';
import { parseSteps, type Placement, type Step, type StepModel } from './steps.ts';

export interface InstructionsResult {
  status: 'built' | 'blocked';
  checked: boolean;                        // false when no parts database was available
  pdf: string | null;                      // null when blocked
  steps: StepRow[];
  findings: Finding[];
  accepted: { part: string; color: number; source: { file: string; line: number } }[];
  totalParts: number;
}

/**
 * One build step for the `.md`. `parts` are the parts this step adds by hand: its loose parts and its
 * callouts' parts (every instance). A sub-assembly added whole is listed in `inserts` instead, since
 * its parts are counted in its own section's steps. Summed over all steps, each multiplied by
 * `sectionQuantity` (how many times its section is built), the parts equal `totalParts`.
 */
export interface StepRow {
  number: number; section: string; sectionQuantity: number; text: string | null; png: string | null;
  parts: { part: string; color: number; colorName: string | null; count: number }[];
  inserts: { section: string; quantity: number }[];
}

/** A step that adds more than this many parts (loose plus callout parts) gets a `large-step` warning. */
export const LARGE_STEP = 8;

const fmt = (v: number[]) => `(${v.map((n) => Number(n.toFixed(1))).join(', ')})`;

function finding(kind: Finding['kind'], section: string, step: number, p: Placement, what: string): Finding {
  return {
    kind, blocking: false, section, step, part: p.part, color: p.color, pos: p.pos, source: p.source,
    message: `Step ${step}: ${p.part} (color ${p.color}) at ${fmt(p.pos)} ${what}.`,
  };
}

/** Parts a step adds by hand: loose and callout parts. Inserted sub-assemblies were built in their own steps. */
function reportableParts(step: Step): Placement[] {
  return [...step.loose, ...step.callouts.flatMap((c) => c.instances.flat())];
}

/**
 * Adds a `large-step` finding for each step that adds more than LARGE_STEP parts (loose plus callout
 * parts, not inserted sub-assemblies), or is too crowded to fit one page; one finding per step,
 * naming both reasons when both apply. Too many parts is a warning. Too crowded for a page blocks the
 * booklet, because the page would clip it. Runs with or without the connection check.
 */
export function addStepSizeFindings(model: StepModel, findings: Finding[]): void {
  for (const section of model.sections) {
    for (const step of section.steps) {
      const size = reportableParts(step).length;
      const crowded = !planCell(step, 3).fits;
      const reasons = [
        ...(size > LARGE_STEP ? [`adds ${size} parts (more than ${LARGE_STEP})`] : []),
        ...(crowded ? ['is too crowded to fit one page; split it into smaller steps or callouts'] : []),
      ];
      const first = step.added[0];
      if (reasons.length > 0 && first) {
        const f = finding('large-step', section.id, step.number, first, `starts a step that ${reasons.join(' and ')}`);
        f.blocking = crowded;
        findings.push(f);
      }
    }
  }
}

/** The per-step rows of the tool result, from the same parse as the booklet. */
export function stepRows(model: StepModel, colorNames: Map<number, string>, shots: Map<string, { png: string }> | null): StepRow[] {
  const digits = stepDigits(model);
  return model.sections.flatMap((section) => section.steps.map((step) => {
    const counts = new Map<string, StepRow['parts'][number]>();
    for (const p of reportableParts(step)) {
      const part = p.part.replace(/\.dat$/, '');
      const key = `${part}\u0000${p.color}`;
      const row = counts.get(key) ?? { part, color: p.color, colorName: colorNames.get(p.color) ?? null, count: 0 };
      row.count++;
      counts.set(key, row);
    }
    return {
      number: step.number, section: section.id, sectionQuantity: section.quantity, text: step.text,
      png: shots?.get(stepShotName(step.number, digits))?.png ?? null,
      parts: [...counts.values()],
      inserts: step.inserts.map((i) => ({ section: i.sectionId, quantity: i.quantity })),
    };
  }));
}

/**
 * Builds the instruction booklet for an LDraw model: checks each step's connections (when a parts
 * geometry source is given), renders every step, and prints a PDF. A blocked model renders nothing.
 */
export async function buildInstructions(opts: {
  modelPath: string; outDir?: string; browser: string; library: ZipIndex;
  geometry: GeometrySource | null; timeoutMs?: number;
}): Promise<InstructionsResult> {
  const modelPath = resolve(opts.modelPath);
  const modelDir = dirname(modelPath);
  const outDir = resolve(opts.outDir ?? modelDir);
  const colorNames = ldrawColorNames(opts.library);
  const model = parseSteps(modelPath, { isLibraryPart: (f) => opts.library.has(`parts/${f}`) });
  const checked = opts.geometry !== null;
  const check = opts.geometry ? checkModel(model, opts.geometry) : null;
  const findings: Finding[] = check ? [...check.findings] : [];
  const accepted = (check?.accepted ?? []).map((p) => ({ part: p.part, color: p.color, source: p.source }));

  addStepSizeFindings(model, findings);

  // A PDF left from an earlier run must not pass for this one, whether this run prints or not.
  const pdf = join(outDir, `${model.stem}-instructions.pdf`);
  await rm(pdf, { force: true });

  if (findings.some((f) => f.blocking)) {
    return { status: 'blocked', checked, pdf: null, steps: stepRows(model, colorNames, null), findings, accepted, totalParts: model.totalParts };
  }

  const shots = await renderShots({
    model, outDir, stem: model.stem, browser: opts.browser, library: opts.library, modelDir, timeoutMs: opts.timeoutMs,
  });
  const digits = stepDigits(model);
  for (const section of model.sections) {
    for (const step of section.steps) {
      const limit = reportableParts(step).length;
      for (const i of shots.get(stepShotName(step.number, digits))?.hiddenParts ?? []) {
        const p = step.added[i];
        if (p && i < limit) findings.push(finding('unverified', section.id, step.number, p, 'new part is hidden from the camera'));
      }
    }
  }

  const work = join(outDir, `.${model.stem}-instructions`);
  await mkdir(work, { recursive: true });
  const htmlPath = join(work, 'booklet.html');
  await writeFile(htmlPath, bookletHtml({ model, pages: layoutBooklet(model), shots, checked, colorNames }));
  await printToPdf({ htmlPath, pdfPath: pdf, browser: opts.browser, timeoutMs: opts.timeoutMs });

  return { status: 'built', checked, pdf, steps: stepRows(model, colorNames, shots), findings, accepted, totalParts: model.totalParts };
}
