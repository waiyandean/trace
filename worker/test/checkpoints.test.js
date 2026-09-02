import test from 'node:test';
import assert from 'node:assert/strict';
import { judge, planReadings } from '../src/ledger/checkpoints.js';

// The checks a batch is made under. Three outcomes, and the third is the
// common one: forty-four of the kitchen's sixty checkpoints state no limit.

const cp = (over = {}) => ({
  id: 'cp1', code: 'cooking-end-temp', label: 'Cooking end temp', kind: 'temp',
  is_ccp: 1, required: 1, min_celsius: null, max_celsius: null,
  anchor_code: null, due_minutes: null, min_duration_hours: null, sort_order: 1, ...over,
});

const envelope = { occurred_at: '2026-09-02T09:00:00Z', staff_id: 'staff:nikin' };

test('a reading with no stated limit is unjudged, not passed', () => {
  // Calling it a pass would be a claim nobody made.
  assert.equal(judge(cp(), 95), null);
});

test('a maximum is checked when stated', () => {
  assert.equal(judge(cp({ max_celsius: 30 }), 29), true);
  assert.equal(judge(cp({ max_celsius: 30 }), 30), true, 'the limit itself passes');
  assert.equal(judge(cp({ max_celsius: 30 }), 31), false);
});

test('a minimum is checked when stated', () => {
  assert.equal(judge(cp({ min_celsius: 75 }), 80), true);
  assert.equal(judge(cp({ min_celsius: 75 }), 70), false);
});

test('both bounds apply when both are stated', () => {
  const both = cp({ min_celsius: 1, max_celsius: 5 });
  assert.equal(judge(both, 3), true);
  assert.equal(judge(both, 0), false);
  assert.equal(judge(both, 6), false);
});

test('every checkpoint becomes an unanswered row, due now or later', () => {
  // The batch records what went in. The cooking temperature is taken while it
  // cooks, so asking for it on that form would be asking somebody to type a
  // number before it existed.
  const { rows } = planReadings([cp()], {}, 'lot1', 'ev1', envelope);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].answered, null);
  assert.equal(rows[0].dueAt, envelope.occurred_at, 'taken during the batch, so due now');
});

test('a timed checkpoint is left unanswered with the moment it falls due', () => {
  // "Cooling temp after 12 hours" is not a field somebody fills in at the
  // end: it is a reading due twelve hours after cooling started.
  const start = cp({ code: 'cooling-start-temp', label: 'Cooling start temp' });
  const after = cp({
    code: 'cooling-after', label: 'Cooling temp after 12 hours', kind: 'temp-after',
    max_celsius: 30, anchor_code: 'cooling-start-temp', due_minutes: 720, sort_order: 2,
  });

  const { rows } = planReadings([start, after], { 'cooling-start-temp': { celsius: 80 } }, 'lot1', 'ev1', envelope);
  const pending = rows.find((row) => row.checkpoint.code === 'cooling-after');
  assert.equal(pending.answered, null, 'it is not answered yet');
  assert.equal(pending.dueAt, '2026-09-02T21:00:00.000Z', 'twelve hours after the batch');
});

test('the clock runs from the anchor reading when one was observed', () => {
  const start = cp({ code: 'cooling-start', kind: 'time' });
  const after = cp({
    code: 'cooling-end', kind: 'temp-after', max_celsius: 5,
    anchor_code: 'cooling-start', due_minutes: 60, sort_order: 2,
  });
  const { rows } = planReadings(
    [start, after], { 'cooling-start': { observed_at: '2026-09-02T14:00:00Z' } },
    'lot1', 'ev1', envelope,
  );
  assert.equal(rows[1].dueAt, '2026-09-02T15:00:00.000Z', 'an hour after cooling actually started');
});

test('a timed checkpoint runs from the batch until its anchor is answered', () => {
  // At the moment the ingredients go in, the anchor has not been read. The
  // clock starts from the batch and is reset when the anchor is answered.
  const after = cp({ kind: 'temp-after', anchor_code: 'cooling-start', due_minutes: 60 });
  const { rows } = planReadings([after], {}, 'lot1', 'ev1', envelope);
  assert.equal(rows[0].dueAt, '2026-09-02T10:00:00.000Z', 'an hour after the batch began');
});

test('a reading outside its limit is reported as a breach', () => {
  const { breaches } = planReadings(
    [cp({ max_celsius: 30 })], { 'cooking-end-temp': { celsius: 45 } }, 'lot1', 'ev1', envelope,
  );
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].celsius, 45);
});

test('a confirmation is true or false, not a temperature', () => {
  const check = cp({ kind: 'check', code: 'equipment' });
  assert.throws(
    () => planReadings([check], { equipment: { celsius: 20 } }, 'lot1', 'ev1', envelope),
    /is confirmed or not/,
  );
  const { rows } = planReadings([check], { equipment: { confirmed: true } }, 'lot1', 'ev1', envelope);
  assert.equal(rows[0].answered.confirmed, 1);
});

test('a time checkpoint records a moment, not a measurement', () => {
  const when = cp({ kind: 'time', code: 'cooling-start' });
  assert.throws(
    () => planReadings([when], { 'cooling-start': { celsius: 80 } }, 'lot1', 'ev1', envelope),
    /records a moment/,
  );
});

test('a cooking temperature is not judged against a fridge probe range', () => {
  // Boiling water and hot oil read far above anything a delivery would.
  const { rows } = planReadings([cp()], { 'cooking-end-temp': { celsius: 95 } }, 'lot1', 'ev1', envelope);
  assert.equal(rows[0].answered.celsius, 95);
  assert.throws(
    () => planReadings([cp()], { 'cooking-end-temp': { celsius: 400 } }, 'lot1', 'ev1', envelope),
    /outside anything a probe should report/,
  );
});
