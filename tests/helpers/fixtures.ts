import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { zipSync } from 'fflate';
import type { FetchedSources } from '../../src/sources/fetch.ts';

export interface FixtureSources {
  dir: string;
  rebrickableDir: string;
  ldrawRoot: string;
  shadowRoot: string;
  ldrawZip: string;
  ldcadZip: string;
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
  ['3039', 'Brick Sloped 45° 2 x 2', 3],
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
  ['3437', 'Duplo Brick 2 x 2', 4],
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
  add(6, '33085', RED); // minifig inventory: not a set
  const listed = new Set(['3001', '3008', '3009', '3010', '3004', '3622', '3023', '33085', '99999', '003383']);
  for (const [num] of PARTS) if (!listed.has(num)) add(2, num, BLACK);
  return rows;
}

// ---- LDraw and LDCad shadow fixtures -------------------------------------

type Pt = [number, number, number];
const LICENSE = '0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt';

function quad(a: Pt, b: Pt, c: Pt, d: Pt): string {
  return `4 16 ${[...a, ...b, ...c, ...d].join(' ')}`;
}

/** Six type-4 quads forming an axis-aligned box. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): string[] {
  return [
    quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]), // y0 face
    quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]), // y1 face
    quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]), // z0 face
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]), // z1 face
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]), // x0 face
    quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]), // x1 face
  ];
}

/** Outer box plus an inner box inset 4 LDU on the sides and from the top (y0). */
function hollow(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): string[] {
  return [...box(x0, y0, z0, x1, y1, z1), ...box(x0 + 4, y0 + 4, z0 + 4, x1 - 4, y1, z1 - 4)];
}

function studRef(x: number, z: number, file = 'stud.dat'): string {
  return `1 16 ${x} 0 ${z} 1 0 0 0 1 0 0 0 1 ${file}`;
}

function ldFile(
  desc: string, name: string, org: string, body: string[], update = '2026-10',
): string {
  return [
    `0 ${desc}`, `0 Name: ${name}`, '0 Author: fixture',
    `0 !LDRAW_ORG ${org} UPDATE ${update}`, LICENSE, '', ...body, '',
  ].join('\n');
}

function brick1xN(n: number, stud = 'stud.dat'): string[] {
  const w = 10 * n;
  const studs = Array.from({ length: n }, (_, i) => studRef(-w + 10 + 20 * i, 0, stud));
  return [...hollow(-w, 0, -10, w, 24, 10), ...studs];
}

