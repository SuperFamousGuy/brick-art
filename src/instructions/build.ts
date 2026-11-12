import { mkdir, writeFile } from 'node:fs/promises';
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
  steps: { number: number; section: string; text: string | null; png: string | null;
           parts: { part: string; color: number; colorName: string | null; count: number }[] }[];
  findings: Finding[];
  accepted: { part: string; color: number; source: { file: string; line: number } }[];
  totalParts: number;
}

const fmt = (v: number[]) => `(${v.map((n) => Number(n.toFixed(1))).join(', ')})`;

function finding(kind: Finding['kind'], section: string, step: number, p: Placement, what: string): Finding {
  return {
    kind, blocking: false, section, step, part: p.part, color: p.color, pos: p.pos, source: p.source,
    message: `Step ${step}: ${p.part} (color ${p.color}) at ${fmt(p.pos)} ${what}.`,
  };
}

/** Parts of a step the booklet shows as loose or in callouts; inserted sub-assemblies are hidden inside by design. */
function reportableCount(step: Step): number {
  return step.loose.length + step.callouts.reduce((n, c) => n + c.instances.reduce((m, i) => m + i.length, 0), 0);
}

/**
 * Adds a non-blocking `large-step` finding for each step too crowded to fit one page. A step the
 * check already reported as large gets the crowding note appended to that finding instead.
 */
export function addCrowdedFindings(model: StepModel, findings: Finding[]): void {
  for (const section of model.sections) {
    for (const step of section.steps) {
      if (planCell(step, 3).fits) continue;
      const existing = findings.find((f) => f.kind === 'large-step' && f.section === section.id && f.step === step.number);
      if (existing) {
        existing.message = `${existing.message.replace(/\.$/, '')}; it is too crowded to fit one page.`;
        continue;
      }
      const first = step.added[0];
      if (first) findings.push(finding('large-step', section.id, step.number, first, 'starts a step that is too crowded to fit one page'));
    }
  }
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

  addCrowdedFindings(model, findings);

  const stepRows = (shots: Map<string, { png: string }> | null) => {
    const digits = stepDigits(model);
    return model.sections.flatMap((section) => section.steps.map((step) => {
      const counts = new Map<string, { part: string; color: number; colorName: string | null; count: number }>();
      for (const p of step.added) {
        const part = p.part.replace(/\.dat$/, '');
        const key = `${part}\u0000${p.color}`;
        const row = counts.get(key) ?? { part, color: p.color, colorName: colorNames.get(p.color) ?? null, count: 0 };
        row.count++;
        counts.set(key, row);
      }
      return {
        number: step.number, section: section.id, text: step.text,
        png: shots?.get(stepShotName(step.number, digits))?.png ?? null,
        parts: [...counts.values()],
      };
    }));
  };

  if (check?.blocked) {
    return { status: 'blocked', checked, pdf: null, steps: stepRows(null), findings, accepted, totalParts: model.totalParts };
  }

  const shots = await renderShots({
    model, outDir, stem: model.stem, browser: opts.browser, library: opts.library, modelDir, timeoutMs: opts.timeoutMs,
  });
  const digits = stepDigits(model);
  for (const section of model.sections) {
    for (const step of section.steps) {
      const limit = reportableCount(step);
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
  const pdf = join(outDir, `${model.stem}-instructions.pdf`);
  await printToPdf({ htmlPath, pdfPath: pdf, browser: opts.browser, timeoutMs: opts.timeoutMs });

  return { status: 'built', checked, pdf, steps: stepRows(shots), findings, accepted, totalParts: model.totalParts };
}
