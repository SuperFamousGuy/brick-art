import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { readLocalModel, splitMpd } from '../render/tally.ts';
import { modelFolderFiles } from '../render/serve.ts';

export interface ModelInfo { name: string; title: string | null; author: string | null }
/** files[0] is the main model; the rest are its submodels in first-reference order. */
export interface Bundle { info: ModelInfo; files: { name: string; lines: string[] }[] }

const MAX_DEPTH = 32;
// A `0 !BRICKART` meta, not a `0 //` comment: parseSteps reads every `0 //` line as step text.
const HASH_PREFIX = '0 !BRICKART LEOCAD_FILE ';
const HASH_LINE = /^0 !BRICKART LEOCAD_FILE ([0-9a-f]{64})$/;
// Type-0 lines that belong to the build, not the header.
const BUILD_META = /^0\s+(STEP|ROTSTEP|SAVE|CLEAR|PAUSE|WRITE|PRINT|\/\/)(\s|$)/;
// Header lines that are not a plain title.
const NOT_TITLE = /^(Name|Author|Theme|Unofficial|Official|Part|Subpart|Primitive|Model|Meta)\s*:|^(!|BFC\b|\/\/)/i;

const normalize = (ref: string) => ref.trim().toLowerCase().replaceAll('\\', '/');
const trimEnd = (lines: string[]) => {
  const out = [...lines];
  while (out.length && out.at(-1)!.trim() === '') out.pop();
  return out;
};

function headerLength(lines: string[]): number {
  let i = 0;
  while (i < lines.length && /^\s*0(\s|$)/.test(lines[i]!) && !BUILD_META.test(lines[i]!.trim())) i++;
  return i;
}

function readInfo(lines: string[], fileName: string): ModelInfo {
  const header = lines.slice(0, headerLength(lines)).map((l) => l.trim().replace(/^0\s*/, ''));
  const field = (key: string) => header.find((l) => new RegExp(`^${key}:`, 'i').test(l))?.slice(key.length + 1).trim() || null;
  const named = field('Name');
  const name = (named ?? fileName).replace(/^.*[\\/]/, '').replace(/\.(ldr|mpd|dat)$/i, '');
  const first = header[0];
  return { name, title: first && !NOT_TITLE.test(first) ? first : null, author: field('Author') };
}

/**
 * Reads a model and inlines every file it references that is not a library part: submodels and
 * local part files from its folder, and blocks embedded in a referenced `.mpd`.
 */
export function bundleModel(modelPath: string, isLibraryPart: (ref: string) => boolean): Bundle {
  const local = modelFolderFiles(dirname(modelPath));
  const { main, files: embedded } = splitMpd(readFileSync(modelPath, 'utf8'));
  const loadLocal = (key: string): string[] | null => {
    const inMpd = embedded.get(key);
    if (inMpd) return inMpd;
    const path = local.get(key);
    return path ? readLocalModel(path, embedded) : null;
  };

  const mainName = basename(modelPath);
  const out: Bundle['files'] = [{ name: mainName, lines: trimEnd(main) }];
  const seen = new Set<string>([normalize(mainName)]);
  const walk = (lines: string[], depth: number, ancestors: string[]) => {
    if (depth > MAX_DEPTH) throw new Error(`model nesting is deeper than ${MAX_DEPTH} levels`);
    for (const line of lines) {
      const t = line.trim().split(/\s+/);
      if (t[0] !== '1' || t.length < 15) continue;
      const written = t.slice(14).join(' ');
      const ref = normalize(written);
      if (ancestors.includes(ref)) throw new Error(`"${written}" includes itself (a cycle through ${ancestors.join(' > ')})`);
      if (seen.has(ref)) continue;
      const isLib = isLibraryPart(ref);
      const sub = isLib ? null : loadLocal(ref);
      if (!sub) {
        if (!isLib) throw new Error(`"${ref}" is neither a library part nor a file next to the model`);
        continue;
      }
      // A local part file (one with its own geometry) is inlined too, so the shared file is complete.
      seen.add(ref);
      const subLines = trimEnd(sub);
      out.push({ name: written.trim(), lines: subLines });
      walk(subLines, depth + 1, [...ancestors, ref]);
    }
  };
  walk(out[0]!.lines, 0, [normalize(mainName)]);
  return { info: readInfo(out[0]!.lines, mainName), files: out };
}

/** Hash of the text with any hash line removed. */
export function contentHash(text: string): string {
  const kept = text.split('\n').filter((l) => !HASH_LINE.test(l));
  return createHash('sha256').update(kept.join('\n')).digest('hex');
}

export function storedHash(text: string): string | null {
  for (const l of text.split('\n')) {
    const m = HASH_LINE.exec(l);
    if (m) return m[1]!;
  }
  return null;
}

/** The MPD text: LeoCAD MODEL lines and cameras after the main header, then the hash line. */
export function mpdText(bundle: Bundle, cameraLines: string[]): string {
  const [mainFile, ...subs] = bundle.files as [Bundle['files'][number], ...Bundle['files']];
  const split = headerLength(mainFile.lines);
  const { info } = bundle;
  // LeoCAD takes the model name from `0 Name:` and ignores this line; it is kept for other readers.
  const model = [`0 !LEOCAD MODEL NAME ${info.name}`];
  if (info.author) model.push(`0 !LEOCAD MODEL AUTHOR ${info.author}`);
  if (info.title) model.push(`0 !LEOCAD MODEL DESCRIPTION ${info.title}`);
  const head = [`0 FILE ${mainFile.name}`, ...mainFile.lines.slice(0, split), ...model, ...cameraLines];
  const tail = [...mainFile.lines.slice(split), '0 NOFILE'];
  for (const s of subs) tail.push(`0 FILE ${s.name}`, ...s.lines, '0 NOFILE');
  const hash = contentHash([...head, ...tail].join('\n') + '\n');
  return [...head, HASH_PREFIX + hash, ...tail].join('\n') + '\n';
}
