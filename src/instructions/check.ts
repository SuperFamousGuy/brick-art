import type { ConnectionType, Mat3, Vec3 } from '../types.ts';
import type { GeometrySource, PartGeom } from './geometry.ts';
import type { Placement, StepModel } from './steps.ts';

export type FindingKind = 'floating' | 'overlap' | 'off-grid' | 'unverified' | 'large-step';
export interface Finding {
  kind: FindingKind;
  blocking: boolean;          // true for floating, overlap, off-grid
  section: string; step: number;
  part: string; color: number; pos: Vec3;
  source: { file: string; line: number };
  message: string;            // one sentence naming the step, part, color, and position
}
export interface CheckResult { findings: Finding[]; accepted: Placement[]; blocked: boolean }
export const POS_TOLERANCE = 0.5;   // LDU
/**
 * LDU an axial connection (pin, axle, bar) may sit along its partner's axis: one stud-length
 * insertion. A sliding connection's `span` widens this to the two spans added together.
 */
export const AXIAL_REACH = 20;
const OVERLAP_SHARE = 0.5;          // shared cells / smaller part's cells for a blocking overlap
const OFF_GRID_REACH = 20;          // LDU, lateral reach of an off-grid near miss
const PARALLEL = 0.99;
const SAME_SIDE_EPS = 1e-6;          // LDU², centre-side product above this = same side of a mate
const CELL: Vec3 = [20, 8, 20];
const CLUSTER_LIST = 5;             // parts named in a floating finding
/** Connection pairs that join along an axis: the points may sit apart along it, as a pin's middle sits off a hole's centre. */
const AXIAL = new Set([
  'pin|pin_hole', 'pin_hole|pin', 'axle|axle_hole', 'axle_hole|axle', 'axle|pin_hole', 'pin_hole|axle',
  'bar|bar_holder', 'bar_holder|bar', 'bar|clip', 'clip|bar',
]);
const AXIAL_TYPES = new Set<ConnectionType>(['pin', 'pin_hole', 'axle', 'axle_hole', 'bar', 'bar_holder', 'clip']);

interface Box { min: Vec3; max: Vec3 }
interface Conn { type: ConnectionType; pos: Vec3; dir: Vec3; span: number; owner: Placed }
/** A placement with its geometry resolved into the checking frame. */
interface Placed {
  p: Placement; geom: PartGeom | null; conns: Conn[] | null;
  box: Box | null;   // world AABB shrunk by POS_TOLERANCE, null without geometry
  hull: Box;         // world AABB, or the origin point without geometry
  cells?: Box[];
}

const BLOCKING: Record<FindingKind, boolean> = {
  floating: true, overlap: true, 'off-grid': true, unverified: false, 'large-step': false,
};

function apply(rot: Mat3, pos: Vec3, v: Vec3): Vec3 {
  return [
    rot[0] * v[0] + rot[1] * v[1] + rot[2] * v[2] + pos[0],
    rot[3] * v[0] + rot[4] * v[1] + rot[5] * v[2] + pos[1],
    rot[6] * v[0] + rot[7] * v[1] + rot[8] * v[2] + pos[2],
  ];
}
const turn = (rot: Mat3, v: Vec3): Vec3 => apply(rot, [0, 0, 0], v);
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: Vec3) => Math.sqrt(dot(a, a));
const parallel = (a: Vec3, b: Vec3) => {
  const n = norm(a) * norm(b);
  return n > 0 && Math.abs(dot(a, b)) / n > PARALLEL;
};
/** Offset of `d` along the axis `dir`, and its distance from that axis. */
function split(d: Vec3, dir: Vec3): { along: number; lateral: number } {
  const axis = dir.map((v) => v / norm(dir)) as Vec3;
  const along = dot(d, axis);
  return { along, lateral: norm(sub(d, axis.map((v) => v * along) as Vec3)) };
}

