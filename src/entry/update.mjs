import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { assertNodeVersion } from './version-guard.mjs';

assertNodeVersion();

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// --variant-from-options reads the variant from the saved plugin options (for /reseed).
const fromOptions = process.argv.includes('--variant-from-options');
const i = process.argv.indexOf('--variant');
const flagVariant = i === -1 ? 'standard' : process.argv[i + 1];
if (!fromOptions && flagVariant !== 'standard' && flagVariant !== 'full') {
  console.error('brick-art update: --variant must be one of standard, full');
  process.exit(2);
}

let logFile = null;
const log = (msg) => {
  console.log(msg);
  if (logFile === null) return;
  try { appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ }
};

try {
  const { runUpdate } = await import('../release/download.ts');
  const { dataPaths, resolveDataDir } = await import('../paths.ts');
  const dataDir = resolveDataDir(process.env, repoRoot);
  mkdirSync(dataDir, { recursive: true });
  logFile = dataPaths(dataDir).log;
  let variant = flagVariant;
  if (fromOptions) {
    const { readOptions, variantFor } = await import('../seed/options.ts');
    variant = variantFor(readOptions(process.env, dataDir));
  }
  const result = await runUpdate({ dataDir, repoRoot, variant, force: process.argv.includes('--force') });
  log(`brick-art update: ${result.outcome}${result.tag ? ` (${result.tag})` : ''}`);
  process.exit(0);
} catch (err) {
  const message = `brick-art update failed: ${err instanceof Error ? err.message : String(err)}`;
  console.error(message);
  if (logFile !== null) {
    try { appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`); } catch { /* ignore */ }
  }
  process.exit(1);
}
