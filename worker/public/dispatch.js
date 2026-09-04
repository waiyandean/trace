import { ulid, makeStore, probeKindFor } from './lib/offline.js';

// The dispatch screen: produced stock leaving for a customer.
//
// One customer, many product lines, then a single submission that writes a
// DISPATCH movement per line. Not offline-first: it is used inside on wifi at
// the freezer (Dean, 2026-09-04), and it reads live balances a cached copy
// would get wrong the moment somebody else moved something.
//
// The use-by is never entered or calculated here. Each product lot already
// carries the use-by its recipe rule set at packing, and that is what the
// customer is told — the screen only shows it.

const $ = (id) => document.getElementById(id);
const store = makeStore(window.localStorage);
const STAFF_KEY = 'trace.dispatch.staff';
const CUSTOMER_KEY = 'trace.dispatch.customer';

const state = { catalog: null, products: new Map(), rows: [], lines: [], chosen: null };

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

// A use-by inside a week is what somebody loading the van is looking for.
function daysLeft(useBy) {
  if (!useBy) return null;
  const day = 24 * 60 * 60 * 1000;
  return Math.round((new Date(`${useBy}T00:00:00Z`) - new Date().setHours(0, 0, 0, 0)) / day);
}

function soonSpan(useBy) {
  const days = daysLeft(useBy);
  if (days === null || days > 7) return null;
  const span = document.createElement('span');
  span.className = 'soon';
  span.textContent = days < 0 ? ' — past its use-by' : days === 0 ? ' — today' : ` — ${days} days`;
  return span;
}

// ------------------------------------------------------------------ reads

async function load() {
  if (!online()) {
    $('lots-empty').textContent = 'Offline. Dispatch reads stock from the server, so this screen needs a connection.';
    $('lots-empty').hidden = false;
    $('lots').replaceChildren();
    return;
  }

  const stock = await api('/api/ledger?action=stock');
  if (!stock.ok) {
    notify(`Could not read stock: ${stock.body.error || stock.status}`, 'bad');
    return;
  }
  // Every open product lot with something in it. The stock read does not
  // carry the lot origin, so the product catalog is what filters it — a
  // delivered ingredient never appears here.
  state.rows = stock.body.rows.filter(
    (row) => state.products.has(row.item_id) && row.status === 'open' && row.quantity > 0,
  );
  renderLots();
}

// The whole product list, always. A product with no lot in stock stays on
// screen greyed out rather than vanishing (Dean, 2026-09-04): staff need to
// see that it exists and that there is nothing to send, not be left guessing
// whether it was filtered or forgotten.
function renderLots() {
  const wanted = $('search').value.trim().toLowerCase();
  const taken = new Set(state.lines.map((line) => `${line.lot_id}@${line.location_id}`));

  const list = $('lots');
  list.replaceChildren();
  $('lots-empty').hidden = true;

  const products = (state.catalog?.products || []).filter(
    (product) =>
      !wanted ||
      product.name.toLowerCase().includes(wanted) ||
      state.rows.some(
        (row) => row.item_id === product.id && (row.short_code || '').toLowerCase().includes(wanted),
      ),
  );
  if (!products.length) {
    $('lots-empty').hidden = false;
    $('lots-empty').textContent = state.catalog?.products?.length
      ? `Nothing matches “${$('search').value}”.`
      : 'No products in the catalog.';
    return;
  }

  for (const product of products) {
    const stock = state.rows.filter((row) => row.item_id === product.id);
    const available = stock.filter((row) => !taken.has(`${row.lot_id}@${row.location_id}`));

    const head = document.createElement('li');
    head.className = available.length ? 'prod' : 'prod disabled';

    const grow = document.createElement('div');
    grow.className = 'grow';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = product.name;
    grow.append(name);

    if (!available.length) {
      const detail = document.createElement('div');
      detail.className = 'detail';
      detail.textContent = stock.length
        ? 'every lot in stock is already on this dispatch'
        : 'no lot in stock — cannot be dispatched';
      grow.append(detail);
      head.append(grow);
      list.append(head);
      continue;
    }

    const total = available.reduce((sum, row) => sum + row.quantity, 0);
    const qty = document.createElement('div');
    qty.className = 'qty';
    qty.textContent = `${Number(total.toFixed(3))} ${product.base_unit}`;
    head.append(grow, qty);
    list.append(head);

    for (const row of available) {
      const li = document.createElement('li');
      li.className = 'lot';

      const g = document.createElement('div');
      g.className = 'grow';
      const detail = document.createElement('div');
      detail.className = 'detail';
      const useBy = row.use_by ? `use by ${row.use_by}` : 'no use-by recorded';
      detail.textContent = `${row.short_code || 'no code'} · ${row.location_name} · ${useBy}`;
      const soon = soonSpan(row.use_by);
      if (soon) detail.append(soon);
      g.append(detail);

      const q = document.createElement('div');
      q.className = 'qty';
      q.textContent = `${row.quantity} ${row.base_unit}`;

      li.append(g, q);
      li.addEventListener('click', () => openLine(row));
      list.append(li);
    }
  }
}

