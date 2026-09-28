import {
  ulid, makeStore, makeQueue, makePool, makeCatalogCache,
  unitsFor, batchCodeFor, buildSubmission, syncQueue, POOL_TARGET,
  groupByStorage, defaultLocationFor, forSupplier, splitByRole, usualSupplierFor, duplicateLines,
  probeKindFor, withinLimit, vehicleReadingsNeeded,
} from './lib/offline.js';
import { authedFetch, mountStaff, session, onSessionChange } from './lib/signin.js';
import { RELAY, PRINT_ENABLED_KEY, mountRelayStatus } from './lib/relay.js';
import { mountNav } from './lib/nav.js';
import { bearer } from './lib/auth.js';
import { buildGoodsInLabel } from './lib/zpl.js';

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

mountNav($('nav'), '/');

const store = makeStore(window.localStorage);
const queue = makeQueue(store);
const pool = makePool(store);
const catalogCache = makeCatalogCache(store);

// Registered as early as possible so a first visit on kitchen wifi caches the
// app before anybody walks away from the router. It is not required for the
// form to work; a browser without it simply loses the offline start-up.
function installServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // Blocked, or a browser that will not have it. Nothing else changes.
  });
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.version) {
      state.appVersion = event.data.version;
      renderDeviceNote();
    }
  });
  navigator.serviceWorker.ready.then((registration) => {
    registration.active?.postMessage('version');
  });
}

const DEVICE_KEY = 'trace.intake.device';
const STAFF_KEY = 'trace.intake.staff';

const state = {
  catalog: null,
  deviceId: store.read(DEVICE_KEY, null),
  lines: [],
  pickerSelection: new Set(),
};

// ---------------------------------------------------------------- network

async function api(path, options) {
  const response = await authedFetch(path, options);
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
    const parts = [
      'items', 'locations', 'suppliers', 'staff', 'devices', 'conversions',
      'item_suppliers', 'temperature_limits',
    ];
    const responses = await Promise.all(parts.map((action) => api(`/api/catalog?action=${action}`)));
    if (responses.some((response) => !response.ok)) return;

    const [items, locations, suppliers, staff, devices, conversions, itemSuppliers, limitRows] =
      responses.map((response) => response.body.rows);
    const limits = {};
    for (const row of limitRows) limits[row.kind] = row.celsius;
    state.catalog = { items, locations, suppliers, staff, devices, conversions, itemSuppliers, limits };
    catalogCache.write(state.catalog);
  } catch {
    // Offline in all but name. The cache stands.
  }
}

// ---------------------------------------------------------------- devices

