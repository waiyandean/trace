// The offline half of goods intake, kept apart from the DOM so it can be
// tested on its own. Nothing in here touches the page.
//
// The rule this file exists to honour: staff are stood at the goods-in door
// holding a box, and the kitchen wifi drops. Everything the form needs to
// accept a delivery — the catalog, a supply of short codes, somewhere to put
// the submission — has to already be on the device before the network goes.
// Sync is a background chore afterwards, never a precondition.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// ULIDs, minted here rather than by the server, so a lot exists the moment
// the person says it does. The first ten characters are the timestamp, which
// makes ids sort in the order the deliveries were booked; the last sixteen are
// random. A counter breaks ties inside the same millisecond, so two lines
// added in the same tick cannot collide.
let lastMillisecond = 0;
let sameMillisecondCounter = 0;

export function ulid(now = Date.now(), random = crypto) {
  if (now === lastMillisecond) sameMillisecondCounter += 1;
  else {
    lastMillisecond = now;
    sameMillisecondCounter = 0;
  }

  let time = '';
  for (let i = 9; i >= 0; i -= 1) time += CROCKFORD[Math.floor(now / 32 ** i) % 32];

  const bytes = new Uint8Array(16);
  random.getRandomValues(bytes);
  bytes[15] = (bytes[15] + sameMillisecondCounter) & 255;
  let tail = '';
  for (const byte of bytes) tail += CROCKFORD[byte & 31];

  return time + tail;
}

