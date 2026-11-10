import type { Mat3, Triangle, Vec3 } from '../types.ts';

export interface Ref { file: string; pos: Vec3; matrix: Mat3 }
export interface ParsedFile {
  description: string;
  license: string | null;
  updateTag: string | null;
  refs: Ref[];
  tris: Triangle[];
  snapLines: string[];
}

const UPDATE_RE = /^\s*0\s+!LDRAW_ORG\b.*\bUPDATE\s+(\d{4}-\d{2})\b/m;
const SNAP_RE = /^0\s+!LDCAD\s+SNAP_/;

/** Extract the `YYYY-RR` release tag from a `0 !LDRAW_ORG ... UPDATE YYYY-RR` line. */
export function extractUpdateTag(text: string): string | null {
  return UPDATE_RE.exec(text)?.[1] ?? null;
}

function nums(tokens: string[], from: number, count: number): number[] | null {
  const out: number[] = [];
  for (let i = from; i < from + count; i++) {
    const n = Number(tokens[i]);
    if (tokens[i] === undefined || Number.isNaN(n)) return null;
    out.push(n);
  }
  return out;
}

export function parseLDraw(text: string): ParsedFile {
  const result: ParsedFile = {
    description: '', license: null, updateTag: extractUpdateTag(text),
    refs: [], tris: [], snapLines: [],
  };
  let sawFirstLine = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const isFirst = !sawFirstLine;
    sawFirstLine = true;
    const tokens = line.split(/\s+/);
    switch (tokens[0]) {
      case '0': {
        if (SNAP_RE.test(line)) result.snapLines.push(line);
        else if (tokens[1] === '!LICENSE') result.license = line.replace(/^0\s+!LICENSE\s*/, '');
        else if (isFirst) result.description = line.replace(/^0\s*/, '');
        break;
      }
      case '1': {
        const v = nums(tokens, 2, 12);
        if (!v || tokens.length < 15) break;
        result.refs.push({
          file: tokens.slice(14).join(' '),
          pos: [v[0], v[1], v[2]],
          matrix: v.slice(3) as Mat3,
        });
        break;
      }
      case '3': {
        const v = nums(tokens, 2, 9);
        if (!v) break;
        result.tris.push([[v[0], v[1], v[2]], [v[3], v[4], v[5]], [v[6], v[7], v[8]]]);
        break;
      }
      case '4': {
        const v = nums(tokens, 2, 12);
        if (!v) break;
        const p1: Vec3 = [v[0], v[1], v[2]];
        const p2: Vec3 = [v[3], v[4], v[5]];
        const p3: Vec3 = [v[6], v[7], v[8]];
        const p4: Vec3 = [v[9], v[10], v[11]];
        result.tris.push([p1, p2, p3], [p1, p3, p4]);
        break;
      }
      default:
        break; // types 2 and 5 (lines) carry no surface geometry
    }
  }
  return result;
}
