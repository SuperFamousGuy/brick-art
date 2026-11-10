import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../../src/sources/csv.ts';

test('parseCsv handles quoted fields with commas and escaped quotes', () => {
  assert.deepEqual(parseCsv('a,b\n1,"x, ""y"""\n'), [{ a: '1', b: 'x, "y"' }]);
});

test('parseCsv handles CRLF line ends and a trailing newline', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n3,4\r\n'), [
    { a: '1', b: '2' },
    { a: '3', b: '4' },
  ]);
});

test('parseCsv handles missing trailing newline, empty fields, and embedded newlines', () => {
  assert.deepEqual(parseCsv('a,b\n1,\n"x\ny",2'), [
    { a: '1', b: '' },
    { a: 'x\ny', b: '2' },
  ]);
});

test('parseCsv returns no rows for empty input', () => {
  assert.deepEqual(parseCsv(''), []);
});
