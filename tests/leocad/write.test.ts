import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { writeLeoCadFile } from '../../src/leocad/write.ts';
import { ZipIndex } from '../../src/render/zip-index.ts';
import type { GeometrySource } from '../../src/instructions/geometry.ts';
import { parseSteps } from '../../src/instructions/steps.ts';
import { writeLibrary } from '../helpers/ldraw-fixture.ts';

let tmp: string;
let library: ZipIndex;
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'leocad-write-'));
  library = ZipIndex.open(writeLibrary(tmp), /^ldraw\//);
});
after(() => rm(tmp, { recursive: true, force: true }));

const geometry: GeometrySource = {
  get: () => ({ bounds: { min: [-10, -20, -10], max: [10, 0, 10] }, grid: null, connections: null }),
  compatible: () => false,
};

const HOUSE = ['0 House', '0 Name: house.ldr', '1 4 0 0 0 1 0 0 0 1 0 0 0 1 wall.ldr', '1 1 0 -20 0 1 0 0 0 1 0 0 0 1 box.dat', ''].join('\n');
const WALL = ['0 Wall', '1 4 0 0 0 1 0 0 0 1 0 0 0 1 box.dat', ''].join('\n');

async function setup(name: string, house = HOUSE, houseName = 'house.ldr') {
  const dir = join(tmp, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, houseName), house);
  await writeFile(join(dir, 'wall.ldr'), WALL);
  return { dir, modelPath: join(dir, houseName) };
}

test('writes <name>.mpd next to the model', async () => {
  const { dir, modelPath } = await setup('basic');
  const before = await readFile(modelPath);
  const r = await writeLeoCadFile({ modelPath, library, geometry });
  assert.equal(basename(r.mpd), 'house.mpd');
  assert.equal(r.mpd, join(dir, 'house.mpd'));
  assert.deepEqual(r.submodels, ['wall.ldr']);
  assert.deepEqual(r.cameras, ['Front', 'Three-quarter']);
  const text = await readFile(join(dir, 'house.mpd'), 'utf8');
  assert.match(text, /^0 FILE house\.ldr/);
  assert.match(text, /0 !LEOCAD CAMERA .* NAME Front/);
  assert.deepEqual(await readFile(modelPath), before);
});

test('creates outDir', async () => {
  const { modelPath } = await setup('outdir');
  const outDir = join(tmp, 'outdir', 'new', 'deeper');
  const r = await writeLeoCadFile({ modelPath, outDir, library, geometry });
  assert.equal(r.mpd, join(outDir, 'house.mpd'));
  assert.ok((await stat(r.mpd)).isFile());
});

test('rewrites its own unedited file', async () => {
  const { modelPath } = await setup('rewrite');
  const { mpd } = await writeLeoCadFile({ modelPath, library, geometry });
  const first = await readFile(mpd);
  await writeLeoCadFile({ modelPath, library, geometry });
  assert.deepEqual(await readFile(mpd), first);
});

test('refuses to overwrite an edited file', async () => {
  const { dir, modelPath } = await setup('edited');
  await writeLeoCadFile({ modelPath, library, geometry });
  await appendFile(join(dir, 'house.mpd'), '0 // my edit\n');
  await assert.rejects(writeLeoCadFile({ modelPath, library, geometry }), /edited.*overwrite: true/);
  await writeLeoCadFile({ modelPath, library, geometry, overwrite: true });
});

test('refuses a file with no hash line', async () => {
  const { dir, modelPath } = await setup('nohash');
  await writeFile(join(dir, 'house.mpd'), '0 FILE house.ldr\n');
  await assert.rejects(writeLeoCadFile({ modelPath, library, geometry }), /edited.*overwrite: true/);
  await writeLeoCadFile({ modelPath, library, geometry, overwrite: true });
});

test('rejects a non-model path and an .mpd input', async () => {
  const { dir } = await setup('badext');
  await writeFile(join(dir, 'house.txt'), '');
  await writeFile(join(dir, 'other.mpd'), '');
  await assert.rejects(writeLeoCadFile({ modelPath: join(dir, 'house.txt'), library, geometry }), /\.ldr, \.mpd, or \.dat/);
  await assert.rejects(writeLeoCadFile({ modelPath: join(dir, 'other.mpd'), library, geometry }), /already an .mpd/);
});

test('rejects a model that places no parts', async () => {
  const { modelPath } = await setup('empty', '0 Empty\n');
  await assert.rejects(writeLeoCadFile({ modelPath, library, geometry }), /the model places no parts/);
});

test('the hash line does not leak into step text', async () => {
  const house = ['0 House', '0 Name: house.ldr', '0 // Build the wall.', '1 4 0 0 0 1 0 0 0 1 0 0 0 1 wall.ldr', '0 STEP', '1 1 0 -20 0 1 0 0 0 1 0 0 0 1 box.dat', '0 STEP', ''].join('\n');
  const { modelPath } = await setup('steptext', house);
  const { mpd } = await writeLeoCadFile({ modelPath, library, geometry });
  assert.match(await readFile(mpd, 'utf8'), /^0 !BRICKART LEOCAD_FILE [0-9a-f]{64}$/m);
  const isLibraryPart = (r: string) => library.has(`parts/${r}`);
  const model = parseSteps(mpd, { isLibraryPart });
  assert.equal(model.sections.at(-1)!.steps[0]!.text, 'Build the wall.');
});

test('finds the main section of a model with an upper-case file name', async () => {
  const { modelPath } = await setup('upper', HOUSE, 'House.ldr');
  const r = await writeLeoCadFile({ modelPath, library, geometry });
  assert.equal(basename(r.mpd), 'House.mpd');
});

test('accepts a model that references a library primitive', async () => {
  const house = ['0 House', '1 4 0 0 0 1 0 0 0 1 0 0 0 1 Stored.dat', '1 1 0 -20 0 1 0 0 0 1 0 0 0 1 box.dat', ''].join('\n');
  const { modelPath } = await setup('primitive', house);
  const r = await writeLeoCadFile({ modelPath, library, geometry });
  assert.deepEqual(r.submodels, []);
});
