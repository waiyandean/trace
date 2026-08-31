import {
  ulid, makeStore, makeQueue, makePool, makeCatalogCache,
  unitsFor, defaultBatchCode, buildSubmission, syncQueue, POOL_TARGET,
  groupByStorage, soleLocationFor, forSupplier, splitByRole, usualSupplierFor,
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
    const parts = ['items', 'locations', 'suppliers', 'staff', 'devices', 'conversions', 'item_suppliers'];
    const responses = await Promise.all(parts.map((action) => api(`/api/catalog?action=${action}`)));
    if (responses.some((response) => !response.ok)) return;

    const [items, locations, suppliers, staff, devices, conversions, itemSuppliers] =
      responses.map((response) => response.body.rows);
    state.catalog = { items, locations, suppliers, staff, devices, conversions, itemSuppliers };
    catalogCache.write(state.catalog);
  } catch {
    // Offline in all but name. The cache stands.
  }
}

// ------------------------------------------------------------------ pool

// Why the pool is the size it is, in words, so an empty pool is never a
// mystery to somebody stood at the door. Every path through refillPool sets
// it.
state.poolReason = null;

async function refillPool({ force = false } = {}) {
  if (!state.deviceId) {
    state.poolReason = 'No codes yet: this iPad is not registered as a device.';
    render();
    return;
  }
  if (!online()) {
    state.poolReason = 'Offline, so no more codes can be fetched. What is held will be used.';
    render();
    return;
  }
  if (!force && !pool.isLow()) return;

  try {
    const response = await api('/api/codes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_id: state.deviceId, want: POOL_TARGET }),
    });

    if (response.ok) {
      pool.replace(state.deviceId, response.body.codes.map((row) => row.code));
      state.poolReason = null;
      // Lines added while the pool was empty get a code as soon as one
      // exists. They have not been submitted yet, so nothing has been printed
      // against them and there is no relabelling to do.
      for (const line of state.lines) {
        if (!line.short_code) line.short_code = pool.take();
      }
    } else {
      state.poolReason = `The server would not issue codes: ${response.body.error || response.status}`;
      notify(state.poolReason, 'bad');
    }
  } catch {
    state.poolReason = 'Could not reach the server for codes. What is held will be used.';
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
    if (item) {
      const image = thumbnail(item);
      image.style.width = '44px';
      image.style.height = '44px';
      image.style.borderRadius = '10px';
      image.style.objectFit = 'cover';
      image.style.flex = 'none';
      li.append(image);
    }

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
  if (!state.deviceId) problems.push('a registered device');
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
  const devices = state.catalog?.devices || [];

  if (!state.deviceId) {
    note.textContent = devices.length
      ? 'Choose which device this is before adding anything. Codes are issued per device, so two iPads never print the same one.'
      : 'No device is registered, so no short codes can be issued to this one. Register it in the database before using this at the door.';
    return;
  }

  const name = devices.find((row) => row.id === state.deviceId)?.name || state.deviceId;
  const parts = [`${name}. ${pool.remaining()} short codes held.`];
  if (state.poolReason) parts.push(state.poolReason);
  const cached = state.catalog?.cached_at;
  parts.push(cached
    ? `Catalog last refreshed ${new Date(cached).toLocaleString()}.`
    : 'Catalog has never been cached on this device.');
  note.textContent = parts.join(' ');
}

function render() {
  renderStatus();
  renderLines();
  renderSubmitNote();
  renderDeviceNote();
}

// ------------------------------------------------------------ line dialog

// The picker. Staff recognise their stock by the photograph faster than by
// reading a name, and the kitchen already has a picture of every ingredient,
// so this is a grid of pictures rather than a list to scroll. The grouping
// and the location default are in lib/offline.js, where they are tested.
function allIngredients() {
  return (state.catalog?.items || [])
    .filter((item) => item.kind === 'ingredient')
    .sort((a, b) => a.name.localeCompare(b.name));
}

function ingredientsForSupplier() {
  return forSupplier(allIngredients(), state.catalog?.itemSuppliers || [], $('supplier').value || null);
}

