import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGoodsInLabel, buildPackingLabel, buildDateOpenedLabel } from '../public/lib/zpl.js';

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
  assert.match(withDate, /\^FD01\/10\/2026\^FS/);
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

// -------------------------------------------------------- buildPackingLabel

test('carries the short code as both text and the QR payload', () => {
  const zpl = buildPackingLabel({
    name: 'Tonkotsu Broth', shortCode: 'k7m4qp', batch: '1609GA1',
    useBy: '2026-10-16', packed: '2026-09-16', quantity: 20,
  });
  assert.match(zpl, /\^FDK7M4QP\^FS/);
  assert.match(zpl, /\^BQN,2,6\^FDQA,K7M4QP\^FS/);
});

test('a use-by prints; a missing one says so rather than a blank', () => {
  const withDate = buildPackingLabel({
    name: 'X', shortCode: 'ABCDEF', batch: '1609GA', useBy: '2026-10-01', packed: '2026-09-16',
  });
  assert.match(withDate, /\^FD01\/10\/2026\^FS/);

  const withoutDate = buildPackingLabel({
    name: 'X', shortCode: 'ABCDEF', batch: '1609GA', useBy: null, packed: '2026-09-16',
  });
  assert.match(withoutDate, /No shelf life recorded/);
});

test('the batch code and packet count land where a packet label needs them', () => {
  const zpl = buildPackingLabel({
    name: 'X', shortCode: 'ABCDEF', batch: '1609GA3', useBy: null, packed: '2026-09-16', quantity: 48,
  });
  assert.match(zpl, /\^FD1609GA3\^FS/);
  assert.match(zpl, /\^PQ48$/m);
});

test('quantity defaults to one and is never printed as zero', () => {
  const zpl = buildPackingLabel({
    name: 'X', shortCode: 'ABCDEF', batch: '1609GA', useBy: null, packed: '2026-09-16', quantity: 0,
  });
  assert.match(zpl, /\^PQ1$/m);
});

test('opens and closes exactly one label', () => {
  const zpl = buildPackingLabel({
    name: 'X', shortCode: 'ABCDEF', batch: '1609GA', useBy: null, packed: '2026-09-16',
  });
  assert.equal((zpl.match(/\^XA/g) || []).length, 1);
  assert.equal((zpl.match(/\^XZ/g) || []).length, 1);
});

test('every date prints UK-style, dd/mm/yyyy, not the yyyy-mm-dd it arrives in', () => {
  const zpl = buildGoodsInLabel({
    name: 'X', shortCode: 'ABCDEF', batch: '1', useBy: '2026-01-05', delivered: '2026-12-31', supplier: 'S',
  });
  assert.match(zpl, /\^FD05\/01\/2026\^FS/);
  assert.match(zpl, /Delivered 31\/12\/2026/);
});

// -------------------------------------------------------------- health mark

test('the oval prints only when the item needs it', () => {
  const without = buildGoodsInLabel({
    name: 'X', shortCode: 'ABCDEF', batch: '1', useBy: null, delivered: '2026-09-16', supplier: 'S',
  });
  assert.doesNotMatch(without, /\^GE150,58,3\^FS/);

  const withMark = buildGoodsInLabel({
    name: 'Chicken Carcass', shortCode: 'ABCDEF', batch: '1', useBy: null, delivered: '2026-09-16',
    supplier: 'S', healthMark: true,
  });
  assert.match(withMark, /\^GE150,58,3\^FS/);
  assert.match(withMark, /\^FDGB\\&\^FS/);
  assert.match(withMark, /\^FDGA 121\\&\^FS/);
});

test('the packing label carries the same oval when the product needs it', () => {
  const zpl = buildPackingLabel({
    name: 'Chicken Broth', shortCode: 'ABCDEF', batch: '1609GA1', useBy: '2027-09-01',
    packed: '2026-09-16', healthMark: true,
  });
  assert.match(zpl, /\^GE150,58,3\^FS/);
  assert.match(zpl, /\^FDGB\\&\^FS/);
  assert.match(zpl, /\^FDGA 121\\&\^FS/);
});

test('the packing label mirrors labels/gui\'s product layout, not the case label\'s', () => {
  const zpl = buildPackingLabel({
    name: 'Chicken Broth', shortCode: 'ABCDEF', batch: '1609GA1',
    useBy: '2027-09-01', packed: '2026-09-16', healthMark: true,
  });
  // CODE is a small caption under the QR, not the 72pt block letters the
  // Goods In case label uses, and it does not occupy either of Packed/Qty's
  // rows.
  assert.match(zpl, /\^FO622,264\^A0N,20\^FB150,1,0,C\^FDABCDEF\^FS/);
  assert.doesNotMatch(zpl, /A0N,72,72/);
  assert.doesNotMatch(zpl, /\^FT180,256\^A0N,30\^FDABCDEF\^FS/);
  // USE BY and BATCH sit side by side near the top, matching labels/gui's
  // positions exactly, not the lower band the case label uses.
  assert.match(zpl, /\^FO40,112\^A0N,20\^FDUSE BY\^FS/);
  assert.match(zpl, /\^FO450,112\^A0N,20\^FDBATCH\^FS/);
  // The QR sits in the same corner labels/gui's SKU QR does.
  assert.match(zpl, /\^FO622,110\^BQN,2,6\^FDQA,ABCDEF\^FS/);
  // The oval takes the same no-barcode slot labels/gui's does.
  assert.match(zpl, /\^FO450,196\^GE150,58,3\^FS/);
  // Chicken Broth's real pack size, in labels/gui's own Qty slot.
  assert.match(zpl, /\^FT40,256\^A0N,22\^FDQty\^FS/);
  assert.match(zpl, /\^FT180,256\^A0N,30\^FD1\.8 Litres\^FS/);
});

