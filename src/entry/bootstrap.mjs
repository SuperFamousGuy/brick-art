import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { isSupportedNode } from './version-guard.mjs';

// A SessionStart hook must never fail the session: every path prints one line and exits 0.
process.exitCode = 0;

if (!isSupportedNode()) {
  console.log(`brick-art: requires Node.js 22.18.0 or later (found ${process.versions.node}); parts lookups are disabled.`);
} else {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  try {
    const { bootstrap, spawnDetachedSeed } = await import('../seed/bootstrap.ts');
    const { resolveDataDir } = await import('../paths.ts');
    const dataDir = resolveDataDir(process.env, repoRoot);
    console.log(await bootstrap(dataDir, repoRoot, () => spawnDetachedSeed(dataDir, repoRoot)));
  } catch (err) {
    console.log(`brick-art: setup check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