// --------------------------------------------------------------- the lines

function renderLines() {
  const list = $('lines');
  list.replaceChildren();
  $('lines-section').hidden = state.lines.length === 0;

  for (const line of state.lines) {
    const li = document.createElement('li');
    li.className = 'line';

    const grow = document.createElement('div');
    grow.className = 'grow';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = `${line.quantity} ${line.base_unit} — ${line.item_name}`;
    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.textContent =
      `${line.short_code || 'no code'} · ${line.location_name}` +
      (line.use_by ? ` · use by ${line.use_by}` : '');
    grow.append(name, detail);

    const remove = document.createElement('button');
    remove.className = 'secondary';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      state.lines = state.lines.filter((other) => other !== line);
      afterLinesChanged();
    });

    li.append(grow, remove);
    list.append(li);
  }
}

// Which van temperatures the load calls for, from the storage class of the
// products on it. Shown only when relevant, and required by the server once
// shown.
function syncVehicleTemps() {
  const kinds = new Set(
    state.lines
      .map((line) => probeKindFor(state.products.get(line.item_id) || {}))
      .filter(Boolean),
  );
  $('vehicle-temps').hidden = kinds.size === 0;
  $('chilled-field').hidden = !kinds.has('chilled');
  $('frozen-field').hidden = !kinds.has('frozen');
  if (!kinds.has('chilled')) $('vehicle-chilled').value = '';
  if (!kinds.has('frozen')) $('vehicle-frozen').value = '';
}

function afterLinesChanged() {
  renderLines();
  renderLots();
  syncVehicleTemps();
  refreshSave();
}

function openLine(row) {
  state.chosen = row;
  $('line-title').textContent = row.item_name;

  const chosen = $('line-chosen');
  chosen.replaceChildren();
  const image = document.createElement('img');
  image.src = `/photos/${row.item_id}.jpg`;
  image.alt = '';
  image.addEventListener('error', () => image.remove());
  const b = document.createElement('b');
  b.textContent = `${row.quantity} ${row.base_unit} available`;
  chosen.append(image, b);

  $('line-where').textContent =
    `${row.short_code || 'no code'} · ${row.location_name}` +
    (row.use_by ? ` · use by ${row.use_by}` : '');
  $('line-quantity-label').textContent = `How much, in ${row.base_unit} (there is ${row.quantity})`;
  $('line-quantity').value = '';
  $('line-error').replaceChildren();
  $('line-dialog').showModal();
}

function addLine() {
  const row = state.chosen;
  const quantity = Number($('line-quantity').value);
  if (!(quantity > 0)) {
    $('line-error').replaceChildren(banner('Enter how much is going.'));
    return;
  }
  if (quantity > row.quantity) {
    $('line-error').replaceChildren(
      banner(`There is only ${row.quantity} ${row.base_unit} of that lot in ${row.location_name}.`),
    );
    return;
  }
  state.lines.push({
    lot_id: row.lot_id,
    item_id: row.item_id,
    item_name: row.item_name,
    short_code: row.short_code,
    base_unit: row.base_unit,
    location_id: row.location_id,
    location_name: row.location_name,
    use_by: row.use_by,
    quantity,
  });
  $('line-dialog').close();
  afterLinesChanged();
}

// ------------------------------------------------------------------ submit

function banner(text, kind = 'bad') {
  const div = document.createElement('div');
  div.className = `banner ${kind}`;
  div.textContent = text;
  return div;
}

