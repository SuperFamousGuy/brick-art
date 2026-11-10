import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCurated, validateUses, curatedDir } from '../../src/curated/load.ts';

const FAMILIES = 'families:\n  green: [2]\n  red: [4]\n';
const USES = `- part: "33085"
  represents: flower petal
  note: ring around a plate
  reviewed: false
- part: "3001"
  represents: wall
  reviewed: true
`;

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'curated-'));
  await writeFile(join(dir, 'color-families.yaml'), FAMILIES);
  await writeFile(join(dir, 'creative-uses.yaml'), USES);
});
after(() => rm(dir, { recursive: true, force: true }));

async function makeDir(families: string, uses: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'curated-x-'));
  await writeFile(join(d, 'color-families.yaml'), families);
  await writeFile(join(d, 'creative-uses.yaml'), uses);
  return d;
}

test('loads families, uses, and a 64-hex hash', async () => {
  const c = await loadCurated(dir);
  assert.equal(c.families.get(2), 'green');
  assert.equal(c.families.get(4), 'red');
  assert.equal(c.uses.length, 2);
  assert.deepEqual(c.uses[1], { part: '3001', represents: 'wall', note: null, reviewed: true });
  assert.equal(c.uses[0]!.note, 'ring around a plate');
  assert.match(c.hash, /^[0-9a-f]{64}$/);
});

test('changing one byte changes the hash', async () => {
  const a = await loadCurated(dir);
  const d = await makeDir(FAMILIES.replace('[4]', '[5]'), USES);
  try {
    assert.notEqual((await loadCurated(d)).hash, a.hash);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test('rejects a color id listed under two families', async () => {
  const d = await makeDir('families:\n  green: [2]\n  red: [2]\n', USES);
  try {
    await assert.rejects(loadCurated(d), /2/);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test('throws on a missing file or a wrong top-level shape', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'curated-e-'));
  const bad = await makeDir('- not a map\n', USES);
  const bad2 = await makeDir(FAMILIES, 'uses: nope\n');
  try {
    await assert.rejects(loadCurated(empty));
    await assert.rejects(loadCurated(bad));
    await assert.rejects(loadCurated(bad2));
  } finally {
    await Promise.all([empty, bad, bad2].map((x) => rm(x, { recursive: true, force: true })));
  }
});

test('validateUses rejects unknown parts with a reason', () => {
  const r = validateUses(
    [
      { part: 'nope', represents: 'x', note: null, reviewed: false },
      { part: '3001', represents: 'wall', note: null, reviewed: false },
    ],
    new Set(['3001']),
  );
  assert.equal(r.accepted.length, 1);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0]!.reason, /unknown part/);
});

test('an entry missing represents is rejected without throwing', async () => {
  const d = await makeDir(FAMILIES, '- part: "3001"\n  reviewed: false\n');
  try {
    const c = await loadCurated(d);
    const r = validateUses(c.uses, new Set(['3001']));
    assert.equal(r.accepted.length, 0);
    assert.match(r.rejected[0]!.reason, /represents/);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test('a missing or non-boolean reviewed is a validation rejection', async () => {
  const d = await makeDir(
    FAMILIES,
    '- part: "3001"\n  represents: a\n  reviewed: "yes"\n- part: "3001"\n  represents: b\n',
  );
  try {
    const c = await loadCurated(d);
    const r = validateUses(c.uses, new Set(['3001']));
    assert.equal(r.accepted.length, 0);
    assert.equal(r.rejected.length, 2);
    assert.match(r.rejected[0]!.reason, /reviewed/);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test('curatedDir joins the repo root with curated', () => {
  assert.equal(curatedDir(join('a', 'b')), join('a', 'b', 'curated'));
});

test('the shipped curated files load and validate', async () => {
  const c = await loadCurated(curatedDir(process.cwd()));
  assert.ok(c.uses.length > 0);
  const pairs = c.uses.map((u) => `${u.part}|${u.represents}`);
  assert.equal(new Set(pairs).size, pairs.length, 'no duplicate part/represents pairs');
  assert.ok(c.uses.every((u) => u.represents === u.represents.toLowerCase()));
  assert.ok(c.uses.every((u) => (u.note ?? '').trim() !== ''), 'every entry has a note');
  assert.ok(c.uses.every((u) => u.reviewed === false));
  assert.ok(c.uses.some((u) => u.part === '33085' && u.represents === 'flower petal'));
  assert.equal(c.families.get(0), 'black');
  assert.equal(c.families.get(47), 'transparent');
  assert.equal(c.families.get(9999), 'other');
  const r = validateUses(c.uses, new Set(c.uses.map((u) => u.part)));
  assert.equal(r.rejected.length, 0);
});
