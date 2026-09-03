import { ulid, makeStore } from './lib/offline.js';

// What every unfinished batch is still waiting for.
//
// One list rather than three screens. A batch needs its temperatures taken
// during and after cooking, and packing out at the end, and both are picked
// up by whoever is on shift when they fall due — often not the person who
// started it. Splitting them would mean two places to remember to look, and
// the one nobody looks at is where a cooling check goes to die.

const $ = (id) => document.getElementById(id);
const store = makeStore(window.localStorage);
const STAFF_KEY = 'trace.intake.staff';

const state = { catalog: null, batches: [], open: null, unproven: [] };

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

const when = (iso) => new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z')).toLocaleString();
const isLate = (iso) => new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z')) < new Date();

// ------------------------------------------------------------------ list

async function load() {
  if (!online()) {
    $('batches-empty').textContent = 'Offline. This screen reads live and needs a connection.';
    $('batches-empty').hidden = false;
    return;
  }
  const response = await api('/api/batches');
  if (!response.ok) {
    notify(`Could not read the batches: ${response.body.error || response.status}`, 'bad');
    return;
  }
  state.batches = response.body.rows;
  render();
}

function render() {
  const list = $('batches');
  list.replaceChildren();
  $('batches-empty').hidden = state.batches.length > 0;
  if (!state.batches.length) {
    $('batches-empty').textContent = 'Nothing outstanding. Every batch has its checks in and has been packed out.';
    return;
  }

  for (const batch of state.batches) {
    const li = document.createElement('li');
    li.className = 'batch';

    const grow = document.createElement('div');
    grow.className = 'grow';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = batch.product_name;
    grow.append(name);

    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.textContent =
      `${batch.short_code || 'no code'} · started ${when(batch.originated_at)}` +
      `${batch.started_by ? ` by ${batch.started_by}` : ''}` +
      `${batch.multiplier !== 1 ? ` · ${batch.multiplier}× the recipe` : ''}`;
    grow.append(detail);

    // What it is waiting for, said plainly rather than as a count somebody
    // has to open the batch to understand.
    const waiting = document.createElement('div');
    waiting.className = 'waiting';
    const parts = [];
    if (batch.checks_outstanding) {
      const span = document.createElement('span');
      span.className = batch.checks_overdue ? 'overdue' : '';
      span.textContent = batch.checks_overdue
        ? `${batch.checks_overdue} check(s) overdue`
        : `${batch.checks_outstanding} check(s) to take`;
      waiting.append(span);
      parts.push(true);
    }
    if (!batch.packed_at) {
      if (parts.length) waiting.append(document.createTextNode(' · '));
      waiting.append(document.createTextNode('not packed out'));
    }
    if (batch.holds_open) {
      const held = document.createElement('span');
      held.className = 'held';
      held.textContent = ` · held`;
      waiting.append(held);
    }
    grow.append(waiting);

    li.append(grow);
    li.addEventListener('click', () => openBatch(batch));
    list.append(li);
  }
}

// ---------------------------------------------------------------- one batch

async function openBatch(batch) {
  const response = await api(`/api/batches?lot=${encodeURIComponent(batch.lot_id)}`);
  if (!response.ok) {
    notify(response.body.error || `Could not read that batch: ${response.status}`, 'bad');
    return;
  }
  state.open = response.body;

  $('batch-title').textContent = batch.product_name;
  $('batch-detail').textContent =
    `${batch.short_code || 'no code'} · started ${when(batch.originated_at)}` +
    `${batch.use_by ? ` · use by ${batch.use_by}` : ''}` +
    ` · made from ${state.open.inputs.length} identified lot(s)`;
  $('yield-label').textContent = `How much it made, in ${batch.base_unit}`;
  $('batch-error').replaceChildren();
  $('yield').value = '';
  $('packets').value = '';
  $('labelled').checked = false;

  const packed = Boolean(batch.packed_at);
  $('pack-heading').hidden = packed;
  $('pack-form').hidden = packed;
  $('pack-save').hidden = packed;

  renderChecks();
  $('batch-dialog').showModal();
}

