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

test('licenseAllowed rejects non-commercial and no-derivatives licenses', () => {
  for (const line of [
    'Licensed under CC BY-NC 4.0', 'Licensed under CC BY-ND 4.0', 'Licensed under CC BY-NC-SA 3.0',
    'Licensed under CC BY-NC-ND 4.0', 'Non-commercial use only, CC BY 4.0', 'CC BY 4.0, no derivatives',
  ]) assert.equal(licenseAllowed(line), false, line);
});

test('licenseAllowed accepts CC BY, CC BY-SA, and CC0 only as whole license names', () => {
  for (const line of [
    'CC BY 2.0', 'Licensed under CC BY 4.0', 'Licensed under CC BY 2.0 and CC BY 4.0 : see CAreadme.txt',
    'Redistributable under CC BY-SA version 4.0 : see https://creativecommons.org/licenses/by-sa/4.0/',
    'CC BY-SA 3.0', 'CC BY-SA 4.0', 'CC0', 'CC0 1.0',
  ]) {
    assert.equal(licenseAllowed(line), true, line);
  }
  for (const line of ['Copyright acc by me', 'CC BY', 'CC BYSA 4.0', 'CC01', 'nonpublic domains']) {
    assert.equal(licenseAllowed(line), false, line);
  }
});

test('licenseAllowed falls back to the source default only for a null line', () => {
  assert.equal(licenseAllowed(null), false);
  assert.equal(licenseAllowed(null, 'CC0'), true);
  assert.equal(licenseAllowed(null, null), false);
  assert.equal(licenseAllowed('All rights reserved', 'CC0'), false);
});
