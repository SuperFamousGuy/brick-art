import path from 'node:path';

export function resolveDataDir(env: NodeJS.ProcessEnv, repoRoot: string): string {
  return env.CLAUDE_PLUGIN_DATA || env.BRICK_ART_DATA || path.join(repoRoot, '.data');
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
