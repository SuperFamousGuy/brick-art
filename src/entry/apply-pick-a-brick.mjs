import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { assertNodeVersion } from './version-guard.mjs';

assertNodeVersion();

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

try {
  const { applyPickABrick } = await import('../curated/apply-pick-a-brick.ts');
  const { resolveDataDir } = await import('../paths.ts');
  const r = await applyPickABrick(resolveDataDir(process.env, repoRoot), repoRoot);
  console.log(`wrote ${r.written} Pick a Brick checks to ${r.dbFile}`);
  for (const x of r.rejected) console.log(`skipped ${x.part}: ${x.reason}`);
  process.exit(0);
} catch (err) {
  console.error(`brick-art pick-a-brick apply failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
