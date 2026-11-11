import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SEED_VERSION } from '../db/schema.ts';
import { findRelease, readUpdateState } from './download.ts';

/** Files that carry the plugin version. They are the only files the release commit changes. */
export const VERSION_FILES = ['.claude-plugin/plugin.json', 'package.json', 'package-lock.json'] as const;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const WORKFLOW = 'data-release.yml';

/** The next version: `patch`, `minor`, `major`, or an explicit `X.Y.Z` that is newer than `current`. */
export function nextVersion(current: string, spec: string): string {
  const cur = SEMVER.exec(current);
  if (cur === null) throw new Error(`current version ${current} is not X.Y.Z`);
  const [maj, min, pat] = cur.slice(1).map(Number) as [number, number, number];
  if (spec === 'patch') return `${maj}.${min}.${pat + 1}`;
  if (spec === 'minor') return `${maj}.${min + 1}.0`;
  if (spec === 'major') return `${maj + 1}.0.0`;
  const want = SEMVER.exec(spec);
  if (want === null) throw new Error(`version must be patch, minor, major, or X.Y.Z (got ${spec})`);
  const a = want.slice(1).map(Number);
  const b = [maj, min, pat];
  const cmp = a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
  if (cmp <= 0) throw new Error(`version ${spec} is not newer than ${current}`);
  return spec;
}

/**
 * `text` with the top-level `"version"` set to `version`. For package-lock.json this also sets the root
 * package entry (`packages[""]`). Only the version strings change, so the file keeps its formatting. The
 * files use two-space indent; the result is parsed back to check that the right fields changed.
 */
export function setVersion(text: string, version: string): string {
  type Doc = { version?: unknown; packages?: Record<string, { version?: unknown }> };
  const before = JSON.parse(text) as Doc;
  if (typeof before.version !== 'string') throw new Error('file has no top-level version');
  let out = text.replace(/^( {2}"version": ")[^"]*"/m, `$1${version}"`);
  if (before.packages?.[''] !== undefined) {
    out = out.replace(/^( {4}"": \{\n(?: {6}.*\n)*? {6}"version": ")[^"]*"/m, `$1${version}"`);
  }
  const after = JSON.parse(out) as Doc;
  const root = after.packages?.[''];
  if (after.version !== version || (root !== undefined && root.version !== version)) {
    throw new Error('could not find the version field to update');
  }
  return out;
}

/** Default release notes: the data release it ships with, then the commit subjects since the last tag. */
export function defaultNotes(version: string, dataTag: string, subjects: string[]): string {
  const changes = subjects.length > 0 ? subjects.map((s) => `- ${s}`).join('\n') : '- No code changes.';
  return [
    `brick-art ${version}.`,
    '',
    `Ships with the parts database from [${dataTag}](https://github.com/SuperFamousGuy/brick-art/releases/tag/${dataTag}) (schema ${SEED_VERSION}).`,
    '',
    '## Changes',
    '',
    changes,
    '',
  ].join('\n');
}

export interface ReleaseArgs {
  spec: string;
  dryRun: boolean;
  /** A finished data-release run to use instead of starting one. */
  dataRun: string | null;
  notesFile: string | null;
}

export function parseArgs(argv: string[]): ReleaseArgs {
  const out: ReleaseArgs = { spec: '', dryRun: false, dataRun: null, notesFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--data-run') out.dataRun = value();
    else if (a === '--notes-file') out.notesFile = value();
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (out.spec === '') out.spec = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (out.spec === '') throw new Error('usage: npm run release -- <patch|minor|major|X.Y.Z> [--dry-run] [--data-run <id>] [--notes-file <file>]');
  if (out.dataRun !== null && !/^\d+$/.test(out.dataRun)) throw new Error(`--data-run must be a run id (got ${out.dataRun})`);
  return out;
}

// ---- side effects ----

const step = (msg: string) => console.log(`\n==> ${msg}`);
const sh = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();
const shLoud = (cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: env ?? process.env });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Run { databaseId: number; headSha: string; createdAt: string; status: string; conclusion: string; url: string }

function viewRun(repoRoot: string, id: string): Run {
  return JSON.parse(sh('gh', ['run', 'view', id, '--json', 'databaseId,headSha,createdAt,status,conclusion,url'], repoRoot)) as Run;
}

/** Starts the data-release workflow on main and returns its run once GitHub lists it. */
async function dispatchDataRun(repoRoot: string, head: string): Promise<Run> {
  const since = Date.now() - 10_000;
  sh('gh', ['workflow', 'run', WORKFLOW, '--ref', 'main'], repoRoot);
  for (let i = 0; i < 40; i++) {
    await sleep(5_000);
    const runs = JSON.parse(sh('gh', [
      'run', 'list', '--workflow', WORKFLOW, '--branch', 'main', '--event', 'workflow_dispatch', '--limit', '10',
      '--json', 'databaseId,headSha,createdAt,status,conclusion,url',
    ], repoRoot)) as Run[];
    const run = runs.find((r) => r.headSha === head && Date.parse(r.createdAt) >= since);
    if (run !== undefined) return run;
  }
  throw new Error('started the data-release workflow, but no run appeared within 200 s');
}

