import { ulid, makeStore } from './lib/offline.js';

// The weekly count: what the ledger thinks is in one storage area against what
// is physically counted there. The difference is written as ADJUST movements
// by the server, spread across that item's open lots pro-rata by balance
// (PLAN.md P5, Dean 2026-09-09).
//
// Not offline-first, like stock and dispatch. It is done inside on wifi
// walking the racking, and it is measured against live balances a cached copy
// would get wrong the moment somebody else moved something. This screen needs
// a connection and says so rather than showing stale figures as current.
//
// The count is item + location, never per lot: staff record "how much hoi sin
// is in the walk-in", not a figure per lot. An item that is not added is not
// counted — it is left alone, not treated as zero.

const $ = (id) => document.getElementById(id);
const store = makeStore(window.localStorage);
const STAFF_KEY = 'trace.intake.staff';

const state = { catalog: null, ledger: new Map(), lines: [], chosen: null, openLines: [], resolving: null };

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

const online = () => navigator.onLine;
const areaOf = () => state.catalog.locations.find((l) => l.id === $('where').value) || null;
const areaName = () => areaOf()?.name || 'that area';
const areaKindOf = () => areaOf()?.kind || null;

// A glyph per area so the four tiles read at a glance. The label underneath is
// the real identifier; the glyph only tells the two dry-store tiles apart
// quickly.
function areaGlyph(loc) {
  if (/allergen/i.test(loc.name)) return '🌾';
  if (/freezer/i.test(loc.name) || loc.kind === 'freezer') return '🧊';
  if (/fridge|chill/i.test(loc.name) || loc.kind === 'chill') return '❄️';
  return '📦';
}

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

const trim = (n) => Number(n.toFixed(4)).toString();

// ---------------------------------------------------------------- ledger

async function loadLedger() {
  state.ledger = new Map();
  const where = $('where').value;
  $('add-section').hidden = !where;
  if (!where) {
    renderItems();
    renderLines();
    return;
  }
  if (!online()) {
    notify('Offline. Ledger figures are read from the server, and this screen needs a connection.', 'bad');
    return;
  }
  const stock = await api(`/api/ledger?action=stock&location=${encodeURIComponent(where)}`);
  if (!stock.ok) {
    notify(`Could not read what the ledger has here: ${stock.body.error || stock.status}`, 'bad');
    return;
  }
  for (const row of stock.body.rows) {
    state.ledger.set(row.item_id, (state.ledger.get(row.item_id) || 0) + row.quantity);
  }
  renderItems();
  renderLines();
}

const ledgerFor = (itemId) => state.ledger.get(itemId) || 0;

// ------------------------------------------------------------------- areas

// Four tappable tiles instead of a dropdown: tap where you are standing and
// the items in that area come up ready to count, the way the current stock
// check works.
function renderAreas() {
  const box = $('areas');
  box.replaceChildren();
  const current = $('where').value;
  for (const loc of state.catalog.locations) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = `area${loc.id === current ? ' on' : ''}`;
    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    glyph.textContent = areaGlyph(loc);
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = loc.name;
    tile.append(glyph, label);
    tile.addEventListener('click', () => selectArea(loc.id));
    box.append(tile);
  }
}

function selectArea(id) {
  if (id === $('where').value) return;
  // Lines already counted belong to the area they were counted in. Switching
  // area drops them rather than measuring them against the wrong ledger.
  if (state.lines.length) {
    state.lines = [];
    renderLines();
    notify('Area changed — cleared what was counted, it belonged to the other area.', 'warn');
  }
  $('where').value = id;
  $('result-section').hidden = true;
  $('search').value = '';
  renderAreas();
  loadLedger();
}

// ------------------------------------------------------------------ items

function renderItems() {
  const wanted = $('search').value.trim().toLowerCase();
  const chosen = new Set(state.lines.map((line) => line.item_id));
  const kind = areaKindOf();
  const items = (state.catalog.items || []).filter((item) => {
    if (chosen.has(item.id)) return false;
    if (wanted) return item.name.toLowerCase().includes(wanted);
    // No search term: show what is kept in this area, plus anything the ledger
    // already has stock of here. A search reaches every other item.
    return item.storage_unopened === kind || state.ledger.has(item.id);
  });

  const list = $('items');
  list.replaceChildren();
  $('items-empty').hidden = items.length > 0;
  if (!items.length) {
    $('items-empty').textContent = !$('where').value
      ? 'Tap an area above to start.'
      : $('search').value
        ? `Nothing matches “${$('search').value}”.`
        : 'Nothing is kept in this area. Search to count something stored elsewhere.';
  }

  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'item';

    const grow = document.createElement('div');
    grow.className = 'grow';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = item.name;
    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.textContent = 'not counted';
    grow.append(name, detail);

    const ledger = document.createElement('div');
    ledger.className = 'ledger';
    ledger.textContent = `ledger ${trim(ledgerFor(item.id))} ${item.base_unit}`;

    li.append(grow, ledger);
    li.addEventListener('click', () => openLine(item));
    list.append(li);
  }
}

