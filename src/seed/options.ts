import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Options { fanProjects: boolean }
export type OptionsSource = 'env' | 'plugin' | 'file' | 'default';

const optionsPath = (dataDir: string) => join(dataDir, 'options.json');
const truthy = (value: string) => /^(true|1)$/i.test(value.trim());

/**
 * The plugin options: BRICK_ART_FAN_PROJECTS, then CLAUDE_PLUGIN_OPTION_FAN_PROJECTS, then
 * `<dataDir>/options.json`, then off. Empty variables count as unset; an unreadable file is ignored.
 */
export function readOptions(env: NodeJS.ProcessEnv, dataDir: string): Options & { source: OptionsSource } {
  if (env.BRICK_ART_FAN_PROJECTS) return { fanProjects: truthy(env.BRICK_ART_FAN_PROJECTS), source: 'env' };
  if (env.CLAUDE_PLUGIN_OPTION_FAN_PROJECTS) {
    return { fanProjects: truthy(env.CLAUDE_PLUGIN_OPTION_FAN_PROJECTS), source: 'plugin' };
  }
  try {
    const raw = JSON.parse(readFileSync(optionsPath(dataDir), 'utf8')) as { fanProjects?: unknown } | null;
    if (typeof raw?.fanProjects === 'boolean') return { fanProjects: raw.fanProjects, source: 'file' };
  } catch { /* missing or unreadable: use the default */ }
  return { fanProjects: false, source: 'default' };
}

/** Saves the options to `<dataDir>/options.json` atomically, so commands run outside the hook see them. */
export function writeOptions(dataDir: string, o: Options): void {
  mkdirSync(dataDir, { recursive: true });
  const file = optionsPath(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ fanProjects: o.fanProjects }));
  renameSync(tmp, file);
}

export const variantFor = (o: Options): 'standard' | 'full' => (o.fanProjects ? 'full' : 'standard');
