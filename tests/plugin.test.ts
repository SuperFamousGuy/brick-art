import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel: string) => JSON.parse(readFileSync(join(root, rel), 'utf8'));

test('plugin.json declares the MCP server inline', () => {
  const manifest = readJson('.claude-plugin/plugin.json');
  assert.equal(manifest.name, 'brick-art');
  const server = manifest.mcpServers['brick-art-parts'];
  assert.equal(server.command, 'node');
  assert.match(server.args[0], /server\.mjs$/);
  assert.equal(server.env.BRICK_ART_DATA, '${CLAUDE_PLUGIN_DATA}');
});

test('marketplace.json lists the plugin at the repo root', () => {
  const marketplace = readJson('.claude-plugin/marketplace.json');
  assert.equal(marketplace.name, 'brick-art');
  assert.deepEqual(
    marketplace.plugins.map((p: { name: string; source: string }) => [p.name, p.source]),
    [['brick-art', './']],
  );
});

test('hooks.json runs the bootstrap on SessionStart', () => {
  const hooks = readJson('hooks/hooks.json').hooks.SessionStart;
  const commands = hooks.flatMap((entry: { hooks: { command: string }[] }) => entry.hooks.map((h) => h.command));
  assert.ok(commands.some((c: string) => c.includes('bootstrap.mjs')));
});

test('reseed command file exists', () => {
  assert.ok(existsSync(join(root, 'commands', 'reseed.md')));
});

test('no .mcp.json at the repo root', () => {
  assert.equal(existsSync(join(root, '.mcp.json')), false);
});

test('bin/brick-art-seed is executable', { skip: process.platform === 'win32' }, () => {
  accessSync(join(root, 'bin', 'brick-art-seed'), constants.X_OK);
});

test('plugin.json declares the fan_projects option, off by default', () => {
  const option = readJson('.claude-plugin/plugin.json').userConfig.fan_projects;
  assert.equal(option.type, 'boolean');
  assert.equal(option.default, false);
  assert.equal(option.title, 'Download fan-made designs');
});

test('reseed command passes the plugin data folder to the update and the local seed', () => {
  const text = readFileSync(join(root, 'commands', 'reseed.md'), 'utf8');
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(frontmatter, 'frontmatter present');
  assert.match(frontmatter[1], /^description:\s*\S/m);
  assert.match(frontmatter[1], /^argument-hint:\s*\S/m);
  assert.ok(text.includes(
    'BRICK_ART_DATA="${CLAUDE_PLUGIN_DATA}" node --max-old-space-size=3072 "${CLAUDE_PLUGIN_ROOT}/src/entry/update.mjs" --variant-from-options --force',
  ));
  assert.ok(text.includes(
    'BRICK_ART_DATA="${CLAUDE_PLUGIN_DATA}" node --max-old-space-size=3072 "${CLAUDE_PLUGIN_ROOT}/src/entry/seed.mjs" --refresh --variant-from-options',
  ));
  assert.ok(text.includes('run_in_background'));
});
