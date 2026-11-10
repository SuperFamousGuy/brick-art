import path from 'node:path';

const INSTALLED_PLUGIN = /[\\/]\.claude[\\/]plugins[\\/]cache(?:[\\/]|$)/;

/**
 * The data directory: BRICK_ART_DATA, then CLAUDE_PLUGIN_DATA, then `<repoRoot>/.data` for development.
 * Empty variables count as unset. An installed plugin's root is never written to, so there is no fallback.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv, repoRoot: string): string {
  const fromEnv = env.BRICK_ART_DATA || env.CLAUDE_PLUGIN_DATA;
  if (fromEnv) return fromEnv;
  if (INSTALLED_PLUGIN.test(repoRoot)) throw new Error('no data directory: set CLAUDE_PLUGIN_DATA or BRICK_ART_DATA');
  return path.join(repoRoot, '.data');
}

export interface DataPaths {
  pointer: string;
  lock: string;
  state: string;
  log: string;
  cacheDir: string;
  dbFile(stamp: string): string;
}

export function dataPaths(dataDir: string): DataPaths {
  return {
    pointer: path.join(dataDir, 'current.json'),
    lock: path.join(dataDir, 'seed.lock'),
    state: path.join(dataDir, 'seed-state.json'),
    log: path.join(dataDir, 'seed.log'),
    cacheDir: path.join(dataDir, 'cache'),
    dbFile: (stamp: string) => path.join(dataDir, `parts-${stamp}.db`),
  };
}
