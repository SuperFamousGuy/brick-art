import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOptions, variantFor, writeOptions } from '../../src/seed/options.ts';

async function tmp(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'brick-art-opts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('with nothing set the option is off from the default', async (t) => {
  const dir = await tmp(t);
  assert.deepEqual(readOptions({}, dir), { fanProjects: false, source: 'default' });
});

test('options.json is read when no variable is set', async (t) => {
  const dir = await tmp(t);
  writeOptions(dir, { fanProjects: true });
  assert.deepEqual(readOptions({}, dir), { fanProjects: true, source: 'file' });
});

test('the plugin option overrides options.json', async (t) => {
  const dir = await tmp(t);
  writeOptions(dir, { fanProjects: true });
  assert.deepEqual(readOptions({ CLAUDE_PLUGIN_OPTION_FAN_PROJECTS: 'false' }, dir), { fanProjects: false, source: 'plugin' });
});

test('BRICK_ART_FAN_PROJECTS overrides the plugin option', async (t) => {
  const dir = await tmp(t);
  const env = { BRICK_ART_FAN_PROJECTS: '1', CLAUDE_PLUGIN_OPTION_FAN_PROJECTS: 'false' };
  assert.deepEqual(readOptions(env, dir), { fanProjects: true, source: 'env' });
});

test('truthy values are true and 1, case-insensitive; anything else is false', async (t) => {
  const dir = await tmp(t);
  for (const [value, expected] of [['TRUE', true], ['true', true], ['1', true], ['no', false], ['0', false], ['yes', false]] as const) {
    assert.equal(readOptions({ BRICK_ART_FAN_PROJECTS: value }, dir).fanProjects, expected, value);
  }
});

test('empty variables count as unset', async (t) => {
  const dir = await tmp(t);
  assert.deepEqual(readOptions({ BRICK_ART_FAN_PROJECTS: '', CLAUDE_PLUGIN_OPTION_FAN_PROJECTS: '' }, dir), { fanProjects: false, source: 'default' });
});

test('an unreadable options.json falls back to the default', async (t) => {
  const dir = await tmp(t);
  await writeFile(join(dir, 'options.json'), '{not json');
  assert.deepEqual(readOptions({}, dir), { fanProjects: false, source: 'default' });
});

test('writeOptions creates the data dir and writes JSON', async (t) => {
  const dir = join(await tmp(t), 'nested');
  writeOptions(dir, { fanProjects: true });
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'options.json'), 'utf8')), { fanProjects: true });
});

test('variantFor maps the fan option to a variant', () => {
  assert.equal(variantFor({ fanProjects: false }), 'standard');
  assert.equal(variantFor({ fanProjects: true }), 'full');
});