// Registers this browser as a device the first time it shows up with no
// remembered one. The id is minted the same way every other client-side id
// is (ulid); the server picks the name, so nothing here can typo a name into
// colliding with an existing device. Failure is quiet — no device just means
// the add-ingredient button stays disabled with its usual explanation,
// exactly as it did before self-registration existed.
async function registerDevice() {
  const id = ulid();
  try {
    const response = await api('/api/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!response.ok) return;
    state.catalog.devices = [...(state.catalog.devices || []), response.body];
    catalogCache.write(state.catalog);
    state.deviceId = id;
    store.write(DEVICE_KEY, id);
  } catch {
    // Offline in all but name, or the request failed outright. Left
    // unregistered; boot() will try again next load.
  }
}

// Which registered device this is, and self-registration where none is.
// Called once immediately by onSessionChange (below) and again on every
// sign-in, sign-out and shift expiry, because registerDevice() needs a
// signed-in person to attach its request to — server-side it is a write
// like any other, requiring the same token everything else does — and at
// raw page load, before anyone has typed a PIN, there is none. Running this
// only inline in boot() meant it always lost that race on a genuinely fresh
// device: found by testing it directly (POST /api/devices with no token is
// a 401), not assumed. `registering` stops two overlapping calls — a sign-in
// followed quickly by some other session change — from both trying to
// register at once.
let registering = false;
async function syncDevice() {
  if (!state.catalog) return;
  let devices = state.catalog.devices || [];
  if (devices.length === 1) {
    state.deviceId = devices[0].id;
    store.write(DEVICE_KEY, state.deviceId);
  } else if (state.deviceId && !devices.some((row) => row.id === state.deviceId)) {
    // The remembered device is no longer registered — retired, or renamed.
    // Silently carrying on with it would fail at the first submission.
    state.deviceId = null;
  }

  if (!state.deviceId && online() && session.current() && !registering) {
    registering = true;
    await registerDevice();
    registering = false;
    devices = state.catalog.devices || [];
  }

  $('device-row').hidden = devices.length < 2;
  fillSelect($('device'), devices, { placeholder: 'Not set', selected: state.deviceId });
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
      // The server still calls a code "unbound" until the delivery is
      // submitted. Keep codes already shown on this form out of the refreshed
      // pool so another row cannot be handed the same one in the meantime.
      const claimed = new Set(state.lines.map((line) => line.short_code).filter(Boolean));
      const available = response.body.codes.map((row) => row.code).filter((code) => !claimed.has(code));
      pool.replace(state.deviceId, available);
      state.poolReason = null;
      // A row shows its code while its details are being entered. Anything
      // added while the pool was empty gets one as soon as codes arrive.
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

// The batch code every case in this delivery carries. One value for the whole
// delivery, taken from when it arrived.
function batchCode() {
  const arrived = $('occurred').value ? new Date($('occurred').value) : new Date();
  return batchCodeFor(Number.isNaN(arrived.getTime()) ? new Date() : arrived);
}

function itemById(id) {
  return (state.catalog?.items || []).find((item) => item.id === id) || null;
}

function locationById(id) {
  return (state.catalog?.locations || []).find((row) => row.id === id) || null;
}

function removeLine(line) {
  pool.giveBack(line.short_code);
  state.lines = state.lines.filter((other) => other.lot_id !== line.lot_id);
  render();
}

function fieldFor(line, key, labelText, control) {
  const field = document.createElement('div');
  field.className = 'field';
  control.id = `${key}-${line.lot_id}`;

  const label = document.createElement('label');
  label.htmlFor = control.id;
  label.textContent = labelText;
  field.append(label, control);
  return field;
}

function draftInput(line, key, { type = 'text', inputmode = null, step = null } = {}) {
  const input = document.createElement('input');
  input.type = type;
  if (inputmode) input.inputMode = inputmode;
  if (step) input.step = step;
  input.value = line[key] ?? '';
  input.addEventListener('input', () => {
    line[key] = input.value;
    line.acknowledged_breach = false;
  });
  return input;
}

function draftTextarea(line, key) {
  const textarea = document.createElement('textarea');
  textarea.rows = 2;
  textarea.value = line[key] ?? '';
  textarea.addEventListener('input', () => {
    line[key] = textarea.value;
  });
  return textarea;
}

function draftSelect(line, key, rows, options = {}) {
  const select = document.createElement('select');
  fillSelect(select, rows, { ...options, selected: line[key] });
  select.addEventListener('change', () => {
    line[key] = select.value;
    line.acknowledged_breach = false;
  });
  return select;
}

function addAnotherDate(source, item) {
  const draft = makeDraftLine(item);
  draft.unit = source.unit || draft.unit;
  draft.location_id = source.location_id || draft.location_id;

  const sourceIndex = state.lines.findIndex((line) => line.lot_id === source.lot_id);
  state.lines.splice(sourceIndex + 1, 0, draft);
  render();
  document.getElementById(`quantity-${draft.lot_id}`)?.focus();
  refillPool();
}

function anotherDateButton(line, item) {
  const button = document.createElement('button');
  button.className = 'secondary compact';
  button.type = 'button';
  button.disabled = Boolean(line.saving);
  button.textContent = 'Add another date';
  button.setAttribute('aria-label', `Add another use-by date for ${item.name}`);
  button.addEventListener('click', () => addAnotherDate(line, item));
  return button;
}

function removeLineButton(line, item) {
  const button = document.createElement('button');
  button.className = 'danger compact icon-remove';
  button.type = 'button';
  button.textContent = '×';
  button.setAttribute('aria-label', `Remove ${item.name}`);
  button.title = `Remove ${item.name}`;
  button.addEventListener('click', () => removeLine(line));
  return button;
}

function renderDraftLine(line, item) {
  const li = document.createElement('li');
  li.className = 'line-editor';
  li.dataset.lineId = line.lot_id;

  const heading = document.createElement('div');
  heading.className = 'line-editor-head';
  heading.append(thumbnail(item, 'line-photo'));

  const title = document.createElement('div');
  title.className = 'grow';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = item.name;

  const identifiers = document.createElement('dl');
  identifiers.className = 'line-identifiers';

  const shortCodeGroup = document.createElement('div');
  shortCodeGroup.className = 'line-identifier';
  const shortCodeLabel = document.createElement('dt');
  shortCodeLabel.textContent = 'Short code';
  const shortCode = document.createElement('dd');
  shortCode.className = line.short_code ? 'code' : 'code none';
  shortCode.textContent = line.short_code || 'no code';
  shortCodeGroup.append(shortCodeLabel, shortCode);

  const batchGroup = document.createElement('div');
  batchGroup.className = 'line-identifier';
  const batchLabel = document.createElement('dt');
  batchLabel.textContent = 'Batch';
  const batch = document.createElement('dd');
  batch.className = 'line-batch-code';
  batch.textContent = batchCode();
  batchGroup.append(batchLabel, batch);

  identifiers.append(shortCodeGroup, batchGroup);
  const status = document.createElement('div');
  status.className = 'line-state';
  status.textContent = line.saving ? 'Adding to delivery' : 'Details needed';
  title.append(name, status);
  heading.append(title, identifiers, removeLineButton(line, item));
  li.append(heading);

  const grid = document.createElement('div');
  grid.className = 'line-editor-grid';

  const quantity = draftInput(line, 'quantity', { type: 'number', inputmode: 'decimal', step: 'any' });
  quantity.min = '0';
  grid.append(fieldFor(line, 'quantity', 'How many', quantity));

  const units = unitsFor(item, state.catalog.conversions).map((unit) => ({ id: unit, name: unit }));
  grid.append(fieldFor(line, 'unit', 'Of what', draftSelect(line, 'unit', units)));

  const defaultLocationId = defaultLocationFor(item, state.catalog.locations);
  const locationSelect = draftSelect(
    line,
    'location_id',
    state.catalog.locations,
    { placeholder: 'Choose where it is going' },
  );
  grid.append(fieldFor(line, 'location', 'Storage location', locationSelect));

  const overrideNote = draftTextarea(line, 'location_override_note');
  overrideNote.placeholder = 'What changed?';
  const overrideField = fieldFor(
    line,
    'location-override-note',
    'Why is this going somewhere else?',
    overrideNote,
  );
  const renderLocationException = () => {
    const isException = Boolean(
      defaultLocationId && locationSelect.value && locationSelect.value !== defaultLocationId,
    );
    overrideField.hidden = !isException;
    if (!isException) {
      overrideNote.value = '';
      line.location_override_note = '';
    }
  };
  locationSelect.addEventListener('change', renderLocationException);
  renderLocationException();
  grid.append(overrideField);

  const probeKind = probeKindFor(item);
  if (probeKind) {
    const limit = state.catalog?.limits?.[probeKind];
    grid.append(fieldFor(
      line,
      'temperature',
      `Product temperature °C, ${limit}° or below`,
      draftInput(line, 'product_temp_c', { type: 'number', inputmode: 'decimal', step: '0.1' }),
    ));
  }

  grid.append(fieldFor(
    line,
    'use-by',
    'Use-by printed on the box',
    draftInput(line, 'use_by', { type: 'date' }),
  ));

  li.append(grid);

  const note = document.createElement('p');
  note.className = 'note line-note';
  note.textContent =
    `Leave the use-by empty if the box has no printed date. The ${item.shelf_life_days}-day rule will be applied.`;
  li.append(note);

  const error = document.createElement('div');
  error.setAttribute('role', 'alert');
  li.append(error);

  const actions = document.createElement('div');
  actions.className = 'actions line-actions';
  const save = document.createElement('button');
  save.type = 'button';
  save.disabled = Boolean(line.saving);
  save.textContent = line.saving ? 'Adding to delivery' : 'Add to delivery';
  save.addEventListener('click', () => completeDraftLine(line, item, error, save));
  actions.append(save, anotherDateButton(line, item));
  li.append(actions);
  return li;
}

function renderCompleteLine(line, item) {
  const location = locationById(line.location_id);
  const li = document.createElement('li');
  li.className = 'line-summary';
  if (item) li.append(thumbnail(item, 'line-photo'));

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
    : `use by not printed, ${item ? item.shelf_life_days : 7} days will be applied`;
  detail.textContent =
    `${line.quantity} ${line.unit} to ${location ? location.name : line.location_id}, ` +
    `batch ${batchCode()}, ${useBy}` +
    (line.note ? `, storage exception: ${line.note}` : '');
  grow.append(detail);
  li.append(grow);

  const code = document.createElement('div');
  code.className = line.short_code ? 'code' : 'code none';
  code.textContent = line.short_code || 'no code';
  li.append(code);

  const actions = document.createElement('div');
  actions.className = 'line-summary-actions';
  actions.append(anotherDateButton(line, item), removeLineButton(line, item));
  li.append(actions);
  return li;
}

function renderLines() {
  const list = $('lines');
  list.replaceChildren();
  $('lines-empty').hidden = state.lines.length > 0;

  for (const line of state.lines) {
    const item = itemById(line.item_id);
    if (!item) continue;
    list.append(line.draft ? renderDraftLine(line, item) : renderCompleteLine(line, item));
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

  const holds = state.holds?.length ?? 0;
  $('holds-count').textContent = String(holds);
  $('open-holds').className = `header-btn ${holds ? 'danger' : 'secondary'}`;
}

// The van's compartments are asked about only where the delivery carries
// stock they are about. A frozen reading on an all-ambient load is a number
// with nothing to say.
function renderVehicle() {
  const needed = vehicleReadingsNeeded(state.lines, itemById);
  const limits = state.catalog?.limits || {};

  $('vehicle-chilled-field').hidden = !needed.has('chilled');
  $('vehicle-frozen-field').hidden = !needed.has('frozen');
  $('vehicle-note-field').hidden = $('vehicle-condition').value !== 'poor';

  const said = [];
  for (const [kind, id] of [['chilled', 'vehicle-chilled'], ['frozen', 'vehicle-frozen']]) {
    if (!needed.has(kind)) continue;
    const raw = $(id).value;
    if (raw === '') {
      said.push(`${kind} compartment: needs a reading, ${limits[kind]}° or below`);
      continue;
    }
    const celsius = Number(raw);
    said.push(
      withinLimit(celsius, limits[kind])
        ? `${kind} compartment ${celsius}°, within the ${limits[kind]}° limit`
        : `${kind} compartment ${celsius}° is above the ${limits[kind]}° limit. Everything ${kind} ` +
          'in this delivery will be held until it is rechecked',
    );
  }

  const hint = $('vehicle-note-hint');
  hint.replaceChildren();
  if (!needed.size) {
    hint.textContent = 'Nothing chilled or frozen on this delivery, so no compartment readings are needed.';
    return;
  }
  for (const line of said) {
    const div = document.createElement('div');
    if (line.includes('above the')) div.className = 'breach';
    div.textContent = line;
    hint.append(div);
  }
}

function renderSubmitNote() {
  const note = $('submit-note');
  const problems = [];
  if (!$('staff').value) problems.push('who is booking it in');
  if (!$('supplier').value) problems.push('the supplier');
  if (!state.deviceId) problems.push('a registered device');
  if (!state.lines.length) problems.push('at least one ingredient');
  if (state.lines.some((line) => line.draft)) problems.push('details for every ingredient');

  for (const [kind, id] of [['chilled', 'vehicle-chilled'], ['frozen', 'vehicle-frozen']]) {
    if (vehicleReadingsNeeded(state.lines, itemById).has(kind) && $(id).value === '') {
      problems.push(`the van's ${kind} temperature`);
    }
  }
  if ($('vehicle-condition').value === 'poor' && !$('vehicle-note').value.trim()) {
    problems.push('what was wrong with the vehicle');
  }
  // Unticked by default and required: a box that starts ticked records that
  // the form was submitted, not that anybody checked.
  for (const [id, said] of [
    ['condition-ok', 'that the goods arrived in good condition'],
    ['labels-applied', 'that the labels went on'],
    ['allergens-confirmed', 'that the allergens were checked'],
  ]) {
    if (!$(id).checked) problems.push(said);
  }

  if (problems.length) {
    note.textContent = `Before this record can be saved: ${problems.join(', ')}.`;
    $('submit').disabled = true;
    return;
  }

  // Said before booking rather than after, while it is still one tap to fix.
  const duplicates = duplicateLines(state.lines);
  if (duplicates.length) {
    const names = [...new Set(duplicates.map((line) => itemById(line.item_id)?.name).filter(Boolean))];
    note.textContent =
      `${names.join(' and ')} appears twice with the same use-by and the same place. ` +
      'Two lots nothing can tell apart. Combine them, or give one a different date, ' +
      'unless you meant to count them apart, which is fine.';
    $('submit').disabled = false;
    return;
  }

  const withoutCode = state.lines.filter((line) => !line.short_code).length;
  note.textContent = withoutCode
    ? `${state.lines.length} line(s). ${withoutCode} without a short code. Save the record anyway and ` +
      'relabel those cases once codes are available.'
    : `${state.lines.length} line(s). Write each short code on that case's label before it goes into storage.`;
  $('submit').disabled = false;
}

function renderDeviceNote() {
  const note = $('device-note');
  const devices = state.catalog?.devices || [];

  if (!state.deviceId) {
    note.textContent = devices.length
      ? 'Choose which device this is before adding anything. Codes are issued per device, so two iPads never print the same one.'
      : 'Registering this device. Connect once and reload if this does not clear on its own.';
    return;
  }

  const name = devices.find((row) => row.id === state.deviceId)?.name || state.deviceId;
  const parts = [`${name}. ${pool.remaining()} short codes held.`];
  // What this iPad is actually running. A cached app that has quietly outlived
  // a deploy is invisible otherwise, and that is exactly the failure a cache
  // introduces.
  if (state.appVersion) parts.push(`App version ${state.appVersion}.`);
  if (state.poolReason) parts.push(state.poolReason);
  const cached = state.catalog?.cached_at;
  parts.push(cached
    ? `Catalog last refreshed ${new Date(cached).toLocaleString()}.`
    : 'Catalog has never been cached on this device.');
  note.textContent = parts.join(' ');
}

function renderAddButton() {
  const ready = Boolean(state.deviceId && $('supplier').value);
  $('add-line').disabled = !ready;
  $('add-line').textContent = $('supplier').value
    ? 'Add ingredients'
    : 'Choose the supplier first';
}

function render() {
  renderStatus();
  renderLines();
  renderVehicle();
  renderAddButton();
  renderSubmitNote();
  renderDeviceNote();
}

// ----------------------------------------------- ingredient picker and rows

// The picker. Staff recognise their stock by the photograph faster than by
// reading a name, and the kitchen already has a picture of every ingredient,
// so this is a grid of pictures rather than a list to scroll. The grouping
// and the location default are in lib/offline.js, where they are tested.
function allIngredients() {
  return (state.catalog?.items || [])
    .filter((item) => item.kind === 'ingredient')
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Strictly the chosen supplier's own ingredients, with no way round it: an
// item item_suppliers does not name for this supplier cannot be added to
// their delivery, full stop (Dean, 2026-09-25). If that turns out to hide
// something real, the fix is a row in item_suppliers, not a way to bypass
// this filter from the door.
function ingredients() {
  return forSupplier(allIngredients(), state.catalog?.itemSuppliers || [], $('supplier').value || null);
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
  const { everyday, backup } = splitByRole(
    ingredients(), state.catalog?.itemSuppliers || [], $('supplier').value || null,
  );

  const tileFor = (item) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.append(thumbnail(item));
    const name = document.createElement('span');
    name.className = 'tile-name';
    name.textContent = item.name;
    tile.append(name);

    const selected = document.createElement('span');
    selected.className = 'tile-selected';
    selected.textContent = '✓ Selected';
    tile.append(selected);

    const paint = () => {
      const isSelected = state.pickerSelection.has(item.id);
      tile.className = `tile${isSelected ? ' selected' : ''}`;
      tile.setAttribute('aria-pressed', String(isSelected));
      selected.hidden = !isSelected;
    };
    paint();
    tile.addEventListener('click', () => {
      if (state.pickerSelection.has(item.id)) state.pickerSelection.delete(item.id);
      else state.pickerSelection.add(item.id);
      paint();
      renderPickerSelection();
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
        names.length === 1 ? `Backup only, normally ${names[0]}` : 'Backup only',
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
      : 'No ingredients are set up for this supplier. Ask whoever manages trace to update the supplier list.';
    groups.append(empty);
  }
}

function renderPickerSelection() {
  const count = state.pickerSelection.size;
  $('picker-add').disabled = count === 0;
  $('picker-add').textContent = count ? `Add ${count} ingredient${count === 1 ? '' : 's'}` : 'Add ingredients';
}

// Says what the grid is showing. No toggle, no way round it — see the
// comment on ingredients() above for why.
function renderPickerScope() {
  const scope = $('picker-scope');
  const supplier = (state.catalog?.suppliers || []).find((row) => row.id === $('supplier').value);
  scope.replaceChildren();

  scope.textContent = supplier
    ? `${supplier.name}’s ingredients only.`
    : 'Every ingredient. Choose a supplier on the form to narrow this.';
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
        ? 'Choose which device this is first. Short codes are issued per device.'
        : 'No device is registered, so this one cannot be issued short codes.',
      'bad',
    );
    $('device').focus();
    return;
  }
  // The picker shows one supplier's ingredients, so opening it without a
  // supplier would show all fifty-five and quietly defeat the narrowing. The
  // line's supplier is the delivery's supplier in any case: there is nothing
  // to add an ingredient to yet.
  if (!$('supplier').value) {
    notify('Choose the supplier first. The ingredient list is theirs.', 'bad');
    $('supplier').focus();
    return;
  }

  // Top up before the codes are needed rather than after, so the first line
  // of the morning gets one.
  await refillPool();
  state.pickerSelection = new Set();
  $('picker-search').value = '';
  renderPicker();
  renderPickerSelection();
  $('picker-dialog').showModal();
}

function makeDraftLine(item) {
  const units = unitsFor(item, state.catalog.conversions);
  return {
    lot_id: ulid(),
    item_id: item.id,
    short_code: pool.take(),
    quantity: '',
    unit: units.includes('case') ? 'case' : item.base_unit,
    location_id: defaultLocationFor(item, state.catalog.locations) || '',
    location_override_note: '',
    use_by: '',
    product_temp_c: '',
    draft: true,
  };
}

function addSelectedIngredients() {
  const selected = [...state.pickerSelection].map(itemById).filter(Boolean);
  if (!selected.length) return;

  const drafts = selected.map(makeDraftLine);
  state.lines.push(...drafts);
  $('picker-dialog').close();
  render();
  document.getElementById(`quantity-${drafts[0].lot_id}`)?.focus();
  refillPool();
}

async function completeDraftLine(line, item, error, button) {
  if (line.saving) return;
  const problems = [];
  const quantity = Number(line.quantity);
  const unit = line.unit;
  const locationId = line.location_id;
  const defaultLocationId = defaultLocationFor(item, state.catalog.locations);

  if (!(quantity > 0)) problems.push('enter how many');
  if (!unit) problems.push('choose a unit');
  if (!locationId) problems.push('choose where it is going');
  if (
    defaultLocationId
    && locationId !== defaultLocationId
    && !line.location_override_note.trim()
  ) problems.push('say why the storage location changed');

  const probeKind = probeKindFor(item);
  let productTemp = null;
  if (probeKind) {
    if (line.product_temp_c === '') problems.push('take a product temperature');
    else {
      productTemp = Number(line.product_temp_c);
      if (!Number.isFinite(productTemp)) problems.push('enter a valid product temperature');
    }
  }

  if (problems.length) {
    const div = document.createElement('div');
    div.className = 'banner bad';
    div.textContent = `Still needed: ${problems.join(', ')}.`;
    error.replaceChildren(div);
    return;
  }

  // Said here rather than at submit, while the person is still holding the
  // probe and can take another reading if the first was a mis-key.
  if (probeKind && !withinLimit(productTemp, state.catalog.limits[probeKind])) {
    const limit = state.catalog.limits[probeKind];
    const div = document.createElement('div');
    div.className = 'banner warn';
    div.textContent =
      `${productTemp}°C is above the ${limit}°C limit. This case will be recorded and held ` +
      'until it is rechecked. Add it if the reading is right; take another if it is not.';
    if (!line.acknowledged_breach) {
      line.acknowledged_breach = true;
      error.replaceChildren(div);
      return;
    }
  }
  line.acknowledged_breach = false;

  // The row normally received its code as soon as it reached the main page.
  // If the pool was empty then, give an online device one last chance to fill
  // it before the label is written.
  line.saving = true;
  button.disabled = true;
  button.textContent = 'Adding to delivery';
  if (!line.short_code) {
    if (!pool.remaining() && online()) await refillPool({ force: true });
    line.short_code = line.short_code || pool.take();
  }
  line.quantity = quantity;
  line.unit = unit;
  line.location_id = locationId;
  line.note = line.location_override_note.trim() || null;
  line.use_by = line.use_by || null;
  line.product_temp_c = productTemp;
  line.draft = false;
  render();
  refillPool();
  printLine(line, item);
}

// -------------------------------------------------------------- printing

// Fires at the moment a line is added, same as taking the short code from
// the pool — that is when the label is written (PLAN.md), not when the
// server confirms the delivery, which can be minutes or hours away offline.
// A print failure is shown but never blocks the line: the short code is
// already on the line either way, and the fallback this form has always had
// is writing it on the case by hand.
async function printLine(line, item) {
  if (!$('print-enabled').checked || !line.short_code) return;

  const zpl = buildGoodsInLabel({
    name: item?.name || line.item_id,
    shortCode: line.short_code,
    batch: batchCode(),
    useBy: line.use_by,
    delivered: $('occurred').value ? $('occurred').value.slice(0, 10) : new Date().toISOString().slice(0, 10),
    supplier: (state.catalog?.suppliers || []).find((row) => row.id === $('supplier').value)?.name || '',
    quantity: line.quantity,
    healthMark: item?.needs_health_mark === true,
  });

  try {
    const response = await fetch(`${RELAY}/print`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: zpl,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) {
      notify(`Label for ${item?.name || 'that line'} did not print: ${body.error || response.status}. `
        + 'Write the short code on the case by hand.', 'warn');
    }
  } catch {
    notify('Could not reach the print relay. Write the short code on the case by hand.', 'warn');
  }
}

// -------------------------------------------------------------- submitting

async function submitDelivery() {
  if (state.lines.some((line) => line.draft)) {
    notify('Add the details for every ingredient before saving this delivery.', 'bad');
    return;
  }

  const draft = {
    device_id: state.deviceId,
    staff_id: $('staff').value,
    supplier_id: $('supplier').value,
    invoice: $('invoice').value.trim(),
    checks: {
      vehicle_condition: $('vehicle-condition').value,
      vehicle_note: $('vehicle-note').value.trim() || null,
      condition_ok: $('condition-ok').checked,
      labels_applied: $('labels-applied').checked,
      allergens_confirmed: $('allergens-confirmed').checked,
      vehicle_chilled_c: $('vehicle-chilled-field').hidden || $('vehicle-chilled').value === ''
        ? undefined : Number($('vehicle-chilled').value),
      vehicle_frozen_c: $('vehicle-frozen-field').hidden || $('vehicle-frozen').value === ''
        ? undefined : Number($('vehicle-frozen').value),
    },
    occurred_at: $('occurred').value ? new Date($('occurred').value) : new Date(),
    lines: state.lines.map((line) => ({ ...line, batch_code: batchCode() })),
  };

  const submission = buildSubmission(draft);

  // Queued before it is sent, always. If this device dies on the next line
  // the delivery is still on it.
  if (!queue.add(submission, session.current()?.token ?? null)) {
    notify(
      'This device could not store the record, so it has NOT been saved. Do not clear the screen: '
        + 'write the delivery down.',
      'bad',
    );
    return;
  }

  state.lines = [];
  $('invoice').value = '';
  // Cleared between deliveries. An attestation carried over from the last one
  // is an attestation nobody made about this one.
  for (const id of ['condition-ok', 'labels-applied', 'allergens-confirmed']) $(id).checked = false;
  for (const id of ['vehicle-chilled', 'vehicle-frozen', 'vehicle-note']) $(id).value = '';
  $('vehicle-condition').value = 'good';
  render();
  notify('Goods in record saved. Write each short code on its case.', 'ok');

  await drainQueue();
}

async function drainQueue() {
  // Each record goes out with the token of whoever keyed it, which may not be
  // whoever is signed in by the time the wifi is back.
  const results = await syncQueue(queue, async (payload, token) =>
    api('/api/receive', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? bearer(token) : {}) },
      body: JSON.stringify(payload),
    }),
  );

  if (results.rejected) notify(`${results.rejected} record(s) were refused. Open the queue to see why.`, 'bad');
  if (results.waiting) notify('Waiting for a connection. Nothing is lost; it will send when the form is next opened.', 'warn');

  // The server decides what the pool holds, so a successful sync is the right
  // moment to reconcile: codes bound by a submission this device never heard
  // back about are gone from the pool afterwards.
  if (results.sent) await refillPool({ force: true });
  render();
}

