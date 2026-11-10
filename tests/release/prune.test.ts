import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectReleasesToDelete } from '../../src/release/prune.ts';

test('selectReleasesToDelete keeps the newest releases per schema version', () => {
  const tags = ['data-3-20261103', 'data-3-20261110', 'data-3-20261117', 'data-3-20261124', 'data-2-20261001', 'v0.1.0'];
  assert.deepEqual(selectReleasesToDelete(tags, 3), ['data-3-20261103']);
});

test('selectReleasesToDelete never deletes the newest release of a schema version', () => {
  assert.deepEqual(selectReleasesToDelete(['data-2-20261001', 'data-2-20261002'], 0), ['data-2-20261001']);
  assert.deepEqual(selectReleasesToDelete(['data-3-20261117', 'junk', 'data-x-1'], 1), []);
});