// Narrowed to the chosen supplier unless the person has asked to see
// everything. The escape hatch matters: the mapping came from the kitchen's
// records rather than from first principles, so a filter must never be the
// reason a delivery cannot be booked in.
function ingredients() {
  return state.showEveryIngredient ? allIngredients() : ingredientsForSupplier();
}

// A photograph is served from this origin, so it works offline once cached.
// An item without one gets its name on a plain tile: a stand-in picture of
// something else would be worse than no picture at all.
function thumbnail(item, className = '') {
  const image = document.createElement('img');
  image.src = `/photos/${item.id}.jpg`;
  image.alt = '';
  image.loading = 'lazy';
  image.className = className;
  image.addEventListener('error', () => {
    const fallback = document.createElement('div');
    fallback.className = `noimg ${className}`;
    fallback.textContent = 'no photo';
    image.replaceWith(fallback);
  });
  return image;
}

function renderPicker(filter = '') {
  const groups = $('picker-groups');
  groups.replaceChildren();

  renderPickerScope();

  // Backups are drawn after everything else, under their own heading, so the
  // everyday grid stays the everyday grid.
  const { everyday, backup } = state.showEveryIngredient
    ? { everyday: ingredients(), backup: [] }
    : splitByRole(ingredients(), state.catalog?.itemSuppliers || [], $('supplier').value || null);

  const tileFor = (item) => {
    const tile = document.createElement('button');
    tile.className = 'tile';
    tile.type = 'button';
    tile.append(thumbnail(item));
    const name = document.createElement('span');
    name.textContent = item.name;
    tile.append(name);
    tile.addEventListener('click', () => {
      $('picker-dialog').close();
      openLineDialog(item);
    });
    return tile;
  };

  const drawGroup = (label, items, isBackup = false) => {
    const heading = document.createElement('div');
    heading.className = isBackup ? 'group-head backup' : 'group-head';
    heading.textContent = label;
    groups.append(heading);

    const tiles = document.createElement('div');
    tiles.className = isBackup ? 'tiles backup' : 'tiles';
    for (const item of items) tiles.append(tileFor(item));
    groups.append(tiles);
  };

  for (const group of groupByStorage(everyday, filter)) drawGroup(group.label, group.items);

  if (backup.length) {
    const wanted = filter.trim().toLowerCase();
    const matching = backup.filter((item) => item.name.toLowerCase().includes(wanted));
    if (matching.length) {
      const mapping = state.catalog?.itemSuppliers || [];
      const usual = (item) => {
        const id = usualSupplierFor(item.id, mapping);
        return (state.catalog?.suppliers || []).find((row) => row.id === id)?.name;
      };
      const names = [...new Set(matching.map(usual).filter(Boolean))];
      drawGroup(
        names.length === 1 ? `Backup only — normally ${names[0]}` : 'Backup only',
        matching,
        true,
      );
    }
  }

  if (!groups.children.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = filter
      ? `Nothing matches “${filter}”.`
      : 'No ingredients to show. Try showing everything.';
    groups.append(empty);
  }
}

// Says what the grid is showing and offers the way out of it, because a
// filter the person cannot see is a filter they cannot work around.
function renderPickerScope() {
  const scope = $('picker-scope');
  const supplier = (state.catalog?.suppliers || []).find((row) => row.id === $('supplier').value);
  scope.replaceChildren();

  if (!supplier) {
    scope.textContent = 'Every ingredient. Choose a supplier on the form to narrow this.';
    return;
  }

  // The "plus any with no supplier" clause is only true while some ingredient
  // has no supplier recorded. Saying it when none do would describe a rule
  // that is not currently doing anything.
  const mapping = state.catalog?.itemSuppliers || [];
  const mapped = new Set(mapping.map((row) => row.item_id));
  const unmapped = ingredientsForSupplier().filter((item) => !mapped.has(item.id)).length;

  const label = document.createElement('span');
  label.textContent = state.showEveryIngredient
    ? 'Showing every ingredient. '
    : unmapped
      ? `${supplier.name}’s ingredients, plus ${unmapped} with no supplier recorded. `
      : `${supplier.name}’s ingredients. `;
  scope.append(label);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'secondary';
  toggle.style.minHeight = '32px';
  toggle.style.padding = '4px 10px';
  toggle.style.fontSize = '14px';
  toggle.textContent = state.showEveryIngredient ? `Just ${supplier.name}` : 'Show everything';
  toggle.addEventListener('click', () => {
    state.showEveryIngredient = !state.showEveryIngredient;
    renderPicker($('picker-search').value);
  });
  scope.append(toggle);
}

