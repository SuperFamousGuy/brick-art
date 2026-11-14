import { writeFile, mkdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { buildColorMap } from '../projects/colors.ts';
import { MODEL_EXT, modelFolderFiles } from '../render/serve.ts';
import { ldrawColorNames, tallyModel, type TallyRow } from '../render/tally.ts';
import type { ZipIndex } from '../render/zip-index.ts';

/** The page whose upload format the list follows, and whose search takes element IDs. */
export const PICK_A_BRICK_URL = 'https://www.lego.com/en-us/pick-and-build/pick-a-brick';
/** Pick a Brick accepts at most this many lines in one upload. */
export const UPLOAD_LIMIT = 200;
/** Element IDs in one search URL; a longer query is cut off. */
const SEARCH_LIMIT = 60;
/**
 * Element IDs from 6540000 up are mostly recent reissues that Pick a Brick does not stock while an
 * older element in the same color is still sold. Checked against Pick a Brick in November 2026.
 */
const RECENT_REISSUE = 6_540_000;

export interface Candidate { elementId: string; partNum: string; designId: string }

/** Finds Rebrickable parts and LEGO elements for LDraw files and colors. */
export interface ElementLookup {
  /** Rebrickable part number for an LDraw file stem, such as "3001" for 3001.dat, or null. */
  partFor(ldrawPart: string): string | null;
  /** Rebrickable color id for an LDraw color code, or null. */
  colorFor(ldrawColor: number): number | null;
  /** Elements of the part in the color, then of its mold variants and alternates when it has none. */
  elementsFor(partNum: string, colorId: number): Candidate[];
}

/** Claude's decision for one part and color, after checking Pick a Brick. */
export interface Override {
  /** LDraw part, as in the model file, without ".dat". */
  part: string;
  /** LDraw color code, as in the model file. */
  color: number;
  /** The element to buy, or null when Pick a Brick does not sell the part in this color. */
  elementId: string | null;
}

export type RowSource = 'guess' | 'checked' | 'not-sold' | 'no-element';

export interface PlanRow {
  part: string;
  color: number;
  colorName: string | null;
  quantity: number;
  partNum: string | null;
  colorId: number | null;
  /** Element in the CSV, or null when the row is left out. */
  elementId: string | null;
  /**
   * guess: the default pick among the candidates, not yet checked on Pick a Brick.
   * checked: set by an override. not-sold: an override says Pick a Brick does not sell it.
   * no-element: no LEGO element is known for this part and color.
   */
  source: RowSource;
  candidates: Candidate[];
}

export interface Plan {
  rows: PlanRow[];
  /** One line per element, quantities summed across rows that share it. */
  lines: { elementId: string; quantity: number }[];
  /** Search URLs that together cover every candidate; no two rows in one URL share a design. */
  searchUrls: string[];
  /** Overrides that match no part and color in the model. */
  unusedOverrides: Override[];
}

/** The default pick: the newest element that is not a recent reissue, else the newest. */
export function defaultElement(candidates: readonly Candidate[]): string | null {
  if (candidates.length === 0) return null;
  const ids = candidates.map((c) => c.elementId).sort((a, b) => Number(b) - Number(a));
  return ids.find((id) => Number(id) < RECENT_REISSUE) ?? ids[0]!;
}

const key = (part: string, color: number) => `${part.toLowerCase()}\u0000${color}`;

/**
 * Plans a Pick a Brick list from a model tally. Rows without an override take the default pick,
 * and an override replaces it with a checked element or marks the part as not sold.
 */
export function planPickABrick(tally: readonly TallyRow[], lookup: ElementLookup, overrides: readonly Override[] = []): Plan {
  const byKey = new Map(overrides.map((o) => [key(o.part, o.color), o]));
  const used = new Set<string>();
  const rows: PlanRow[] = tally.map((t) => {
    const partNum = lookup.partFor(t.part);
    const colorId = lookup.colorFor(t.color);
    const candidates = partNum !== null && colorId !== null ? lookup.elementsFor(partNum, colorId) : [];
    const k = key(t.part, t.color);
    const o = byKey.get(k);
    if (o) used.add(k);
    const base = { part: t.part, color: t.color, colorName: t.colorName, quantity: t.count, partNum, colorId, candidates };
    if (o) return { ...base, elementId: o.elementId, source: o.elementId === null ? 'not-sold' : 'checked' };
    const pick = defaultElement(candidates);
    return { ...base, elementId: pick, source: pick === null ? 'no-element' : 'guess' };
  });

  const totals = new Map<string, number>();
  for (const r of rows) if (r.elementId !== null) totals.set(r.elementId, (totals.get(r.elementId) ?? 0) + r.quantity);
  const lines = [...totals].map(([elementId, quantity]) => ({ elementId, quantity }));

  return {
    rows,
    lines,
    searchUrls: searchUrls(rows.filter((r) => r.candidates.length > 0)),
    unusedOverrides: overrides.filter((o) => !used.has(key(o.part, o.color))),
  };
}

/**
 * Groups rows into Pick a Brick searches. A search shows one card per design, with only one of its
 * colors, so rows that share a design go into different searches.
 */
export function searchUrls(rows: readonly Pick<PlanRow, 'candidates'>[]): string[] {
  const groups: { designs: Set<string>; ids: string[] }[] = [];
  for (const r of rows) {
    const designs = new Set(r.candidates.map((c) => c.designId));
    const ids = r.candidates.map((c) => c.elementId);
    let g = groups.find((x) => [...designs].every((d) => !x.designs.has(d)) && x.ids.length + ids.length <= SEARCH_LIMIT);
    if (!g) groups.push((g = { designs: new Set(), ids: [] }));
    for (const d of designs) g.designs.add(d);
    g.ids.push(...ids);
  }
  return groups.map((g) => `${PICK_A_BRICK_URL}?query=${g.ids.join('%20')}`);
}

/** The upload file: an `elementId,quantity` header, then one line per element, CRLF line ends. */
export function toCsv(lines: readonly { elementId: string; quantity: number }[]): string {
  return ['elementId,quantity', ...lines.map((l) => `${l.elementId},${l.quantity}`)].join('\r\n') + '\r\n';
}

/** Element lookup over the parts database, with LDraw colors mapped through LDConfig.ldr. */
export function dbElementLookup(db: DatabaseSync, ldconfig: string): ElementLookup {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'elements'").get();
  if (!hasTable) throw new Error('The parts database has no element IDs. Run /brick-art:reseed to install a newer one.');
  const colors = (db.prepare('SELECT id, name, rgb, is_trans AS t FROM colors').all() as
    { id: number; name: string; rgb: string; t: number }[]).map((c) => ({ id: c.id, name: c.name, rgb: c.rgb, isTrans: c.t === 1 }));
  const colorMap = buildColorMap(ldconfig, colors).map;
  const byNum = db.prepare('SELECT part_num AS p FROM parts WHERE lower(part_num) = ?');
  const byFile = db.prepare('SELECT part_num AS p FROM parts WHERE lower(ldraw_file) = ? ORDER BY (geometry_from = part_num) DESC, part_num LIMIT 1');
  const els = db.prepare('SELECT element_id AS e, part_num AS p, design_id AS d FROM elements WHERE part_num = ? AND color_id = ?');
  const related = db.prepare(
    `SELECT parent_part_num AS p FROM part_relationships WHERE child_part_num = ? AND rel_type IN ('M', 'A')
     UNION SELECT child_part_num FROM part_relationships WHERE parent_part_num = ? AND rel_type IN ('M', 'A')
     ORDER BY 1`,
  );
  const get = (partNum: string, colorId: number): Candidate[] =>
    (els.all(partNum, colorId) as { e: string; p: string; d: string | null }[])
      .map((r) => ({ elementId: r.e, partNum: r.p, designId: r.d ?? r.p }));
  return {
    partFor(ldrawPart) {
      const stem = ldrawPart.toLowerCase();
      const hit = (byNum.get(stem) ?? byFile.get(`${stem}.dat`)) as { p: string } | undefined;
      return hit?.p ?? null;
    },
    colorFor: (code) => colorMap.get(code) ?? null,
    elementsFor(partNum, colorId) {
      const own = get(partNum, colorId);
      if (own.length > 0) return own;
      const seen = new Set<string>();
      const out: Candidate[] = [];
      for (const { p } of related.all(partNum, partNum) as { p: string }[]) {
        for (const c of get(p, colorId)) if (!seen.has(c.elementId)) { seen.add(c.elementId); out.push(c); }
      }
      return out;
    },
  };
}

export interface PickABrickOptions {
  modelPath: string;
  /** Folder for the CSV; default is the model's folder. */
  outDir?: string;
  overrides?: Override[];
  library: ZipIndex;
  db: DatabaseSync;
}

export interface PickABrickResult extends Omit<Plan, 'lines'> {
  csv: string;
  /** Lines in the CSV; Pick a Brick takes at most UPLOAD_LIMIT. */
  lineCount: number;
  totalParts: number;
  /** Parts in the CSV. */
  partsInCsv: number;
  /** Rows still on their default pick: check these on Pick a Brick. */
  unchecked: number;
}

/** Writes `<model>-pick-a-brick.csv` for an LDraw model and returns the plan behind it. */
export async function writePickABrickList(opts: PickABrickOptions): Promise<PickABrickResult> {
  const modelPath = resolve(opts.modelPath);
  if (!MODEL_EXT.has(extname(modelPath).toLowerCase())) throw new Error(`model must be an .ldr, .mpd, or .dat file: ${modelPath}`);
  if (!(await stat(modelPath).then((s) => s.isFile(), () => false))) throw new Error(`model file not found: ${modelPath}`);
  const ldconfig = opts.library.get('LDConfig.ldr');
  if (!ldconfig) throw new Error('the LDraw library has no LDConfig.ldr');
  const lookup = dbElementLookup(opts.db, new TextDecoder().decode(ldconfig));
  const tally = tallyModel(await readFile(modelPath, 'utf8'), modelFolderFiles(dirname(modelPath)), opts.library, ldrawColorNames(opts.library));
  const plan = planPickABrick(tally, lookup, opts.overrides);
  const outDir = resolve(opts.outDir ?? dirname(modelPath));
  await mkdir(outDir, { recursive: true });
  const csv = join(outDir, `${basename(modelPath, extname(modelPath))}-pick-a-brick.csv`);
  await writeFile(csv, toCsv(plan.lines));
  const { lines, ...rest } = plan;
  return {
    ...rest,
    csv,
    lineCount: lines.length,
    totalParts: plan.rows.reduce((n, r) => n + r.quantity, 0),
    partsInCsv: lines.reduce((n, l) => n + l.quantity, 0),
    unchecked: plan.rows.filter((r) => r.source === 'guess').length,
  };
}
