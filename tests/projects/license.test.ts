import { test } from 'node:test';
import assert from 'node:assert/strict';
import { licenseAllowed } from '../../src/projects/license.ts';

test('licenseAllowed applies the allow list', () => {
  assert.equal(licenseAllowed('Licensed under CC BY 4.0 : see CAreadme.txt'), true);
  assert.equal(licenseAllowed('Licensed under CC BY-SA 2.0'), true);
  assert.equal(licenseAllowed('Redistributable under CCAL version 2.0 : see CAreadme.txt'), true);
  assert.equal(licenseAllowed('Public Domain'), true);
  assert.equal(licenseAllowed('CC0'), true);
  assert.equal(licenseAllowed('Not redistributable : see NonCAreadme.txt'), false);
  assert.equal(licenseAllowed('All rights reserved'), false);
  assert.equal(licenseAllowed('Licensed under CCAL version 2.0'), false);
});

test('licenseAllowed falls back to the source default only for a null line', () => {
  assert.equal(licenseAllowed(null), false);
  assert.equal(licenseAllowed(null, 'CC0'), true);
  assert.equal(licenseAllowed(null, null), false);
  assert.equal(licenseAllowed('All rights reserved', 'CC0'), false);
});
