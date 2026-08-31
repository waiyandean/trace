import { BadRequest } from '../http.js';

// Judging a temperature, and what follows from a bad one.
//
// The limits live in the database rather than here, because an auditor asks
// what the limit was at the time and a constant in a source file cannot
// answer that. Every reading stores the limit it was judged against, so
// tightening the limit later does not rewrite last year's history.

// How long the kitchen gives itself to take a second reading. Half an hour is
// its own existing practice, read off the deviation record it already keeps.
export const RECHECK_MINUTES = 30;

// Which items are probed. Taken from the kitchen's records rather than from a
// rule somebody made up: a product temperature appears against chicken feet,
// femur bones, diced onions and ginger root, and never against oil, noodles,
// sugar or miso. Chilled and frozen stock is probed; ambient stock is not.
export function probeKindFor(item) {
  if (item.storage_unopened === 'chill') return 'chilled';
  if (item.storage_unopened === 'freezer') return 'frozen';
  return null;
}

export async function loadLimits(db) {
  const { results } = await db.prepare('SELECT kind, celsius FROM temperature_limits').all();
  const limits = {};
  for (const row of results || []) limits[row.kind] = row.celsius;
  if (limits.chilled === undefined || limits.frozen === undefined) {
    throw new Error('temperature limits are missing from the database');
  }
  return limits;
}

// Both limits are upper bounds: chilled must be at or below 5, frozen at or
// below -18. Stated rather than assumed, because the frozen one reads as the
// smaller number and inverting it by accident would pass every breach.
export function withinLimit(celsius, limitCelsius) {
  return celsius <= limitCelsius;
}

export function requireReading(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BadRequest(`${field} must be a temperature in °C, got ${JSON.stringify(value)}`);
  }
  // A probe that reads -60 or +90 is a broken probe or a mis-key, and either
  // way the number should not enter the record unchallenged.
  if (value < -40 || value > 60) {
    throw new BadRequest(`${field} of ${value}°C is outside anything a probe should report`);
  }
  return value;
}

export function recheckDueAt(from, minutes = RECHECK_MINUTES) {
  return new Date(new Date(from).getTime() + minutes * 60_000).toISOString();
}
