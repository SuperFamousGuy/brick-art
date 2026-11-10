import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseCsv } from './csv.ts';

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

async function readTable(dir: string, name: string): Promise<Record<string, string>[]> {
  const gz = await readFile(join(dir, `${name}.csv.gz`));
  return parseCsv(gunzipSync(gz).toString('utf8'));
}

const isTrue = (v: string) => v === 'True';

/** Load the Rebrickable CSV downloads from `dir`. Extra columns are ignored. */
export async function loadRebrickable(dir: string): Promise<RebrickableData> {
  const [parts, categories, colors, elements, relationships, inventories, inventoryParts, sets] =
    await Promise.all([
      readTable(dir, 'parts'),
      readTable(dir, 'part_categories'),
      readTable(dir, 'colors'),
      readTable(dir, 'elements'),
      readTable(dir, 'part_relationships'),
      readTable(dir, 'inventories'),
      readTable(dir, 'inventory_parts'),
      readTable(dir, 'sets'),
    ]);

  return {
    parts: parts.map((r) => ({
      partNum: r.part_num,
      name: r.name,
      categoryId: Number(r.part_cat_id),
    })),
    categories: new Map(categories.map((r) => [Number(r.id), r.name])),
    colors: colors.map((r) => ({
      id: Number(r.id),
      name: r.name,
      rgb: r.rgb,
      isTrans: isTrue(r.is_trans),
    })),
    elements: elements.map((r) => ({ partNum: r.part_num, colorId: Number(r.color_id) })),
    relationships: relationships.map((r) => ({
      relType: r.rel_type,
      child: r.child_part_num,
      parent: r.parent_part_num,
    })),
    inventories: new Map(inventories.map((r) => [Number(r.id), r.set_num])),
    inventoryParts: inventoryParts.map((r) => ({
      inventoryId: Number(r.inventory_id),
      partNum: r.part_num,
      colorId: Number(r.color_id),
      isSpare: isTrue(r.is_spare),
    })),
    setYears: new Map(sets.map((r) => [r.set_num, Number(r.year)])),
  };
}
