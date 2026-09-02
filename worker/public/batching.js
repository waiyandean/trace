import { ulid, makeStore } from './lib/offline.js';

// The batching form.
//
// It follows the shape of the one the kitchen already uses — pick the product
// from a grid of photographs, work down its ingredients, record the checks —
// and adds the one thing that form cannot do: say which lot each ingredient
// came from.
//
// Read live, like the stock screen and unlike goods-in. Batching happens
// inside on wifi (PLAN.md, "Where the iPad actually is") and it needs lot
// balances that a cached copy would get wrong the moment somebody else took
// something.

const $ = (id) => document.getElementById(id);
const store = makeStore(window.localStorage);
const STAFF_KEY = 'trace.intake.staff';

const state = {
  catalog: null,
  product: null,
  recipe: [],
  checkpoints: [],
  stock: {},
  picks: new Map(),   // ingredient id -> { allocations } or { unproven }
  editing: null,
};

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

const online = () => navigator.onLine;

function notify(message, kind = 'warn') {
  const div = document.createElement('div');
  div.className = `banner ${kind}`;
  div.style.borderRadius = '12px';
  div.style.marginBottom = '12px';
  div.textContent = message;
  $('alerts').replaceChildren(div);
}

function fillSelect(select, rows, { placeholder = null, selected = null } = {}) {
  select.replaceChildren();
  if (placeholder) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = placeholder;
    select.append(option);
  }
  for (const row of rows) {
    const option = document.createElement('option');
    option.value = row.id;
    option.textContent = row.name;
    if (row.id === selected) option.selected = true;
    select.append(option);
  }
}

function thumbnail(itemId) {
  const image = document.createElement('img');
  image.src = `/photos/${itemId}.jpg`;
  image.alt = '';
  image.loading = 'lazy';
  image.addEventListener('error', () => {
    const fallback = document.createElement('div');
    fallback.className = 'noimg';
    image.replaceWith(fallback);
  });
  return image;
}

// The recipe states its own units; the ledger works in the item's base unit.
// Only the two conversions that need no evidence are done here — a spelling
// and a metric prefix — and anything else is left to the server, which has
// the conversions master. A line the form cannot convert is shown in the
// recipe's own words rather than guessed at.
function toBase(quantity, unit, baseUnit) {
  const same = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const canonical = (u) => (same(u, 'litres') || same(u, 'litre') ? 'L' : u.trim());
  const from = canonical(unit);
  const to = canonical(baseUnit);
  if (same(from, to)) return quantity;
  if (same(from, 'g') && same(to, 'kg')) return quantity / 1000;
  if (same(from, 'ml') && same(to, 'L')) return quantity / 1000;
  return null;
}

function targetFor(line) {
  const multiplier = Number($('multiplier').value) || 1;
  const base = toBase(line.quantity, line.unit, line.ingredient_base_unit);
  return {
    stated: `${+(line.quantity * multiplier).toFixed(3)} ${line.unit}`,
    base: base === null ? null : +(base * multiplier).toFixed(4),
  };
}

// ------------------------------------------------------------------ reads

async function loadStock() {
  const response = await api('/api/ledger?action=stock');
  if (!response.ok) {
    notify(`Could not read stock: ${response.body.error || response.status}`, 'bad');
    return;
  }
  state.stock = {};
  for (const row of response.body.rows) {
    if (row.status !== 'open') continue;  // held stock cannot go into a batch
    (state.stock[row.item_id] ||= []).push(row);
  }
  // First-expiring first, which is the order stock should be picked in.
  for (const rows of Object.values(state.stock)) {
    rows.sort((a, b) => String(a.use_by || '9999').localeCompare(String(b.use_by || '9999')));
  }
}

// ------------------------------------------------------------ the product