// ------------------------------------------------------------ held stock

// Clearing a hold. Needs a second reading, an outcome and a name — a lot
// cannot quietly return to usable stock, and it cannot sit held forever
// either, which is what happened to the kitchen's one existing deviation:
// recheck due at 14:02, taken seven days later.
//
// This is the one screen that requires a connection. Held stock is in the
// walk-in, not at the door, and the person clearing it is stood inside.

async function loadHolds() {
  const body = $('holds-body');
  if (!online()) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Offline. Held stock is read from the server, and this screen needs a connection.';
    body.replaceChildren(p);
    return;
  }

  const response = await api('/api/deviations');
  if (!response.ok) {
    notify(`Could not read held stock: ${response.body.error || response.status}`, 'bad');
    return;
  }
  state.holds = response.body.rows;
  renderHolds();
  renderStatus();
}

function renderHolds() {
  const body = $('holds-body');
  body.replaceChildren();

  if (!state.holds?.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Nothing is held. Every temperature taken was within limit, or every hold has been closed.';
    body.append(p);
    return;
  }

  for (const hold of state.holds) {
    const card = document.createElement('div');
    card.className = 'hold';

    const what = document.createElement('div');
    what.className = 'what';
    what.textContent = `${hold.item_name || 'a lot'}${hold.short_code ? ` · ${hold.short_code}` : ''}`;
    card.append(what);

    const why = document.createElement('div');
    why.className = 'why';
    const source = hold.kind === 'product' ? 'probed at' : `the van's ${hold.kind.replace('vehicle_', '')} compartment read`;
    why.textContent = `${source} ${hold.celsius}°C, against a ${hold.limit_celsius}°C limit`;
    card.append(why);

    const due = document.createElement('div');
    const overdue = new Date(hold.recheck_due_at) < new Date();
    due.className = overdue ? 'due late' : 'due';
    due.textContent = overdue
      ? `Recheck was due ${new Date(hold.recheck_due_at).toLocaleString()}, overdue`
      : `Recheck due ${new Date(hold.recheck_due_at).toLocaleString()}`;
    card.append(due);

    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('label');
    label.textContent = 'Second reading °C';
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.1';
    input.inputMode = 'decimal';
    row.append(label, input);
    card.append(row);

    const outcomes = document.createElement('div');
    outcomes.className = 'outcomes';
    for (const [outcome, text] of [
      ['resolved', 'Back within limit'],
      ['rejected', 'Sent back'],
      ['disposed', 'Thrown away'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      if (outcome !== 'resolved') button.className = 'secondary';
      button.textContent = text;
      button.addEventListener('click', () => closeHold(hold, outcome, input.value));
      outcomes.append(button);
    }
    card.append(outcomes);
    body.append(card);
  }
}

async function closeHold(hold, outcome, reading) {
  const response = await api('/api/deviations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviation_id: hold.id,
      outcome,
      recheck_celsius: reading === '' ? null : Number(reading),
      staff_id: $('staff').value || null,
    }),
  });

  if (!response.ok) {
    notify(response.body.error || `Could not close it: ${response.status}`, 'bad');
    return;
  }

  const status = response.body.lot?.status;
  notify(
    status === 'held'
      ? 'Closed, but the lot is still held by another reading.'
      : `Closed. The lot is now ${status}.`,
    status === 'open' ? 'ok' : 'warn',
  );
  await loadHolds();
}

