import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { splitMpd } from '../render/tally.ts';
import type { Mat3, Vec3 } from '../types.ts';

export const CALLOUT_MAX_PARTS = 8;
export const DEFAULT_VIEW = { yaw: -35, pitch: 30 }; // front-left, from above
const MAX_DEPTH = 32;

export interface Placement {
  part: string;        // library file, lowercased, e.g. '3001.dat'
  color: number;       // resolved LDraw color (16 replaced by the inherited color)
  pos: Vec3;           // world position, LDU
  rot: Mat3;           // world rotation, row-major
  source: { file: string; line: number }; // file name and 1-based line of the type-1 line
  accepted: boolean;   // preceded by 0 !BRICKART CONNECTED
}
export interface Callout {
  file: string;              // submodel file name
  quantity: number;          // instances of this submodel placed in this step
  miniSteps: Placement[][];  // the submodel's own steps, in the submodel's local frame
  instances: Placement[][];  // world-frame parts of each instance, in placement order
  attach: Vec3[];            // world origin of each instance
  accepted: boolean[];       // per instance: its reference line was preceded by 0 !BRICKART CONNECTED
}
export interface Insert {
  sectionId: string; quantity: number; parts: Placement[]; attach: Vec3;
  accepted: boolean;         // every reference line of this insert in this step was preceded by 0 !BRICKART CONNECTED
}
export interface Step {
  number: number;            // 1-based, continuous across the whole booklet
  text: string | null;       // joined `0 //` comments in this step
  loose: Placement[];        // library parts placed directly in this step (the parts box)
  callouts: Callout[];
  inserts: Insert[];         // whole large submodels added in this step
  added: Placement[];        // every part that becomes visible in this step = loose + callout instances + insert parts
  view: { yaw: number; pitch: number };
  rotated: boolean;          // this step starts a new ROTSTEP view
}
export interface Section { id: string; title: string; file: string; quantity: number; steps: Step[] }
export interface PartCount { part: string; color: number; count: number }
export interface StepModel { title: string; stem: string; sections: Section[]; parts: PartCount[]; totalParts: number }

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const ZERO: Vec3 = [0, 0, 0];
const TOO_DEEP = 'model nesting is too deep (a submodel may include itself)';

interface Frame { color: number; pos: Vec3; rot: Mat3 }
interface Ref { file: string; frame: Frame; line: number; accepted: boolean }
type Event =
  | { kind: 'ref'; ref: Ref }
  | { kind: 'break'; rotstep: string | null }
  | { kind: 'text'; text: string };

function mulVec(r: Mat3, v: Vec3): Vec3 {
  return [
    r[0] * v[0] + r[1] * v[1] + r[2] * v[2],
    r[3] * v[0] + r[4] * v[1] + r[5] * v[2],
    r[6] * v[0] + r[7] * v[1] + r[8] * v[2],
  ];
}

function mulMat(a: Mat3, b: Mat3): Mat3 {
  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out.push(a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!);
    }
  }
  return out as Mat3;
}

function placement(ref: Ref, file: string): Placement {
  return {
    part: ref.file, color: ref.frame.color, pos: ref.frame.pos, rot: ref.frame.rot,
    source: { file, line: ref.line }, accepted: ref.accepted,
  };
}

function titleOf(lines: string[]): string | null {
  for (const line of lines) {
    const m = /^\s*0\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    if (/^(\/\/|!|STEP\b|ROTSTEP\b|FILE\b|NOFILE\b|Name:|Author:|BFC\b)/i.test(m[1]!)) continue;
    return m[1]!;
  }
  return null;
}

/** Applies a `ROTSTEP` line to the current view; `END` restores the default view. */
function applyRotstep(view: { yaw: number; pitch: number }, line: string): { yaw: number; pitch: number } {
  const m = /^ROTSTEP\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*(ABS|REL|ADD)?/i.exec(line);
  if (!m) return { ...DEFAULT_VIEW };
  const x = Number(m[1]);
  const y = Number(m[2]);
  if ((m[4] ?? 'REL').toUpperCase() === 'ABS') return { yaw: DEFAULT_VIEW.yaw + y, pitch: DEFAULT_VIEW.pitch + x };
  return { yaw: view.yaw + y, pitch: view.pitch + x };
}

/**
 * Parses a model into build sections and steps. Submodels with at most CALLOUT_MAX_PARTS parts
 * become callouts inside a step; larger ones become their own sections, built before their user.
 */
