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

/** Maps a normalized LDraw file to a part number, preferring the part that owns the geometry. */
export function buildPartMap(
  parts: { partNum: string; ldrawFile: string | null; geometryFrom: string | null }[],
): Map<string, string> {
  const out = new Map<string, string>();
  const owns = new Map<string, boolean>();
  for (const p of parts) {
    if (!p.ldrawFile) continue;
    const file = normalizeRef(p.ldrawFile);
    const owner = p.geometryFrom === p.partNum;
    const cur = out.get(file);
    if (cur === undefined || (owner && !owns.get(file)) || (owner === owns.get(file) && p.partNum < cur)) {
      out.set(file, p.partNum);
      owns.set(file, owner);
    }
  }
  return out;
}