/** Checks that the newest data release was built by `run` and installs; returns its tag. */
async function verifyData(repoRoot: string, run: Run): Promise<string> {
  const release = await findRelease(SEED_VERSION);
  if (release === null) throw new Error(`no data release for schema ${SEED_VERSION}`);
  const metaUrl = release.assets.get('release.json');
  if (metaUrl === undefined) throw new Error(`${release.tag} has no release.json`);
  const meta = await (await fetch(metaUrl, { headers: { 'User-Agent': 'brick-art-release' } })).json() as {
    builtAt?: string; variants?: Record<string, unknown>;
  };
  if (typeof meta.builtAt !== 'string' || Date.parse(meta.builtAt) < Date.parse(run.createdAt)) {
    throw new Error(`newest data release ${release.tag} was built at ${meta.builtAt}, before run ${run.databaseId} started`);
  }
  for (const v of ['standard', 'full']) {
    if (meta.variants?.[v] === undefined) throw new Error(`${release.tag} has no ${v} variant`);
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'brick-art-release-'));
  try {
    shLoud('node', ['src/entry/update.mjs', '--variant', 'standard'], repoRoot, { ...process.env, BRICK_ART_DATA: dataDir });
    const state = readUpdateState(dataDir);
    if (state.releaseTag !== release.tag || state.origin !== 'release') {
      throw new Error(`test install got ${state.releaseTag ?? 'nothing'} (${state.lastError ?? 'no error'}), expected ${release.tag}`);
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
  return release.tag;
}

export async function main(argv: string[], repoRoot: string): Promise<void> {
  const args = parseArgs(argv);

  step('Checking the repo');
  if (sh('git', ['branch', '--show-current'], repoRoot) !== 'main') throw new Error('releases run from main');
  if (sh('git', ['status', '--porcelain'], repoRoot) !== '') throw new Error('the working tree is not clean');
  sh('git', ['fetch', '--tags', 'origin', 'main'], repoRoot);
  const head = sh('git', ['rev-parse', 'HEAD'], repoRoot);
  if (head !== sh('git', ['rev-parse', 'origin/main'], repoRoot)) throw new Error('main is not the same as origin/main');
  sh('gh', ['auth', 'status'], repoRoot);
  const current = (JSON.parse(readFileSync(join(repoRoot, '.claude-plugin/plugin.json'), 'utf8')) as { version: string }).version;
  for (const f of VERSION_FILES.slice(1)) {
    const v = (JSON.parse(readFileSync(join(repoRoot, f), 'utf8')) as { version: string }).version;
    if (v !== current) throw new Error(`${f} has version ${v}, plugin.json has ${current}`);
  }
  const version = nextVersion(current, args.spec);
  const tag = `v${version}`;
  if (sh('git', ['tag', '--list', tag], repoRoot) !== '') throw new Error(`tag ${tag} already exists`);
  const lastTag = sh('git', ['tag', '--list', 'v*', '--sort=-v:refname'], repoRoot).split('\n')[0] || null;
  const subjects = sh('git', ['log', '--format=%s', lastTag ? `${lastTag}..HEAD` : 'HEAD'], repoRoot)
    .split('\n').filter((s) => s !== '');
  console.log(`release ${current} -> ${version} from ${head.slice(0, 7)}; ${subjects.length} commits since ${lastTag ?? 'the start'}`);

  step('Running tests and the type check');
  shLoud('npm', ['test'], repoRoot);
  shLoud('npm', ['run', 'typecheck'], repoRoot);

  if (args.dryRun) {
    console.log(`\ndry run: would build data from ${head.slice(0, 7)}, then commit, tag, push, and publish ${tag}`);
    return;
  }

  step('Building the data release');
  let run: Run;
  if (args.dataRun !== null) {
    run = viewRun(repoRoot, args.dataRun);
    if (run.headSha !== head) throw new Error(`run ${args.dataRun} built ${run.headSha.slice(0, 7)}, not HEAD ${head.slice(0, 7)}`);
  } else {
    run = await dispatchDataRun(repoRoot, head);
  }
  console.log(`run ${run.databaseId}: ${run.url}`);
  if (run.status !== 'completed') {
    try {
      shLoud('gh', ['run', 'watch', String(run.databaseId), '--exit-status', '--interval', '30'], repoRoot);
    } catch {
      throw new Error(`data-release run ${run.databaseId} failed; fix it, then rerun the release with a new run`);
    }
    run = viewRun(repoRoot, String(run.databaseId));
  }
  if (run.conclusion !== 'success') throw new Error(`data-release run ${run.databaseId} concluded ${run.conclusion}`);

  step('Checking the data release installs');
  const dataTag = await verifyData(repoRoot, run);
  console.log(`data release ${dataTag} installs`);

  step(`Committing and tagging ${tag}`);
  sh('git', ['fetch', 'origin', 'main'], repoRoot);
  if (sh('git', ['rev-parse', 'origin/main'], repoRoot) !== head) throw new Error('origin/main moved during the data build; start over');
  for (const f of VERSION_FILES) {
    const file = join(repoRoot, f);
    writeFileSync(file, setVersion(readFileSync(file, 'utf8'), version));
  }
  sh('git', ['add', ...VERSION_FILES], repoRoot);
  sh('git', ['commit', '-m', `chore: release ${tag}\n\nData: ${dataTag}`], repoRoot);
  sh('git', ['tag', '-a', tag, '-m', `brick-art ${tag} (data ${dataTag})`], repoRoot);
  shLoud('git', ['push', '--atomic', 'origin', 'main', tag], repoRoot);

  step(`Publishing the ${tag} release`);
  let notesFile = args.notesFile;
  let tmpNotes: string | null = null;
  if (notesFile === null) {
    tmpNotes = mkdtempSync(join(tmpdir(), 'brick-art-notes-'));
    notesFile = join(tmpNotes, 'notes.md');
    writeFileSync(notesFile, defaultNotes(version, dataTag, subjects));
  }
  try {
    shLoud('gh', ['release', 'create', tag, '--title', `brick-art ${tag}`, '--notes-file', notesFile, '--latest', '--verify-tag'], repoRoot);
  } finally {
    if (tmpNotes !== null) rmSync(tmpNotes, { recursive: true, force: true });
  }
  console.log(`\nreleased ${tag} with data ${dataTag}`);
}