function ldrawFixtures(): Map<string, string> {
  const f = new Map<string, string>();
  const part = (num: string, desc: string, body: string[], update?: string) =>
    f.set(`parts/${num}.dat`, ldFile(desc, `${num}.dat`, 'Part', body, update));
  f.set('p/stud.dat', ldFile('Stud', 'stud.dat', 'Primitive', box(-6, -4, -6, 6, 0, 6)));
  f.set('p/stud2.dat', ldFile('Stud Variant', 'stud2.dat', 'Primitive', box(-6, -4, -6, 6, 0, 6)));
  f.set('parts/s/3001s01.dat',
    ldFile('Brick  2 x  4 Body', 's\\3001s01.dat', 'Subpart', hollow(-40, 0, -20, 40, 24, 20)));
  const studs: string[] = [];
  for (const x of [-30, -10, 10, 30]) for (const z of [-10, 10]) studs.push(studRef(x, z));
  part('3001', 'Brick  2 x  4',
    ['1 16 0 0 0 1 0 0 0 1 0 0 0 1 S\\3001S01.DAT', ...studs]);
  part('3008', 'Brick  1 x  8', brick1xN(8));
  part('3009', 'Brick  1 x  6', brick1xN(6));
  part('3010', 'Brick  1 x  4', brick1xN(4));
  part('3622', 'Brick  1 x  3', brick1xN(3));
  part('3004', 'Brick  1 x  2', brick1xN(2));
  part('3005', 'Brick  1 x  1', brick1xN(1, 'stud2.dat'), '2025-03');
  part('3023', 'Plate  1 x  2', [...box(-20, 0, -10, 20, 8, 10), studRef(-10, 0), studRef(10, 0)]);
  part('33085', 'Banana', box(-10, 0, -30, 10, 8, 30));
  const wedge = [
    `3 16 -20 8 0 -20 24 -20 -20 24 0`, // x = -20 end
    `3 16 20 8 0 20 24 0 20 24 -20`, // x = +20 end
    quad([-20, 8, 0], [-20, 24, -20], [20, 24, -20], [20, 8, 0]), // slope
    quad([-20, 24, -20], [-20, 24, 0], [20, 24, 0], [20, 24, -20]), // bottom
    quad([-20, 8, 0], [20, 8, 0], [20, 24, 0], [-20, 24, 0]), // back
  ];
  part('3039', 'Slope Brick 45  2 x  2',
    [...hollow(-20, 0, 0, 20, 24, 20), ...wedge, studRef(-10, 10), studRef(10, 10)]);
  part('87087', 'Brick  1 x  1 with Stud on 1 Side', [
    ...hollow(-10, 0, -10, 10, 24, 10), studRef(0, 0),
    '1 16 0 12 -10 1 0 0 0 0 -1 0 1 0 stud.dat',
  ]);
  for (const num of ['60478', '15712', '3937', '3938']) {
    part(num, `Fixture Part ${num}`, box(-10, 0, -10, 10, 8, 10));
  }
  part('3437', 'Duplo Brick  2 x  2',
    [...hollow(-20, 0, -20, 20, 24, 20), ...[-10, 10].flatMap((x) => [studRef(x, -10), studRef(x, 10)])]);
  part('99999', 'Broken Part', ['1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\missing.dat']);
  // Placement kinds: a primitive, a flexible segment, and a `~Moved to` alias with no Rebrickable row.
  f.set('p/4-4cyli.dat', ldFile('Cylinder 1.0', '4-4cyli.dat', 'Primitive', box(-10, 0, -10, 10, 1, 10)));
  part('77', '~Technic Flex-System Hose Segment', box(-2, 0, -2, 2, 2, 2));
  f.set('parts/166.dat', ldFile('~Moved to 3001', '166.dat', 'Part Alias', ['1 16 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat']));
  // A variant file with no Rebrickable part of its own: it maps to Rebrickable 3023 by suffix.
  part('3023b', 'Plate  1 x  2 without Bottom Tube', box(-20, 0, -10, 20, 8, 10));
  // Variant-named alias and sub-part: neither is suffix-matched to 3001.
  f.set('parts/3001x.dat', ldFile('~Moved to 166', '3001x.dat', 'Part Alias', ['1 16 0 0 0 1 0 0 0 1 0 0 0 1 166.dat']));
  part('3001y', '~Brick  2 x  4 Shell', box(-20, 0, -10, 20, 24, 10));
  const colour = (name: string, code: number, rgb: string) =>
    `0 !COLOUR ${name.padEnd(40)} CODE ${String(code).padStart(3)}   VALUE #${rgb}   EDGE #333333`;
  f.set('LDConfig.ldr', [
    '0 LDraw.org Configuration File', '',
    colour('Black', 0, '1B2A34'), colour('Red', 4, 'C91A09'), colour('Green', 2, '237841'),
    colour('Dark_Bluish_Grey', 72, '6C6E68'), colour('Trans_Clear', 47, 'FCFCFC'), '',
  ].join('\n'));
  return f;
}

