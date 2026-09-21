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

let tracedLot = null;

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
  tracedLot = lot.id;
  $('recall').hidden = true;
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


// ------------------------------------------------------------------ recall
//
// The whole chain from one lot, not one hop (PLAN.md P6, and the exit test
// P7 is timed against). Forward answers "who did this reach"; back answers
// "what was this made from, and who supplied it". Everything the ledger
// cannot see is listed as a gap rather than left off, so an empty list here
// means nothing was found, never that nothing was looked for.

const day = (value) => String(value || '').slice(0, 10);
const qty = (row) => `${trim(row.quantity)} ${row.base_unit || row.unit || ''}`.trim();
const codes = (row) => [row.short_code, row.batch_code && `batch ${row.batch_code}`].filter(Boolean).join(' · ');

function section(title, rows, empty, build) {
  const parts = [];
  const h = document.createElement('h3');
  h.textContent = title;
  parts.push(h);
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = empty;
    parts.push(p);
    return parts;
  }
  const ul = document.createElement('ul');
  ul.className = 'rows';
  for (const row of rows) {
    const [name, detail, flag] = build(row);
    const li = document.createElement('li');
    const n = document.createElement('div');
    n.className = 'name';
    n.textContent = name;
    const d = document.createElement('div');
    d.className = 'detail';
    d.textContent = detail;
    li.append(n, d);
    for (const line of [].concat(flag || []).filter(Boolean)) {
      const f = document.createElement('div');
      f.className = 'detail flag';
      f.textContent = line;
      li.append(f);
    }
    ul.append(li);
  }
  parts.push(ul);
  return parts;
}

function headline(text) {
  const div = document.createElement('div');
  div.className = 'headline';
  div.textContent = text;
  return div;
}

const GAP_TEXT = {
  possible_downstream: (g) => [
    `${g.batch_item_name} · ${codes({ short_code: g.batch_short_code, batch_code: g.batch_code }) || 'no code'}`,
    `Used ${trim(g.quantity)} ${g.unit} of ${g.item_name} with no lot recorded — "${g.reason}"`,
    'Cannot be ruled out. Trace this batch to see where it went.',
  ],
  missing_upstream: (g) => [
    `${g.batch_item_name} · ${codes({ short_code: g.batch_short_code, batch_code: g.batch_code }) || 'no code'}`,
    `Used ${trim(g.quantity)} ${g.unit} of ${g.item_name} with no lot recorded — "${g.reason}"`,
    'The trail above this input is missing.',
  ],
};

function forwardParts(r) {
  const people = new Set(r.customers.map((c) => c.customer_id));
  const held = r.lots.filter((lot) => lot.held).length;
  return [
    headline(`Reached ${people.size} customer${people.size === 1 ? '' : 's'} · ${r.lots.length} lot`
      + `${r.lots.length === 1 ? '' : 's'} made from it · ${r.on_hand.length} stock line`
      + `${r.on_hand.length === 1 ? '' : 's'} still in the building`),
    ...section('Went to customers', r.customers, 'Nothing has been dispatched from this chain.',
      (c) => [
        c.customer_name,
        `${c.item_name} · ${qty(c)} · ${codes(c) || 'no code'} · use by ${day(c.use_by) || 'none'} · `
          + `sent ${day(c.occurred_at)}${c.reference ? ` · ${c.reference}` : ''}`,
      ]),
    ...section('Still in the building', r.on_hand, 'No stock from this chain is on hand.',
      (row) => {
        const lot = row.lot_id === r.start.id ? r.start : r.lots.find((l) => l.id === row.lot_id);
        return [
          row.item_name,
          `${qty(row)} in ${row.location_name} · ${codes(row) || 'no code'}`
            + `${row.lot_id === r.start.id ? ' · the lot recalled' : ''}`,
          lot && lot.held ? 'Held' : '',
        ];
      }),
    ...section(`Made from it${held ? ` (${held} held)` : ''}`, r.lots, 'Nothing was made from this lot.',
      (lot) => [
        lot.item_name,
        `${lot.depth === 1 ? 'directly' : `${lot.depth} steps on`} · ${codes(lot) || 'no code'} · `
          + `${lot.status} · made ${day(lot.originated_at)}`,
        lot.held ? 'Held' : '',
      ]),
    ...section('Binned', r.wasted, 'Nothing from this chain has been thrown away.',
      (w) => [w.item_name, `${qty(w)} · ${w.reason || 'no reason recorded'} · ${day(w.occurred_at)}`]),
    ...section('Cannot be ruled out', r.gaps, 'No batch used this item without naming a lot.',
      (g) => GAP_TEXT[g.kind](g)),
  ];
}

