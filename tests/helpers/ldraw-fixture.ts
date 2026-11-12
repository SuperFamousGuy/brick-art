import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';

/** A cube of side `s` LDU, from y = 0 up to y = -s: outward-facing CCW triangles plus its 12 edges as type-2 lines. */
function cube(name: string, s: number): string {
  const h = s / 2;
  const [a, b, t] = [-h, h, -s];
  return [
    `0 Test ${name}`, `0 Name: ${name}`, '0 BFC CERTIFY CCW',
    `3 16 ${a} 0 ${a} ${b} 0 ${b} ${b} 0 ${a}`, `3 16 ${a} 0 ${a} ${a} 0 ${b} ${b} 0 ${b}`,
    `3 16 ${a} ${t} ${a} ${b} ${t} ${b} ${a} ${t} ${b}`, `3 16 ${a} ${t} ${a} ${b} ${t} ${a} ${b} ${t} ${b}`,
    `3 16 ${a} 0 ${a} ${b} ${t} ${a} ${a} ${t} ${a}`, `3 16 ${a} 0 ${a} ${b} 0 ${a} ${b} ${t} ${a}`,
    `3 16 ${a} 0 ${b} ${b} ${t} ${b} ${b} 0 ${b}`, `3 16 ${a} 0 ${b} ${a} ${t} ${b} ${b} ${t} ${b}`,
    `3 16 ${a} 0 ${a} ${a} ${t} ${b} ${a} 0 ${b}`, `3 16 ${a} 0 ${a} ${a} ${t} ${a} ${a} ${t} ${b}`,
    `3 16 ${b} 0 ${a} ${b} ${t} ${b} ${b} ${t} ${a}`, `3 16 ${b} 0 ${a} ${b} 0 ${b} ${b} ${t} ${b}`,
    ...[0, t].flatMap((y) => [
      `2 24 ${a} ${y} ${a} ${b} ${y} ${a}`, `2 24 ${b} ${y} ${a} ${b} ${y} ${b}`,
      `2 24 ${b} ${y} ${b} ${a} ${y} ${b}`, `2 24 ${a} ${y} ${b} ${a} ${y} ${a}`,
    ]),
    ...[[a, a], [b, a], [b, b], [a, b]].map(([x, z]) => `2 24 ${x} 0 ${z} ${x} ${t} ${z}`),
  ].join('\n');
}

/** A 20 x 20 x 20 LDU box part. */
export const BOX = cube('box.dat', 20);
/** A 60 x 60 x 60 LDU box part, big enough to hide a box inside it. */
export const BIG = cube('big.dat', 60);
export const LDCONFIG = [
  '0 LDraw.org Configuration File',
  '0 !COLOUR Blue CODE 1 VALUE #0055BF EDGE #333333',
  '0 !COLOUR Red CODE 4 VALUE #C91A09 EDGE #333333',
  '0 !COLOUR Yellow CODE 14 VALUE #F2CD37 EDGE #333333',
  '',
].join('\n');

/** Writes a tiny LDraw library zip (colors, box.dat, big.dat, one stored primitive) into `dir`. */
export function writeLibrary(dir: string): string {
  const file = join(dir, 'library.zip');
  writeFileSync(file, zipSync({
    'ldraw/LDConfig.ldr': strToU8(LDCONFIG),
    'ldraw/parts/box.dat': [strToU8(BOX), { level: 0 }],
    'ldraw/parts/big.dat': strToU8(BIG),
    'ldraw/p/Stored.dat': strToU8('0 stored primitive'),
  }));
  return file;
}