// ------------------------------------------------------------------ lines

function renderLines() {
  const list = $('lines');
  list.replaceChildren();
  $('lines-section').hidden = state.lines.length === 0;

  for (const [index, line] of state.lines.entries()) {
    const li = document.createElement('li');

    const grow = document.createElement('div');
    grow.className = 'grow';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = line.item_name;
    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.textContent = `counted ${trim(line.counted)} ${line.base_unit} · ledger ${trim(line.ledger)} ${line.base_unit}`;
    grow.append(name, detail);

    const delta = line.counted - line.ledger;
    const span = document.createElement('div');
    span.className = `delta ${Math.abs(delta) < 1e-6 ? 'exact' : delta < 0 ? 'short' : 'over'}`;
    span.textContent = Math.abs(delta) < 1e-6 ? 'Δ 0' : `Δ ${delta > 0 ? '+' : ''}${trim(delta)}`;
    grow.append(span);

    const remove = document.createElement('button');
    remove.className = 'danger';
    remove.style.cssText = 'min-height:34px;flex:none;padding:6px 12px;font-size:14px';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      state.lines.splice(index, 1);
      renderLines();
      renderItems();
      refreshSave();
    });

    li.append(grow, remove);
    list.append(li);
  }
  refreshSave();
}

function openLine(item) {
  state.chosen = item;
  $('line-title').textContent = item.name;

  const chosen = $('line-chosen');
  chosen.replaceChildren();
  const image = document.createElement('img');
  image.src = `/photos/${item.id}.jpg`;
  image.alt = '';
  image.addEventListener('error', () => image.remove());
  const label = document.createElement('b');
  label.textContent = item.name;
  chosen.append(image, label);

  const has = ledgerFor(item.id);
  $('line-where').textContent = has
    ? `The ledger has ${trim(has)} ${item.base_unit} in ${areaName()}. Count everything of it that is in this area.`
    : `The ledger has none of this in ${areaName()}. If there is some, that gets flagged for a person to trace.`;
  $('line-quantity-label').textContent = `How much is there, in ${item.base_unit}`;
  $('line-quantity').value = '';
  $('line-error').replaceChildren();
  $('line-dialog').showModal();
}

function addLine() {
  const item = state.chosen;
  const counted = Number($('line-quantity').value);
  if (!Number.isFinite(counted) || counted < 0 || $('line-quantity').value.trim() === '') {
    const div = document.createElement('div');
    div.className = 'banner bad';
    div.textContent = 'Enter how much is there — zero if there is none.';
    $('line-error').replaceChildren(div);
    return;
  }
  state.lines.push({
    item_id: item.id,
    item_name: item.name,
    base_unit: item.base_unit,
    counted,
    ledger: ledgerFor(item.id),
  });
  $('line-dialog').close();
  renderLines();
  renderItems();
}

function refreshSave() {
  const ready = $('staff').value && $('where').value && state.lines.length > 0;
  $('save').disabled = !ready;
  $('finish-note').textContent = state.lines.length
    ? `${state.lines.length} item${state.lines.length === 1 ? '' : 's'} counted in ${areaName()}. `
      + 'Anything you have not added is left as it is, not set to zero.'
    : 'Add a line for each item you have counted in this area.';
}

// ------------------------------------------------------------------- save

function envelope() {
  return {
    event_id: ulid(),
    idempotency_key: `count-${ulid()}`,
    staff_id: $('staff').value,
    occurred_at: new Date().toISOString(),
  };
}

async function save() {
  if (!online()) {
    notify('Offline. A count is recorded on the server, and this screen needs a connection.', 'bad');
    return;
  }
  const where = $('where').value;
  const body = {
    ...envelope(),
    lines: state.lines.map((line) => ({
      item_id: line.item_id,
      location_id: where,
      counted_quantity: line.counted,
    })),
  };

  const response = await api('/api/count', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    notify(response.body.error || `Refused with ${response.status}`, 'bad');
    return;
  }

  renderResult(response.body);
  state.lines = [];
  state.chosen = null;
  $('lines-section').hidden = true;
  $('add-section').hidden = true;
  renderLines();
  await Promise.all([loadLedger(), loadOpen()]);
}

