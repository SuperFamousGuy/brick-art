import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { runSeed } from '../../src/seed/seed.ts';
import { fixtureFetched, writeFixtureSources } from '../helpers/fixtures.ts';
import { createServer } from '../../src/mcp/server.ts';

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
