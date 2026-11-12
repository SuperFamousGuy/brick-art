import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutBooklet, placeCells } from '../../src/instructions/layout.ts';
import { fakeModel, fakeStep, section } from '../helpers/fake-steps.ts';


test('layout puts the cover first and parts last', () => {
  const m = fakeModel([section('test', Array.from({ length: 7 }, (_, i) => fakeStep(i + 1)))]);
  assert.deepEqual(layoutBooklet(m).map((p) => p.kind), ['cover', 'steps', 'steps', 'parts']);
});

test('big steps span two slots and never split', () => {
  const steps = [fakeStep(1, { callouts: 1 }), fakeStep(2, { callouts: 1 }), fakeStep(3, { callouts: 1 }), fakeStep(4)];
  const pages = layoutBooklet(fakeModel([section('test', steps)])).filter((p) => p.kind === 'steps');
  assert.deepEqual(pages.map((p) => p.cells!.map((c) => c.step)), [[1, 2, 3], [4]]);
  assert.deepEqual(pages[0]!.cells!.map((c) => c.span), [2, 2, 2]);
});

test('more than four loose parts takes two slots', () => {
  const pages = layoutBooklet(fakeModel([section('test', [fakeStep(1, { loose: 5 }), fakeStep(2, { loose: 4 })])]));
  assert.deepEqual(pages[1]!.cells!.map((c) => c.span), [2, 1]);
});

test('a step that does not fit in order starts the next page', () => {
  const steps = [fakeStep(1), fakeStep(2), fakeStep(3), fakeStep(4, { callouts: 1 })];
  const pages = layoutBooklet(fakeModel([section('test', steps)])).filter((p) => p.kind === 'steps');
  assert.deepEqual(pages.map((p) => p.cells!.map((c) => c.step)), [[1, 2, 3], [4]]);
});

test('placeCells fills the grid in reading order', () => {
  assert.deepEqual(placeCells([2, 1, 1, 1, 1]), [
    { row: 0, col: 0, rows: 2 }, { row: 0, col: 1, rows: 1 }, { row: 0, col: 2, rows: 1 },
    { row: 1, col: 1, rows: 1 }, { row: 1, col: 2, rows: 1 },
  ]);
  assert.equal(placeCells([1, 1, 1, 1, 1, 1, 1]), null);
});

test('section dividers only with more than one section', () => {
  const hull = section('hull', [fakeStep(1), fakeStep(2)]);
  const main = section('test', [fakeStep(3)]);
  const pages = layoutBooklet(fakeModel([hull, main]));
  assert.deepEqual(pages.map((p) => [p.kind, p.sectionId]), [
    ['cover', undefined], ['section', 'hull'], ['steps', 'hull'], ['section', 'test'], ['steps', 'test'], ['parts', undefined],
  ]);
  assert.ok(!layoutBooklet(fakeModel([main])).some((p) => p.kind === 'section'));
});
