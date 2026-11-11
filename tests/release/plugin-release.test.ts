import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION_FILES, defaultNotes, nextVersion, parseArgs, setVersion } from '../../src/release/plugin-release.ts';

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
