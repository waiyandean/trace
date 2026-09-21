import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Data } from '../src/labels/data.js';
import { build, form, render, sealInfo, sealRender } from '../src/labels/handlers.js';

const data = new Data();

function itemNamed(name) {
  return data.catalog.items.find((item) => item.name === name);
}

test('Goods In rows retain the supplier group selected by the operator', async () => {
  const rows = new Map(
    data.listing('goods-in').flatMap((group) =>
      group.sections.flatMap((section) =>
        section.items.map((item) => [`${group.name}:${item.name}`, item]))),
  );
  assert.equal(rows.get('Tazaki:Ground Bean Sauce').supplier, 'Tazaki');
  assert.equal(rows.get('Lynas:Ground Bean Sauce').supplier, 'Lynas');

  const item = itemNamed('Ground Bean Sauce');
  const selected = await form('goods-in', item.id, 'Tazaki');
  const values = Object.fromEntries(selected.fields.map((field) => [field.key, field.value]));
  assert.equal(values.supplier, 'Tazaki');
  await assert.rejects(() => form('goods-in', item.id, 'Unknown'), /not a recorded supplier/);
});

test('Date Opened tells the browser which opening rule drives use-by', async () => {
  const item = data.catalog.items.find((candidate) => candidate.days_after_opening);
  const result = await form('date-opened', item.id);
  const useBy = result.fields.find((field) => field.key === 'use_by');
  assert.equal(useBy.derive, `days:${item.days_after_opening}`);
});

test('storage stays editable even once the catalog has an answer, unlike allergens', async () => {
  const item = data.catalog.items.find((candidate) => candidate.storage_unopened && candidate.storage_unopened !== 'freezer');
  const goodsIn = await form('goods-in', item.id);
  const storage = goodsIn.fields.find((field) => field.key === 'storage');
  assert.equal(storage.editable, true);
  assert.equal(storage.value, item.storage_unopened);

  const [zpl] = build('goods-in', item.id, { storage: 'freezer' }, 1);
  assert.match(zpl, /FROZEN/);

  const opening = data.catalog.items.find((candidate) => candidate.storage_opened);
  const dateOpened = await form('date-opened', opening.id);
  const storageOpened = dateOpened.fields.find((field) => field.key === 'storage_opened');
  assert.equal(storageOpened.editable, true);
});

test('allergens are locked and rebuilt from deployed label data', async () => {
  const item = data.catalog.items.find((candidate) => data.extra.allergens[candidate.name]);
  const result = await form('goods-in', item.id);
  const allergen = result.fields.find((field) => field.key === 'allergens');
  assert.equal(allergen.editable, false);

  const [zpl] = build('goods-in', item.id, { allergens: 'FORGED DECLARATION' }, 1);
  assert.doesNotMatch(zpl, /FORGED DECLARATION/);
  assert.match(zpl, new RegExp(data.extra.allergens[item.name]));
});

test('missing allergens and invalid quantities block preparation', async () => {
  const item = data.catalog.items.find((candidate) => data.extra.allergens[candidate.name]);
  const saved = data.extra.allergens[item.name];
  delete data.extra.allergens[item.name];
  try {
    assert.throws(() => build('goods-in', item.id, {}, 1), /No allergen declaration/);
  } finally {
    data.extra.allergens[item.name] = saved;
  }

  for (const quantity of [0, 201, 1.5, null]) {
    await assert.rejects(
      () => render({ type: 'goods-in', item: item.id, values: {}, quantity, preview: false }),
      /Quantity/,
    );
  }
});

test('preparation can skip the external preview and still return exact ZPL', async () => {
  const item = data.catalog.items.find((candidate) => candidate.kind === 'ingredient');
  const result = await render({
    type: 'goods-in', item: item.id, values: { batch: '170926' },
    quantity: 1, preview: false,
  });
  assert.match(result.zpl, /^\^XA/);
  assert.equal(result.png, null);
  assert.equal(result.preview_error, '');
});

test('a line break typed into a notice starts a new field, independent of word-wrap', () => {
  // How many fields "wash hands before" auto-wraps into on its own depends
  // on the font size the label happens to fit at, so this checks the one
  // thing the typed break is meant to guarantee: "hands" and "before" never
  // land in the same field once there is a break between them, however the
  // surrounding words wrap.
  const [withBreak] = build('notice', '-', { text: 'wash hands\nbefore' }, 1);
  const texts = [...withBreak.matchAll(/\^FD([^^]*)\^FS/g)].map((m) => m[1]);
  assert.equal(texts.join(' '), 'wash hands before');
  assert.ok(texts.every((line) => !(line.includes('hands') && line.includes('before'))));
});