/** The world AABB of the part-local box `min..max` under `rot`/`pos`. */
function worldBox(rot: Mat3, pos: Vec3, min: Vec3, max: Vec3): Box {
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const c = apply(rot, pos, [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]]);
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, c[k]!); hi[k] = Math.max(hi[k]!, c[k]!); }
  }
  return { min: lo, max: hi };
}
const shrink = (b: Box): Box => ({
  min: b.min.map((v) => v + POS_TOLERANCE) as Vec3,
  max: b.max.map((v) => v - POS_TOLERANCE) as Vec3,
});
const grown = (b: Box): Box => ({
  min: b.min.map((v) => v - POS_TOLERANCE) as Vec3,
  max: b.max.map((v) => v + POS_TOLERANCE) as Vec3,
});
const intersects = (a: Box, b: Box) =>
  a.min[0] < b.max[0] && b.min[0] < a.max[0] &&
  a.min[1] < b.max[1] && b.min[1] < a.max[1] &&
  a.min[2] < b.max[2] && b.min[2] < a.max[2];
/** Touch or intersect within POS_TOLERANCE. */
const touches = (a: Box, b: Box) =>
  a.min[0] <= b.max[0] + POS_TOLERANCE && b.min[0] <= a.max[0] + POS_TOLERANCE &&
  a.min[1] <= b.max[1] + POS_TOLERANCE && b.min[1] <= a.max[1] + POS_TOLERANCE &&
  a.min[2] <= b.max[2] + POS_TOLERANCE && b.min[2] <= a.max[2] + POS_TOLERANCE;
const axisAligned = (rot: Mat3) => rot.every((v) => Math.abs(v) < 1e-6 || Math.abs(Math.abs(v) - 1) < 1e-6);
const around = (v: Vec3, r: number): Box => ({ min: v.map((n) => n - r) as Vec3, max: v.map((n) => n + r) as Vec3 });
const center = (b: Box): Vec3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];

/** Shrunk world boxes of every filled grid cell. */
function cellBoxes(q: Placed): Box[] {
  if (q.cells) return q.cells;
  const { grid, bounds } = q.geom!;
  const out: Box[] = [];
  grid!.forEach((layer, y) => layer.forEach((row, z) => row.forEach((filled, x) => {
    if (!filled) return;
    const min: Vec3 = [bounds.min[0] + x * CELL[0], bounds.min[1] + y * CELL[1], bounds.min[2] + z * CELL[2]];
    const max: Vec3 = [min[0] + CELL[0], min[1] + CELL[1], min[2] + CELL[2]];
    out.push(shrink(worldBox(q.p.rot, q.p.pos, min, max)));
  })));
  q.cells = out;
  return out;
}

function resolve(p: Placement, geom: GeometrySource): Placed {
  const g = geom.get(p.part);
  const q: Placed = {
    p, geom: g, conns: null,
    box: g ? shrink(worldBox(p.rot, p.pos, g.bounds.min, g.bounds.max)) : null,
    hull: g ? worldBox(p.rot, p.pos, g.bounds.min, g.bounds.max) : { min: p.pos, max: p.pos },
  };
  q.conns = g?.connections?.map((c) => ({
    type: c.type, pos: apply(p.rot, p.pos, c.position), dir: turn(p.rot, c.direction), span: c.span ?? 0, owner: q,
  })) ?? null;
  return q;
}

interface StepUnits {
  number: number;
  name: string;            // how a floating finding names this step, e.g. 'step 4'
  units: Placement[][];
  loose: number;           // units[0 .. loose) are loose parts; the rest are callout or insert groups
  free: boolean[];         // per unit: its own reference line was accepted, so its attachment is not checked
  label: (unit: number) => string;
}

