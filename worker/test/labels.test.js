import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Data } from '../src/labels/data.js';
import { build, form, render } from '../src/labels/handlers.js';

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

test('a line break typed into a notice prints as a forced break, not a reflow', () => {
  const [oneLine] = build('notice', '-', { text: 'wash hands before returning to the floor' }, 1);
  const [twoLines] = build('notice', '-', { text: 'wash hands\nbefore returning to the floor' }, 1);
  assert.doesNotMatch(oneLine, /\\&/);
  assert.match(twoLines, /wash hands\\&before returning to the floor/);
});

test('a blank line typed into a notice still costs a line of space', () => {
  const [zpl] = build('notice', '-', { text: 'line one\n\nline two' }, 1);
  assert.match(zpl, /line one\\&\\&line two/);
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
});
