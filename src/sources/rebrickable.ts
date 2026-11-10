import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { iterateCsv } from './csv.ts';

export interface RbPart { partNum: string; name: string; categoryId: number }
export interface RbColor { id: number; name: string; rgb: string; isTrans: boolean }
export interface RbElement { partNum: string; colorId: number }
export interface RbRelationship { relType: string; child: string; parent: string }
export interface RbInventoryPart { inventoryId: number; partNum: string; colorId: number; isSpare: boolean }

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
}

/** Read one table and map each record as it is parsed, so raw records are never all held at once. */
async function loadTable<T>(dir: string, name: string, map: (r: Record<string, string>) => T): Promise<T[]> {
  const gz = await readFile(join(dir, `${name}.csv.gz`));
  const out: T[] = [];
  for (const rec of iterateCsv(gunzipSync(gz).toString('utf8'))) out.push(map(rec));
  return out;
}

const isTrue = (v: string) => v === 'True';

/** Load the Rebrickable CSV downloads from `dir`. Extra columns are ignored. */
export async function loadRebrickable(dir: string): Promise<RebrickableData> {
  // Sequential on purpose: each table's decompressed text is large and must be freed before the next.
  const parts = await loadTable<RbPart>(dir, 'parts', (r) => ({
    partNum: r.part_num,
    name: r.name,
    categoryId: Number(r.part_cat_id),
  }));
  const categories = new Map(
    await loadTable<[number, string]>(dir, 'part_categories', (r) => [Number(r.id), r.name]),
  );
  const colors = await loadTable<RbColor>(dir, 'colors', (r) => ({
    id: Number(r.id),
    name: r.name,
    rgb: r.rgb,
    isTrans: isTrue(r.is_trans),
  }));
  const elements = await loadTable<RbElement>(dir, 'elements', (r) => ({
    partNum: r.part_num,
    colorId: Number(r.color_id),
  }));
  const relationships = await loadTable<RbRelationship>(dir, 'part_relationships', (r) => ({
    relType: r.rel_type,
    child: r.child_part_num,
    parent: r.parent_part_num,
  }));
  const inventories = new Map(
    await loadTable<[number, string]>(dir, 'inventories', (r) => [Number(r.id), r.set_num]),
  );
  // Part numbers repeat across 1.5M rows; share one string per distinct value.
  const interned = new Map<string, string>();
  const intern = (s: string) => {
    const hit = interned.get(s);
    if (hit !== undefined) return hit;
    interned.set(s, s);
    return s;
  };
  const inventoryParts = await loadTable<RbInventoryPart>(dir, 'inventory_parts', (r) => ({
    inventoryId: Number(r.inventory_id),
    partNum: intern(r.part_num),
    colorId: Number(r.color_id),
    isSpare: isTrue(r.is_spare),
  }));
  const setYears = new Map(
    await loadTable<[string, number]>(dir, 'sets', (r) => [r.set_num, Number(r.year)]),
  );

  return { parts, categories, colors, elements, relationships, inventories, inventoryParts, setYears };
}