/** Buckets items by the grid cells their box touches, for neighbourhood queries. */
class SpatialHash<T> {
  private cells = new Map<string, T[]>();
  private size: number;
  constructor(size: number) { this.size = size; }
  private keys(b: Box): string[] {
    const lo = b.min.map((v) => Math.floor(v / this.size));
    const hi = b.max.map((v) => Math.floor(v / this.size));
    const out: string[] = [];
    for (let x = lo[0]!; x <= hi[0]!; x++) for (let y = lo[1]!; y <= hi[1]!; y++) for (let z = lo[2]!; z <= hi[2]!; z++) out.push(`${x},${y},${z}`);
    return out;
  }
  add(item: T, b: Box) {
    for (const k of this.keys(b)) {
      const list = this.cells.get(k);
      if (list) list.push(item); else this.cells.set(k, [item]);
    }
  }
  /** Every item whose box shares a cell with `b`, each once. */
  query(b: Box): T[] {
    const seen = new Set<T>();
    for (const k of this.keys(b)) for (const item of this.cells.get(k) ?? []) seen.add(item);
    return [...seen];
  }
}

const fmt = (v: Vec3) => `(${v.map((n) => Math.round(n * 100) / 100).join(', ')})`;
const named = (p: Placement) => `${p.part} (color ${p.color}) at ${fmt(p.pos)}`;

/**
 * Checks every build step: each new part (or callout / insert group) must connect to the model
 * built so far, must not overlap it, and must sit on the stud grid.
 */
