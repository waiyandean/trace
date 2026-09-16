import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGoodsInLabel } from '../public/lib/zpl.js';

// This is the one label goods-in.js prints on its own, separate from
// labels/gui (Dean, 2026-09-16). See public/lib/zpl.js for why.

test('carries the short code as both text and the QR payload', () => {
  const zpl = buildGoodsInLabel({
    name: 'Chicken Carcass', shortCode: 'k7m4qp', batch: '160926',
    useBy: '2026-09-20', delivered: '2026-09-16', supplier: 'Lynas', quantity: 3,
  });
  // Printed upper-case regardless of how it was minted, matching every other
  // place a short code is shown.
  assert.match(zpl, /\^FDK7M4QP\^FS/);
  assert.match(zpl, /\^BQN,2,6\^FDQA,K7M4QP\^FS/);
});

test('a use-by prints; a missing one says where to look instead of a blank', () => {
  const withDate = buildGoodsInLabel({
    name: 'X', shortCode: 'ABCDEF', batch: '1', useBy: '2026-10-01', delivered: '2026-09-16', supplier: 'S',
  });
  assert.match(withDate, /\^FD2026-10-01\^FS/);
  assert.doesNotMatch(withDate, /See product packaging/);

  const withoutDate = buildGoodsInLabel({
    name: 'X', shortCode: 'ABCDEF', batch: '1', useBy: null, delivered: '2026-09-16', supplier: 'S',
  });
  assert.match(withoutDate, /See product packaging/);
});

test('the batch and quantity land where a case label needs them', () => {
  const zpl = buildGoodsInLabel({
    name: 'X', shortCode: 'ABCDEF', batch: '160926', useBy: null, delivered: '2026-09-16', supplier: 'S', quantity: 5,
  });
  assert.match(zpl, /\^FD160926\^FS/);
  assert.match(zpl, /\^PQ5/);
});

test('quantity defaults to one and is never printed as zero or a fraction', () => {
  const zpl = buildGoodsInLabel({
    name: 'X', shortCode: 'ABCDEF', batch: '1', useBy: null, delivered: '2026-09-16', supplier: 'S', quantity: 0,
  });
  assert.match(zpl, /\^PQ1$/m);
});

test('^ and ~ in a name cannot be read as ZPL markup', () => {
  const zpl = buildGoodsInLabel({
    name: 'Weird^Name~Here', shortCode: 'ABCDEF', batch: '1', useBy: null, delivered: '2026-09-16', supplier: 'S',
  });
  assert.doesNotMatch(zpl, /\^FDWeird\^Name/);
  assert.match(zpl, /\^FDWeird Name Here\^FS/);
});

test('sets ^BY explicitly, the same trap labels/gui already paid for', () => {
  const zpl = buildGoodsInLabel({
    name: 'X', shortCode: 'ABCDEF', batch: '1', useBy: null, delivered: '2026-09-16', supplier: 'S',
  });
  assert.match(zpl, /\^BY2,3,10/);
});

test('opens and closes exactly one label', () => {
  const zpl = buildGoodsInLabel({
    name: 'X', shortCode: 'ABCDEF', batch: '1', useBy: null, delivered: '2026-09-16', supplier: 'S',
  });
  assert.equal((zpl.match(/\^XA/g) || []).length, 1);
  assert.equal((zpl.match(/\^XZ/g) || []).length, 1);
});