function renderProducts(filter = '') {
  const wanted = filter.trim().toLowerCase();
  const groups = $('product-groups');
  groups.replaceChildren();

  const withRecipe = new Set(state.catalog.recipes.map((row) => row.item_id));
  const products = state.catalog.items
    .filter((item) => item.kind === 'product' && item.name.toLowerCase().includes(wanted))
    .sort((a, b) => a.name.localeCompare(b.name));

  // A product with no recipe cannot be batched through one. Shown, greyed,
  // with the reason — hiding it would leave somebody hunting for a product
  // they can see on the shelf.
  for (const [label, rows] of [
    ['Ready to batch', products.filter((item) => withRecipe.has(item.id))],
    ['No recipe recorded', products.filter((item) => !withRecipe.has(item.id))],
  ]) {
    if (!rows.length) continue;
    const heading = document.createElement('div');
    heading.className = rows === products.filter((i) => withRecipe.has(i.id)) ? 'group-head' : 'group-head backup';
    heading.textContent = label;
    groups.append(heading);

    const tiles = document.createElement('div');
    tiles.className = 'tiles';
    for (const item of rows) {
      const tile = document.createElement('button');
      tile.className = 'tile';
      tile.type = 'button';
      tile.append(thumbnail(item.id));
      const name = document.createElement('span');
      name.textContent = item.name;
      tile.append(name);
      if (withRecipe.has(item.id)) {
        tile.addEventListener('click', () => chooseProduct(item));
      } else {
        tile.disabled = true;
        tile.title = 'no recipe recorded';
      }
      tiles.append(tile);
    }
    groups.append(tiles);
  }
}

async function chooseProduct(item) {
  $('product-dialog').close();
  state.product = item;
  state.picks = new Map();

  const [recipe, checks] = await Promise.all([
    api(`/api/catalog?action=recipes&item=${encodeURIComponent(item.id)}`),
    api(`/api/catalog?action=checkpoints&item=${encodeURIComponent(item.id)}`),
  ]);
  state.recipe = recipe.ok ? recipe.body.rows : [];
  // Not asked for here, only counted: the form says what will be waiting
  // rather than pretending these can be answered now.
  state.checkpoints = checks.ok ? checks.body.rows : [];

  await loadStock();
  $('product-name').textContent = item.name;
  render();
}

// -------------------------------------------------------------- the lines

function renderIngredients() {
  const list = $('ingredients');
  list.replaceChildren();
  $('ingredients-section').hidden = !state.recipe.length;

  for (const line of state.recipe) {
    const target = targetFor(line);
    const pick = state.picks.get(line.ingredient_id);

    const li = document.createElement('li');
    li.className = 'ing';

    const head = document.createElement('div');
    head.className = 'head';
    head.append(thumbnail(line.ingredient_id));

    const grow = document.createElement('div');
    grow.className = 'grow';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = line.ingredient_name;
    const targetLine = document.createElement('div');
    targetLine.className = 'target';
    targetLine.textContent = target.base === null
      ? `recipe asks for ${target.stated} — this cannot be converted to ${line.ingredient_base_unit}`
      : `recipe asks for ${target.stated}`;
    grow.append(name, targetLine);
    head.append(grow);
    li.append(head);

    const picked = document.createElement('div');
    picked.className = 'picked';
    if (pick?.unproven) {
      const div = document.createElement('div');
      div.className = 'unproven';
      div.textContent = `no identified lot — ${pick.unproven.quantity} ${line.ingredient_base_unit}: ${pick.unproven.reason}`;
      picked.append(div);
    } else if (pick?.allocations?.length) {
      let total = 0;
      for (const allocation of pick.allocations) {
        total += allocation.quantity;
        const div = document.createElement('div');
        div.textContent =
          `${allocation.quantity} ${line.ingredient_base_unit} from ${allocation.short_code || 'no code'}` +
          `${allocation.use_by ? ` · use by ${allocation.use_by}` : ''}`;
        picked.append(div);
      }
      const summary = document.createElement('div');
      const short = target.base !== null && total + 0.0001 < target.base;
      summary.className = short ? 'short' : 'done';
      summary.textContent = short
        ? `${+total.toFixed(3)} of ${target.base} ${line.ingredient_base_unit} — still short`
        : `${+total.toFixed(3)} ${line.ingredient_base_unit} picked`;
      picked.append(summary);
    } else {
      const div = document.createElement('div');
      div.className = 'short';
      div.textContent = 'no lot picked yet';
      picked.append(div);
    }
    li.append(picked);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const pickButton = document.createElement('button');
    pickButton.className = pick ? 'secondary' : '';
    pickButton.textContent = pick ? 'Change' : 'Pick lots';
    pickButton.addEventListener('click', () => openLots(line));
    actions.append(pickButton);
    li.append(actions);

    list.append(li);
  }
}