export function parseSteps(modelPath: string, opts: { isLibraryPart: (file: string) => boolean }): StepModel {
  const dir = dirname(modelPath);
  const stem = basename(modelPath, extname(modelPath));
  const mainName = basename(modelPath).toLowerCase();
  const { main, files } = splitMpd(readFileSync(modelPath, 'utf8'));
  const localPaths = new Map<string, string>();
  for (const f of readdirSync(dir)) localPaths.set(f.toLowerCase(), join(dir, f));

  const submodel = (ref: string): string[] | null => {
    if (opts.isLibraryPart(ref)) return null;
    const inMpd = files.get(ref);
    if (inMpd) return inMpd;
    const path = localPaths.get(ref);
    if (!path) return null;
    const lines = splitMpd(readFileSync(path, 'utf8')).main;
    files.set(ref, lines);
    return lines;
  };

  /** The events of one file's lines, with each placement already in the frame `frame`. */
  const events = (lines: string[], frame: Frame): Event[] => {
    const out: Event[] = [];
    let accepted = false;
    lines.forEach((line, i) => {
      const t = line.trim().split(/\s+/);
      if (t[0] === '0') {
        const rest = line.trim().replace(/^0\s*/, '');
        if (/^STEP\b/i.test(rest)) out.push({ kind: 'break', rotstep: null });
        else if (/^ROTSTEP\b/i.test(rest)) out.push({ kind: 'break', rotstep: rest });
        else if (/^!BRICKART\s+CONNECTED\b/i.test(rest)) accepted = true;
        else if (rest.startsWith('//') && rest.slice(2).trim()) out.push({ kind: 'text', text: rest.slice(2).trim() });
        return;
      }
      if (t[0] !== '1' || t.length < 15) return;
      const n = t.slice(2, 14).map(Number);
      const raw = Number(t[1]);
      const pos = mulVec(frame.rot, [n[0]!, n[1]!, n[2]!]);
      out.push({
        kind: 'ref',
        ref: {
          file: t.slice(14).join(' ').toLowerCase().replaceAll('\\', '/'),
          frame: {
            color: raw === 16 ? frame.color : raw,
            pos: [frame.pos[0] + pos[0], frame.pos[1] + pos[1], frame.pos[2] + pos[2]],
            rot: mulMat(frame.rot, n.slice(3) as Mat3),
          },
          line: i + 1,
          accepted,
        },
      });
      accepted = false;
    });
    return out;
  };

  /** Every library part under a file, grouped by the file's own steps; nested submodels are expanded in place. */
  const flatten = (lines: string[], file: string, frame: Frame, depth: number): Placement[][] => {
    if (depth > MAX_DEPTH) throw new Error(TOO_DEEP);
    const groups: Placement[][] = [[]];
    for (const ev of events(lines, frame)) {
      if (ev.kind === 'break') groups.push([]);
      if (ev.kind !== 'ref') continue;
      const sub = submodel(ev.ref.file);
      groups[groups.length - 1]!.push(
        ...(sub ? flatten(sub, ev.ref.file, ev.ref.frame, depth + 1).flat() : [placement(ev.ref, file)]),
      );
    }
    return groups.filter((g) => g.length > 0);
  };

  const sections: Section[] = [];
  const sectionKeys = new Set<string>();
  const sectionKeyOf = new Map<Section, string>();
  const insertKeys = new Map<Insert, string>();
  const edges: { parent: string; child: string }[] = [];
  const keyOf = (file: string, color: number) => `${file}\u0000${color}`;
  const stemOf = (file: string) => file.replace(/\.[^./]+$/, '');

  const buildSteps = (lines: string[], file: string, color: number, depth: number): Step[] => {
    if (depth > MAX_DEPTH) throw new Error(TOO_DEEP);
    const steps: Step[] = [];
    let view = { ...DEFAULT_VIEW };
    let rotated = false;
    let loose: Placement[] = [];
    let texts: string[] = [];
    const callouts = new Map<string, Callout>();
    const inserts = new Map<string, { insert: Insert; all: Placement[] }>();
    const selfKey = keyOf(file, color);

    const flush = () => {
      const added = [
        ...loose,
        ...[...callouts.values()].flatMap((c) => c.instances.flat()),
        ...[...inserts.values()].flatMap((i) => i.all),
      ];
      if (added.length > 0) {
        steps.push({
          number: 0, text: texts.length ? texts.join(' ') : null, loose, callouts: [...callouts.values()],
          inserts: [...inserts.values()].map((i) => i.insert), added, view, rotated,
        });
        rotated = false;
      }
      loose = []; texts = []; callouts.clear(); inserts.clear();
    };

    for (const ev of events(lines, { color, pos: ZERO, rot: IDENTITY })) {
      if (ev.kind === 'text') { texts.push(ev.text); continue; }
      if (ev.kind === 'break') {
        flush();
        if (ev.rotstep) { view = applyRotstep(view, ev.rotstep); rotated = true; }
        continue;
      }
      const { ref } = ev;
      const sub = submodel(ref.file);
      if (!sub) { loose.push(placement(ref, file)); continue; }
      const instance = flatten(sub, ref.file, ref.frame, depth + 1).flat();
      if (instance.length <= CALLOUT_MAX_PARTS) {
        let c = callouts.get(ref.file);
        if (!c) {
          const miniSteps = flatten(sub, ref.file, { color: ref.frame.color, pos: ZERO, rot: IDENTITY }, depth + 1);
          c = { file: ref.file, quantity: 0, miniSteps, instances: [], attach: [], accepted: [] };
          callouts.set(ref.file, c);
        }
        c.quantity++;
        c.instances.push(instance);
        c.attach.push(ref.frame.pos);
        c.accepted.push(ref.accepted);
        continue;
      }
      const childKey = keyOf(ref.file, ref.frame.color);
      if (!sectionKeys.has(childKey)) {
        sectionKeys.add(childKey);
        const built = buildSteps(sub, ref.file, ref.frame.color, depth + 1);
        const section = { id: stemOf(ref.file), title: stemOf(ref.file), file: ref.file, quantity: 0, steps: built };
        sectionKeyOf.set(section, childKey);
        sections.push(section);
      }
      edges.push({ parent: selfKey, child: childKey });
      const existing = inserts.get(childKey);
      if (existing) {
        existing.insert.quantity++;
        existing.insert.accepted &&= ref.accepted;
        existing.all.push(...instance);
      } else {
        const insert = { sectionId: '', quantity: 1, parts: instance, attach: ref.frame.pos, accepted: ref.accepted };
        insertKeys.set(insert, childKey);
        inserts.set(childKey, { insert, all: [...instance] });
      }
    }
    flush();
    return steps;
  };

  const mainSteps = buildSteps(main, mainName, 16, 0);
  const mainSection = { id: stem, title: stem, file: mainName, quantity: 1, steps: mainSteps };
  sectionKeyOf.set(mainSection, keyOf(mainName, 16));
  sections.push(mainSection);

  // A file placed in more than one colour gets one section per colour, ids suffixed with the colour.
  const colorsPerFile = new Map<string, number>();
  for (const s of sections) colorsPerFile.set(s.file, (colorsPerFile.get(s.file) ?? 0) + 1);
  const idByKey = new Map<string, string>();
  for (const s of sections) {
    const key = sectionKeyOf.get(s)!;
    if (s !== mainSection && colorsPerFile.get(s.file)! > 1) {
      s.id = `${stemOf(s.file)}-${key.split('\u0000')[1]}`;
      s.title = s.id;
    }
    idByKey.set(key, s.id);
  }
  for (const [insert, key] of insertKeys) insert.sectionId = idByKey.get(key)!;

  // Instances of a section = instances of each user times how often it places the section.
  const quantity = new Map<string, number>([[sectionKeyOf.get(mainSection)!, 1]]);
  for (const s of [...sections].reverse()) {
    const key = sectionKeyOf.get(s)!;
    s.quantity = quantity.get(key) ?? 0;
    for (const e of edges) if (e.parent === key) quantity.set(e.child, (quantity.get(e.child) ?? 0) + s.quantity);
  }
  let number = 0;
  for (const s of sections) for (const step of s.steps) step.number = ++number;

  const counts = new Map<string, PartCount>();
  for (const p of flatten(main, mainName, { color: 16, pos: ZERO, rot: IDENTITY }, 0).flat()) {
    const part = p.part.replace(/\.dat$/, '');
    const key = `${part}\u0000${p.color}`;
    const row = counts.get(key) ?? { part, color: p.color, count: 0 };
    row.count++;
    counts.set(key, row);
  }
  const parts = [...counts.values()].sort((a, b) => a.part.localeCompare(b.part) || a.color - b.color);
  return {
    title: titleOf(main) ?? stem, stem, sections, parts, totalParts: parts.reduce((a, p) => a + p.count, 0),
  };
}
