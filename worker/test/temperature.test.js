import test from 'node:test';
import assert from 'node:assert/strict';
import { probeKindFor, withinLimit, requireReading, recheckDueAt, RECHECK_MINUTES } from '../src/ledger/temperature.js';

// Both limits are upper bounds, and the frozen one reads as the smaller
// number. Inverting it by accident would pass every breach silently, so the
// direction is pinned here rather than left to be obvious.

test('chilled stock is within limit at or below the limit', () => {
  assert.equal(withinLimit(4, 5), true);
  assert.equal(withinLimit(5, 5), true, 'the limit itself is acceptable');
  assert.equal(withinLimit(6, 5), false);
});

test('frozen stock is within limit at or below minus eighteen', () => {
  assert.equal(withinLimit(-20, -18), true);
  assert.equal(withinLimit(-18, -18), true);
  assert.equal(withinLimit(-10, -18), false, 'warmer than the limit is a breach');
});

test('only chilled and frozen items are probed', () => {
  // Taken from the kitchen's own records: chicken feet and femur bones carry
  // a product temperature, oil and noodles never do.
  assert.equal(probeKindFor({ storage_unopened: 'chill' }), 'chilled');
  assert.equal(probeKindFor({ storage_unopened: 'freezer' }), 'frozen');
  assert.equal(probeKindFor({ storage_unopened: 'ambient' }), null);
  assert.equal(probeKindFor({ storage_unopened: null }), null, 'undecided storage asks for nothing');
});

test('a reading no probe could produce is refused', () => {
  assert.equal(requireReading(-18, 'x'), -18);
  assert.throws(() => requireReading(-60, 'x'), /outside anything a probe should report/);
  assert.throws(() => requireReading(90, 'x'), /outside anything a probe should report/);
  assert.throws(() => requireReading('cold', 'x'), /must be a temperature/);
  assert.throws(() => requireReading(null, 'x'), /must be a temperature/);
});

test('a reading of zero is a reading, not a missing one', () => {
  assert.equal(requireReading(0, 'x'), 0);
});

test('the recheck is due half an hour after the reading', () => {
  assert.equal(RECHECK_MINUTES, 30);
  assert.equal(recheckDueAt('2026-09-20T09:00:00Z'), '2026-09-20T09:30:00.000Z');
});