function shadowFixtures(): Map<string, string> {
  const fgr = (g: 'F' | 'M') =>
    `0 !LDCAD SNAP_FGR [group=hgBrC] [genderOfs=${g}] [seq=18 4 18] [radius=4] [pos=0 10 0] [ori=0 -1 0 1 0 0 0 0 1]`;
  return new Map([
    ['p/stud.dat', '0 !LDCAD SNAP_CYL [ID=studC] [gender=M] [caps=one] [secs=R 6 4]\n'],
    ['parts/s/3001s01.dat',
      '0 !LDCAD SNAP_CYL [gender=F] [caps=one] [secs=R 6 20] [pos=0 24 0] [grid=C 4 C 2 20 20]\n'],
    ['parts/3937.dat',
      `0 !LDCAD SNAP_CYL [gender=F] [caps=one] [secs=S 6 4] [pos=0 24 0] [grid=C 2 1 20 0]\n${fgr('F')}\n`],
    ['parts/3938.dat', `${fgr('M')}\n`],
    ['parts/15712.dat', '0 !LDCAD SNAP_CLP [radius=4] [length=8] [pos=0 -6 0]\n'],
    ['parts/60478.dat',
      '0 !LDCAD SNAP_CYL [gender=M] [caps=none] [secs=R 4 16] [pos=0 4 -30] [ori=1 0 0 0 0 1 0 -1 0]\n'],
    ['parts/33085.dat', '0 !LDCAD SNAP_CYL [gender=M] [caps=none] [secs=R 4 8] [pos=0 4 30]\n'],
  ]);
}

async function writeTree(root: string, files: Map<string, string>): Promise<void> {
  for (const [rel, text] of files) {
    const path = join(root, ...rel.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
}

function zipTree(prefix: string, files: Map<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [rel, text] of files) entries[`${prefix}/${rel}`] = new TextEncoder().encode(text);
  return zipSync(entries);
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
      [27, 'Minifig Accessories'], [58, 'Stickers'], [4, 'Duplo, Quatro and Primo'],
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
      [6, 1, 'fig-000001'],
    ]),
    themes: toCsv(['id', 'name', 'parent_id'], [[1, 'Harbor', 2], [2, 'Town', '']]),
    inventory_minifigs: toCsv(['inventory_id', 'fig_num', 'quantity'], [[1, 'fig-000001', 2]]),
    minifigs: toCsv(['fig_num', 'name', 'num_parts', 'img_url'], [['fig-000001', 'Fixture Fig', 1, '']]),
    inventory_parts: toCsv(
      ['inventory_id', 'part_num', 'color_id', 'quantity', 'is_spare', 'img_url'],
      inventoryRows(),
    ),
  };
  for (const [name, text] of Object.entries(tables)) {
    await writeFile(join(rebrickableDir, `${name}.csv.gz`), gzipSync(text));
  }

  const ldraw = ldrawFixtures();
  const shadow = shadowFixtures();
  const ldrawRoot = join(dir, 'ldraw');
  const shadowRoot = join(dir, 'ldcad');
  await writeTree(ldrawRoot, ldraw);
  await writeTree(shadowRoot, shadow);
  const ldrawZip = join(dir, 'complete.zip');
  const ldcadZip = join(dir, 'ldcad.zip');
  await writeFile(ldrawZip, zipTree('ldraw', ldraw));
  await writeFile(ldcadZip, zipTree('LDCadShadowLibrary-abc123', shadow));
  return { dir, rebrickableDir, ldrawRoot, shadowRoot, ldrawZip, ldcadZip };
}

const SOURCE_NAMES = [
  'parts', 'part_categories', 'part_relationships', 'colors', 'elements',
  'inventory_parts', 'inventories', 'sets', 'themes', 'inventory_minifigs', 'minifigs',
  'ldraw', 'ldcad',
];

/** Prebuilt `FetchedSources` pointing at the fixture trees, with synthetic source records. */
export function fixtureFetched(fx: FixtureSources): FetchedSources {
  return {
    rebrickableDir: fx.rebrickableDir,
    ldrawRoot: fx.ldrawRoot,
    shadowRoot: fx.shadowRoot,
    ldcadCommit: 'abc123',
    records: SOURCE_NAMES.map((name, i) => ({
      name,
      url: `https://example.test/${name}`,
      downloadedAt: '2026-11-09T00:00:00.000Z',
      bytes: 100 + i,
      sha256: String(i).padStart(64, '0'),
      lastModified: null,
    })),
  };
}