function openLots(line) {
  state.editing = line;
  const target = targetFor(line);
  const available = state.stock[line.ingredient_id] || [];

  $('lot-title').textContent = line.ingredient_name;
  $('lot-note').textContent = target.base === null
    ? `The recipe asks for ${target.stated}, which cannot be converted to ${line.ingredient_base_unit}. Enter what was used.`
    : `The recipe asks for ${target.base} ${line.ingredient_base_unit}. Enter what was actually used from each case.`;
  $('lot-error').replaceChildren();
  $('lot-code').value = '';
  $('lot-code-note').textContent =
    'Earliest use-by first below. Or type the short code, or the batch number.';

  const list = $('lot-list');
  list.replaceChildren();

  if (!available.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No open lots of this in stock. Record it as having no identified lot, with a reason.';
    list.append(p);
  }

  const existing = new Map((state.picks.get(line.ingredient_id)?.allocations || []).map((a) => [a.lot_id, a.quantity]));

  for (const lot of available) {
    const row = document.createElement('div');
    row.className = 'lotpick';
    row.dataset.lot = lot.lot_id;

    const grow = document.createElement('div');
    grow.className = 'grow';
    const title = document.createElement('div');
    title.textContent = `${lot.short_code || 'no code'} · ${lot.location_name}`;
    const when = document.createElement('div');
    when.className = 'target';
    // The batch number is shown because it is what staff read off the label,
    // and the use-by because it is what tells two cases of one batch apart.
    when.textContent =
      [lot.batch_code ? `batch ${lot.batch_code}` : null,
       lot.use_by ? `use by ${lot.use_by}` : 'no use-by recorded'].filter(Boolean).join(' · ');
    grow.append(title, when);

    const have = document.createElement('div');
    have.className = 'qty';
    have.textContent = `${lot.quantity} ${line.ingredient_base_unit}`;

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = 'any';
    input.inputMode = 'decimal';
    input.dataset.lot = lot.lot_id;
    input.dataset.location = lot.location_id;
    input.dataset.available = String(lot.quantity);
    // Deliberately not pre-filled, even though the arithmetic is obvious
    // (Dean, 2026-09-02). A figure the form put there records that the form
    // was submitted, not that anybody checked the label — and a wrong one
    // gets left alone precisely because it looks already done. The only
    // values here are ones somebody keyed after reading the case.
    if (existing.has(lot.lot_id)) input.value = String(existing.get(lot.lot_id));

    row.append(grow, have, input);
    list.append(row);
  }

  $('lot-dialog').showModal();
}

// The code on the label is the way in. Typing or scanning it is the act of
// having looked at the case, which is the thing a pre-filled quantity
// quietly removed.
//
// Crockford's alphabet excludes I, L, O and U precisely so a mistyped
// character is decodable rather than ambiguous, so those are folded rather
// than rejected.
function normaliseCode(text) {
  return text.trim().toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0');
}

// Show only the rows a search matched, so the disambiguation is the list
// itself rather than a sentence somebody has to act on.
function showOnly(lotIds) {
  for (const row of $('lot-list').children) {
    if (!row.dataset || !row.dataset.lot) continue;
    row.hidden = lotIds !== null && !lotIds.includes(row.dataset.lot);
  }
}