export function checkModel(model: StepModel, geom: GeometrySource): CheckResult {
  const findings: Finding[] = [];
  const accepted = new Set<Placement>();
  const checkedCallouts = new Set<string>();

  const report = (kind: FindingKind, section: string, step: number, p: Placement, what: string): Finding => {
    const f: Finding = {
      kind, blocking: BLOCKING[kind], section, step, part: p.part, color: p.color, pos: p.pos, source: p.source,
      message: `Step ${step}: ${named(p)} ${what}.`,
    };
    findings.push(f);
    return f;
  };

  /**
   * True when two connection points join: compatible types and parallel directions, and either the
   * points coincide, or (for an axial pair) the axes line up and the points sit at most AXIAL_REACH
   * apart along them, or within both sliding spans for a long axle or bar.
   */
  const joins = (a: Conn, b: Conn) => {
    if (!geom.compatible(a.type, b.type) || !parallel(a.dir, b.dir)) return false;
    const d = sub(a.pos, b.pos);
    if (!AXIAL.has(`${a.type}|${b.type}`)) return norm(d) <= POS_TOLERANCE;
    const { along, lateral } = split(d, b.dir);
    return lateral <= POS_TOLERANCE && Math.abs(along) <= axialLimit(a, b) + POS_TOLERANCE;
  };
  const axialLimit = (a: Conn, b: Conn) => Math.max(AXIAL_REACH, a.span + b.span);
  /** Search radius for partners of `a`, given the longest sliding span among placed points. */
  const reach = (a: Conn, maxSpan: number) =>
    AXIAL_TYPES.has(a.type) ? Math.max(AXIAL_REACH, a.span + maxSpan) + POS_TOLERANCE : POS_TOLERANCE;
  const nearby = (a: Conn, b: Conn) => {
    if (!geom.compatible(a.type, b.type) || !parallel(a.dir, b.dir)) return false;
    const { along, lateral } = split(sub(a.pos, b.pos), b.dir);
    return Math.abs(along) <= POS_TOLERANCE && lateral < OFF_GRID_REACH;
  };

  /**
   * True when the two parts mate through a compatible connection with each other. An axial pair
   * that joins is a mate (the pin sits inside the hole). Otherwise the points must touch and the
   * parts sit on opposite sides of the connection plane. The side test rejects a part turned over
   * into its mate, and works whether the data's mating directions are parallel or anti-parallel
   * (the parts DB points studs and receptors outward, so a real mate is anti-parallel). Only both
   * centres strictly on the same side rejects a mate.
   */
  const mated = (q: Placed, o: Placed) => !!q.conns && !!o.conns && q.conns.some((a) => o.conns!.some((b) =>
    joins(a, b) && (AXIAL.has(`${a.type}|${b.type}`)
      || dot(sub(center(q.hull), a.pos), a.dir) * dot(sub(center(o.hull), a.pos), a.dir) <= SAME_SIDE_EPS)));

  /**
   * Classifies one colliding pair. Parts that mate with each other are exempt. With grids, a blocking
   * overlap needs the shared cells to cover OVERLAP_SHARE of the smaller part's filled cells.
   */
  const overlap = (q: Placed, o: Placed): 'overlap' | 'possible' | 'unchecked' | null => {
    if (!q.box || !o.box || !intersects(q.box, o.box) || mated(q, o)) return null;
    if (!q.geom!.grid || !o.geom!.grid || !axisAligned(q.p.rot) || !axisAligned(o.p.rot)) return 'unchecked';
    const mine = cellBoxes(q);
    const theirs = cellBoxes(o);
    const [small, large] = mine.length <= theirs.length ? [mine, theirs] : [theirs, mine];
    const near = large.filter((b) => intersects(b, q.box!) && intersects(b, o.box!));
    const shared = small.filter((a) => near.some((b) => intersects(a, b))).length;
    if (shared === 0) return null;
    return shared >= OVERLAP_SHARE * small.length ? 'overlap' : 'possible';
  };

  /**
   * Checks one sequence of steps in one frame. Each step is a list of units; a unit is a loose part
   * or one callout / insert instance, which passes when any member connects. Units that connect to
   * nothing are reported as clusters: the units of one step that connect to each other.
   */
  /** `whole` names what the steps build, for messages: 'the model', 'sub-assembly hull', 'callout pair.ldr'. */
  const checkSteps = (section: string, steps: StepUnits[], collect: Set<Placement>, whole: string) => {
    const conns = new SpatialHash<Conn>(OFF_GRID_REACH);   // connection points of placed parts
    let maxSpan = 0;                                       // longest sliding span among them
    const solids = new SpatialHash<Placed>(40);            // boxes of parts already overlap-checked
    const bodies = new SpatialHash<Placed>(40);            // hulls of placed parts
    // Connectivity of placed parts (union-find), to say when a floating cluster joins the model.
    const parent = new Map<Placed, Placed>();
    const find = (q: Placed): Placed => {
      let r = q;
      while (parent.get(r)! !== r) r = parent.get(r)!;
      parent.set(q, r);
      return r;
    };
    let ground: Placed | null = null;
    interface Cluster { finding: Finding; head: string; parts: Placement[]; rep: Placed; joined: { name: string; via: Placement } | null }
    const clusters: Cluster[] = [];

    for (const step of steps) {
      const units = step.units.map((parts, i) => ({ i, members: parts.map((p) => resolve(p, geom)) })).filter((u) => u.members.length > 0);
      type Unit = (typeof units)[number];
      type Link = [Placed, Placed];   // [member, placed part it attaches to]

      // Per-part overlap with everything placed earlier, including earlier units of this step (but
      // not members of the same unit).
      for (const u of units) {
        for (const q of u.members) {
          if (q.p.accepted) { if (collect.has(q.p)) accepted.add(q.p); continue; }
          if (!q.box) continue;
          for (const o of solids.query(q.box)) {
            const kind = overlap(q, o);
            if (kind === 'overlap') report('overlap', section, step.number, q.p, `overlaps ${named(o.p)}`);
            if (kind === 'possible') report('unverified', section, step.number, q.p, `has a possible overlap with ${named(o.p)}, sharing less than half the smaller part's grid cells`);
            if (kind === 'unchecked') report('unverified', section, step.number, q.p, `has a possible overlap with ${named(o.p)}, which could not be checked cell by cell`);
          }
        }
        for (const q of u.members) if (q.box) solids.add(q, q.box);
      }

      /** Links from a unit's connection points to placed connection points they join. */
      const connLinks = (u: Unit): Link[] => {
        const out: Link[] = [];
        for (const q of u.members) {
          for (const a of q.conns ?? []) {
            for (const b of conns.query(around(a.pos, reach(a, maxSpan)))) if (joins(a, b)) out.push([q, b.owner]);
          }
        }
        return out;
      };
      /**
       * A contact that stands in for a connection: a member with connection points resting on a
       * placed part without connection data, or a member with geometry but no connection data
       * resting on any placed part.
       */
      const contactOf = (u: Unit): { q: Placed; hit: Placed } | null => {
        for (const q of u.members) {
          if (!q.geom) continue;
          const hit = bodies.query(grown(q.hull)).find((o) => (!q.conns || !o.conns) && touches(q.hull, o.hull));
          if (hit) return { q, hit };
        }
        return null;
      };
      const noData = new Set<Placed>();   // members already reported for their missing connection data
      const place = (u: Unit, links: Link[], toGround: boolean) => {
        const first = u.members[0]!;
        for (const q of u.members) parent.set(q, q);
        for (const q of u.members) parent.set(find(q), find(first));
        const joinCheck = (via: Placed) => {
          for (const c of clusters) {
            if (!c.joined && ground && find(c.rep) === find(ground)) c.joined = { name: step.name, via: via.p };
          }
        };
        for (const [q, o] of links) {
          const a = find(q);
          const b = find(o);
          if (a !== b) { parent.set(a, b); joinCheck(q); }
        }
        if (toGround) {
          if (!ground) ground = first;
          const a = find(first);
          const b = find(ground);
          if (a !== b) { parent.set(a, b); joinCheck(first); }
        }
        for (const q of u.members) {
          for (const c of q.conns ?? []) { conns.add(c, around(c.pos, 0)); maxSpan = Math.max(maxSpan, c.span); }
          bodies.add(q, q.hull);
        }
      };
      /** Reports each non-accepted member without connection data of a unit that was placed. */
      const reportNoData = (u: Unit) => {
        for (const q of u.members) {
          if (q.conns || q.p.accepted || noData.has(q)) continue;
          report('unverified', section, step.number, q.p, 'has no connection data, so its connection was not checked');
        }
      };

      let pending: Unit[] = [];
      for (const u of units) {
        // An accepted loose part, or a group whose own reference line was accepted, is declared
        // connected. A group's members never free it, accepted or not: only its reference line does.
        // A unit with no geometry at all has nothing to check.
        const free = ground === null || step.free[u.i]! || !u.members.some((q) => q.geom);
        if (step.free[u.i] && u.i >= step.loose) for (const q of u.members) accepted.add(q.p);   // accepted group
        if (free) { place(u, connLinks(u), true); reportNoData(u); } else pending.push(u);
      }
      // Real connections first; a unit that only rests against a part without connection data (or
      // whose own part has none) is placed as unverified, and the connection fixpoint then resumes.
      for (;;) {
        let progress = true;
        while (progress && pending.length > 0) {
          progress = false;
          pending = pending.filter((u) => {
            const links = connLinks(u);
            if (links.length === 0) return true;
            place(u, links, false);
            reportNoData(u);
            progress = true;
            return false;
          });
        }
        const rescued = pending.map((u) => ({ u, c: contactOf(u) })).filter((x) => x.c);
        if (rescued.length === 0) break;
        for (const { u, c } of rescued) {
          const { q, hit } = c!;
          noData.add(q);
          report('unverified', section, step.number, q.p, q.conns
            ? `${step.label(u.i)}does not connect through known connection points but touches ${named(hit.p)}, which has no connection data`
            : `${step.label(u.i)}has no connection data but touches ${named(hit.p)}, so its connection was not checked`);
          place(u, [[q, hit]], false);
          reportNoData(u);
        }
        pending = pending.filter((u) => !rescued.some((x) => x.u === u));
      }

      // What is left connects to nothing placed. Units that join each other form one cluster.
      const near = new Set(pending.filter((u) => u.members.some((q) =>
        q.conns?.some((a) => conns.query(around(a.pos, OFF_GRID_REACH)).some((b) => nearby(a, b))))));
      for (const u of pending) {
        const c = contactOf(u);
        place(u, c ? [...connLinks(u), [c.q, c.hit]] : connLinks(u), false);
      }
      const groups = new Map<Placed, Unit[]>();
      for (const u of pending) {
        const r = find(u.members[0]!);
        groups.set(r, [...(groups.get(r) ?? []), u]);
      }
      for (const [rep, group] of groups) {
        const parts = group.flatMap((u) => u.members.map((q) => q.p));
        const firstMember = group[0]!.members.find((q) => q.conns) ?? group[0]!.members.find((q) => q.geom) ?? group[0]!.members[0]!;
        const labels = new Set(group.map((u) => step.label(u.i)));
        const label = labels.size === 1 ? [...labels][0]! : '';
        const offGrid = group.some((u) => near.has(u));
        const count = parts.length === 1 ? '1 part' : `${parts.length} parts`;
        const listed = parts.slice(0, CLUSTER_LIST).map(named).join(', ')
          + (parts.length > CLUSTER_LIST ? `, and ${parts.length - CLUSTER_LIST} more` : '');
        const head = `Step ${step.number}: ${count} ${label}${parts.length === 1 ? 'does' : 'do'} not connect to ${whole}`
          + `${offGrid ? ' (off the stud grid by less than one stud)' : ''}: ${listed}`;
        const finding = report(offGrid ? 'off-grid' : 'floating', section, step.number, firstMember.p, '');
        clusters.push({ finding, head, parts, rep, joined: null });
      }
    }
    for (const c of clusters) {
      const subject = c.parts.length === 1 ? 'it' : 'this group';
      c.finding.message = c.joined
        ? `${c.head}; ${subject} first joins ${whole} in ${c.joined.name} via ${named(c.joined.via)}.`
        : `${c.head}; ${subject} never joins the finished ${whole.replace(/^the /, '')}.`;
    }
  };

  for (const section of model.sections) {
    const steps = section.steps.map((step): StepUnits => {
      const units: Placement[][] = step.loose.map((p) => [p]);
      const labels: string[] = step.loose.map(() => '');
      const free: boolean[] = step.loose.map((p) => p.accepted);
      step.callouts.forEach((c) => c.instances.forEach((inst, k) => {
        units.push(inst); labels.push(`(in callout ${c.file}) `); free.push(c.accepted[k]!);
      }));
      let offset = step.loose.length + step.callouts.reduce((n, c) => n + c.instances.flat().length, 0);
      for (const ins of step.inserts) {
        const n = ins.parts.length;
        for (let k = 0; k < ins.quantity; k++) {
          units.push(step.added.slice(offset, offset + n));
          labels.push(`(in sub-assembly ${ins.sectionId}) `);
          free.push(ins.accepted);
          offset += n;
        }
      }
      return { number: step.number, name: `step ${step.number}`, units, loose: step.loose.length, free, label: (u: number) => labels[u]! };
    });
    // Accepted parts are collected from loose parts and callout instances only, so each
    // build instruction counts once (inserts repeat a section already collected on its own).
    const collectable = new Set(section.steps.flatMap((s) => [...s.loose, ...s.callouts.flatMap((c) => c.instances.flat())]));
    const isMain = section === model.sections[model.sections.length - 1];
    checkSteps(section.id, steps, collectable, isMain ? 'the model' : `sub-assembly ${section.id}`);

    // Callout mini-steps, in the submodel's local frame, once per submodel file.
    for (const step of section.steps) {
      for (const c of step.callouts) {
        if (checkedCallouts.has(c.file)) continue;
        checkedCallouts.add(c.file);
        checkSteps(section.id, c.miniSteps.map((parts, k) => ({
          number: step.number, name: `mini-step ${k + 1} of callout ${c.file}`, units: parts.map((p) => [p]), loose: parts.length,
          free: parts.map((p) => p.accepted), label: () => `(in callout ${c.file}) `,
        })), new Set(), `callout ${c.file}`);
      }
    }
  }
  return { findings, accepted: [...accepted], blocked: findings.some((f) => f.blocking) };
}
