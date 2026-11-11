import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { assertNodeVersion } from './version-guard.mjs';

assertNodeVersion();

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const i = process.argv.indexOf('--out');
const out = i === -1 ? undefined : process.argv[i + 1];
if (!out) {
  console.error('brick-art release: --out <dir> is required');
  process.exit(2);
}

try {
  const { buildRelease } = await import('../release/build.ts');
  const { resolveDataDir } = await import('../paths.ts');
  const result = await buildRelease({
    dataDir: resolveDataDir(process.env, repoRoot),
    repoRoot,
    outDir: resolve(out),
  });
  if (result.gateFailures.length > 0) {
    for (const failure of result.gateFailures) console.error(`gate failed: ${failure}`);
    process.exit(1);
  }
  console.log(result.tag);
  process.exit(0);
} catch (err) {
  console.error(`brick-art release failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
