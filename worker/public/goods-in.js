import {
  ulid, makeStore, makeQueue, makePool, makeCatalogCache,
  unitsFor, defaultBatchCode, buildSubmission, syncQueue, POOL_TARGET,
} from './lib/offline.js';

// The goods intake form. Everything it needs to accept a delivery is on the
// device before the network is asked for anything: the catalog is cached, the
// short codes are already held, and the submission is written to the queue
// before it is sent. Losing the wifi mid-delivery slows the labels down; it
// never loses the delivery.
//
// This file is the DOM wiring only. The parts worth being sure about — id
// minting, the queue, the pool, the submission shape — live in lib/offline.js
// and are unit tested.

const $ = (id) => document.getElementById(id);

const store = makeStore(window.localStorage);
const queue = makeQueue(store);
const pool = makePool(store);
const catalogCache = makeCatalogCache(store);

const DEVICE_KEY = 'trace.intake.device';
const STAFF_KEY = 'trace.intake.staff';

const state = {
  catalog: null,
  deviceId: store.read(DEVICE_KEY, null),
  lines: [],
  editing: null,
};

// ---------------------------------------------------------------- network

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

const online = () => navigator.onLine;

// ---------------------------------------------------------------- catalog

// Fetched when there is a network and cached; used from the cache when there
// is not. The cache's age is shown, because reference data that is a week old
// is workable but a new ingredient might be missing from the list, and the
// person keying the delivery is entitled to know that.
async function loadCatalog() {
  const cached = catalogCache.read();
  if (cached) state.catalog = cached;

  if (!online()) return;

  try {
    const parts = ['items', 'locations', 'suppliers', 'staff', 'devices', 'conversions'];
    const responses = await Promise.all(parts.map((action) => api(`/api/catalog?action=${action}`)));
    if (responses.some((response) => !response.ok)) return;

    const [items, locations, suppliers, staff, devices, conversions] = responses.map((response) => response.body.rows);
    state.catalog = { items, locations, suppliers, staff, devices, conversions };
    catalogCache.write(state.catalog);
  } catch {
    // Offline in all but name. The cache stands.
  }
}

// ------------------------------------------------------------------ pool

async function refillPool({ force = false } = {}) {
  if (!state.deviceId || !online()) return;
  if (!force && !pool.isLow()) return;

  const response = await api('/api/codes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_id: state.deviceId, want: POOL_TARGET }),
  });

  if (response.ok) {
    pool.replace(state.deviceId, response.body.codes.map((row) => row.code));
  } else {
    notify(`Codes: ${response.body.error || response.status}`, 'bad');
  }
  render();
}

// --------------------------------------------------------------- alerts

const alerts = [];

function notify(message, kind = 'warn') {
  alerts.push({ message, kind });
  renderAlerts();
}

function renderAlerts() {
  $('alerts').replaceChildren(
    ...alerts.slice(-3).map((entry) => {
      const div = document.createElement('div');
      div.className = `banner ${entry.kind}`;
      div.style.borderRadius = '12px';
      div.style.marginBottom = '12px';
      div.textContent = entry.message;
      return div;
    }),
  );
}

// -------------------------------------------------------------- rendering

function fillSelect(select, rows, { value = 'id', label = 'name', placeholder = null, selected = null } = {}) {
  select.replaceChildren();
  if (placeholder) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = placeholder;
    select.append(option);
  }
  for (const row of rows) {
    const option = document.createElement('option');
    option.value = row[value];
    option.textContent = row[label];
    if (row[value] === selected) option.selected = true;
    select.append(option);
  }
}

function itemById(id) {
  return (state.catalog?.items || []).find((item) => item.id === id) || null;
}

function locationById(id) {
  return (state.catalog?.locations || []).find((row) => row.id === id) || null;
}

function renderLines() {
  const list = $('lines');
  list.replaceChildren();
  $('lines-empty').hidden = state.lines.length > 0;

  for (const line of state.lines) {
    const item = itemById(line.item_id);
    const location = locationById(line.location_id);

    const li = document.createElement('li');

    const grow = document.createElement('div');
    grow.className = 'grow';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = item ? item.name : line.item_id;
    grow.append(name);

    const detail = document.createElement('div');
    detail.className = 'detail';
    const useBy = line.use_by
      ? `use by ${line.use_by} (from the box)`
      : `use by not printed — ${item ? item.shelf_life_days : 7} days will be applied`;
    detail.textContent = `${line.quantity} ${line.unit} → ${location ? location.name : line.location_id} · ${useBy}`;
    grow.append(detail);

    li.append(grow);

    const code = document.createElement('div');
    if (line.short_code) {
      code.className = 'code';
      code.textContent = line.short_code;
    } else {
      code.className = 'code none';
      code.textContent = 'no code';
    }
    li.append(code);

    const remove = document.createElement('button');
    remove.className = 'danger';
    remove.textContent = 'Remove';
    remove.style.minHeight = '36px';
    remove.style.padding = '6px 12px';
    remove.addEventListener('click', () => {
      pool.giveBack(line.short_code);
      state.lines = state.lines.filter((other) => other.lot_id !== line.lot_id);
      render();
    });
    li.append(remove);

    list.append(li);
  }
}

