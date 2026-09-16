const $ = (id) => document.getElementById(id);

// P6 — Reports. Reads only: nothing on this screen writes to the ledger.
// See PLAN.md, "P6 — Reports": one-step-back, one-step-forward, mass balance,
// and alerts for missing lots, negative balances and conflicting dates.

async function api(path) {
  const response = await fetch(path);
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

const online = () => navigator.onLine;
const trim = (n) => Number(n.toFixed(4)).toString();

function banner(message, kind = 'warn') {
  const div = document.createElement('div');
  div.className = `banner ${kind}`;
  div.style.borderRadius = '12px';
  div.style.marginBottom = '12px';
  div.textContent = message;
  $('banner').replaceChildren(div);
}

// The four categories that already have a home screen where the row is
// acted on: this view sends staff there rather than duplicating the action.
// The two that follow have nowhere else to go, so their detail lives here.
const LINKED = [
  {
    key: 'deviations', title: 'Temperature holds not yet closed', href: '/', linkLabel: 'Open on Goods In',
    detail: (r) => `${r.item_name || 'Vehicle check'} · ${r.kind} ${r.celsius}°C vs limit ${r.limit_celsius}°C`,
  },
  {
    key: 'holds', title: 'Lots held by hand', href: '/stock', linkLabel: 'Open on Stock',
    detail: (r) => `${r.item_name} · ${r.reason} · opened by ${r.opened_by}`,
  },
  {
    key: 'unproven', title: 'Batch inputs with no identified lot', href: '/batches', linkLabel: 'Open on Batches',
    detail: (r) => `${r.product_name} used ${trim(r.quantity)} ${r.unit} of ${r.item_name} — "${r.reason}"`,
  },
  {
    key: 'unresourced', title: 'Counted stock with no lot to carry it', href: '/count', linkLabel: 'Open on Count',
    detail: (r) => `${r.item_name} · ${r.location_name} · counted ${trim(r.counted_quantity)}, `
      + `ledger had ${trim(r.ledger_quantity)}`,
  },
];

const INLINE = [
  {
    key: 'negative_balances', title: 'Negative balances',
    empty: 'None. A lot-location balance should never go below zero — the app refuses the movement that would.',
    detail: (r) => `<b>${r.item_name} · ${r.location_name}</b>${r.short_code ? ` (${r.short_code})` : ''} — `
      + `${trim(r.quantity)} ${r.base_unit || ''}`,
  },
  {
    key: 'conflicting_dates', title: 'Conflicting dates',
    empty: 'None. Every lot’s use-by is after the day it came into being.',
    detail: (r) => `<b>${r.item_name}${r.short_code ? ` · ${r.short_code}` : ''}</b> — `
      + `use-by ${r.use_by} is not after it originated ${(r.originated_at || '').slice(0, 10)} `
      + `(${r.use_by_source === 'supplier_printed' ? "supplier's own date" : 'the shelf-life rule'}, status ${r.status})`,
  },
];

function renderAlerts(data) {
  const box = $('alert-list');
  box.replaceChildren();

  for (const cat of LINKED) {
    const rows = data[cat.key] || [];
    const a = document.createElement('a');
    a.className = 'alert-row';
    a.href = cat.href;
    const grow = document.createElement('div');
    grow.className = 'grow';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = cat.title;
    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.textContent = rows.length ? rows.slice(0, 2).map(cat.detail).join(' · ') : 'Nothing open.';
    grow.append(name, detail);
    const count = document.createElement('span');
    count.className = `count${rows.length ? ' warn' : ''}`;
    count.textContent = String(rows.length);
    a.append(grow, count);
    box.append(a);
  }

  for (const cat of INLINE) {
    const rows = data[cat.key] || [];
    const row = document.createElement('div');
    row.className = 'alert-row expandable';
    const grow = document.createElement('div');
    grow.className = 'grow';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = cat.title;
    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.textContent = rows.length ? `${rows.length} to look at — tap to see them` : cat.empty;
    grow.append(name, detail);
    const count = document.createElement('span');
    count.className = `count${rows.length ? ' warn' : ''}`;
    count.textContent = String(rows.length);
    row.append(grow, count);

    const body = document.createElement('div');
    body.className = 'alert-detail';
    body.hidden = true;
    for (const r of rows) {
      const item = document.createElement('div');
      item.className = 'item';
      item.innerHTML = cat.detail(r);
      body.append(item);
    }
    if (rows.length) {
      row.addEventListener('click', () => { body.hidden = !body.hidden; });
    }
    box.append(row, body);
  }
}

async function loadAlerts() {
  if (!online()) return;
  const response = await api('/api/alerts');
  if (!response.ok) {
    banner(`Could not load alerts: ${response.body.error || response.status}`, 'bad');
    return;
  }
  renderAlerts(response.body);
}

// ------------------------------------------------------------------- trace

function lotSummary(lot) {
  const bits = [lot.short_code, lot.batch_code, lot.status].filter(Boolean);
  return `${lot.base_unit || ''} · ${bits.join(' · ')}`.trim();
}

function renderEdges(box, rows, verb) {
  box.replaceChildren();
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.style.padding = '4px 16px 12px';
    p.textContent = `Nothing ${verb} — this is where the trail stops in that direction.`;
    box.append(p);
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'lines';
  for (const row of rows) {
    const li = document.createElement('li');
    const grow = document.createElement('div');
    grow.className = 'grow';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = row.item_name;
    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.textContent = `${trim(row.quantity)} ${row.base_unit} · ${[row.short_code, row.batch_code]
      .filter(Boolean).join(' · ')}${row.status ? ` · ${row.status}` : ''}`;
    grow.append(name, detail);
    const link = document.createElement('button');
    link.className = 'secondary';
    link.style.cssText = 'min-height:34px;flex:none;padding:6px 12px;font-size:14px';
    link.textContent = 'Trace this';
    link.addEventListener('click', () => trace(row.id));
    li.append(grow, link);
    ul.append(li);
  }
  box.append(ul);
}

async function trace(lotId) {
  $('picker').hidden = true;
  $('search-error').replaceChildren();
  const response = await api(`/api/trace?lot=${encodeURIComponent(lotId)}`);
  if (!response.ok) {
    const div = document.createElement('div');
    div.className = 'banner bad';
    div.style.borderRadius = '12px';
    div.textContent = response.body.error || `Refused with ${response.status}`;
    $('search-error').replaceChildren(div);
    $('trace').hidden = true;
    return;
  }
  const { lot, back, forward } = response.body;
  const box = $('trace-lot');
  box.replaceChildren();
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = lot.item_name;
  const detail = document.createElement('div');
  detail.className = 'detail';
  detail.textContent = lotSummary(lot);
  box.append(name, detail);

  renderEdges($('trace-back'), back, 'fed it');
  renderEdges($('trace-forward'), forward, 'it fed');
  $('trace').hidden = false;
}

function renderPicker(lots) {
  const box = $('picker');
  box.replaceChildren();
  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = `That code names ${lots.length} lots — the batch scheme this replaces routinely did. Pick one.`;
  box.append(note);
  for (const lot of lots) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'picker-row';
    button.innerHTML = `<div class="grow"><b>${lot.item_name}</b>`
      + `<div class="detail">${lotSummary(lot)} · received ${(lot.originated_at || '').slice(0, 10)}</div></div>`;
    button.addEventListener('click', () => trace(lot.id));
    box.append(button);
  }
  box.hidden = false;
  $('trace').hidden = true;
}

