import type { Mat3, Vec3 } from '../types.ts';
import type { ModelFile, ModelLine, ParsedModel } from './types.ts';

export function normalizeRef(ref: string): string {
  return ref.trim().toLowerCase().replace(/\\/g, '/');
}

interface Builder { file: ModelFile; step: number; stepLines: number }

function newBuilder(name: string): Builder {
  return { file: { name, author: null, license: null, lines: [], stepCount: 0 }, step: 1, stepLines: 0 };
}

function endStep(b: Builder): void {
  if (b.stepLines === 0) return;
  b.file.stepCount++;
  b.step++;
  b.stepLines = 0;
}

/** Parse an MPD or plain LDR model, keeping color codes on type-1 lines. */
export function parseModel(text: string, fileName: string): ParsedModel {
  const files = new Map<string, ModelFile>();
  let main: string | null = null;
  let cur: Builder | null = null;

  const close = (): void => {
    if (!cur) return;
    endStep(cur);
    files.set(cur.file.name, cur.file);
    cur = null;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const tok = line.split(/\s+/);
    if (tok[0] === '0') {
      const kw = tok[1]?.toUpperCase();
      if (kw === 'FILE') {
        close();
        cur = newBuilder(normalizeRef(tok.slice(2).join(' ')));
        main ??= cur.file.name;
      } else if (kw === 'NOFILE') {
        close();
      } else if (kw === 'STEP' || kw === 'ROTSTEP') {
        if (cur) endStep(cur);
      } else if (kw === 'AUTHOR:' || kw === '!LICENSE') {
        cur ??= newBuilder(normalizeRef(fileName));
        main ??= cur.file.name;
        const value = tok.slice(2).join(' ');
        if (kw === 'AUTHOR:') cur.file.author = value || null;
        else cur.file.license = value || null;
      }
      continue;
    }
    if (tok[0] !== '1' || tok.length < 15) continue;
    const n = tok.slice(2, 14).map(Number);
    if (n.some((v) => !Number.isFinite(v)) || !Number.isFinite(Number(tok[1]))) continue;
    cur ??= newBuilder(normalizeRef(fileName));
    main ??= cur.file.name;
    const entry: ModelLine = {
      step: cur.step,
      seq: cur.file.lines.length,
      color: Number(tok[1]),
      pos: n.slice(0, 3) as Vec3,
      matrix: n.slice(3, 12) as Mat3,
      ref: tok.slice(14).join(' '),
    };
    cur.file.lines.push(entry);
    cur.stepLines++;
  }
  close();
  return { main: main ?? normalizeRef(fileName), files };
}
