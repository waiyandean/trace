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
  state.checkpoints = checks.ok ? checks.body.rows : [];

  await loadStock();
  $('product-name').textContent = item.name;
  // Addressed by id rather than walked to from the input: a label found by
  // climbing the tree breaks the day somebody wraps the field in a div.
  $('yield-label').textContent = `How much it made, in ${item.base_unit}`;
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
    : `The recipe asks for ${target.base} ${line.ingredient_base_unit}. Earliest use-by first.`;
  $('lot-error').replaceChildren();

  const list = $('lot-list');
  list.replaceChildren();

  if (!available.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No open lots of this in stock. Record it as having no identified lot, with a reason.';
    list.append(p);
  }

  const existing = new Map((state.picks.get(line.ingredient_id)?.allocations || []).map((a) => [a.lot_id, a.quantity]));
  let remaining = target.base ?? 0;

  for (const lot of available) {
    const row = document.createElement('div');
    row.className = 'lotpick';

    const grow = document.createElement('div');
    grow.className = 'grow';
    const title = document.createElement('div');
    title.textContent = `${lot.short_code || 'no code'} · ${lot.location_name}`;
    const when = document.createElement('div');
    when.className = 'target';
    when.textContent = lot.use_by ? `use by ${lot.use_by}` : 'no use-by recorded';
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
    // Filled in first-expiring first up to what the recipe asks for, which is
    // what somebody would do by hand. Every figure stays editable.
    if (existing.has(lot.lot_id)) input.value = String(existing.get(lot.lot_id));
    else if (remaining > 0) {
      const take = Math.min(remaining, lot.quantity);
      input.value = String(+take.toFixed(3));
      remaining -= take;
    }

    row.append(grow, have, input);
    list.append(row);
  }

  $('lot-dialog').showModal();
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

function renderCheckpoints() {
  const holder = $('checkpoints');
  holder.replaceChildren();
  $('checks-section').hidden = !state.checkpoints.length;

  for (const checkpoint of state.checkpoints) {
    const row = document.createElement('div');
    row.className = 'cp';

    const grow = document.createElement('div');
    grow.className = 'grow';
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = checkpoint.label;
    if (checkpoint.is_ccp) {
      const flag = document.createElement('span');
      flag.className = 'ccp';
      flag.textContent = ' CCP';
      label.append(flag);
    }
    grow.append(label);

    const limit = document.createElement('div');
    limit.className = 'limit';
    const bounds = [
      checkpoint.min_celsius !== null ? `at least ${checkpoint.min_celsius}°C` : null,
      checkpoint.max_celsius !== null ? `no more than ${checkpoint.max_celsius}°C` : null,
    ].filter(Boolean);
    limit.textContent = bounds.length ? bounds.join(', ') : 'recorded, no limit stated';
    grow.append(limit);
    row.append(grow);

    if (checkpoint.due_minutes) {
      // Not asked for now: it falls due later and somebody comes back to it.
      const later = document.createElement('div');
      later.className = 'later';
      later.textContent =
        `Due ${checkpoint.due_minutes} minutes after ${checkpoint.anchor_code.replace(/-/g, ' ')}. ` +
        'It will be waiting on the checks screen; the batch does not need it now.';
      row.append(later);
      holder.append(row);
      continue;
    }

    if (checkpoint.kind === 'check') {
      const wrap = document.createElement('label');
      wrap.style.display = 'flex';
      wrap.style.alignItems = 'center';
      wrap.style.gap = '10px';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.code = checkpoint.code;
      box.dataset.kind = 'check';
      wrap.append(box, document.createTextNode('Confirmed'));
      row.append(wrap);
    } else if (checkpoint.kind === 'time') {
      const input = document.createElement('input');
      input.type = 'datetime-local';
      input.dataset.code = checkpoint.code;
      input.dataset.kind = 'time';
      row.append(input);
    } else {
      const input = document.createElement('input');
      input.type = 'number';
      input.step = '0.1';
      input.inputMode = 'decimal';
      input.placeholder = '°C';
      input.dataset.code = checkpoint.code;
      input.dataset.kind = 'temp';
      input.dataset.min = checkpoint.min_celsius ?? '';
      input.dataset.max = checkpoint.max_celsius ?? '';
      input.addEventListener('input', () => renderFinish());
      row.append(input);
    }

    holder.append(row);
  }
}