function renderStatus() {
  const net = $('net');
  net.textContent = online() ? 'online' : 'offline';
  net.className = `pill ${online() ? 'ok' : 'warn'}`;

  const remaining = pool.remaining();
  const poolPill = $('pool');
  poolPill.textContent = `codes ${remaining}`;
  poolPill.className = `pill ${remaining === 0 ? 'bad' : pool.isLow() ? 'warn' : 'ok'}`;

  const pending = queue.pending().length;
  const rejected = queue.rejected().length;
  $('queue-count').textContent = rejected ? `${pending} · ${rejected}!` : String(pending);
}

function renderSubmitNote() {
  const note = $('submit-note');
  const problems = [];
  if (!$('staff').value) problems.push('who is booking it in');
  if (!$('supplier').value) problems.push('the supplier');
  if (!state.deviceId) problems.push('which device this is');
  if (!state.lines.length) problems.push('at least one ingredient');

  if (problems.length) {
    note.textContent = `Still needed: ${problems.join(', ')}.`;
    $('submit').disabled = true;
    return;
  }

  const withoutCode = state.lines.filter((line) => !line.short_code).length;
  note.textContent = withoutCode
    ? `${state.lines.length} line(s). ${withoutCode} has no short code — book it in anyway and relabel when codes are back.`
    : `${state.lines.length} line(s). Write each short code on that case's label before it goes into storage.`;
  $('submit').disabled = false;
}

function renderDeviceNote() {
  const note = $('device-note');
  if (!state.deviceId) {
    note.textContent = 'Choose which device this is before booking anything in. Codes are issued per device, so two iPads never print the same one.';
    return;
  }
  const cached = state.catalog?.cached_at;
  note.textContent = cached
    ? `Catalog last refreshed ${new Date(cached).toLocaleString()}.`
    : 'Catalog has never been cached on this device.';
}

function render() {
  renderStatus();
  renderLines();
  renderSubmitNote();
  renderDeviceNote();
}

// ------------------------------------------------------------ line dialog

function openLineDialog() {
  if (!state.catalog) {
    notify('The catalog has not been loaded on this device yet. Connect once, then this will work offline.', 'bad');
    return;
  }

  const ingredients = state.catalog.items
    .filter((item) => item.kind === 'ingredient')
    .sort((a, b) => a.name.localeCompare(b.name));

  fillSelect($('line-item'), ingredients, { placeholder: 'Choose an ingredient' });
  fillSelect($('line-location'), state.catalog.locations, { placeholder: 'Choose where it is going' });
  $('line-quantity').value = '';
  $('line-use-by').value = '';
  $('line-batch').value = defaultBatchCode();
  $('line-error').replaceChildren();
  onItemChange();
  $('line-dialog').showModal();
}

// The units offered are exactly the ones the conversions master can reach the
// base unit from. Offering anything else would put a refusal in front of
// somebody holding a box.
function onItemChange() {
  const item = itemById($('line-item').value);
  const unitSelect = $('line-unit');
  if (!item) {
    fillSelect(unitSelect, [], { placeholder: 'Choose an ingredient first' });
    $('line-use-by-note').textContent = '';
    return;
  }
  const units = unitsFor(item, state.catalog.conversions).map((unit) => ({ id: unit, name: unit }));
  fillSelect(unitSelect, units, { selected: units.length > 1 ? 'case' : item.base_unit });

  $('line-use-by-note').textContent =
    `Leave the use-by empty if the box has no printed date: ${item.shelf_life_days} days from today will be ` +
    'applied and recorded as a rule rather than as the supplier’s date.';
}

function saveLine() {
  const problems = [];
  const item = itemById($('line-item').value);
  const quantity = Number($('line-quantity').value);
  const unit = $('line-unit').value;
  const locationId = $('line-location').value;

  if (!item) problems.push('choose an ingredient');
  if (!(quantity > 0)) problems.push('enter how many');
  if (!unit) problems.push('choose a unit');
  if (!locationId) problems.push('choose where it is going');

  if (problems.length) {
    const div = document.createElement('div');
    div.className = 'banner bad';
    div.textContent = `Still needed: ${problems.join(', ')}.`;
    $('line-error').replaceChildren(div);
    return;
  }

  // The code is taken now, at the moment the line is added, because that is
  // when the label is written. If the pool is empty the line is still added.
  const shortCode = pool.take();

  state.lines.push({
    lot_id: ulid(),
    item_id: item.id,
    short_code: shortCode,
    quantity,
    unit,
    location_id: locationId,
    use_by: $('line-use-by').value || null,
    batch_code: $('line-batch').value || null,
  });

  $('line-dialog').close();
  render();
  refillPool();
}

