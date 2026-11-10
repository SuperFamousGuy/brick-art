import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRebrickable } from '../../src/sources/rebrickable.ts';
import { writeFixtureSources } from '../helpers/fixtures.ts';

test('loadRebrickable loads typed data from the fixtures', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'brick-art-rb-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { rebrickableDir } = await writeFixtureSources(dir);
  const data = await loadRebrickable(rebrickableDir);

  assert.equal(data.parts.length, 20);
  assert.equal(
    data.parts.find((p) => p.partNum === '003383')?.name,
    'Sticker Sheet for Sets 618-1, 628-2',
  );
  assert.equal(data.parts.find((p) => p.partNum === '3001')?.categoryId, 11);
  assert.equal(data.colors.find((c) => c.id === 47)?.isTrans, true);
  assert.equal(data.colors.find((c) => c.id === 4)?.rgb, 'C91A09');
  assert.equal(data.categories.get(58), 'Stickers');
  assert.equal(data.setYears.get('S4-1'), 1998);
  assert.equal(data.inventories.get(5), 'S3-1');
  assert.equal(data.inventoryParts.filter((r) => r.isSpare).length, 1);
  assert.deepEqual(data.elements, [{ partNum: '3001', colorId: 2 }]);
  assert.deepEqual(data.relationships, [
    { relType: 'P', child: '3001pr0001', parent: '3001' },
    { relType: 'M', child: '3009b', parent: '3009' },
  ]);
});

test('loadRebrickable rejects a table missing a required column', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'brick-art-rb-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { rebrickableDir } = await writeFixtureSources(dir);
  await writeFile(join(rebrickableDir, 'colors.csv.gz'), gzipSync('id,name,is_trans\n0,Black,False\n'));
  await assert.rejects(loadRebrickable(rebrickableDir), { message: 'colors.csv missing column rgb' });
  await writeFile(join(rebrickableDir, 'colors.csv.gz'), gzipSync('id,name,rgb,is_trans\n'));
  await writeFile(join(rebrickableDir, 'sets.csv.gz'), gzipSync('set_num,name\n'));
  await assert.rejects(loadRebrickable(rebrickableDir), { message: 'sets.csv missing column year' });
});
