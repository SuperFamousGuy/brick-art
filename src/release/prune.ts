import { execFileSync } from 'node:child_process';

const TAG = /^data-(\d+)-(\d{8})$/;
const KEEP = 3;

/**
 * Tags to delete: per schema version, everything but the newest `keep` releases. The newest release
 * of each schema version is never selected. Tags that are not `data-<n>-<YYYYMMDD>` are ignored.
 */
export function selectReleasesToDelete(tags: string[], keep: number): string[] {
  const bySchema = new Map<string, string[]>();
  for (const tag of tags) {
    const m = TAG.exec(tag);
    if (m === null) continue;
    bySchema.set(m[1]!, [...(bySchema.get(m[1]!) ?? []), tag]);
  }
  const out: string[] = [];
  for (const group of bySchema.values()) {
    const newestFirst = group.sort((a, b) => TAG.exec(b)![2]!.localeCompare(TAG.exec(a)![2]!));
    out.push(...newestFirst.slice(Math.max(keep, 1)));
  }
  return out.sort();
}

export function main(): void {
  const listed = execFileSync('gh', ['release', 'list', '--limit', '200', '--json', 'tagName'], { encoding: 'utf8' });
  const tags = (JSON.parse(listed) as { tagName: string }[]).map((r) => r.tagName);
  for (const tag of selectReleasesToDelete(tags, KEEP)) {
    console.log(`deleting release ${tag}`);
    execFileSync('gh', ['release', 'delete', tag, '--yes', '--cleanup-tag'], { stdio: 'inherit' });
  }
}

if (process.argv[1] !== undefined && import.meta.filename === process.argv[1]) main();
