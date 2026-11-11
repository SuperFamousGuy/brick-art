import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { assertNodeVersion } from './version-guard.mjs';

assertNodeVersion();

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

try {
  const { main } = await import('../release/plugin-release.ts');
  await main(process.argv.slice(2), repoRoot);
  process.exit(0);
} catch (err) {
  console.error(`\nbrick-art release failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
