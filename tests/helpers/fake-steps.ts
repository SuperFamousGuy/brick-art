import type { Callout, Placement, Step, StepModel, Section } from '../../src/instructions/steps.ts';

const IDENT: Placement['rot'] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const part = (): Placement => ({ part: '3001.dat', color: 4, pos: [0, 0, 0], rot: IDENT, source: { file: 'm.ldr', line: 1 }, accepted: false });

export function fakeStep(number: number, opts: { loose?: number; callouts?: number } = {}): Step {
  const loose = Array.from({ length: opts.loose ?? 1 }, part);
  const callouts: Callout[] = Array.from({ length: opts.callouts ?? 0 }, () => ({
    file: 'c.ldr', quantity: 1, miniSteps: [[part()]], instances: [[part()]], attach: [[0, 0, 0]], accepted: [false],
  }));
  return {
    number, text: null, loose, callouts, inserts: [], added: loose, view: { yaw: -35, pitch: 30 }, rotated: false,
  };
}
export function fakeModel(sections: Section[], parts = 1): StepModel {
  return {
    title: 'Test', stem: 'test', sections,
    parts: Array.from({ length: parts }, (_, i) => ({ part: `300${i}`, color: 4, count: 1 })),
    totalParts: parts,
  };
}
export const section = (id: string, steps: Step[]): Section => ({ id, title: id, file: `${id}.ldr`, quantity: 1, steps });
