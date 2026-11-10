import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, isLockHeld, readState, releaseLock, writeState } from '../../src/seed/lock.ts';

async function tmp(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'brick-art-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('acquireLock twice in one process: second returns false', async (t) => {
  const lock = join(await tmp(t), 'seed.lock');
  assert.equal(acquireLock(lock), true);
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
  assert.match(await readFile(lock, 'utf8'), new RegExp(`^${process.pid} \\d{4}-\\d{2}-\\d{2}T`));
});

test('an unparsable lock with an old mtime is stale', async (t) => {
  const lock = join(await tmp(t), 'seed.lock');
  await writeFile(lock, 'nope');
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  assert.equal(acquireLock(lock), true);
});

test('an empty lock with a fresh mtime is live', async (t) => {
  const lock = join(await tmp(t), 'seed.lock');
  await writeFile(lock, '');
  assert.equal(acquireLock(lock), false);
  assert.equal(existsSync(lock), true);
});

test('releaseLock does not remove another pid\'s lock', async (t) => {
  const lock = join(await tmp(t), 'seed.lock');
  await writeFile(lock, '999999');
  releaseLock(lock);
  assert.equal(await readFile(lock, 'utf8'), '999999');
});

test('acquireLock leaves no temp or stale files behind', async (t) => {
  const dir = await tmp(t);
  const lock = join(dir, 'seed.lock');
  await writeFile(lock, '999999');
  assert.equal(acquireLock(lock), true);
  assert.deepEqual(await readdir(dir), ['seed.lock']);
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

test('the lock stores pid and start time; a fresh lock of a live pid is held', async (t) => {
  const lock = join(await tmp(t), 'seed.lock');
  assert.equal(acquireLock(lock), true);
  const [pid, started] = (await readFile(lock, 'utf8')).split(' ');
  assert.equal(pid, String(process.pid));
  assert.ok(Math.abs(Date.parse(started!) - Date.now()) < 60_000);
  assert.equal(isLockHeld(lock), true);
  releaseLock(lock);
  assert.equal(existsSync(lock), false);
});

test('a lock older than 2 hours is stale even when its pid is alive', async (t) => {
  const lock = join(await tmp(t), 'seed.lock');
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000 - 1000).toISOString();
  await writeFile(lock, `${process.pid} ${old}`);
  assert.equal(isLockHeld(lock), false);
  assert.equal(acquireLock(lock), true);
  releaseLock(lock);
});

test('legacy pid-only content still parses', async (t) => {
  const lock = join(await tmp(t), 'seed.lock');
  await writeFile(lock, String(process.pid));
  assert.equal(isLockHeld(lock), true);
  await writeFile(lock, '999999');
  assert.equal(isLockHeld(lock), false);
});