function refreshSave() {
  $('save').disabled = !(
    $('staff').value &&
    $('customer').value &&
    $('vehicle-condition').value &&
    state.lines.length > 0
  );
}

async function save() {
  const problems = [];
  if (!$('staff').value) problems.push('choose who is sending it');
  if (!$('customer').value) problems.push('choose the customer');
  if (!$('vehicle-condition').value) problems.push('say what condition the vehicle is in');
  if (!state.lines.length) problems.push('add at least one product');
  if (!$('chilled-field').hidden && !$('vehicle-chilled').value) problems.push('take the van chilled temperature');
  if (!$('frozen-field').hidden && !$('vehicle-frozen').value) problems.push('take the van frozen temperature');
  if (problems.length) {
    $('finish-note').replaceChildren(banner(`Still needed: ${problems.join(', ')}.`));
    return;
  }

  const payload = {
    event_id: ulid(),
    idempotency_key: `dispatch-${ulid()}`,
    staff_id: $('staff').value,
    occurred_at: new Date().toISOString(),
    customer_id: $('customer').value,
    reference: $('reference').value.trim() || null,
    vehicle_condition: $('vehicle-condition').value,
    lines: state.lines.map((line) => ({
      lot_id: line.lot_id,
      location_id: line.location_id,
      quantity: line.quantity,
      unit: line.base_unit,
    })),
  };
  if (!$('chilled-field').hidden) payload.vehicle_chilled_c = Number($('vehicle-chilled').value);
  if (!$('frozen-field').hidden) payload.vehicle_frozen_c = Number($('vehicle-frozen').value);

  const response = await api('/api/dispatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    $('finish-note').replaceChildren(banner(response.body.error || `Refused with ${response.status}`));
    return;
  }

  const customerName = state.catalog.customers.find((c) => c.id === payload.customer_id)?.name || 'the customer';
  const count = state.lines.length;
  discard();
  notify(`Dispatched ${count} line${count === 1 ? '' : 's'} to ${customerName}.`, 'ok');
  await load();
}

function discard() {
  state.lines = [];
  state.chosen = null;
  $('reference').value = '';
  $('vehicle-chilled').value = '';
  $('vehicle-frozen').value = '';
  $('finish-note').replaceChildren();
  afterLinesChanged();
}

// -------------------------------------------------------------------- boot

async function boot() {
  const parts = ['staff', 'customers', 'locations', 'items'];
  const responses = await Promise.all([
    api('/api/catalog?action=staff'),
    api('/api/catalog?action=customers'),
    api('/api/catalog?action=locations'),
    api('/api/catalog?action=items&kind=product'),
  ]);
  if (responses.some((response) => !response.ok)) {
    notify('Could not load the catalog. This screen needs a connection.', 'bad');
    return;
  }
  const [staff, customers, locations, products] = responses.map((response) => response.body.rows);
  state.catalog = { staff, customers, locations, products };
  state.products = new Map(products.map((item) => [item.id, item]));

  fillSelect($('staff'), staff, { placeholder: 'Choose your name', selected: store.read(STAFF_KEY, null) });
  fillSelect($('customer'), customers, { placeholder: 'Choose the customer', selected: store.read(CUSTOMER_KEY, null) });
  if (!customers.length) {
    notify('No customers in the catalog yet. Add them before a dispatch can be recorded.', 'warn');
  }

  $('net').textContent = online() ? 'online' : 'offline';
  $('net').className = `pill ${online() ? 'ok' : 'warn'}`;

  await load();
  refreshSave();
}

$('staff').addEventListener('change', (event) => {
  store.write(STAFF_KEY, event.target.value);
  refreshSave();
});
$('customer').addEventListener('change', (event) => {
  store.write(CUSTOMER_KEY, event.target.value);
  refreshSave();
});
$('vehicle-condition').addEventListener('change', refreshSave);
$('search').addEventListener('input', renderLots);
$('line-add').addEventListener('click', addLine);
$('line-cancel').addEventListener('click', () => $('line-dialog').close());
$('save').addEventListener('click', save);
$('discard').addEventListener('click', discard);
window.addEventListener('online', boot);
window.addEventListener('offline', () => {
  $('net').textContent = 'offline';
  $('net').className = 'pill warn';
});

boot();