function renderChecks() {
  const holder = $('batch-checks');
  holder.replaceChildren();

  for (const check of state.open.checks) {
    const row = document.createElement('div');
    row.className = 'cp';

    const grow = document.createElement('div');
    grow.className = 'grow';
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = check.label;
    if (check.is_ccp) {
      const flag = document.createElement('span');
      flag.className = 'ccp';
      flag.textContent = ' CCP';
      label.append(flag);
    }
    grow.append(label);

    const bounds = [
      check.min_celsius !== null ? `at least ${check.min_celsius}°C` : null,
      check.max_celsius !== null ? `no more than ${check.max_celsius}°C` : null,
    ].filter(Boolean);
    const limit = document.createElement('div');
    limit.className = 'limit';
    limit.textContent = bounds.length ? bounds.join(', ') : 'recorded, no limit stated';
    grow.append(limit);
    row.append(grow);

    if (check.recorded_at) {
      const answered = document.createElement('div');
      // A reading with no limit is shown as kept, not as passed. Calling it a
      // pass would be a claim nobody made.
      answered.className = check.within_limit === 0 ? 'failed' : check.within_limit === 1 ? 'answered' : '';
      const value = check.celsius !== null ? `${check.celsius}°C`
        : check.confirmed !== null ? (check.confirmed ? 'confirmed' : 'not confirmed')
        : check.observed_at ? when(check.observed_at) : '—';
      answered.textContent =
        check.within_limit === 0 ? `${value} — outside its limit`
        : check.within_limit === 1 ? `${value} — within limit`
        : `${value} — kept, no limit stated`;
      row.append(answered);
      holder.append(row);
      continue;
    }

    const due = document.createElement('div');
    due.className = isLate(check.due_at) ? 'due late' : 'due';
    due.textContent = isLate(check.due_at) ? `due ${when(check.due_at)} — overdue` : `due ${when(check.due_at)}`;
    grow.append(due);

    const input = document.createElement('input');
    if (check.kind === 'check') {
      input.type = 'checkbox';
      input.style.width = '26px';
      input.style.height = '26px';
    } else if (check.kind === 'time') {
      input.type = 'datetime-local';
    } else {
      input.type = 'number';
      input.step = '0.1';
      input.inputMode = 'decimal';
      input.placeholder = '°C';
    }
    row.append(input);

    const save = document.createElement('button');
    save.textContent = 'Record';
    save.style.minHeight = '40px';
    save.style.padding = '6px 14px';
    save.addEventListener('click', () => recordCheck(check, input));
    row.append(save);

    holder.append(row);
  }
}

async function recordCheck(check, input) {
  if (!$('staff').value) {
    notify('Choose your name first — a reading has to be somebody’s.', 'bad');
    return;
  }
  const body = {
    event_id: ulid(),
    idempotency_key: `check-${ulid()}`,
    staff_id: $('staff').value,
    occurred_at: new Date().toISOString(),
    reading_id: check.id,
  };
  if (check.kind === 'check') body.confirmed = input.checked;
  else if (check.kind === 'time') {
    if (!input.value) return notify('Enter the time it happened.', 'bad');
    body.observed_at = new Date(input.value).toISOString();
  } else {
    if (input.value === '') return notify('Enter the reading.', 'bad');
    body.celsius = Number(input.value);
  }

  const response = await api('/api/checks', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) {
    notify(response.body.error || `Refused with ${response.status}`, 'bad');
    return;
  }
  if (response.body.within_limit === false) {
    notify(`${check.label} is outside its limit, so this batch is held until somebody releases it.`, 'bad');
  }
  await refresh();
}

async function packOut() {
  const batch = state.open.batch;
  const problems = [];
  if (!$('staff').value) problems.push('choose your name');
  if (!Number($('yield').value)) problems.push('how much it made');
  if (!$('where').value) problems.push('where it is going');
  if ($('packets').value === '') problems.push('how many packets');
  if (!$('labelled').checked) problems.push('that every packet carries its label');

  const outstanding = state.open.checks.filter((check) => !check.recorded_at);
  if (outstanding.length) {
    problems.push(`${outstanding.length} check(s) still to take`);
  }

  if (problems.length) {
    const div = document.createElement('div');
    div.className = 'banner bad';
    div.textContent = `Before this can be packed out: ${problems.join(', ')}.`;
    $('batch-error').replaceChildren(div);
    return;
  }

  const response = await api('/api/packing', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event_id: ulid(),
      idempotency_key: `pack-${ulid()}`,
      staff_id: $('staff').value,
      occurred_at: new Date().toISOString(),
      lot_id: batch.lot_id,
      location_id: $('where').value,
      yield_quantity: Number($('yield').value),
      packets_produced: Number($('packets').value),
      label_check: $('labelled').checked,
    }),
  });

  if (!response.ok) {
    const div = document.createElement('div');
    div.className = 'banner bad';
    div.textContent = response.body.error || `Refused with ${response.status}`;
    $('batch-error').replaceChildren(div);
    return;
  }

  $('batch-dialog').close();
  const balance = response.body.balance;
  notify(
    `Packed out: ${response.body.packets_produced} packets. ` +
      `${balance.input} ${response.body.unit} in, ${balance.output} out, ` +
      `a difference of ${balance.difference}.`,
    'ok',
  );
  await load();
}

