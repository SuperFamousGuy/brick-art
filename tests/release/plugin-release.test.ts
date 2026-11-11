import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VERSION_FILES, dataReleaseProblems, defaultNotes, nextVersion, parseArgs, setVersion, withDataLine,
} from '../../src/release/plugin-release.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('nextVersion bumps patch, minor, and major', () => {
  assert.equal(nextVersion('0.1.9', 'patch'), '0.1.10');
  assert.equal(nextVersion('0.1.9', 'minor'), '0.2.0');
  assert.equal(nextVersion('0.1.9', 'major'), '1.0.0');
});

test('nextVersion takes an explicit newer version and refuses others', () => {
  assert.equal(nextVersion('0.1.0', '0.3.0'), '0.3.0');
  assert.throws(() => nextVersion('0.2.0', '0.1.9'), /not newer/);
  assert.throws(() => nextVersion('0.2.0', '0.2.0'), /not newer/);
  assert.throws(() => nextVersion('0.2.0', 'v0.3.0'), /patch, minor, major/);
  assert.throws(() => nextVersion('0.2', 'patch'), /not X\.Y\.Z/);
});

test('setVersion sets the top-level and lockfile root versions only', () => {
  const lock = JSON.stringify({
    name: 'x', version: '0.1.0', packages: { '': { version: '0.1.0' }, 'node_modules/y': { version: '0.1.0' } },
  }, null, 2);
  const out = JSON.parse(setVersion(lock, '0.2.0'));
  assert.equal(out.version, '0.2.0');
  assert.equal(out.packages[''].version, '0.2.0');
  assert.equal(out.packages['node_modules/y'].version, '0.1.0');
  assert.throws(() => setVersion('{}', '0.2.0'), /no top-level version/);
});

test('setVersion round-trips the real version files unchanged', () => {
  for (const f of VERSION_FILES) {
    const text = readFileSync(join(root, f), 'utf8');
    const v = (JSON.parse(text) as { version: string }).version;
    assert.equal(setVersion(text, v), text, f);
  }
});

test('the version files agree', () => {
  const versions = VERSION_FILES.map((f) => (JSON.parse(readFileSync(join(root, f), 'utf8')) as { version: string }).version);
  assert.equal(new Set(versions).size, 1, versions.join(', '));
});

test('defaultNotes names the data release and lists the commits', () => {
  const notes = defaultNotes('0.2.0', 'data-3-20261111', ['feat: a', 'fix: b']);
  assert.match(notes, /data-3-20261111/);
  assert.match(notes, /- feat: a\n- fix: b/);
  assert.match(defaultNotes('0.2.0', 'data-3-20261111', []), /No code changes/);
});

test('parseArgs reads the version and options', () => {
  assert.deepEqual(parseArgs(['minor', '--dry-run']), { spec: 'minor', dryRun: true, dataRun: null, notesFile: null });
  assert.deepEqual(parseArgs(['patch', '--data-run', '123', '--notes-file', 'n.md']),
    { spec: 'patch', dryRun: false, dataRun: '123', notesFile: 'n.md' });
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['patch', '--data-run']), /needs a value/);
  assert.throws(() => parseArgs(['patch', '--data-run', 'abc']), /run id/);
  assert.throws(() => parseArgs(['patch', '--bogus']), /unknown option/);
});

test('withDataLine appends the data release unless the notes name it', () => {
  const out = withDataLine('## Features\n\n- New tool\n\n', 'data-3-20261111');
  assert.match(out, /^## Features\n\n- New tool\n\nShips with the parts database from \[data-3-20261111\]/);
  assert.equal(withDataLine('Uses data-3-20261111.\n', 'data-3-20261111'), 'Uses data-3-20261111.\n');
});

test('dataReleaseProblems accepts a release built by the run, with both files attached', () => {
  const meta = {
    tag: 'data-3-20261111', source: { runId: '7', sha: 'abc' },
    variants: { standard: { file: 'standard.db.gz' }, full: { file: 'full.db.gz' } },
  };
  const assets = new Set(['standard.db.gz', 'full.db.gz', 'release.json']);
  assert.deepEqual(dataReleaseProblems('data-3-20261111', meta, assets, '7', 'abc'), []);
});

test('dataReleaseProblems rejects another run, another commit, or a missing file', () => {
  const meta = {
    tag: 'data-3-20261111', source: { runId: '8', sha: 'def' },
    variants: { standard: { file: 'standard.db.gz' }, full: { file: 'full.db.gz' } },
  };
  const problems = dataReleaseProblems('data-3-20261111', meta, new Set(['standard.db.gz']), '7', 'abc');
  assert.equal(problems.length, 3);
  assert.match(problems.join('\n'), /run 8, expected 7/);
  assert.match(problems.join('\n'), /commit def, expected abc/);
  assert.match(problems.join('\n'), /full file full\.db\.gz is not attached/);
});

test('dataReleaseProblems rejects a release with no recorded source or variant', () => {
  const problems = dataReleaseProblems('data-3-20261111', { tag: 'data-3-20261111' }, new Set(), '7', 'abc');
  assert.match(problems.join('\n'), /run undefined/);
  assert.match(problems.join('\n'), /no standard variant/);
  assert.match(problems.join('\n'), /no full variant/);
});
