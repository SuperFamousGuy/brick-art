import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, readState, releaseLock, writeState } from '../../src/seed/lock.ts';

async function tmp(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'brick-art-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('acquireLock twice in one process: second returns false', async (t) => {
  const lock = join(await tmp(t), 'seed.lock');
  assert.equal(acquireLock(lock), true);
  assert.equal(await readFile(lock, 'utf8'), String(process.pid));
  assert.equal(acquireLock(lock), false);
  releaseLock(lock);
  assert.equal(existsSync(lock), false);
  assert.equal(acquireLock(lock), true);
  releaseLock(lock);
});

test('a lock held by a dead pid is replaced', async (t) => {
  const lock = join(await tmp(t), 'seed.lock');
  await writeFile(lock, '999999');
  assert.equal(acquireLock(lock), true);
  assert.equal(await readFile(lock, 'utf8'), String(process.pid));
});

test('a lock with garbage content is treated as stale', async (t) => {
  const lock = join(await tmp(t), 'seed.lock');
  await writeFile(lock, 'nope');
  assert.equal(acquireLock(lock), true);
});

test('releaseLock tolerates a missing file', async (t) => {
  releaseLock(join(await tmp(t), 'seed.lock'));
});

test('readState defaults to idle, and writeState round-trips', async (t) => {
  const p = join(await tmp(t), 'seed-state.json');
  assert.deepEqual(readState(p), {
    status: 'idle', startedAt: null, finishedAt: null, lastError: null, failures: 0,
  });
  const s = { status: 'failed' as const, startedAt: 'a', finishedAt: 'b', lastError: 'boom', failures: 2 };
  writeState(p, s);
  assert.deepEqual(readState(p), s);
  await writeFile(p, '{not json');
  assert.equal(readState(p).status, 'idle');
});
