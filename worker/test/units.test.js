import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFactor, toBaseUnit } from '../src/ledger/units.js';
import { fakeDb } from './fakeDb.js';

// The conversions the catalog actually holds: most ingredients reach their
// base unit through an item, bulk meat goes straight from a case to kilograms.
const perItem = [
  { id: 'c1', from_unit: 'case', to_unit: 'item', factor: 6 },
  { id: 'c2', from_unit: 'item', to_unit: 'kg', factor: 0.5 },
];
const bulk = [{ id: 'c3', from_unit: 'case', to_unit: 'kg', factor: 8 }];

test('the same unit needs no conversion', () => {
  assert.deepEqual(resolveFactor(perItem, 'kg', 'kg'), { factor: 1, path: [] });
});

test('a two-hop conversion multiplies both stated hops', () => {
  const resolved = resolveFactor(perItem, 'case', 'kg');
  assert.equal(resolved.factor, 3);
  assert.deepEqual(resolved.path, ['case->item', 'item->kg']);
});

test('a single-hop bulk case converts in one step', () => {
  assert.equal(resolveFactor(bulk, 'case', 'kg').factor, 8);
});

test('a hop reads backwards as well as forwards', () => {
  assert.equal(resolveFactor(bulk, 'kg', 'case').factor, 1 / 8);
});

test('a unit with no recorded path resolves to nothing rather than a guess', () => {
  assert.equal(resolveFactor(perItem, 'pallet', 'kg'), null);
});

test('toBaseUnit refuses a unit the catalog cannot convert', async () => {
  const db = fakeDb(() => perItem);
  const item = { id: 'i1', name: 'Chicken Carcass', base_unit: 'kg' };
  await assert.rejects(() => toBaseUnit(db, item, 3, 'pallet'), /no recorded conversion from pallet to kg/);
});

test('toBaseUnit converts what was keyed and says how', async () => {
  const db = fakeDb(() => bulk);
  const item = { id: 'i1', name: 'Chicken Carcass', base_unit: 'kg' };
  const converted = await toBaseUnit(db, item, 3, 'case');
  assert.equal(converted.quantity, 24);
  assert.deepEqual(converted.path, ['case->kg']);
});

test('a quantity of zero or less is refused', async () => {
  const db = fakeDb(() => bulk);
  const item = { id: 'i1', name: 'Chicken Carcass', base_unit: 'kg' };
  await assert.rejects(() => toBaseUnit(db, item, 0, 'case'), /greater than zero/);
});