async function refresh() {
  const lot = state.open.batch.lot_id;
  const [detail, list] = await Promise.all([api(`/api/batches?lot=${encodeURIComponent(lot)}`), api('/api/batches')]);
  if (detail.ok) {
    state.open = detail.body;
    renderChecks();
  }
  if (list.ok) {
    state.batches = list.body.rows;
    render();
  }
}

// ------------------------------------------------------------- unproven

// PLAN.md's open question was who is allowed to record a batch input with no
// identified lot, and how it is supervised. Nobody is gated at the pot — a
// block there gets worked around with a plausible wrong lot, which is worse
// than the honest gap. So the supervision lives here instead: the same shape
// as a held lot, a count nobody can miss, that only clears when a named
// person has looked at it.

async function loadUnprovenCount() {
  if (!online()) return;
  const response = await api('/api/unproven');
  if (!response.ok) return;
  state.unproven = response.body.rows;
  renderUnprovenBadge();
}

function renderUnprovenBadge() {
  const count = state.unproven.length;
  $('unproven-count').textContent = String(count);
  $('open-unproven').className = count ? 'danger' : 'secondary';
}

function renderUnproven() {
  const body = $('unproven-body');
  body.replaceChildren();

  if (!state.unproven.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Nothing waiting. Every batch input either named a lot, or its gap has been looked at.';
    body.append(p);
    return;
  }

  for (const row of state.unproven) {
    const card = document.createElement('div');
    card.className = 'hold';

    const what = document.createElement('div');
    what.className = 'what';
    what.textContent = `${row.item_name} — ${row.quantity} ${row.unit}, into ${row.product_name}${row.batch_short_code ? ` · ${row.batch_short_code}` : ''}`;
    card.append(what);

    const why = document.createElement('div');
    why.className = 'why';
    why.textContent = `${row.reason} — ${row.staff_name}, ${when(row.created_at)}`;
    card.append(why);

    const noteRow = document.createElement('div');
    noteRow.className = 'row';
    const noteLabel = document.createElement('label');
    noteLabel.textContent = 'Note (optional)';
    const noteInput = document.createElement('input');
    noteInput.type = 'text';
    noteInput.autocomplete = 'off';
    noteRow.append(noteLabel, noteInput);
    card.append(noteRow);

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Reviewed';
    button.addEventListener('click', () => reviewUnproven(row, noteInput.value));
    card.append(button);

    body.append(card);
  }
}

async function reviewUnproven(row, note) {
  if (!$('staff').value) {
    notify('Choose your name first — reviewing needs one.', 'warn');
    return;
  }
  const response = await api('/api/unproven', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ unproven_id: row.id, staff_id: $('staff').value, note: note || null }),
  });
  if (!response.ok) {
    notify(response.body.error || `Could not record that: ${response.status}`, 'bad');
    return;
  }
  await loadUnprovenCount();
  renderUnproven();
}

// ------------------------------------------------------------------- boot

async function boot() {
  const parts = ['staff', 'locations'];
  const responses = await Promise.all(parts.map((action) => api(`/api/catalog?action=${action}`)));
  if (responses.some((response) => !response.ok)) {
    notify('Could not load the catalog. This screen needs a connection.', 'bad');
    return;
  }
  const [staff, locations] = responses.map((response) => response.body.rows);
  state.catalog = { staff, locations };
  fillSelect($('staff'), staff, { placeholder: 'Choose your name', selected: store.read(STAFF_KEY, null) });
  fillSelect($('where'), locations, { placeholder: 'Choose where it is going' });

  $('net').textContent = online() ? 'online' : 'offline';
  $('net').className = `pill ${online() ? 'ok' : 'warn'}`;
  await load();
  await loadUnprovenCount();
}

$('staff').addEventListener('change', (event) => store.write(STAFF_KEY, event.target.value));
$('pack-save').addEventListener('click', packOut);
$('batch-close').addEventListener('click', () => $('batch-dialog').close());
$('open-unproven').addEventListener('click', async () => {
  $('unproven-dialog').showModal();
  await loadUnprovenCount();
  renderUnproven();
});
$('unproven-list-refresh').addEventListener('click', async () => {
  await loadUnprovenCount();
  renderUnproven();
});
$('unproven-list-close').addEventListener('click', () => $('unproven-dialog').close());
window.addEventListener('online', boot);

boot();
