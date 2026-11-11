import { readFileSync } from 'node:fs';
import type { ZipIndex } from './zip-index.ts';

export interface TallyRow { part: string; color: number; colorName: string | null; count: number }

const COLOUR_LINE = /^\s*0\s+!COLOUR\s+(\S+)\s+CODE\s+(\d+)\b/;
const MAX_DEPTH = 32;

/** LDraw color code to LDConfig.ldr name, such as 4 to "Red". */
export function ldrawColorNames(library: ZipIndex): Map<number, string> {
  const names = new Map<number, string>();
  const bytes = library.get('LDConfig.ldr');
  if (!bytes) return names;
  for (const line of new TextDecoder().decode(bytes).split(/\r?\n/)) {
    const m = COLOUR_LINE.exec(line);
    if (m) names.set(Number(m[2]), m[1]!.replaceAll('_', ' '));
  }
  return names;
}

/** Splits an MPD into its named files; a plain LDR is one unnamed file. */
function splitMpd(text: string): { main: string[]; files: Map<string, string[]> } {
  const files = new Map<string, string[]>();
  let current: string[] | null = null;
  let main: string[] | null = null;
  const plain: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*0\s+FILE\s+(.+?)\s*$/.exec(line);
    if (m) {
      current = [];
      files.set(m[1]!.toLowerCase().replaceAll('\\', '/'), current);
      main ??= current;
      continue;
    }
    if (/^\s*0\s+NOFILE\b/.test(line)) { current = null; continue; }
    (current ?? plain).push(line);
  }
  return { main: main ?? plain, files };
}

/**
 * Counts the library parts a model places, by part and color, expanding submodels found in
 * the model (MPD) or in `localFiles` (model-folder files keyed by lowercased name).
 * Color 16 inherits the parent's color, as in LDraw.
 */
export function tallyModel(
  modelText: string, localFiles: Map<string, string>, library: ZipIndex, colorNames: Map<number, string>,
): TallyRow[] {
  const { main, files } = splitMpd(modelText);
  const counts = new Map<string, number>();
  const loadLocal = (name: string): string[] | null => {
    const inMpd = files.get(name);
    if (inMpd) return inMpd;
    const path = localFiles.get(name);
    if (!path) return null;
    const lines = splitMpd(readFileSync(path, 'utf8')).main;
    files.set(name, lines);
    return lines;
  };
  const walk = (lines: string[], inherited: number, depth: number) => {
    if (depth > MAX_DEPTH) throw new Error('model nesting is too deep (a submodel may include itself)');
    for (const line of lines) {
      const t = line.trim().split(/\s+/);
      if (t[0] !== '1' || t.length < 15) continue;
      const raw = Number(t[1]);
      const color = raw === 16 ? inherited : raw;
      const ref = t.slice(14).join(' ').toLowerCase().replaceAll('\\', '/');
      const sub = loadLocal(ref);
      if (sub && !library.has(`parts/${ref}`)) { walk(sub, color, depth + 1); continue; }
      const key = `${ref}\u0000${color}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  };
  walk(main, 16, 0);
  return [...counts]
    .map(([key, count]) => {
      const [file, color] = key.split('\u0000') as [string, string];
      const code = Number(color);
      return { part: file.replace(/\.dat$/, ''), color: code, colorName: colorNames.get(code) ?? null, count };
    })
    .sort((a, b) => a.part.localeCompare(b.part) || a.color - b.color);
}
