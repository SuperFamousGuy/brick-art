import type { LDrawLibrary } from '../ldraw/library.ts';
import { normalizeRef } from './mpd.ts';

/**
 * What an LDraw reference is, judged from the library: a primitive under `p/`, a `~` segment or
 * sub-part under `parts/`, an alias (`~Moved to` or `=`) naming the part it stands for, or other.
 */
export interface RefClass { kind: 'primitive' | 'segment' | 'alias' | 'other'; aliasTarget?: string }
export type RefClassifier = (normalizedRef: string) => RefClass;

const OTHER: RefClass = { kind: 'other' };
const PRIMITIVE: RefClass = { kind: 'primitive' };
const SEGMENT: RefClass = { kind: 'segment' };
const TYPE1 = /^\s*1\s/;

/** Description from a first line `0 <description>`, or null when the line is not a comment. */
function description(line: string): string | null {
  const m = /^﻿?\s*0\s+(.*)$/.exec(line);
  return m ? m[1]!.trim() : null;
}

/** File named by a type-1 line (fields 15 onward, so names may contain spaces). */
function type1File(line: string): string | null {
  const tokens = line.trim().split(/\s+/);
  return tokens.length >= 15 ? normalizeRef(tokens.slice(14).join(' ')) : null;
}

/** Classifies references from the first lines of their library files, caching each file's result. */
export function refClassifier(lib: LDrawLibrary): RefClassifier {
  const cache = new Map<string, RefClass>();
  const classify = (ref: string): RefClass => {
    const where = lib.where(ref);
    if (where === 'p') return PRIMITIVE;
    if (where === null) return OTHER;
    const first = lib.head(ref, (l) => l.trim() !== '')?.find((l) => l.trim() !== '');
    const desc = first === undefined ? null : description(first);
    if (desc === null) return OTHER;
    if (/^~Moved to\b/i.test(desc) || desc.startsWith('=')) {
      const lines = lib.head(ref, (l) => TYPE1.test(l)) ?? [];
      const last = lines.at(-1);
      const target = last !== undefined && TYPE1.test(last) ? type1File(last) : null;
      return target === null ? OTHER : { kind: 'alias', aliasTarget: target };
    }
    return desc.startsWith('~') ? SEGMENT : OTHER;
  };
  return (ref) => {
    let hit = cache.get(ref);
    if (hit === undefined) {
      hit = classify(ref);
      cache.set(ref, hit);
    }
    return hit;
  };
}
