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

const state = {
  catalog: null, products: new Map(), rows: [], lines: [], chosen: null, chosenProduct: null,
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

// The dispatch screen's grouping of the product list (Dean, 2026-09-04),
// derived from the catalog's own naming rather than a stored field:
//
//   - the intermediate broths from which the ramen is built are named
//     "… (Soup)" and are not dispatched at all, so they are hidden here;
//   - the retail frozen lines are all "Frozen Ramen : …";
//   - the two broths that do ship carry "Broth";
//   - everything else is a sauce.
//
// If this grouping ever has to be authoritative it belongs on `items`, not
// in this file — for now it is one screen's view of the catalog.
const DISPATCH_GROUPS = ['Broths', 'Frozen Ramen', 'Sauces'];

function groupFor(product) {
  const name = product.name.trim();
  if (/\(soup\)$/i.test(name)) return null;
  if (/^frozen ramen\b/i.test(name)) return 'Frozen Ramen';
  if (/\bbroth\b/i.test(name)) return 'Broths';
  return 'Sauces';
}

function buildTile(product, taken) {
  const stock = state.rows.filter((row) => row.item_id === product.id);
  const available = stock.filter((row) => !taken.has(`${row.lot_id}@${row.location_id}`));

  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'tile';
  tile.append(thumbnail(product.id));

  const grow = document.createElement('div');
  grow.className = 'grow';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = product.name;
  const status = document.createElement('div');
  status.className = 'status';
  grow.append(name, status);
  tile.append(grow);

  if (available.length) {
    const total = Number(available.reduce((sum, row) => sum + row.quantity, 0).toFixed(3));
    status.textContent =
      `${total} ${product.base_unit} · ${available.length} lot${available.length === 1 ? '' : 's'}`;
    tile.addEventListener('click', () => openProduct(product, available));
  } else {
    tile.disabled = true;
    status.textContent = stock.length ? 'every lot already added' : 'no lot in stock';
  }
  return tile;
}

// The product list as a grid of photographs under group headings — the same
// picker shape the goods-in and batching screens use. A product with no lot
// in stock stays on the grid greyed out and not tappable (Dean, 2026-09-04):
// staff need to see it exists and that there is nothing to send, rather than
// wonder whether it was filtered out.
function renderLots() {
  const wanted = $('search').value.trim().toLowerCase();
  const taken = new Set(state.lines.map((line) => `${line.lot_id}@${line.location_id}`));

  const container = $('lots');
  container.replaceChildren();
  $('lots-empty').hidden = true;

  const visible = (state.catalog?.products || [])
    .filter((product) => groupFor(product) !== null)
    .filter(
      (product) =>
        !wanted ||
        product.name.toLowerCase().includes(wanted) ||
        state.rows.some(
          (row) => row.item_id === product.id && (row.short_code || '').toLowerCase().includes(wanted),
        ),
    );

  if (!visible.length) {
    $('lots-empty').hidden = false;
    $('lots-empty').textContent = state.catalog?.products?.length
      ? `Nothing matches “${$('search').value}”.`
      : 'No products in the catalog.';
    return;
  }

  for (const group of DISPATCH_GROUPS) {
    const inGroup = visible.filter((product) => groupFor(product) === group);
    if (!inGroup.length) continue;

    const heading = document.createElement('h3');
    heading.className = 'grouphdr';
    heading.textContent = group;
    container.append(heading);

    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const product of inGroup) grid.append(buildTile(product, taken));
    container.append(grid);
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

function openProduct(product, lots) {
  state.chosenProduct = product;
  state.chosen = null;
  $('line-title').textContent = product.name;

  const chosen = $('line-chosen');
  chosen.replaceChildren();
  const total = Number(lots.reduce((sum, row) => sum + row.quantity, 0).toFixed(3));
  const b = document.createElement('b');
  b.textContent = `${total} ${product.base_unit} in stock`;
  chosen.append(thumbnail(product.id), b);

  $('line-error').replaceChildren();
  $('line-quantity').value = '';

  if (lots.length === 1) {
    pickLot(lots[0]);
  } else {
    // Several lots: make the person say which one is going, first-expiring
    // first. Nothing is chosen for them — entering a quantity against a lot
    // they did not look at is the pre-filled-figure mistake in another shape.
    $('line-pick-note').hidden = false;
    $('line-quantity-row').hidden = true;
    $('line-add').hidden = true;
    const box = $('line-lots');
    box.hidden = false;
    box.replaceChildren();
    const ordered = [...lots].sort((a, b2) => String(a.use_by).localeCompare(String(b2.use_by)));
    for (const lot of ordered) {
      const row = document.createElement('div');
      row.className = 'lotrow';
      const g = document.createElement('div');
      g.className = 'grow';
      const detail = document.createElement('div');
      detail.className = 'detail';
      const useBy = lot.use_by ? `use by ${lot.use_by}` : 'no use-by recorded';
      detail.textContent = `${lot.short_code || 'no code'} · ${lot.location_name} · ${useBy}`;
      const soon = soonSpan(lot.use_by);
      if (soon) detail.append(soon);
      g.append(detail);
      const q = document.createElement('div');
      q.className = 'qty';
      q.textContent = `${lot.quantity} ${lot.base_unit}`;
      row.append(g, q);
      row.addEventListener('click', () => pickLot(lot));
      box.append(row);
    }
  }
  $('line-dialog').showModal();
}

function pickLot(lot) {
  state.chosen = lot;
  $('line-lots').hidden = true;
  $('line-pick-note').hidden = true;
  $('line-quantity-row').hidden = false;
  $('line-add').hidden = false;
  $('line-where').textContent =
    `${lot.short_code || 'no code'} · ${lot.location_name}` +
    (lot.use_by ? ` · use by ${lot.use_by}` : '');
  $('line-quantity-label').textContent = `How much, in ${lot.base_unit} (there is ${lot.quantity})`;
  $('line-quantity').value = '';
  $('line-error').replaceChildren();
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