test('a blank line typed into a notice still costs a line of space', () => {
  const [zpl] = build('notice', '-', { text: 'line one\n\nline two' }, 1);
  assert.deepEqual(
    [...zpl.matchAll(/\^FD([^^]*)\^FS/g)].map((m) => m[1]),
    ['line one', '', 'line two'],
  );
});

test('each notice line is its own single-line ^FB, not one block with a forced break', () => {
  // A multi-line ^FB with ZPL's own \& forced break measurably throws off
  // centring on the lines after the first (checked against a real Labelary
  // render). Each visual line getting its own single-line, independently
  // centred ^FB avoids that -- so there must be one ^FB per line, none of
  // them spanning more than one line, and none of them relying on \&.
  const [zpl] = build('notice', '-', { text: 'test\ntest' }, 1);
  const blocks = [...zpl.matchAll(/\^FB(\d+),(\d+),\d+,C\^FD([^^]*)\^FS/g)];
  assert.equal(blocks.length, 2);
  for (const [, , lineCount] of blocks) assert.equal(lineCount, '1');
  assert.doesNotMatch(zpl, /\\&/);
});

test('browser derivations cover Date Opened and existing product rules', () => {
  const source = readFileSync(new URL('../public/labels/logic.js', import.meta.url), 'utf8');
  const context = { module: { exports: {} } };
  vm.runInNewContext(source, context);
  const { derive } = context.module.exports;

  assert.equal(derive('days:14', { opened: '2026-09-17' }), '2026-10-01');
  assert.equal(derive('days:1', { opened: '2028-02-28' }), '2028-02-29');
  assert.equal(derive('batch', { packed: '2026-09-17', pot: '3' }), '1709GA3');
  assert.equal(derive('months:6', { packed: '2026-09-17' }), '2027-03-01');
  assert.equal(derive('days:7', { opened: '2026-02-31' }), '');
  assert.equal(derive('years:1', { packed: '2026-09-18' }), '2027-09-18');
  // 2028 is a leap year, 2029 is not: 29 Feb falls back to 28 Feb.
  assert.equal(derive('years:1', { packed: '2028-02-29' }), '2029-02-28');
});

test('seal-info gives the Brother box seal a frozen ramen product\'s barcode and health mark', async () => {
  const info = await sealInfo('Frozen Ramen : Hell Ramen');
  assert.equal(info.barcode, data.extra.products['Frozen Ramen : Hell Ramen'].barcode);
  assert.equal(info.healthMark, true);
  assert.equal(info.category, 'Frozen Ramen');
  assert.equal(info.hmCountry, data.extra.health_mark_country);
  assert.equal(info.hmCode, data.extra.health_mark_code);
});

test('seal-info answers something ordinary rather than crashing for a product not in label-data', async () => {
  const info = await sealInfo('Not A Real Product');
  assert.equal(info.barcode, '');
  assert.equal(info.healthMark, false);
  assert.equal(info.category, '');
});

test('seal-info requires an item name', async () => {
  await assert.rejects(() => sealInfo(''), /item is required/);
});

test('box-seal lists only Frozen Ramen', () => {
  for (const group of data.listing('box-seal')) {
    for (const section of group.sections) {
      for (const row of section.items) {
        const product = data.extra.products[data.items[row.id].name];
        assert.equal(product.category, 'Frozen Ramen');
      }
    }
  }
});

test('box-seal batch and use-by derive ddmmGA and a year ahead, barcode and health mark are locked', async () => {
  const item = itemNamed('Frozen Ramen : Hell Ramen');
  const result = await form('box-seal', item.id);
  const fields = Object.fromEntries(result.fields.map((f) => [f.key, f]));
  assert.equal(fields.batch.derive, 'batch');
  assert.equal(fields.use_by.derive, 'years:1');
  assert.equal(fields.barcode.editable, false);
  assert.equal(fields.barcode.value, data.extra.products['Frozen Ramen : Hell Ramen'].barcode);
  assert.equal(fields.health_mark.editable, false);
  assert.equal(fields.health_mark.value, 'yes');
  assert.deepEqual(result.gaps, []);
});

test('seal-render locks barcode and health mark to the catalog, regardless of submitted values', async () => {
  const item = itemNamed('Frozen Ramen : Hell Ramen');
  const { seal } = await sealRender({
    item: item.id,
    values: { batch: '1809GA', use_by: '2027-09-18', barcode: '000000000000', health_mark: 'no' },
  });
  assert.equal(seal.barcode, data.extra.products['Frozen Ramen : Hell Ramen'].barcode);
  assert.equal(seal.healthMark, true);
  assert.equal(seal.batch, '1809GA');
  assert.equal(seal.useBy, '18/09/2027');
});

test('seal-render refuses a product with no box seal', async () => {
  const item = data.catalog.items.find((candidate) => candidate.kind === 'ingredient');
  await assert.rejects(
    () => sealRender({ item: item.id, values: {} }),
    /Frozen Ramen only/,
  );
});