function readCheckpoints() {
  const given = {};
  const breaches = [];
  for (const input of $('checkpoints').querySelectorAll('[data-code]')) {
    const code = input.dataset.code;
    if (input.dataset.kind === 'check') {
      given[code] = { confirmed: input.checked };
    } else if (input.dataset.kind === 'time') {
      if (input.value) given[code] = { observed_at: new Date(input.value).toISOString() };
    } else if (input.value !== '') {
      const celsius = Number(input.value);
      given[code] = { celsius };
      const min = input.dataset.min === '' ? null : Number(input.dataset.min);
      const max = input.dataset.max === '' ? null : Number(input.dataset.max);
      if ((min !== null && celsius < min) || (max !== null && celsius > max)) {
        breaches.push(input.closest('.cp').querySelector('.label').textContent.replace(' CCP', ''));
      }
    }
  }
  return { given, breaches };
}

// ----------------------------------------------------------------- finish

function renderFinish() {
  $('finish-section').hidden = !state.product;
  if (!state.product) return;

  const problems = [];
  if (!$('staff').value) problems.push('who is making it');
  if (!Number($('yield').value)) problems.push('how much it made');
  if (!$('where').value) problems.push('where it is going');
  if (!$('equipment').checked) problems.push('that the equipment was checked');

  const unpicked = state.recipe.filter((line) => !state.picks.has(line.ingredient_id));
  if (unpicked.length) problems.push(`lots for ${unpicked.map((l) => l.ingredient_name).join(', ')}`);

  for (const checkpoint of state.checkpoints) {
    if (!checkpoint.required || checkpoint.due_minutes) continue;
    const input = $('checkpoints').querySelector(`[data-code="${checkpoint.code}"]`);
    if (input && input.dataset.kind !== 'check' && input.value === '') problems.push(checkpoint.label);
  }

  const note = $('finish-note');
  if (problems.length) {
    note.textContent = `Before this batch can be saved: ${problems.join(', ')}.`;
    $('save').disabled = true;
    return;
  }

  const { breaches } = readCheckpoints();
  const unproven = state.recipe.filter((line) => state.picks.get(line.ingredient_id)?.unproven);
  const parts = [];
  if (breaches.length) {
    parts.push(`${breaches.join(' and ')} is outside its limit, so this batch will be held until it is rechecked.`);
  }
  if (unproven.length) {
    parts.push(`${unproven.length} ingredient(s) with no identified lot will be recorded as unproven.`);
  }
  const later = state.checkpoints.filter((c) => c.due_minutes).length;
  if (later) parts.push(`${later} check(s) will be waiting on the checks screen afterwards.`);
  note.textContent = parts.join(' ') || 'Everything is picked and every check is in.';
  $('save').disabled = false;
}

function render() {
  renderIngredients();
  renderCheckpoints();
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

  const { given } = readCheckpoints();
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
      location_id: $('where').value,
      yield_quantity: Number($('yield').value),
      yield_unit: state.product.base_unit,
      multiplier: Number($('multiplier').value) || 1,
      equipment_checked: $('equipment').checked,
      checkpoints: given,
      lines,
    }),
  });

  if (!response.ok) {
    notify(response.body.error || `Refused with ${response.status}`, 'bad');
    return;
  }

  const lot = response.body.lot;
  notify(
    `${lot.item_name} recorded${lot.use_by ? `, use by ${lot.use_by}` : ''}` +
      `${lot.status === 'held' ? ' — held, a check was outside its limit' : ''}.`,
    lot.status === 'held' ? 'warn' : 'ok',
  );
  clear();
}

function clear() {
  state.product = null;
  state.recipe = [];
  state.checkpoints = [];
  state.picks = new Map();
  $('product-name').textContent = 'none chosen';
  $('yield').value = '';
  $('equipment').checked = false;
  $('multiplier').value = '1';
  $('ingredients-section').hidden = true;
  $('checks-section').hidden = true;
  $('finish-section').hidden = true;
}

// ------------------------------------------------------------------- boot

async function boot() {
  const parts = ['staff', 'locations', 'items', 'recipes'];
  const responses = await Promise.all(parts.map((action) => api(`/api/catalog?action=${action}`)));
  if (responses.some((response) => !response.ok)) {
    notify('Could not load the catalog. This screen needs a connection.', 'bad');
    return;
  }
  const [staff, locations, items, recipes] = responses.map((response) => response.body.rows);
  state.catalog = { staff, locations, items, recipes };

  fillSelect($('staff'), staff, { placeholder: 'Choose your name', selected: store.read(STAFF_KEY, null) });
  fillSelect($('where'), locations, { placeholder: 'Choose where it is going' });

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
$('yield').addEventListener('input', renderFinish);
$('where').addEventListener('change', renderFinish);
$('equipment').addEventListener('change', renderFinish);

$('pick-product').addEventListener('click', () => {
  $('product-search').value = '';
  renderProducts();
  $('product-dialog').showModal();
});
$('product-search').addEventListener('input', (event) => renderProducts(event.target.value));
$('product-cancel').addEventListener('click', () => $('product-dialog').close());

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