function renderResult(result) {
  const rows = result.lines || [];
  const counts = { apportioned: 0, no_variance: 0, unresourced: 0 };
  const box = $('result');
  box.replaceChildren();

  for (const row of rows) {
    counts[row.disposition] = (counts[row.disposition] || 0) + 1;
    const div = document.createElement('div');
    div.className = `outcome ${row.disposition}`;
    const head = document.createElement('div');
    head.className = 'head';
    const detail = document.createElement('div');
    detail.className = 'detail';

    if (row.disposition === 'no_variance') {
      head.textContent = row.item_name;
      detail.textContent = `counted ${trim(row.counted_quantity)} ${row.base_unit} — matched the ledger`;
    } else if (row.disposition === 'apportioned') {
      head.textContent = `${row.item_name} · adjusted ${row.variance > 0 ? '+' : ''}${trim(row.variance)} ${row.base_unit}`;
      detail.textContent = 'spread across the open lots in that area, pro-rata by balance';
    } else {
      head.textContent = `${row.item_name} — no lot to carry it`;
      detail.textContent = `counted ${trim(row.counted_quantity)} ${row.base_unit}, the ledger had `
        + `${trim(row.ledger_quantity)}. Nothing adjusted; flagged as unresolved.`;
    }
    div.append(head, detail);
    box.append(div);
  }

  $('result-section').hidden = false;
  notify(
    `Count recorded: ${counts.apportioned} adjusted, ${counts.no_variance} matched, `
      + `${counts.unresourced} needing a lot.`,
    counts.unresourced ? 'warn' : 'ok',
  );
}

// ---------------------------------------------------------- unresolved

async function loadOpen() {
  if (!online()) return;
  const response = await api('/api/counts?open');
  state.openLines = response.ok ? response.body.rows : [];
  $('open-count').textContent = String(state.openLines.length);
  $('open-unresolved').className = state.openLines.length ? 'secondary warn-outline' : 'secondary';
}

function openUnresolved() {
  const list = $('open-list');
  list.replaceChildren();
  if (!state.openLines.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Nothing outstanding.';
    list.append(p);
  }
  for (const row of state.openLines) {
    const div = document.createElement('div');
    div.className = 'open-row';
    const head = document.createElement('div');
    head.className = 'name';
    head.textContent = `${row.item_name} · ${row.location_name}`;
    const why = document.createElement('div');
    why.className = 'why';
    why.textContent = `counted ${trim(row.counted_quantity)} ${row.base_unit}, ledger had ${trim(row.ledger_quantity)} — no lot to adjust`;
    const when = document.createElement('div');
    when.className = 'detail';
    when.textContent = `counted ${row.counted_at}`;
    const resolve = document.createElement('button');
    resolve.className = 'secondary';
    resolve.style.cssText = 'min-height:36px;margin-top:6px';
    resolve.textContent = 'Close this line';
    resolve.addEventListener('click', () => startResolve(row));
    div.append(head, why, when, resolve);
    list.append(div);
  }
  $('open-dialog').showModal();
}

function startResolve(row) {
  if (!$('staff').value) {
    notify('Choose your name first — closing a line records who did it.', 'warn');
    return;
  }
  state.resolving = row;
  $('open-dialog').close();
  $('resolve-chosen').textContent = `${row.item_name} · ${row.location_name}`;
  $('resolve-note').value = '';
  $('resolve-error').replaceChildren();
  $('resolve-dialog').showModal();
}

async function confirmResolve() {
  const row = state.resolving;
  const response = await api('/api/counts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      line_id: row.id,
      staff_id: $('staff').value,
      note: $('resolve-note').value.trim() || undefined,
    }),
  });
  if (!response.ok) {
    const div = document.createElement('div');
    div.className = 'banner bad';
    div.textContent = response.body.error || `Refused with ${response.status}`;
    $('resolve-error').replaceChildren(div);
    return;
  }
  $('resolve-dialog').close();
  notify(`Closed the line for ${row.item_name}.`, 'ok');
  await loadOpen();
}

// -------------------------------------------------------------------- boot

async function boot() {
  const parts = ['staff', 'locations', 'items'];
  const responses = await Promise.all(parts.map((action) => api(`/api/catalog?action=${action}`)));
  if (responses.some((response) => !response.ok)) {
    notify('Could not load the catalog. This screen needs a connection.', 'bad');
    return;
  }
  const [staff, locations, items] = responses.map((response) => response.body.rows);
  state.catalog = { staff, locations, items };

  fillSelect($('staff'), staff, { placeholder: 'Choose your name', selected: store.read(STAFF_KEY, null) });
  renderAreas();

  $('net').textContent = online() ? 'online' : 'offline';
  $('net').className = `pill ${online() ? 'ok' : 'warn'}`;

  renderLines();
  await loadOpen();
}

$('staff').addEventListener('change', (event) => {
  store.write(STAFF_KEY, event.target.value);
  refreshSave();
});
$('search').addEventListener('input', renderItems);
$('line-add').addEventListener('click', addLine);
$('line-cancel').addEventListener('click', () => $('line-dialog').close());
$('save').addEventListener('click', save);
$('discard').addEventListener('click', () => {
  state.lines = [];
  $('result-section').hidden = true;
  renderLines();
  renderItems();
});
$('open-unresolved').addEventListener('click', openUnresolved);
$('open-close').addEventListener('click', () => $('open-dialog').close());
$('resolve-confirm').addEventListener('click', confirmResolve);
$('resolve-cancel').addEventListener('click', () => $('resolve-dialog').close());
window.addEventListener('online', boot);
window.addEventListener('offline', () => {
  $('net').textContent = 'offline';
  $('net').className = 'pill warn';
});

boot();
