import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runSeed } from '../../src/seed/seed.ts';
import { fixtureFetched, writeFixtureSources } from '../helpers/fixtures.ts';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { COLOR_FAMILIES, createServer } from '../../src/mcp/server.ts';
import { acquireLock, releaseLock, writeState } from '../../src/seed/lock.ts';
import { dataPaths } from '../../src/paths.ts';
import { TRAITS } from '../../src/derive/traits.ts';

const repoRoot = resolve(import.meta.dirname, '..', '..');
let tmp: string;
let fx: Awaited<ReturnType<typeof writeFixtureSources>>;

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'brick-art-mcp-'));
  fx = await writeFixtureSources(join(tmp, 'fx'));
});

after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function connect(dataDir: string) {
  const server = createServer(dataDir);
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const textOf = (r: unknown): string => (r as { content: { text: string }[] }).content[0]!.text;

test('listTools returns the seven tools', async () => {
  const { client, close } = await connect(join(tmp, 'empty'));
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['database_status', 'find_by_use', 'find_compatible_parts', 'find_substitutes', 'get_part', 'list_colors', 'search_parts'],
  );
  await close();
});

test('without a database, lookups report not ready and status still works', async () => {
  const { client, close } = await connect(join(tmp, 'empty2'));
  const r = await client.callTool({ name: 'search_parts', arguments: {} });
  assert.equal(r.isError, true);
  assert.ok(textOf(r).startsWith('Parts database is not ready'));
  const s = await client.callTool({ name: 'database_status', arguments: {} });
  assert.notEqual(s.isError, true);
  assert.equal(JSON.parse(textOf(s)).seededAt, null);
  await close();
});

test('lookups work after seeding and a reseed is picked up', async () => {
  const dataDir = join(tmp, 'data');
  await runSeed({ dataDir, repoRoot, refresh: false, sources: fixtureFetched(fx), now: () => new Date('2026-01-01T00:00:00Z') });
  const { client, close } = await connect(dataDir);
  const p = await client.callTool({ name: 'get_part', arguments: { partNum: '3001' } });
  assert.equal(JSON.parse(textOf(p)).widthStuds, 4);
  const first = JSON.parse(textOf(await client.callTool({ name: 'database_status', arguments: {} })));

  await runSeed({ dataDir, repoRoot, refresh: false, sources: fixtureFetched(fx), now: () => new Date('2026-02-02T00:00:00Z') });
  const second = JSON.parse(textOf(await client.callTool({ name: 'database_status', arguments: {} })));
  assert.notEqual(second.seededAt, first.seededAt);
  assert.ok(second.seededAt.startsWith('2026-02-02'));
  await close();
});

test('a throwing lookup returns isError instead of crashing', async () => {
  const dataDir = join(tmp, 'data');
  const { client, close } = await connect(dataDir);
  const r = await client.callTool({ name: 'find_compatible_parts', arguments: {} });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /connectionType or partNum/);
  await close();
});

type Prop = { description?: string; type?: string; items?: { enum?: string[] } };

test('tool contract: every input field is described and traits is the closed vocabulary', async () => {
  const { client, close } = await connect(join(tmp, 'empty-contract'));
  const { tools } = await client.listTools();
  for (const tool of tools) {
    const props = (tool.inputSchema.properties ?? {}) as Record<string, Prop>;
    for (const [name, prop] of Object.entries(props)) {
      assert.ok((prop.description ?? '').trim().length > 0, `${tool.name}.${name} has a description`);
    }
  }
  for (const name of ['search_parts', 'find_by_use', 'find_compatible_parts']) {
    const props = tools.find((t) => t.name === name)!.inputSchema.properties as Record<string, Prop>;
    assert.deepEqual(props.traits!.items!.enum, [...TRAITS], `${name}.traits`);
    for (const f of ['includeIncomplete', 'includePrints', 'includeNonSystem', 'width', 'depth', 'height',
      'category', 'color', 'colorFamily', 'minSetCount', 'nameContains']) {
      assert.ok(f in props, `${name}.${f}`);
    }
  }
  await close();
});

test('colorFamily matches case-insensitively and filters pass through the tools', async () => {
  const dataDir = join(tmp, 'data');
  const { client, close } = await connect(dataDir);
  const call = async (name: string, args: Record<string, unknown>) =>
    JSON.parse(textOf(await client.callTool({ name, arguments: args }))) as unknown[];
  const lower = await call('search_parts', { colorFamily: 'green' });
  const upper = await call('search_parts', { colorFamily: 'Green' });
  assert.ok(lower.length > 0);
  assert.deepEqual(upper, lower);
  assert.deepEqual(await call('list_colors', { family: 'GREEN' }), await call('list_colors', { family: 'green' }));
  const recv = await call('find_compatible_parts', { connectionType: 'stud_receptor', includeNonSystem: true, width: 2, depth: 2 });
  assert.ok((recv as { part: { partNum: string } }[]).some((r) => r.part.partNum === '3437'));
  assert.deepEqual(await call('find_by_use', { represents: 'petal', traits: ['slope'] }), []);
  await close();
});

test('COLOR_FAMILIES lists the families in curated/color-families.yaml', () => {
  const doc = parse(readFileSync(join(repoRoot, 'curated', 'color-families.yaml'), 'utf8')) as { families: object };
  assert.deepEqual([...COLOR_FAMILIES].sort(), Object.keys(doc.families).sort());
});

test('database_status reports seeding only while the seed lock is held', async () => {
  const dataDir = join(tmp, 'stale-seeding');
  const paths = dataPaths(dataDir);
  writeState(paths.state, { status: 'seeding', startedAt: 'x', finishedAt: null, lastError: null, failures: 0 });
  const { client, close } = await connect(dataDir);
  const status = async () =>
    JSON.parse(textOf(await client.callTool({ name: 'database_status', arguments: {} }))).state as string;
  assert.equal(await status(), 'idle');
  assert.equal(acquireLock(paths.lock), true);
  assert.equal(await status(), 'seeding');
  releaseLock(paths.lock);
  await close();
});
