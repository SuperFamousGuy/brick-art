import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { assertNodeVersion } from './version-guard.mjs';

assertNodeVersion();

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The value after `--name`, or `fallback` when the flag is absent. Exits on an unknown value. */
function flag(name, allowed, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  if (!allowed.includes(value)) {
    console.error(`brick-art seed: --${name} must be one of ${allowed.join(', ')}`);
    process.exit(2);
  }
  return value;
}

const variant = flag('variant', ['fallback', 'standard', 'full'], 'fallback');
const builtBy = flag('built-by', ['ci', 'local'], 'local');

try {
  const { runSeed } = await import('../seed/seed.ts');
  const { resolveDataDir } = await import('../paths.ts');
  const dataDir = resolveDataDir(process.env, repoRoot);
  let chosen = variant;
  if (process.argv.includes('--variant-from-options')) {
    // For /reseed --local: the variant the plugin options select, saved by the session hook.
    const { readOptions, variantFor } = await import('../seed/options.ts');
    chosen = variantFor(readOptions(process.env, dataDir));
  }
  const result = await runSeed({
    dataDir,
    repoRoot,
    refresh: process.argv.includes('--refresh'),
    variant: chosen,
    builtBy,
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