function backParts(r) {
  const suppliers = new Set(r.lots.filter((l) => l.supplier_name).map((l) => l.supplier_name));
  return [
    headline(`Made from ${r.lots.length} lot${r.lots.length === 1 ? '' : 's'}`
      + `${suppliers.size ? ` · from ${[...suppliers].join(', ')}` : ''}`),
    ...section('Made from', r.lots, 'Nothing is recorded as going into this lot.',
      (lot) => [
        lot.item_name,
        `${lot.depth === 1 ? 'directly' : `${lot.depth} steps back`} · ${codes(lot) || 'no code'}`
          + `${lot.supplier_name ? ` · ${lot.supplier_name}` : ''}`
          + `${lot.supplier_lot ? ` · supplier lot ${lot.supplier_lot}` : ''}`
          + `${lot.supplier_invoice ? ` · invoice ${lot.supplier_invoice}` : ''}`
          + ` · ${lot.origin === 'received' ? 'delivered' : 'made'} ${day(lot.originated_at)}`,
      ]),
    ...section('Where this lot went', r.customers, 'Not dispatched.',
      (c) => [c.customer_name, `${qty(c)} · sent ${day(c.occurred_at)}${c.reference ? ` · ${c.reference}` : ''}`]),
    ...section('Gaps in the trail', r.gaps, 'Every input in this chain names its lot.',
      (g) => GAP_TEXT[g.kind](g)),
  ];
}

// Plain text of the same answer, for a phone call, an email or a note pinned
// to the door. Same content as the screen, no layout.
function recallText(r) {
  const out = [`${r.direction === 'forward' ? 'Recall' : 'Provenance'}: ${r.start.item_name} `
    + `${codes(r.start)} (${day(r.start.originated_at)})`];
  if (r.truncated) out.push(`WARNING: chain longer than ${r.max_depth} steps, this list is incomplete.`);
  const add = (title, rows, line) => {
    out.push('', `${title}${rows.length ? '' : ': none'}`);
    for (const row of rows) out.push(`- ${line(row)}`);
  };
  if (r.direction === 'forward') {
    add('Went to customers', r.customers, (c) => `${c.customer_name}: ${c.item_name} ${qty(c)} ${codes(c)} `
      + `use by ${day(c.use_by) || 'none'}, sent ${day(c.occurred_at)}${c.reference ? `, ${c.reference}` : ''}`);
    add('Still in the building', r.on_hand, (o) => `${o.item_name} ${qty(o)} in ${o.location_name} ${codes(o)}`);
    add('Made from it', r.lots, (l) => `${l.item_name} ${codes(l)} ${l.status}${l.held ? ' HELD' : ''}`);
    add('Binned', r.wasted, (w) => `${w.item_name} ${qty(w)} ${w.reason || ''} ${day(w.occurred_at)}`);
  } else {
    add('Made from', r.lots, (l) => `${l.item_name} ${codes(l)} ${l.supplier_name || ''} `
      + `${l.supplier_lot ? `supplier lot ${l.supplier_lot}` : ''}`.trim());
    add('Where this lot went', r.customers, (c) => `${c.customer_name} ${qty(c)} ${day(c.occurred_at)}`);
  }
  add(r.direction === 'forward' ? 'Cannot be ruled out' : 'Gaps in the trail', r.gaps,
    (g) => `${g.batch_item_name} ${g.batch_short_code || ''}: ${trim(g.quantity)} ${g.unit} of ${g.item_name}, `
      + `no lot recorded`);
  return out.join('\n');
}

