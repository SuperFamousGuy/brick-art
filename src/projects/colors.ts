import type { RbColor } from '../sources/rebrickable.ts';
import { normalizeRef } from './mpd.ts';

const normName = (name: string): string =>
  name.toLowerCase().replace(/[_-]/g, ' ').replaceAll('grey', 'gray').replace(/\s+/g, ' ').trim();
const normRgb = (rgb: string): string => rgb.replace(/^#/, '').toUpperCase();

const COLOUR_LINE = /^\s*0\s+!COLOUR\s+(\S+)\s+CODE\s+(\d+)\s+VALUE\s+#([0-9A-Fa-f]{6})\b/;

function uniqueBy(rb: RbColor[], key: (c: RbColor) => string): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const c of rb) {
    const k = key(c);
    out.set(k, out.has(k) ? null : c.id);
  }
  return out;
}

/** Maps LDraw color codes to Rebrickable color ids using LDConfig.ldr. */
export function buildColorMap(
  ldconfig: string, rbColors: RbColor[],
): { map: Map<number, number>; rate: number } {
  const byId = new Map(rbColors.map((c) => [c.id, c]));
  const byName = uniqueBy(rbColors, (c) => normName(c.name));
  const byRgb = uniqueBy(rbColors, (c) => normRgb(c.rgb));
  const map = new Map<number, number>();
  const codes = new Set<number>();
  for (const line of ldconfig.split(/\r?\n/)) {
    const m = COLOUR_LINE.exec(line);
    if (!m) continue;
    const code = Number(m[2]);
    codes.add(code);
    const name = normName(m[1]!);
    const rgb = normRgb(m[3]!);
    const same = byId.get(code);
    let id: number | null | undefined;
    if (same && (normName(same.name) === name || normRgb(same.rgb) === rgb)) id = code;
    else id = byName.get(name) ?? byRgb.get(rgb);
    if (id !== null && id !== undefined) map.set(code, id);
  }
  return { map, rate: codes.size === 0 ? 0 : map.size / codes.size };
}

const VARIANT_FILE = /^(.+)[a-z]\.dat$/;

/**
 * Maps a normalized LDraw file to a part number, preferring the part that owns the geometry.
 * `parts` lists every Rebrickable part, with its matched LDraw file or null. A library file in
 * `ldrawFiles` named `<base><letter>.dat` that no part maps to, and whose stem is not a Rebrickable
 * part, maps to the Rebrickable part `<base>` when that exists; such keys are listed in `suffixed`.
 */
export function buildPartMap(
  parts: { partNum: string; ldrawFile: string | null; geometryFrom: string | null }[],
  ldrawFiles: Iterable<string> = [],
): { parts: Map<string, string>; suffixed: Set<string> } {
  const out = new Map<string, string>();
  const owns = new Map<string, boolean>();
  const byLower = new Map<string, string>();
  for (const p of parts) {
    byLower.set(p.partNum.toLowerCase(), p.partNum);
    if (!p.ldrawFile) continue;
    const file = normalizeRef(p.ldrawFile);
    const owner = p.geometryFrom === p.partNum;
    const cur = out.get(file);
    if (cur === undefined || (owner && !owns.get(file)) || (owner === owns.get(file) && p.partNum < cur)) {
      out.set(file, p.partNum);
      owns.set(file, owner);
    }
  }
  const suffixed = new Set<string>();
  for (const raw of ldrawFiles) {
    const file = normalizeRef(raw);
    const m = VARIANT_FILE.exec(file);
    if (!m || out.has(file) || byLower.has(file.slice(0, -'.dat'.length))) continue;
    const base = byLower.get(m[1]!);
    if (base === undefined) continue;
    out.set(file, base);
    suffixed.add(file);
  }
  return { parts: out, suffixed };
}
