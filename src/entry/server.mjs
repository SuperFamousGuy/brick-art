import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { assertNodeVersion } from './version-guard.mjs';

assertNodeVersion();

// stdout belongs to the MCP transport; log only to stderr.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = process.env.BRICK_ART_DATA || process.env.CLAUDE_PLUGIN_DATA || resolve(repoRoot, '.data');

try {
  const { createServer } = await import('../mcp/server.ts');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const server = createServer(dataDir);
  const shutdown = () => {
    server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('end', shutdown);
  await server.connect(new StdioServerTransport());
} catch (err) {
  console.error(`brick-art MCP server failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