// -------------------------------------------------------------- submitting

async function submitDelivery() {
  const draft = {
    device_id: state.deviceId,
    staff_id: $('staff').value,
    supplier_id: $('supplier').value,
    invoice: $('invoice').value.trim(),
    occurred_at: $('occurred').value ? new Date($('occurred').value) : new Date(),
    lines: state.lines,
  };

  const submission = buildSubmission(draft);

  // Queued before it is sent, always. If this device dies on the next line
  // the delivery is still on it.
  if (!queue.add(submission)) {
    notify('This device would not store the submission, so it has NOT been sent. Do not clear the screen: write the delivery down.', 'bad');
    return;
  }

  state.lines = [];
  $('invoice').value = '';
  render();
  notify('Booked in and queued. Write each short code on its case.', 'ok');

  await drainQueue();
}

async function drainQueue() {
  const results = await syncQueue(queue, async (payload) =>
    api('/api/receive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );

  if (results.rejected) notify(`${results.rejected} submission(s) were refused. Open the queue to see why.`, 'bad');
  if (results.waiting) notify('Waiting for a connection. Nothing is lost; it will send itself.', 'warn');

  // The server decides what the pool holds, so a successful sync is the right
  // moment to reconcile: codes bound by a submission this device never heard
  // back about are gone from the pool afterwards.
  if (results.sent) await refillPool({ force: true });
  render();
}

// ------------------------------------------------------------ queue dialog

function renderQueue() {
  const body = $('queue-body');
  const entries = queue.all();
  body.replaceChildren();

  if (!entries.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Nothing waiting. Every delivery keyed on this device has been accepted.';
    body.append(p);
    return;
  }

  for (const entry of entries.slice().reverse()) {
    const div = document.createElement('div');
    div.className = 'queue-entry';

    const heading = document.createElement('div');
    const lines = entry.payload.lines.length;
    heading.textContent = `${entry.status} — ${lines} line(s), invoice ${entry.payload.invoice || 'not given'}`;
    div.append(heading);

    const when = document.createElement('div');
    when.className = 'when';
    when.textContent = `keyed ${new Date(entry.queued_at).toLocaleString()}, ${entry.attempts} attempt(s)`;
    div.append(when);

    if (entry.error) {
      const why = document.createElement('div');
      why.className = 'why';
      why.textContent = entry.error;
      div.append(why);
    }
    body.append(div);
  }
}

// -------------------------------------------------------------------- boot

async function boot() {
  await loadCatalog();

  if (!state.catalog) {
    notify('No catalog on this device and no connection. Connect once before using this at the door.', 'bad');
  } else {
    fillSelect($('staff'), state.catalog.staff, { placeholder: 'Choose your name', selected: store.read(STAFF_KEY, null) });
    fillSelect($('supplier'), state.catalog.suppliers, { placeholder: 'Choose the supplier' });
  }

  // Which of the registered devices this iPad is. Registration itself is a
  // deliberate act in the database; this only records the choice, and it is
  // remembered so nobody has to make it twice.
  const devices = state.catalog?.devices || [];
  fillSelect($('device'), devices, { placeholder: 'Not set', selected: state.deviceId });

  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  $('occurred').value = now.toISOString().slice(0, 16);

  render();
  await refillPool();
  await drainQueue();
}

$('staff').addEventListener('change', (event) => {
  store.write(STAFF_KEY, event.target.value);
  renderSubmitNote();
});
$('supplier').addEventListener('change', renderSubmitNote);
$('device').addEventListener('change', (event) => {
  state.deviceId = event.target.value || null;
  store.write(DEVICE_KEY, state.deviceId);
  render();
  refillPool({ force: true });
});

$('add-line').addEventListener('click', openLineDialog);
$('line-item').addEventListener('change', onItemChange);
$('line-save').addEventListener('click', saveLine);
$('line-cancel').addEventListener('click', () => $('line-dialog').close());

$('submit').addEventListener('click', submitDelivery);
$('discard').addEventListener('click', () => {
  if (!state.lines.length) return;
  if (!window.confirm('Discard every line on this delivery?')) return;
  for (const line of state.lines) pool.giveBack(line.short_code);
  state.lines = [];
  render();
});

$('open-queue').addEventListener('click', () => {
  renderQueue();
  $('queue-dialog').showModal();
});
$('queue-sync').addEventListener('click', async () => {
  await drainQueue();
  renderQueue();
});
$('queue-clear').addEventListener('click', () => {
  queue.clearSent();
  renderQueue();
  render();
});
$('queue-close').addEventListener('click', () => $('queue-dialog').close());

window.addEventListener('online', () => {
  render();
  refillPool();
  drainQueue();
});
window.addEventListener('offline', render);

boot();