// localStorage throws rather than returning null in a private window and on a
// device with site data blocked, and a thrown error at the door would lose the
// delivery. Every read and write goes through here.
export function makeStore(storage) {
  return {
    read(key, fallback) {
      try {
        const raw = storage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    write(key, value) {
      try {
        storage.setItem(key, JSON.stringify(value));
        return true;
      } catch {
        // Out of quota, or storage denied. The caller is told so it can say
        // so on screen rather than pretend the submission is safe.
        return false;
      }
    },
  };
}

const QUEUE_KEY = 'trace.intake.queue';

// The submission queue. A submission goes in before anything is sent, and
// leaves only when the server has confirmed it. A crash, a closed lid or a
// dead battery therefore costs nothing that was already keyed in.
//
// Statuses:
//   pending  — not yet accepted; keep retrying
//   sent     — the server has it, with what it wrote
//   rejected — the server refused it and will refuse it again. A person has
//              to look. It stays in the queue, visible, rather than being
//              dropped, because a delivery that vanished silently is exactly
//              the failure this system exists to remove.
export function makeQueue(store) {
  const all = () => store.read(QUEUE_KEY, []);
  const save = (entries) => store.write(QUEUE_KEY, entries);

  return {
    all,
    pending: () => all().filter((entry) => entry.status === 'pending'),
    rejected: () => all().filter((entry) => entry.status === 'rejected'),

    add(payload) {
      const entry = { payload, status: 'pending', queued_at: new Date().toISOString(), attempts: 0, error: null };
      const entries = all();
      entries.push(entry);
      return save(entries) ? entry : null;
    },

    update(idempotencyKey, changes) {
      const entries = all().map((entry) =>
        entry.payload.idempotency_key === idempotencyKey ? { ...entry, ...changes } : entry,
      );
      save(entries);
      return entries.find((entry) => entry.payload.idempotency_key === idempotencyKey) || null;
    },

    // Only what the server has confirmed can be cleared, and only once it has
    // been shown. Nothing else is ever removed automatically.
    clearSent() {
      save(all().filter((entry) => entry.status !== 'sent'));
    },
  };
}

const POOL_KEY = 'trace.intake.pool';
export const POOL_LOW_WATER = 40;
export const POOL_TARGET = 200;

// The short-code pool as the device holds it. The server reserves the codes;
// this only decides which one is used next and remembers which are spent, so
// two lines in one delivery cannot print the same code.
export function makePool(store) {
  const state = () => store.read(POOL_KEY, { device_id: null, codes: [] });

  return {
    state,
    remaining: () => state().codes.length,
    isLow: () => state().codes.length < POOL_LOW_WATER,

    // Replaces the held codes with what the server says this device has
    // unbound. The server is the authority: a code it no longer lists as
    // unbound has been bound by a submission that got through, even if this
    // device never saw the reply.
    replace(deviceId, codes) {
      return store.write(POOL_KEY, { device_id: deviceId, codes: [...codes] });
    },

    // Takes the next code and spends it immediately. Returning null is a
    // normal outcome, not an error: the lot is booked without a printed code
    // and gets relabelled later.
    take() {
      const current = state();
      if (!current.codes.length) return null;
      const [code, ...rest] = current.codes;
      store.write(POOL_KEY, { ...current, codes: rest });
      return code;
    },

    // A line removed before submission hands its code back, at the end of the
    // queue so it is not immediately reused on a label that was already
    // written out by hand.
    giveBack(code) {
      const current = state();
      if (!code || current.codes.includes(code)) return;
      store.write(POOL_KEY, { ...current, codes: [...current.codes, code] });
    },
  };
}

const CATALOG_KEY = 'trace.intake.catalog';

// The catalog, cached so the form works with no network. It is refreshed
// whenever the device is online and otherwise used as it stands, with the age
// shown on screen: stale reference data is workable, but the person keying a
// delivery is entitled to know a new item might be missing from the list.
export function makeCatalogCache(store) {
  return {
    read: () => store.read(CATALOG_KEY, null),
    write(catalog) {
      return store.write(CATALOG_KEY, { ...catalog, cached_at: new Date().toISOString() });
    },
  };
}

// Which units a line may be keyed in. The item's base unit always, plus every
// unit the conversions master can reach it from — no more, because a unit
// with no recorded conversion is refused by the server and should never have
// been offered on screen.
export function unitsFor(item, conversions) {
  const units = new Set([item.base_unit]);
  for (const row of conversions) {
    if (row.item_id !== item.id) continue;
    units.add(row.from_unit);
    units.add(row.to_unit);
  }
  return [...units];
}

// The picker's grouping. Stock is shown in the order somebody walks the
// kitchen — fridge, freezer, dry store — because that is the order boxes come
// off the pallet in. Items whose storage nobody has decided yet get their own
// group rather than being quietly filed under one: an undecided value is
// shown as undecided, the same rule the catalog follows.
export const STORAGE_GROUPS = [
  { key: 'chill', label: 'Fridge' },
  { key: 'freezer', label: 'Freezer' },
  { key: 'ambient', label: 'Dry store' },
  { key: null, label: 'Storage not yet decided' },
];

// Narrowing the picker to one supplier's ingredients. Sixty-odd tiles become
// twenty-odd, which is the difference between scanning a grid and hunting
// through one.
//
// An item nobody has mapped to any supplier is shown under every supplier,
// not under none. The mapping is incomplete — twelve ingredients have no
// supplier recorded anywhere in the kitchen's records — and hiding stock that
// has genuinely turned up is a worse failure than showing one tile too many:
// it leaves somebody at the door with a box they cannot book in.
export function forSupplier(items, mapping, supplierId) {
  if (!supplierId) return items;

  const mapped = new Set(mapping.map((row) => row.item_id));
  const theirs = new Set(mapping.filter((row) => row.supplier_id === supplierId).map((row) => row.item_id));
  return items.filter((item) => theirs.has(item.id) || !mapped.has(item.id));
}

// Which of a supplier's ingredients are the everyday ones and which they only
// supply when the usual source cannot. Seven ingredients are normally bought
// from Tazaki and come from Lynas only as a fallback, so under Lynas they
// belong at the end rather than mixed into the grid — but they belong there,
// because a Lynas delivery of them is a real thing that happens.
export function splitByRole(items, mapping, supplierId) {
  if (!supplierId) return { everyday: items, backup: [] };

  const backupIds = new Set(
    mapping.filter((row) => row.supplier_id === supplierId && row.role === 'backup').map((row) => row.item_id),
  );
  return {
    everyday: items.filter((item) => !backupIds.has(item.id)),
    backup: items.filter((item) => backupIds.has(item.id)),
  };
}

// Who normally supplies an item, for explaining a backup tile: "normally
// Tazaki". Null where nobody has said, or where the item has one supplier.
export function usualSupplierFor(itemId, mapping) {
  const primary = mapping.find((row) => row.item_id === itemId && row.role === 'primary');
  return primary ? primary.supplier_id : null;
}

export function groupByStorage(items, filter = '') {
  const wanted = filter.trim().toLowerCase();
  const matching = items.filter((item) => item.name.toLowerCase().includes(wanted));
  return STORAGE_GROUPS
    .map((group) => ({ ...group, items: matching.filter((item) => (item.storage_unopened || null) === group.key) }))
    .filter((group) => group.items.length);
}

// Where an item goes is usually not a question: an item that must be kept
// chilled has exactly one chilled area to go to. Where the kitchen has more
// than one area of that kind — the dry store and the allergen-free shelf —
// nothing is chosen, because picking for somebody there would be a guess
// about allergens, which is not a guess this system is allowed to make.
export function soleLocationFor(item, locations) {
  const candidates = locations.filter((row) => row.kind === item.storage_unopened);
  return candidates.length === 1 ? candidates[0].id : '';
}

// The batch code staff already write on the case: today's date, as ddmmyy
// (Dean, 2026-08-31). Kept exactly as the kitchen writes it (PLAN.md, "What
// P1 changes, and what it deliberately does not") — it is printed and stored,
// it is simply no longer what anything joins on.
//
// It is a default rather than a format the field enforces. Staff sometimes
// copy the supplier's own batch number instead, and refusing that would lose
// the better identifier of the two.
export function defaultBatchCode(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getDate())}${pad(date.getMonth() + 1)}${pad(date.getFullYear() % 100)}`;
}

// One delivery, as the form holds it, turned into the submission the server
// takes. Ids are minted here so that they exist before any network call.
export function buildSubmission(draft, { now = new Date(), mintId = ulid } = {}) {
  return {
    event_id: draft.event_id || mintId(),
    idempotency_key: draft.idempotency_key || `goods-in-${mintId()}`,
    device_id: draft.device_id,
    staff_id: draft.staff_id,
    occurred_at: (draft.occurred_at ? new Date(draft.occurred_at) : now).toISOString(),
    supplier_id: draft.supplier_id,
    invoice: draft.invoice || null,
    lines: draft.lines.map((line) => ({
      lot_id: line.lot_id,
      item_id: line.item_id,
      short_code: line.short_code || undefined,
      quantity: line.quantity,
      unit: line.unit,
      location_id: line.location_id,
      use_by: line.use_by || undefined,
      batch_code: line.batch_code || undefined,
    })),
  };
}

// Draining the queue. One submission at a time and in the order they were
// keyed, so the ledger sees the morning's deliveries in the order they
// happened rather than in whatever order a flaky connection allowed.
export async function syncQueue(queue, post) {
  const results = { sent: 0, rejected: 0, waiting: 0 };

  for (const entry of queue.pending()) {
    let response;
    try {
      response = await post(entry.payload);
    } catch {
      // No network, or the request never landed. The submission stays
      // pending: a retry is safe because the idempotency key travels with it.
      results.waiting += 1;
      break;
    }

    if (response.ok) {
      queue.update(entry.payload.idempotency_key, {
        status: 'sent',
        result: response.body,
        attempts: entry.attempts + 1,
        error: null,
      });
      results.sent += 1;
    } else if (response.status >= 400 && response.status < 500) {
      // The server has looked at it and will not take it. Retrying cannot
      // help, so it is parked where a person will see it.
      queue.update(entry.payload.idempotency_key, {
        status: 'rejected',
        attempts: entry.attempts + 1,
        error: response.body?.error || `refused with ${response.status}`,
      });
      results.rejected += 1;
    } else {
      queue.update(entry.payload.idempotency_key, {
        attempts: entry.attempts + 1,
        error: response.body?.error || `server error ${response.status}`,
      });
      results.waiting += 1;
      break;
    }
  }

  return results;
}
