import { ulid, makeStore } from './lib/offline.js';

// The stock screen: what is in each area, and the three things that can be
// done to it — move it, throw it away, hold it.
//
// Deliberately not offline-first, unlike goods-in. This is used inside, on
// wifi, stood at the racking (PLAN.md, "Where the iPad actually is"), and it
// reads live balances that a cached copy would get wrong the moment somebody
// else moved something. Pretending otherwise would be worse than saying so.

const $ = (id) => document.getElementById(id);
const store = makeStore(window.localStorage);
const STAFF_KEY = 'trace.intake.staff';
const DEVICE_KEY = 'trace.intake.device';

const state = { catalog: null, rows: [], holds: [], chosen: null, action: null };

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

// ------------------------------------------------------------------ reads

async function load() {
  if (!online()) {
    $('lots-empty').textContent = 'Offline. Stock is read from the server, and this screen needs a connection.';
    $('lots-empty').hidden = false;
    $('lots').replaceChildren();
    return;
  }

  const where = $('where').value;
  const [stock, holds] = await Promise.all([
    api(`/api/ledger?action=stock${where ? `&location=${encodeURIComponent(where)}` : ''}`),
    api('/api/holds'),
  ]);
  if (!stock.ok) {
    notify(`Could not read stock: ${stock.body.error || stock.status}`, 'bad');
    return;
  }
  state.rows = stock.body.rows;
  state.holds = holds.ok ? holds.body.rows : [];
  render();
}

function holdsFor(lotId) {
  return state.holds.filter((hold) => hold.lot_id === lotId);
}

// A use-by inside a week is what somebody walking the racking is looking for,
// so it is marked rather than left to be worked out from a date.
function daysLeft(useBy) {
  if (!useBy) return null;
  const day = 24 * 60 * 60 * 1000;
  return Math.round((new Date(`${useBy}T00:00:00Z`) - new Date().setHours(0, 0, 0, 0)) / day);
}

function render() {
  const wanted = $('search').value.trim().toLowerCase();
  const rows = state.rows.filter(
    (row) =>
      !wanted ||
      row.item_name.toLowerCase().includes(wanted) ||
      (row.short_code || '').toLowerCase().includes(wanted),
  );

  const list = $('lots');
  list.replaceChildren();
  $('lots-empty').hidden = rows.length > 0;
  if (!rows.length) {
    $('lots-empty').textContent = state.rows.length
      ? `Nothing matches “${$('search').value}”.`
      : 'Nothing in stock here yet.';
  }

  for (const row of rows) {
    const held = row.status !== 'open';
    const li = document.createElement('li');
    li.className = held ? 'lot is-held' : 'lot';

    const grow = document.createElement('div');
    grow.className = 'grow';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = row.item_name;
    if (held) {
      const flag = document.createElement('span');
      flag.className = 'flag';
      flag.textContent = ` ${row.status}`;
      name.append(flag);
    }
    grow.append(name);

    const detail = document.createElement('div');
    detail.className = 'detail';
    const days = daysLeft(row.use_by);
    const useBy = row.use_by ? `use by ${row.use_by}` : 'no use-by recorded';
    detail.textContent = `${row.short_code || 'no code'} · ${row.location_name} · ${useBy}`;
    if (days !== null && days <= 7) {
      const soon = document.createElement('span');
      soon.className = 'soon';
      soon.textContent = days < 0 ? ' — past its use-by' : days === 0 ? ' — today' : ` — ${days} days`;
      detail.append(soon);
    }
    grow.append(detail);

    const reasons = holdsFor(row.lot_id);
    if (reasons.length) {
      const why = document.createElement('div');
      why.className = 'detail';
      why.textContent = `held: ${reasons.map((hold) => hold.reason).join('; ')}`;
      grow.append(why);
    }

    const qty = document.createElement('div');
    qty.className = 'qty';
    qty.textContent = `${row.quantity} ${row.base_unit}`;

    li.append(grow, qty);
    li.addEventListener('click', () => openActions(row));
    list.append(li);
  }
}

// --------------------------------------------------------------- actions

function openActions(row) {
  state.chosen = row;
  state.action = null;

  $('action-title').textContent = row.item_name;
  const chosen = $('action-chosen');
  chosen.replaceChildren();
  const image = document.createElement('img');
  image.src = `/photos/${row.item_id}.jpg`;
  image.alt = '';
  image.addEventListener('error', () => image.remove());
  const name = document.createElement('b');
  name.textContent = `${row.quantity} ${row.base_unit}`;
  chosen.append(image, name);

  const heldBy = holdsFor(row.lot_id);
  $('action-where').textContent =
    `${row.short_code || 'no code'} · ${row.location_name}` +
    (row.use_by ? ` · use by ${row.use_by}` : '') +
    (row.status !== 'open' ? ` · ${row.status}` : '');

  const held = row.status !== 'open';
  // Held stock offers only the way out of the hold. Moving or wasting it
  // first is how a hold gets quietly worked around.
  $('do-move').hidden = held;
  $('do-waste').hidden = held;
  $('do-hold').hidden = held;
  $('do-release').hidden = !heldBy.length;

  if (held && !heldBy.length) {
    notify('This lot is held by a temperature reading. Clear it on the goods-in screen.', 'warn');
  }

  $('action-pick').hidden = false;
  $('action-form').hidden = true;
  $('action-error').replaceChildren();
  $('action-dialog').showModal();
}

