import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveDataDir, dataPaths } from '../src/paths.ts';

test('resolveDataDir prefers CLAUDE_PLUGIN_DATA', () => {
  const env = { CLAUDE_PLUGIN_DATA: '/plugin', BRICK_ART_DATA: '/custom' };
  assert.equal(resolveDataDir(env, '/repo'), '/plugin');
});

test('resolveDataDir falls back to BRICK_ART_DATA', () => {
  assert.equal(resolveDataDir({ BRICK_ART_DATA: '/custom' }, '/repo'), '/custom');
});

test('resolveDataDir defaults to <repoRoot>/.data', () => {
  assert.equal(resolveDataDir({}, '/repo'), path.join('/repo', '.data'));
});

test('dataPaths builds file locations', () => {
  const p = dataPaths('/d');
  assert.equal(p.dbFile('20261109T120000'), path.join('/d', 'parts-20261109T120000.db'));
  assert.equal(p.pointer, path.join('/d', 'current.json'));
  assert.equal(p.lock, path.join('/d', 'seed.lock'));
  assert.equal(p.state, path.join('/d', 'seed-state.json'));
  assert.equal(p.log, path.join('/d', 'seed.log'));
  assert.equal(p.cacheDir, path.join('/d', 'cache'));
});