function findByCode() {
  const line = state.editing;
  const typed = $('lot-code').value.trim();
  const code = normaliseCode(typed);
  const note = $('lot-code-note');
  const available = state.stock[line.ingredient_id] || [];

  if (!typed) {
    showOnly(null);
    note.textContent = 'Earliest use-by first below. Or type the short code, or the batch number.';
    return;
  }

  // The short code identifies exactly one case, so it wins.
  const byShortCode = available.find((lot) => (lot.short_code || '') === code);
  if (byShortCode) {
    showOnly([byShortCode.lot_id]);
    note.textContent =
      `${byShortCode.short_code} — ${byShortCode.location_name}, ` +
      `${byShortCode.quantity} ${line.ingredient_base_unit} left`;
    return;
  }

  // Then the batch number, which staff read off the label today and which is
  // the delivery's date. It does not identify a case on its own — every case
  // of one ingredient delivered on a day carries the same one — but inside
  // this ingredient's own stock it usually names one, and where it names
  // several the list narrows to them and the use-by tells them apart. That is
  // asking rather than guessing, which is the whole reason the system stopped
  // joining on this number.
  const byBatch = available.filter((lot) => (lot.batch_code || '').toUpperCase() === typed.toUpperCase());
  if (byBatch.length === 1) {
    showOnly([byBatch[0].lot_id]);
    note.textContent =
      `Batch ${byBatch[0].batch_code} — ${byBatch[0].location_name}, ` +
      `${byBatch[0].quantity} ${line.ingredient_base_unit} left` +
      `${byBatch[0].use_by ? `, use by ${byBatch[0].use_by}` : ''}`;
    return;
  }
  if (byBatch.length > 1) {
    showOnly(byBatch.map((lot) => lot.lot_id));
    const dates = [...new Set(byBatch.map((lot) => lot.use_by || 'no use-by'))];
    note.textContent =
      `${byBatch.length} cases of ${line.ingredient_name} carry batch ${typed}. ` +
      (dates.length > 1
        ? 'They are shown below — the use-by tells them apart.'
        : 'They are shown below and share a use-by, so pick by where each one is.');
    return;
  }

  showOnly(null);
  // Said precisely rather than "not found": which of these it is decides what
  // the person does next.
  const elsewhere = Object.values(state.stock)
    .flat()
    .find((lot) => (lot.short_code || '') === code || (lot.batch_code || '').toUpperCase() === typed.toUpperCase());
  note.textContent = elsewhere
    ? `${typed} is ${elsewhere.item_name}, not ${line.ingredient_name}.`
    : `${typed} matches no open case of ${line.ingredient_name}. ` +
      'If the case has no label, use "No labelled lot" and say why.';
}

function saveLots() {
  const line = state.editing;
  const allocations = [];
  const problems = [];

  for (const input of $('lot-list').querySelectorAll('input')) {
    const quantity = Number(input.value);
    if (!input.value || quantity === 0) continue;
    if (!(quantity > 0)) {
      problems.push('a quantity must be more than zero');
      continue;
    }
    const available = Number(input.dataset.available);
    if (quantity > available) {
      problems.push(`only ${available} ${line.ingredient_base_unit} is in that lot`);
      continue;
    }
    const lot = (state.stock[line.ingredient_id] || []).find((row) => row.lot_id === input.dataset.lot);
    allocations.push({
      lot_id: input.dataset.lot,
      location_id: input.dataset.location,
      quantity,
      unit: line.ingredient_base_unit,
      short_code: lot?.short_code,
      use_by: lot?.use_by,
    });
  }

  if (!allocations.length) problems.push('pick at least one lot, or record it as having no identified lot');

  if (problems.length) {
    const div = document.createElement('div');
    div.className = 'banner bad';
    div.textContent = problems.join('. ');
    $('lot-error').replaceChildren(div);
    return;
  }

  state.picks.set(line.ingredient_id, { allocations });
  $('lot-dialog').close();
  render();
}

// ------------------------------------------------------------ checkpoints

// ----------------------------------------------------------------- finish

function renderFinish() {
  $('finish-section').hidden = !state.product;
  if (!state.product) return;

  const problems = [];
  if (!$('staff').value) problems.push('who is making it');
  if (!$('equipment').checked) problems.push('that the equipment was checked');

  const unpicked = state.recipe.filter((line) => !state.picks.has(line.ingredient_id));
  if (unpicked.length) problems.push(`lots for ${unpicked.map((l) => l.ingredient_name).join(', ')}`);

  const note = $('finish-note');
  if (problems.length) {
    note.textContent = `Before this batch can be saved: ${problems.join(', ')}.`;
    $('save').disabled = true;
    return;
  }

  const unproven = state.recipe.filter((line) => state.picks.get(line.ingredient_id)?.unproven);
  const parts = [];
  if (unproven.length) {
    parts.push(`${unproven.length} ingredient(s) with no identified lot will be recorded as unproven.`);
  }
  if (state.checkpoints.length) {
    parts.push(
      `${state.checkpoints.length} check(s) will be waiting under open batches — ` +
        'the temperatures, and how much it made when it is packed.',
    );
  }
  note.textContent = parts.join(' ');
  $('save').disabled = false;
}

function render() {
  renderIngredients();
  renderFinish();
}