function showForm(action) {
  state.action = action;
  $('action-pick').hidden = true;
  $('action-form').hidden = false;
  $('action-error').replaceChildren();
  $('quantity').value = '';
  $('note').value = '';

  const row = state.chosen;
  const isMove = action === 'move';
  const isWaste = action === 'waste';

  $('quantity-row').hidden = !(isMove || isWaste);
  $('to-field').hidden = !isMove;
  $('reason-row').hidden = !isWaste;
  $('note-row').hidden = false;

  $('quantity-label').textContent = `How much, in ${row.base_unit} (there is ${row.quantity})`;
  $('note-label').textContent =
    action === 'hold' ? 'Why this stock is not to be used' : action === 'release' ? 'Note' : 'Note';

  if (isMove) {
    fillSelect(
      $('to-location'),
      (state.catalog.locations || []).filter((place) => place.id !== row.location_id),
      { placeholder: 'Choose where it is going' },
    );
  }
  if (isWaste) fillSelect($('reason'), state.catalog.wasteReasons, { placeholder: 'Choose a reason' });
}

function envelope() {
  return {
    event_id: ulid(),
    idempotency_key: `stock-${ulid()}`,
    // Sent when this browser happens to know which device it is, omitted
    // otherwise. Stock work is done at the racking on whatever is to hand,
    // and it is not tied to a short-code pool the way goods intake is.
    device_id: store.read(DEVICE_KEY, null) ?? undefined,
    staff_id: $('staff').value,
    occurred_at: new Date().toISOString(),
  };
}

async function save() {
  const row = state.chosen;
  const action = state.action;
  const problems = [];
  if (!$('staff').value) problems.push('choose your name');

  const quantity = Number($('quantity').value);
  if (['move', 'waste'].includes(action) && !(quantity > 0)) problems.push('enter how much');
  if (action === 'move' && !$('to-location').value) problems.push('choose where it is going');
  if (action === 'waste' && !$('reason').value) problems.push('choose a reason');
  if (action === 'hold' && $('note').value.trim().length < 3) problems.push('say why it is being held');

  if (problems.length) {
    const div = document.createElement('div');
    div.className = 'banner bad';
    div.textContent = `Still needed: ${problems.join(', ')}.`;
    $('action-error').replaceChildren(div);
    return;
  }

  const note = $('note').value.trim() || null;
  const calls = {
    move: ['/api/move', { ...envelope(), lot_id: row.lot_id, quantity, from_location_id: row.location_id, to_location_id: $('to-location').value, note }],
    waste: ['/api/waste', { ...envelope(), lot_id: row.lot_id, quantity, location_id: row.location_id, reason_id: $('reason').value, note }],
    hold: ['/api/hold', { ...envelope(), lot_id: row.lot_id, reason: $('note').value.trim() }],
    release: ['/api/hold?release', { ...envelope(), hold_id: holdsFor(row.lot_id)[0]?.id, note }],
  };
  const [path, body] = calls[action];

  const response = await api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const div = document.createElement('div');
    div.className = 'banner bad';
    div.textContent = response.body.error || `Refused with ${response.status}`;
    $('action-error').replaceChildren(div);
    return;
  }

  $('action-dialog').close();
  notify(
    {
      move: `Moved ${quantity} ${row.base_unit} of ${row.item_name}.`,
      waste: `Recorded ${quantity} ${row.base_unit} of ${row.item_name} as waste.`,
      hold: `${row.item_name} is held. It cannot be moved or used until the hold is released.`,
      release: `${row.item_name} released.`,
    }[action],
    'ok',
  );
  await load();
}

// -------------------------------------------------------------------- boot

async function boot() {
  const parts = ['staff', 'locations', 'waste_reasons'];
  const responses = await Promise.all(parts.map((action) => api(`/api/catalog?action=${action}`)));
  if (responses.some((response) => !response.ok)) {
    notify('Could not load the catalog. This screen needs a connection.', 'bad');
    return;
  }
  const [staff, locations, wasteReasons] = responses.map((response) => response.body.rows);
  state.catalog = { staff, locations, wasteReasons };

  fillSelect($('staff'), staff, { placeholder: 'Choose your name', selected: store.read(STAFF_KEY, null) });
  fillSelect($('where'), locations, { placeholder: 'Everywhere' });

  $('net').textContent = online() ? 'online' : 'offline';
  $('net').className = `pill ${online() ? 'ok' : 'warn'}`;

  await load();
}

$('staff').addEventListener('change', (event) => store.write(STAFF_KEY, event.target.value));
$('where').addEventListener('change', load);
$('search').addEventListener('input', render);
$('do-move').addEventListener('click', () => showForm('move'));
$('do-waste').addEventListener('click', () => showForm('waste'));
$('do-hold').addEventListener('click', () => showForm('hold'));
$('do-release').addEventListener('click', () => showForm('release'));
$('action-save').addEventListener('click', save);
$('action-back').addEventListener('click', () => {
  $('action-pick').hidden = false;
  $('action-form').hidden = true;
});
$('action-close').addEventListener('click', () => $('action-dialog').close());
window.addEventListener('online', boot);
window.addEventListener('offline', () => {
  $('net').textContent = 'offline';
  $('net').className = 'pill warn';
});

boot();