test('a product with no known pack size leaves the Qty row out rather than showing it empty', () => {
  const zpl = buildPackingLabel({
    name: 'Something Nobody Has Checked', shortCode: 'ABCDEF', batch: '1609GA', useBy: null, packed: '2026-09-16',
  });
  assert.doesNotMatch(zpl, /FDQty/);
});

// -------------------------------------------------------- allergens/producer

test('a known product prints its declared allergens and disclaimer', () => {
  const zpl = buildPackingLabel({
    name: 'Chicken Broth', shortCode: 'ABCDEF', batch: '1609GA1', useBy: '2027-09-01', packed: '2026-09-16',
  });
  assert.match(zpl, /ALLERGENS: Gluten, Sesame, Soya/);
  assert.match(zpl, /May contain Peanuts and other allergens/);
});

test('an unlisted product says "Not recorded" rather than guessing', () => {
  const zpl = buildPackingLabel({
    name: 'Something Nobody Has Checked', shortCode: 'ABCDEF', batch: '1609GA', useBy: null, packed: '2026-09-16',
  });
  assert.match(zpl, /ALLERGENS: Not recorded/);
  assert.match(zpl, /May contain other allergens/);
});

test('every packing label carries the producer line', () => {
  const zpl = buildPackingLabel({
    name: 'X', shortCode: 'ABCDEF', batch: '1609GA', useBy: null, packed: '2026-09-16',
  });
  assert.match(zpl, /Produced by: AAHQ LTD, 90 Renfield Street, Glasgow/);
});

test('the allergen box sits below everything the label already draws', () => {
  const zpl = buildPackingLabel({
    name: 'Chicken Broth', shortCode: 'ABCDEF', batch: '1609GA1', useBy: '2027-09-01',
    packed: '2026-09-16', healthMark: true,
  });
  assert.match(zpl, /\^FO40,292\^GB732,52,2\^FS/);
});

// ----------------------------------------------------- buildDateOpenedLabel

test('carries the short code as both text and the QR payload', () => {
  const zpl = buildDateOpenedLabel({
    name: 'Hoi Sin Sauce 20kg', shortCode: 'abcdef', batch: '160926',
    opened: '2026-09-17', useBy: '2026-10-29', storageOpened: 'chill',
  });
  assert.match(zpl, /\^FDABCDEF\^FS/);
  assert.match(zpl, /\^BQN,2,6\^FDQA,ABCDEF\^FS/);
});

test('the whole-label border is what tells it apart from Goods In', () => {
  const zpl = buildDateOpenedLabel({
    name: 'X', shortCode: 'ABCDEF', batch: '160926', opened: '2026-09-17', useBy: null, storageOpened: 'ambient',
  });
  assert.match(zpl, /\^FO0,0\^GB812,406,8\^FS/);
});

test('the storage banner and footer follow the after-opening requirement', () => {
  const chilled = buildDateOpenedLabel({
    name: 'X', shortCode: 'ABCDEF', batch: '1', opened: '2026-09-17', useBy: null, storageOpened: 'chill',
  });
  assert.match(chilled, /FDCHILLED\^FS/);
  assert.match(chilled, /REFRIGERATE AFTER OPENING/);

  const frozen = buildDateOpenedLabel({
    name: 'X', shortCode: 'ABCDEF', batch: '1', opened: '2026-09-17', useBy: null, storageOpened: 'freezer',
  });
  assert.match(frozen, /FDFROZEN\^FS/);
  assert.match(frozen, /DO NOT REFREEZE/);
});

test('an unrecorded storage requirement still prints a safe default footer', () => {
  const zpl = buildDateOpenedLabel({
    name: 'X', shortCode: 'ABCDEF', batch: '1', opened: '2026-09-17', useBy: null, storageOpened: null,
  });
  assert.match(zpl, /KEEP SEALED/);
});

test('opened date and use-by both print dd/mm/yyyy', () => {
  const zpl = buildDateOpenedLabel({
    name: 'X', shortCode: 'ABCDEF', batch: '1', opened: '2026-09-17', useBy: '2026-10-29', storageOpened: 'chill',
  });
  assert.match(zpl, /\^FD17\/09\/2026\^FS/);
  assert.match(zpl, /\^FD29\/10\/2026\^FS/);
});

test('opens and closes exactly one label', () => {
  const zpl = buildDateOpenedLabel({
    name: 'X', shortCode: 'ABCDEF', batch: '1', opened: '2026-09-17', useBy: null, storageOpened: 'ambient',
  });
  assert.equal((zpl.match(/\^XA/g) || []).length, 1);
  assert.equal((zpl.match(/\^XZ/g) || []).length, 1);
});
