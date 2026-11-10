import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveDataDir, dataPaths } from '../src/paths.ts';

test('resolveDataDir prefers BRICK_ART_DATA', () => {
  const env = { CLAUDE_PLUGIN_DATA: '/plugin', BRICK_ART_DATA: '/custom' };
  assert.equal(resolveDataDir(env, '/repo'), '/custom');
});

test('resolveDataDir falls back to CLAUDE_PLUGIN_DATA', () => {
  assert.equal(resolveDataDir({ CLAUDE_PLUGIN_DATA: '/plugin' }, '/repo'), '/plugin');
  assert.equal(resolveDataDir({ BRICK_ART_DATA: '', CLAUDE_PLUGIN_DATA: '/plugin' }, '/repo'), '/plugin');
});

test('resolveDataDir defaults to <repoRoot>/.data, treating empty variables as unset', () => {
  assert.equal(resolveDataDir({}, '/repo'), path.join('/repo', '.data'));
  assert.equal(resolveDataDir({ BRICK_ART_DATA: '', CLAUDE_PLUGIN_DATA: '' }, '/repo'), path.join('/repo', '.data'));
});

test('resolveDataDir refuses to write into an installed plugin', () => {
  const message = 'no data directory: set CLAUDE_PLUGIN_DATA or BRICK_ART_DATA';
  for (const root of ['/home/u/.claude/plugins/cache/mkt/brick-art/0.1.0', 'C:\\Users\\u\\.claude\\plugins\\cache\\brick-art']) {
    assert.throws(() => resolveDataDir({}, root), { message });
    assert.throws(() => resolveDataDir({ CLAUDE_PLUGIN_DATA: '' }, root), { message });
  }
  assert.equal(resolveDataDir({ CLAUDE_PLUGIN_DATA: '/plugin' }, '/home/u/.claude/plugins/cache/x'), '/plugin');
});

test('the MCP server entry resolves its data directory through resolveDataDir', () => {
  const text = readFileSync(path.join(import.meta.dirname, '..', 'src', 'entry', 'server.mjs'), 'utf8');
  assert.ok(text.includes('resolveDataDir(process.env, repoRoot)'));
  assert.ok(!text.includes('process.env.BRICK_ART_DATA'));
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