async function save() {
  const lines = state.recipe.map((line) => {
    const pick = state.picks.get(line.ingredient_id);
    if (pick.unproven) {
      return {
        item_id: line.ingredient_id,
        unproven: {
          quantity: pick.unproven.quantity,
          unit: line.ingredient_base_unit,
          reason: pick.unproven.reason,
        },
      };
    }
    return {
      item_id: line.ingredient_id,
      allocations: pick.allocations.map(({ lot_id, location_id, quantity, unit }) => ({
        lot_id, location_id, quantity, unit,
      })),
    };
  });

  const response = await api('/api/produce', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event_id: ulid(),
      idempotency_key: `batch-${ulid()}`,
      staff_id: $('staff').value,
      occurred_at: $('made').value ? new Date($('made').value).toISOString() : new Date().toISOString(),
      lot_id: ulid(),
      item_id: state.product.id,
      multiplier: Number($('multiplier').value) || 1,
      equipment_checked: $('equipment').checked,
      lines,
    }),
  });

  if (!response.ok) {
    notify(response.body.error || `Refused with ${response.status}`, 'bad');
    return;
  }

  const lot = response.body.lot;
  notify(
    `${lot.item_name} started${lot.use_by ? `, use by ${lot.use_by}` : ''}. ` +
      'Its checks and its packing are waiting under open batches.',
    'ok',
  );
  clear();
  countOpenBatches();
}

function clear() {
  state.product = null;
  state.recipe = [];
  state.checkpoints = [];
  state.picks = new Map();
  $('product-name').textContent = 'none chosen';
  $('equipment').checked = false;
  $('multiplier').value = '1';
  $('ingredients-section').hidden = true;
  $('finish-section').hidden = true;
}

// ------------------------------------------------------------------- boot

// The count sits in the header so a batch waiting on its temperatures is
// visible from the page somebody is already on.
async function countOpenBatches() {
  const response = await api('/api/batches');
  if (response.ok) $('open-count').textContent = response.body.count ? String(response.body.count) : '';
}

async function boot() {
  const parts = ['staff', 'items', 'recipes'];
  const responses = await Promise.all(parts.map((action) => api(`/api/catalog?action=${action}`)));
  if (responses.some((response) => !response.ok)) {
    notify('Could not load the catalog. This screen needs a connection.', 'bad');
    return;
  }
  const [staff, items, recipes] = responses.map((response) => response.body.rows);
  state.catalog = { staff, items, recipes };

  fillSelect($('staff'), staff, { placeholder: 'Choose your name', selected: store.read(STAFF_KEY, null) });
  await countOpenBatches();

  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  $('made').value = now.toISOString().slice(0, 16);

  $('net').textContent = online() ? 'online' : 'offline';
  $('net').className = `pill ${online() ? 'ok' : 'warn'}`;
}

$('staff').addEventListener('change', (event) => {
  store.write(STAFF_KEY, event.target.value);
  renderFinish();
});
$('multiplier').addEventListener('input', render);
$('equipment').addEventListener('change', renderFinish);

$('pick-product').addEventListener('click', () => {
  $('product-search').value = '';
  renderProducts();
  $('product-dialog').showModal();
});
$('product-search').addEventListener('input', (event) => renderProducts(event.target.value));
$('product-cancel').addEventListener('click', () => $('product-dialog').close());

$('lot-code').addEventListener('input', findByCode);
$('lot-done').addEventListener('click', saveLots);
$('lot-cancel').addEventListener('click', () => $('lot-dialog').close());
$('lot-unproven').addEventListener('click', () => {
  $('lot-dialog').close();
  $('unproven-qty').value = '';
  $('unproven-why').value = '';
  $('unproven-error').replaceChildren();
  $('unproven-dialog').showModal();
});
$('unproven-save').addEventListener('click', () => {
  const quantity = Number($('unproven-qty').value);
  const reason = $('unproven-why').value.trim();
  if (!(quantity > 0) || reason.length < 3) {
    const div = document.createElement('div');
    div.className = 'banner bad';
    div.textContent = 'How much was used, and why there is no lot. The reason is what makes the gap reviewable later.';
    $('unproven-error').replaceChildren(div);
    return;
  }
  state.picks.set(state.editing.ingredient_id, { unproven: { quantity, reason } });
  $('unproven-dialog').close();
  render();
});
$('unproven-cancel').addEventListener('click', () => $('unproven-dialog').close());

$('save').addEventListener('click', save);
$('discard').addEventListener('click', () => {
  if (!window.confirm('Clear this batch?')) return;
  clear();
});

boot();
