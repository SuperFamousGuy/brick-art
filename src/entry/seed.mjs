import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { assertNodeVersion } from './version-guard.mjs';

assertNodeVersion();

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

try {
  const { runSeed } = await import('../seed/seed.ts');
  const { resolveDataDir } = await import('../paths.ts');
  const result = await runSeed({
    dataDir: resolveDataDir(process.env, repoRoot),
    repoRoot,
    refresh: process.argv.includes('--refresh'),
  });
  if (result.dbFile === '') {
    console.log('seed already running');
  } else {
    console.log(`brick-art seed complete: ${result.counts.parts} parts, ${result.counts.with_connections} with connections, ${result.counts.incomplete} incomplete`);
  }
  process.exit(0);
} catch (err) {
  console.error(`brick-art seed failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