async function runRecall(direction) {
  if (!tracedLot) return;
  const box = $('recall');
  const response = await api(`/api/recall?lot=${encodeURIComponent(tracedLot)}&direction=${direction}`);
  if (!response.ok) {
    const div = document.createElement('div');
    div.className = 'banner bad';
    div.style.borderRadius = '12px';
    div.textContent = response.body.error || `Refused with ${response.status}`;
    box.replaceChildren(div);
    box.hidden = false;
    return;
  }
  const result = response.body;
  const parts = [];
  if (result.truncated) {
    const div = document.createElement('div');
    div.className = 'banner bad';
    div.textContent = `This chain is longer than ${result.max_depth} steps, so the list below is incomplete. `
      + 'That is not normal here and means something in the data needs looking at.';
    parts.push(div);
  }
  parts.push(...(direction === 'forward' ? forwardParts(result) : backParts(result)));

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'secondary';
  copy.style.cssText = 'margin:12px 16px';
  copy.textContent = 'Copy as text';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(recallText(result));
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Could not copy — select the list instead';
    }
  });
  parts.push(copy);
  box.replaceChildren(...parts);
  box.hidden = false;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('recall-forward').addEventListener('click', () => runRecall('forward'));
$('recall-back').addEventListener('click', () => runRecall('back'));


// ------------------------------------------------------------ mass balance
//
// Per item over a period (src/ledger/balance.js). Every figure is a sum over
// the ledger's movements, and `other` proves it: it is what is left when the
// flows are taken off the closing balance, and it should always be zero.

const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${trim(Math.abs(n))}`;

function balanceRow(row) {
  const u = row.base_unit;
  const flows = [
    row.received && `in ${trim(row.received)}`,
    row.produced && `made ${trim(row.produced)}`,
    row.consumed && `used ${trim(row.consumed)}`,
    row.dispatched && `sent ${trim(row.dispatched)}`,
    row.wasted && `binned ${trim(row.wasted)}`,
  ].filter(Boolean);

  const notes = [];
  if (row.adjusted || row.adjusted_up || row.adjusted_down) {
    const both = row.adjusted_up && row.adjusted_down
      ? ` (${signed(row.adjusted_up)} and ${signed(-row.adjusted_down)} across counts)` : '';
    notes.push(`Counts corrected this by ${signed(row.adjusted)} ${u}`
      + `${row.adjusted_pct === null ? '' : ` (${signed(Math.round(row.adjusted_pct * 10) / 10)}%)`}${both}`);
  }
  if (row.unproven || row.unproven_other_units.length) {
    const parts = [row.unproven && `${trim(row.unproven)} ${u}`,
      ...row.unproven_other_units.map((x) => `${trim(x.quantity)} ${x.unit}`)].filter(Boolean);
    notes.push(`Also ${parts.join(' and ')} used with no lot recorded. Not in the figures here, so the next `
      + 'count may write it off as an adjustment.');
  }
  if (row.other) {
    notes.push(`Does not reconcile: ${signed(row.other)} ${u} unexplained. A movement type this report `
      + 'does not know about is being written. Tell whoever maintains trace.');
  }
  return [
    row.name,
    `${trim(row.opening)} → ${trim(row.closing)} ${u}${flows.length ? ` · ${flows.join(' · ')}` : ''}`
      + `${row.nominal ? '\nNominal kg: a case is a stated weight, never weighed, so small variance is packaging, not loss.' : ''}`,
    notes,
  ];
}

async function loadBalance() {
  const from = $('bal-from').value;
  const to = $('bal-to').value;
  $('bal-error').replaceChildren();
  if (!online()) return;
  const kind = $('bal-kind').value;
  const query = new URLSearchParams({ from, to });
  if (kind) query.set('kind', kind);
  const response = await api(`/api/period-balance?${query}`);
  if (!response.ok) {
    const div = document.createElement('div');
    div.className = 'banner bad';
    div.style.borderRadius = '12px';
    div.textContent = response.body.error || `Refused with ${response.status}`;
    $('bal-error').replaceChildren(div);
    $('balance').replaceChildren();
    return;
  }
  const { rows } = response.body;
  $('balance').replaceChildren(...section(
    `${rows.length} item${rows.length === 1 ? '' : 's'} with movement or stock`,
    rows, 'Nothing moved in this period and nothing was on hand.', balanceRow));
  for (const [i, li] of [...$('balance').querySelectorAll('.rows li')].entries()) {
    if (rows[i].nominal) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'nominal';
      li.querySelector('.name').append(tag);
    }
  }
}

// Default to the last four weeks, the cycle the weekly count closes.
(() => {
  const today = new Date();
  const back = new Date(today.getTime() - 28 * 86400000);
  const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  $('bal-to').value = iso(today);
  $('bal-from').value = iso(back);
})();
$('bal-go').addEventListener('click', loadBalance);
$('bal-kind').addEventListener('change', loadBalance);

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
loadBalance();