async function runSearch() {
  const value = $('search').value.trim();
  $('search-error').replaceChildren();
  $('picker').hidden = true;
  if (!value) return;

  // A code (short or batch) resolves through /api/lookup, which is what
  // staff actually hold — a printed label, or one read off it. Falling
  // straight through to /api/trace covers pasting a raw lot id, which
  // nothing prints but which is what another report's "Trace this" sends.
  const looksLikeLotId = value.includes(':') || value.length > 10;
  if (looksLikeLotId) {
    await trace(value);
    return;
  }

  const response = await api(`/api/lookup?code=${encodeURIComponent(value)}`);
  if (!response.ok) {
    const div = document.createElement('div');
    div.className = 'banner bad';
    div.style.borderRadius = '12px';
    div.textContent = response.body.error || `Refused with ${response.status}`;
    $('search-error').replaceChildren(div);
    return;
  }
  const { lots } = response.body;
  if (!lots.length) {
    const div = document.createElement('div');
    div.className = 'banner warn';
    div.style.borderRadius = '12px';
    div.textContent = `Nothing matches "${value}".`;
    $('search-error').replaceChildren(div);
    $('trace').hidden = true;
    return;
  }
  if (lots.length === 1) {
    await trace(lots[0].id);
    return;
  }
  renderPicker(lots);
}

$('search-go').addEventListener('click', runSearch);
$('search').addEventListener('keydown', (event) => { if (event.key === 'Enter') runSearch(); });

$('net').textContent = online() ? 'online' : 'offline';
$('net').className = `pill ${online() ? 'ok' : 'warn'}`;
window.addEventListener('online', () => {
  $('net').textContent = 'online';
  $('net').className = 'pill ok';
  loadAlerts();
});
window.addEventListener('offline', () => {
  $('net').textContent = 'offline';
  $('net').className = 'pill warn';
});

loadAlerts();