async function openPicker() {
  if (!state.catalog) {
    notify('The catalog has not been loaded on this device yet. Connect once, then this will work offline.', 'bad');
    return;
  }
  // Codes are issued per device, so a line added before the device is chosen
  // could only ever be codeless. Better to ask for the one missing answer
  // than to hand back a label with nothing on it.
  if (!state.deviceId) {
    notify(
      (state.catalog?.devices || []).length
        ? 'Choose which device this is first — short codes are issued per device.'
        : 'No device is registered, so this one cannot be issued short codes.',
      'bad',
    );
    $('device').focus();
    return;
  }
  // Top up before the codes are needed rather than after, so the first line
  // of the morning gets one.
  await refillPool();
  $('picker-search').value = '';
  state.showEveryIngredient = false;
  renderPicker();
  $('picker-dialog').showModal();
}

function openLineDialog(item) {
  state.editing = item;

  const chosen = $('line-chosen');
  chosen.replaceChildren();
  chosen.append(thumbnail(item));
  const name = document.createElement('b');
  name.textContent = item.name;
  chosen.append(name);

  fillSelect($('line-location'), state.catalog.locations, {
    placeholder: 'Choose where it is going',
    selected: soleLocationFor(item, state.catalog.locations),
  });
  $('line-quantity').value = '';
  $('line-use-by').value = '';
  $('line-batch').value = defaultBatchCode();
  $('line-error').replaceChildren();
  fillUnits(item);
  $('line-dialog').showModal();
}

// The units offered are exactly the ones the conversions master can reach the
// base unit from. Offering anything else would put a refusal in front of
// somebody holding a box.
function fillUnits(item) {
  const units = unitsFor(item, state.catalog.conversions).map((unit) => ({ id: unit, name: unit }));
  fillSelect($('line-unit'), units, { selected: units.some((u) => u.id === 'case') ? 'case' : item.base_unit });

  $('line-use-by-note').textContent =
    `Leave the use-by empty if the box has no printed date: ${item.shelf_life_days} days from today will be ` +
    'applied and recorded as a rule rather than as the supplier\u2019s date.';
}

async function saveLine() {
  const problems = [];
  const item = state.editing;
  const quantity = Number($('line-quantity').value);
  const unit = $('line-unit').value;
  const locationId = $('line-location').value;

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
  // when the label is written. An empty pool is worth one attempt to refill
  // before giving up on a code — being online with an empty pool is a
  // recoverable state, and a codeless lot means somebody relabels a box
  // later.
  if (!pool.remaining() && online()) await refillPool({ force: true });
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

  // Which registered device this is. The kitchen has one iPad, so this is
  // normally not a question at all: where exactly one device is registered it
  // is used and the row stays hidden. Picking the only candidate is not a
  // guess.
  //
  // The concept stays in the schema regardless, because short codes are
  // reserved per device and two devices must never be able to mint the same
  // one. The day a second iPad or a phone is registered, the choice appears
  // on its own.
  const devices = state.catalog?.devices || [];
  if (devices.length === 1) {
    state.deviceId = devices[0].id;
    store.write(DEVICE_KEY, state.deviceId);
  } else if (state.deviceId && !devices.some((row) => row.id === state.deviceId)) {
    // The remembered device is no longer registered — retired, or renamed.
    // Silently carrying on with it would fail at the first submission.
    state.deviceId = null;
  }

  $('device-row').hidden = devices.length < 2;
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

$('add-line').addEventListener('click', openPicker);
$('picker-search').addEventListener('input', (event) => renderPicker(event.target.value));
$('picker-cancel').addEventListener('click', () => $('picker-dialog').close());
$('line-save').addEventListener('click', saveLine);
$('line-back').addEventListener('click', () => {
  $('line-dialog').close();
  openPicker();
});
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
