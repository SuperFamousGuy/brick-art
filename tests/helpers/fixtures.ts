import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

export interface FixtureSources {
  dir: string;
  rebrickableDir: string;
}

type Row = (string | number | boolean)[];

function csvField(v: string | number | boolean): string {
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function toCsv(header: string[], rows: Row[]): string {
  return [header, ...rows].map((r) => r.map(csvField).join(',')).join('\n') + '\n';
}

const PARTS: [string, string, number][] = [
  ['3001', 'Brick 2 x 4', 11],
  ['3008', 'Brick 1 x 8', 11],
  ['3009', 'Brick 1 x 6', 11],
  ['3010', 'Brick 1 x 4', 11],
  ['3622', 'Brick 1 x 3', 11],
  ['3004', 'Brick 1 x 2', 11],
  ['3005', 'Brick 1 x 1', 11],
  ['3023', 'Plate 1 x 2', 14],
  ['3039', 'Slope 45° 2 x 2', 3],
  ['87087', 'Brick Special 1 x 1 with Stud on 1 Side', 5],
  ['60478', 'Plate Special 1 x 2 with Bar Handle on End', 14],
  ['15712', 'Tile Special 1 x 1 with Clip', 19],
  ['3937', 'Hinge Brick 1 x 2 Base', 18],
  ['3938', 'Hinge Brick 1 x 2 Top Plate', 18],
  ['33085', 'Banana', 27],
  ['3001pr0001', 'Brick 2 x 4 with Print', 11],
  ['3009b', 'Brick 1 x 6 Alternate Mold', 11],
  ['99999', 'Broken Part', 11],
  ['003383', 'Sticker Sheet for Sets 618-1, 628-2', 58],
];

const BLACK = 0;
const GREEN = 2;
const RED = 4;

function inventoryRows(): Row[] {
  const rows: Row[] = [];
  const add = (inv: number, part: string, color: number, spare = false) =>
    rows.push([inv, part, color, 1, spare, '']);
  for (const inv of [1, 2, 3, 5]) add(inv, '3001', RED);
  add(3, '3001', BLACK);
  add(4, '3001', RED, true);
  add(1, '3008', RED);
  add(1, '3009', RED);
  add(2, '3010', GREEN);
  add(2, '3004', GREEN);
  add(3, '3004', GREEN);
  add(3, '3622', GREEN);
  for (const inv of [1, 2, 3]) add(inv, '3023', BLACK);
  add(4, '33085', RED);
  const listed = new Set(['3001', '3008', '3009', '3010', '3004', '3622', '3023', '33085', '99999', '003383']);
  for (const [num] of PARTS) if (!listed.has(num)) add(2, num, BLACK);
  return rows;
}

export async function writeFixtureSources(dir: string): Promise<FixtureSources> {
  const rebrickableDir = join(dir, 'rebrickable');
  await mkdir(rebrickableDir, { recursive: true });
  const tables: Record<string, string> = {
    colors: toCsv(['id', 'name', 'rgb', 'is_trans', 'num_parts', 'num_sets', 'y1', 'y2'], [
      [-1, '[Unknown]', '0033B2', false, 0, 0, 0, 0],
      [0, 'Black', '05131D', false, 1000, 500, 1950, 2024],
      [2, 'Green', '237841', false, 800, 400, 1950, 2024],
      [4, 'Red', 'C91A09', false, 900, 450, 1950, 2024],
      [47, 'Trans-Clear', 'FCFCFC', true, 300, 200, 1950, 2024],
      [288, 'Dark Green', '184632', false, 500, 250, 1990, 2024],
      [9999, '[No Color/Any Color]', 'DA70D6', false, 0, 0, 0, 0],
    ]),
    part_categories: toCsv(['id', 'name'], [
      [11, 'Bricks'], [14, 'Plates'], [3, 'Bricks Sloped'], [19, 'Tiles Special'],
      [5, 'Bricks Special'], [18, 'Hinges Arms and Turntables'],
      [27, 'Minifig Accessories'], [58, 'Stickers'],
    ]),
    parts: toCsv(['part_num', 'name', 'part_cat_id', 'part_material'],
      PARTS.map(([num, name, cat]) => [num, name, cat, 'Plastic'])),
    part_relationships: toCsv(['rel_type', 'child_part_num', 'parent_part_num'], [
      ['P', '3001pr0001', '3001'],
      ['M', '3009b', '3009'],
    ]),
    elements: toCsv(['element_id', 'part_num', 'color_id', 'design_id'], [
      ['300102', '3001', GREEN, '3001'],
    ]),
    sets: toCsv(['set_num', 'name', 'year', 'theme_id', 'num_parts', 'img_url'], [
      ['S1-1', 'Set One', 2020, 1, 10, ''],
      ['S2-1', 'Set Two', 2022, 1, 10, ''],
      ['S3-1', 'Set Three', 2024, 1, 10, ''],
      ['S4-1', 'Set Four', 1998, 1, 10, ''],
    ]),
    inventories: toCsv(['id', 'version', 'set_num'], [
      [1, 1, 'S1-1'], [2, 1, 'S2-1'], [3, 1, 'S3-1'], [4, 1, 'S4-1'], [5, 2, 'S3-1'],
    ]),
    inventory_parts: toCsv(
      ['inventory_id', 'part_num', 'color_id', 'quantity', 'is_spare', 'img_url'],
      inventoryRows(),
    ),
  };
  for (const [name, text] of Object.entries(tables)) {
    await writeFile(join(rebrickableDir, `${name}.csv.gz`), gzipSync(text));
  }
  return { dir, rebrickableDir };
}
