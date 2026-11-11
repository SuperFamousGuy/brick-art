import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { iterateCsv } from './csv.ts';

export interface RbPart { partNum: string; name: string; categoryId: number }
export interface RbColor { id: number; name: string; rgb: string; isTrans: boolean }
export interface RbElement { partNum: string; colorId: number }
export interface RbRelationship { relType: string; child: string; parent: string }
export interface RbInventoryPart { inventoryId: number; partNum: string; colorId: number; isSpare: boolean; quantity: number }
export interface RbSet { name: string; year: number; themeId: number; numParts: number }
export interface RbTheme { name: string; parentId: number | null }
export interface RbInventoryMinifig { inventoryId: number; figNum: string; quantity: number }

export interface RebrickableData {
  parts: RbPart[];
  categories: Map<number, string>;
  colors: RbColor[];
  elements: RbElement[];
  relationships: RbRelationship[];
  /** Inventory ID to set number. */
  inventories: Map<number, string>;
  inventoryParts: RbInventoryPart[];
  /** Set number to release year. */
  setYears: Map<string, number>;
  sets: Map<string, RbSet>;
  themes: Map<number, RbTheme>;
  /** Inventory ID to inventory version. */
  inventoryVersions: Map<number, number>;
  inventoryMinifigs: RbInventoryMinifig[];
  /** Minifig number to name. */
  minifigNames: Map<string, string>;
}

/** Throws when the header row lacks one of `required`. Rebrickable headers are never quoted. */
function assertColumns(name: string, text: string, required: readonly string[]): void {
  const end = text.search(/\r?\n|$/);
  const header = new Set(text.slice(0, end).replace(/^\uFEFF/, '').split(','));
  for (const col of required) {
    if (!header.has(col)) throw new Error(`${name}.csv missing column ${col}`);
  }
}

/** Read one table and map each record as it is parsed, so raw records are never all held at once. */
async function loadTable<T>(
  dir: string, name: string, required: readonly string[], map: (r: Record<string, string>) => T,
): Promise<T[]> {
  const gz = await readFile(join(dir, `${name}.csv.gz`));
  const text = gunzipSync(gz).toString('utf8');
  assertColumns(name, text, required);
  const out: T[] = [];
  for (const rec of iterateCsv(text)) out.push(map(rec));
  return out;
}

const isTrue = (v: string) => v === 'True';

/** Load the Rebrickable CSV downloads from `dir`. Extra columns are ignored. */
export async function loadRebrickable(dir: string): Promise<RebrickableData> {
  // Sequential on purpose: each table's decompressed text is large and must be freed before the next.
  const parts = await loadTable<RbPart>(dir, 'parts', ['part_num', 'name', 'part_cat_id'], (r) => ({
    partNum: r.part_num,
    name: r.name,
    categoryId: Number(r.part_cat_id),
  }));
  const categories = new Map(
    await loadTable<[number, string]>(dir, 'part_categories', ['id', 'name'], (r) => [Number(r.id), r.name]),
  );
  const colors = await loadTable<RbColor>(dir, 'colors', ['id', 'name', 'rgb', 'is_trans'], (r) => ({
    id: Number(r.id),
    name: r.name,
    rgb: r.rgb,
    isTrans: isTrue(r.is_trans),
  }));
  const elements = await loadTable<RbElement>(dir, 'elements', ['part_num', 'color_id'], (r) => ({
    partNum: r.part_num,
    colorId: Number(r.color_id),
  }));
  const relationships = await loadTable<RbRelationship>(
    dir, 'part_relationships', ['rel_type', 'child_part_num', 'parent_part_num'], (r) => ({
      relType: r.rel_type,
      child: r.child_part_num,
      parent: r.parent_part_num,
    }),
  );
  const inventoryRows = await loadTable<[number, string, number]>(
    dir, 'inventories', ['id', 'set_num', 'version'], (r) => [Number(r.id), r.set_num, Number(r.version)],
  );
  const inventories = new Map(inventoryRows.map(([id, setNum]): [number, string] => [id, setNum]));
  const inventoryVersions = new Map(inventoryRows.map(([id, , version]): [number, number] => [id, version]));
  // Part numbers repeat across 1.5M rows; share one string per distinct value.
  const interned = new Map<string, string>();
  const intern = (s: string) => {
    const hit = interned.get(s);
    if (hit !== undefined) return hit;
    interned.set(s, s);
    return s;
  };
  const inventoryParts = await loadTable<RbInventoryPart>(
    dir, 'inventory_parts', ['inventory_id', 'part_num', 'color_id', 'is_spare', 'quantity'], (r) => ({
      inventoryId: Number(r.inventory_id),
      partNum: intern(r.part_num),
      colorId: Number(r.color_id),
      isSpare: isTrue(r.is_spare),
      quantity: Number(r.quantity),
    }),
  );
  const setRows = await loadTable<[string, RbSet]>(
    dir, 'sets', ['set_num', 'name', 'year', 'theme_id', 'num_parts'], (r) => [r.set_num, {
      name: r.name,
      year: Number(r.year),
      themeId: Number(r.theme_id),
      numParts: Number(r.num_parts),
    }],
  );
  const sets = new Map(setRows);
  const setYears = new Map(setRows.map(([num, set]): [string, number] => [num, set.year]));
  const themes = new Map(
    await loadTable<[number, RbTheme]>(dir, 'themes', ['id', 'name', 'parent_id'], (r) => [
      Number(r.id), { name: r.name, parentId: r.parent_id === '' ? null : Number(r.parent_id) },
    ]),
  );
  const inventoryMinifigs = await loadTable<RbInventoryMinifig>(
    dir, 'inventory_minifigs', ['inventory_id', 'fig_num', 'quantity'], (r) => ({
      inventoryId: Number(r.inventory_id),
      figNum: r.fig_num,
      quantity: Number(r.quantity),
    }),
  );
  const minifigNames = new Map(
    await loadTable<[string, string]>(dir, 'minifigs', ['fig_num', 'name'], (r) => [r.fig_num, r.name]),
  );

  return {
    parts, categories, colors, elements, relationships, inventories, inventoryParts, setYears,
    sets, themes, inventoryVersions, inventoryMinifigs, minifigNames,
  };
}