// ------------------------------------------------------------ queue dialog

function renderQueue() {
  const body = $('queue-body');
  const entries = queue.all();
  body.replaceChildren();

  if (!entries.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Nothing waiting. Every record keyed on this device has been accepted.';
    body.append(p);
    return;
  }

  for (const entry of entries.slice().reverse()) {
    const div = document.createElement('div');
    div.className = 'queue-entry';

    const heading = document.createElement('div');
    const lines = entry.payload.lines.length;
    heading.textContent = `${entry.status}: ${lines} line(s), invoice ${entry.payload.invoice || 'not given'}`;
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
    mountStaff($('staff'), state.catalog.staff);
    fillSelect($('supplier'), state.catalog.suppliers, { placeholder: 'Choose the supplier' });
  }

  // Which registered device this is, and self-registration where none is.
  // Driven by the session rather than run once inline here — see
  // syncDevice() below for why.
  onSessionChange(syncDevice);

  $('print-enabled').checked = store.read(PRINT_ENABLED_KEY, true);
  mountRelayStatus($('relay-status'));

  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  $('occurred').value = now.toISOString().slice(0, 16);

  // Set rather than left to the browser's "first option wins". This is a
  // compliance field, and reordering the options one day should not quietly
  // change what a delivery attests to.
  $('vehicle-condition').value = 'good';

  render();
  await refillPool();
  await drainQueue();
  // Held stock is loaded on opening so the badge is honest from the start:
  // somebody arriving at the door should see that yesterday's hold is still
  // sitting there.
  if (online()) await loadHolds();
}

$('staff').addEventListener('change', (event) => {
  store.write(STAFF_KEY, event.target.value);
  renderSubmitNote();
});
$('supplier').addEventListener('change', () => {
  // Changing the supplier changes which ingredients the picker offers, so
  // lines already added may no longer belong to it. They are left alone and
  // named rather than silently dropped: the person put them there.
  const mapping = state.catalog?.itemSuppliers || [];
  const theirs = new Set(
    mapping.filter((row) => row.supplier_id === $('supplier').value).map((row) => row.item_id),
  );
  const mapped = new Set(mapping.map((row) => row.item_id));
  const strangers = state.lines
    .filter((line) => mapped.has(line.item_id) && !theirs.has(line.item_id))
    .map((line) => itemById(line.item_id)?.name)
    .filter(Boolean);
  if (strangers.length) {
    notify(`${strangers.join(', ')} already on this delivery is not from that supplier.`, 'warn');
  }
  render();
});
// The batch code is the arrival date, so changing one changes the other.
$('occurred').addEventListener('change', render);
for (const id of ['vehicle-condition', 'vehicle-chilled', 'vehicle-frozen', 'vehicle-note',
                  'condition-ok', 'labels-applied', 'allergens-confirmed']) {
  $(id).addEventListener('change', render);
  $(id).addEventListener('input', render);
}
$('device').addEventListener('change', (event) => {
  state.deviceId = event.target.value || null;
  store.write(DEVICE_KEY, state.deviceId);
  render();
  refillPool({ force: true });
});

$('print-enabled').addEventListener('change', (event) => {
  store.write(PRINT_ENABLED_KEY, event.target.checked);
});

$('add-line').addEventListener('click', openPicker);
$('picker-search').addEventListener('input', (event) => renderPicker(event.target.value));
$('picker-add').addEventListener('click', addSelectedIngredients);
$('picker-cancel').addEventListener('click', () => $('picker-dialog').close());

$('submit').addEventListener('click', submitDelivery);
$('discard').addEventListener('click', () => {
  if (!state.lines.length) return;
  if (!window.confirm('Clear every line on this delivery?')) return;
  for (const line of state.lines) pool.giveBack(line.short_code);
  state.lines = [];
  render();
});

$('open-holds').addEventListener('click', async () => {
  $('holds-dialog').showModal();
  await loadHolds();
});
$('holds-refresh').addEventListener('click', loadHolds);
$('holds-close').addEventListener('click', () => $('holds-dialog').close());

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

installServiceWorker();
boot();
