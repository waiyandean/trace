import { json, error, BadRequest } from './http.js';
import { handleCatalog, CATALOG_ACTIONS } from './catalog/handlers.js';
import { handleLedger, LEDGER_ACTIONS, lookupCode } from './ledger/reads.js';
import { issueCodes, poolFor } from './ledger/codes.js';
import { receive } from './ledger/receive.js';
import { openDeviations, closeDeviation } from './ledger/deviations.js';
import { move, waste, hold, releaseHold, openHolds } from './ledger/stock.js';
import { produce } from './ledger/produce.js';
import { pendingReadings, recordReading } from './ledger/checkpoints.js';
import { openBatches, batchDetail, recordPacking, massBalance } from './ledger/packing.js';
import { openUnproven, reviewUnproven } from './ledger/unproven.js';
import { dispatch, dispatchResult, recentDispatches } from './ledger/dispatch.js';

// The `trace` Worker.
//
//   GET  /api/health              binding and migration check
//   GET  /api/catalog?action=…    items | locations | suppliers | customers
//                                 | staff | conversions
//                                 items also takes &kind=ingredient|packaging|product
//                                 conversions takes &item=<item id>
//                                 all take &active=all to include retired rows
//   GET  /api/ledger?action=…     lots | stock
//                                 lots takes &item, &status (default open, or all)
//                                 stock takes &item, &location
//   GET  /api/lookup?code=…       resolve a scanned or typed code to its lots
//   GET  /api/codes?device=…      the short codes a device still holds unbound
//   POST /api/codes               {device_id, want} — top that pool up
//   GET  /api/deviations          temperature holds nobody has closed yet
//   POST /api/receive             book a delivery: opens lots, writes RECEIVE
//   POST /api/deviations          close one: a second reading, an outcome, a name
//   GET  /api/holds               lots held by hand, and why
//   GET  /api/unproven            batch inputs with no identified lot, unreviewed
//   POST /api/unproven            mark one reviewed: {unproven_id, staff_id, note}
//   POST /api/move                move stock between storage areas
//   POST /api/waste               throw stock away, with a reason
//   POST /api/hold                hold a lot; ?release to let it go
//   POST /api/produce             make a batch: consumes lots, opens a product lot
//   GET  /api/checks              checkpoint readings that are due and unanswered
//   POST /api/checks              answer one
//   GET  /api/batches             batches still to finish, and what each needs
//   GET  /api/batches?lot=…       one batch: its inputs, its checks, its state
//   POST /api/packing             record packets produced and the label check
//   GET  /api/balance?lot=…       what went in against what came out
//   GET  /api/dispatches          recent dispatches, newest first
//   GET  /api/dispatches?event=…  one dispatch: its customer, lines and temps
//   POST /api/dispatch            send produced lots to a customer: writes DISPATCH
//
// The old `forms` system stays authoritative until Dean cuts over, so nothing
// here is yet the kitchen's record of anything.
//
// There is still no authentication (PLAN.md, open question
// "Authentication"). With P1 this
// stops being a read-only exposure: anyone with the URL can write to the
// ledger. That has to be settled before the kitchen is asked to rely on it.

async function health(db) {
  const row = await db
    .prepare('SELECT (SELECT COUNT(*) FROM items) AS items, (SELECT COUNT(*) FROM lots) AS lots')
    .first();
  return { ok: true, items: row.items, lots: row.lots };
}

// Which methods each path answers to, so that the wrong verb on a real path
// is a 405 telling the caller what it should have used, rather than a 404
// implying the endpoint does not exist.
const ROUTES = {
  '/api/health': ['GET'],
  '/api/catalog': ['GET'],
  '/api/ledger': ['GET'],
  '/api/lookup': ['GET'],
  '/api/codes': ['GET', 'POST'],
  '/api/receive': ['POST'],
  '/api/deviations': ['GET', 'POST'],
  '/api/holds': ['GET'],
  '/api/move': ['POST'],
  '/api/waste': ['POST'],
  '/api/hold': ['POST'],
  '/api/produce': ['POST'],
  '/api/checks': ['GET', 'POST'],
  '/api/packing': ['POST'],
  '/api/batches': ['GET'],
  '/api/balance': ['GET'],
  '/api/unproven': ['GET', 'POST'],
  '/api/dispatch': ['POST'],
  '/api/dispatches': ['GET'],
};

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    throw new BadRequest('the body must be valid JSON');
  }
}

async function route(request, env, url) {
  const db = env.DB;

  if (request.method === 'GET') {
    if (url.pathname === '/api/health') return json(await health(db));
    if (url.pathname === '/api/catalog') return json(await handleCatalog(db, url));
    if (url.pathname === '/api/ledger') return json(await handleLedger(db, url));
    if (url.pathname === '/api/lookup') return json(await lookupCode(db, url.searchParams.get('code')));
    if (url.pathname === '/api/codes') return json(await poolFor(db, url.searchParams.get('device')));
    if (url.pathname === '/api/deviations') {
      const rows = await openDeviations(db);
      return json({ count: rows.length, rows });
    }
    if (url.pathname === '/api/batches') {
      const lot = url.searchParams.get('lot');
      if (lot) return json(await batchDetail(db, lot));
      const rows = await openBatches(db);
      return json({ count: rows.length, rows });
    }
    if (url.pathname === '/api/balance') {
      const lot = url.searchParams.get('lot');
      if (!lot) throw new BadRequest('lot is required');
      return json(await massBalance(db, lot));
    }
    if (url.pathname === '/api/checks') {
      const rows = await pendingReadings(db);
      return json({ count: rows.length, rows });
    }
    if (url.pathname === '/api/holds') {
      const rows = await openHolds(db);
      return json({ count: rows.length, rows });
    }
    if (url.pathname === '/api/dispatches') {
      const event = url.searchParams.get('event');
      if (event) return json(await dispatchResult(db, event));
      const rows = await recentDispatches(db, { customerId: url.searchParams.get('customer') });
      return json({ count: rows.length, rows });
    }
    if (url.pathname === '/api/unproven') {
      const rows = await openUnproven(db);
      return json({ count: rows.length, rows });
    }
    return null;
  }

  if (request.method === 'POST') {
    if (url.pathname === '/api/codes') {
      const body = await readBody(request);
      return json(await issueCodes(db, body.device_id, body.want));
    }
    if (url.pathname === '/api/deviations') {
      return json(await closeDeviation(db, await readBody(request)));
    }
    if (url.pathname === '/api/move') return json(await move(db, await readBody(request)), { status: 201 });
    if (url.pathname === '/api/waste') return json(await waste(db, await readBody(request)), { status: 201 });
    if (url.pathname === '/api/hold') {
      const body = await readBody(request);
      return url.searchParams.get('release') !== null
        ? json(await releaseHold(db, body))
        : json(await hold(db, body), { status: 201 });
    }
    if (url.pathname === '/api/checks') return json(await recordReading(db, await readBody(request)));
    if (url.pathname === '/api/unproven') return json(await reviewUnproven(db, await readBody(request)));
    if (url.pathname === '/api/packing') return json(await recordPacking(db, await readBody(request)));
    if (url.pathname === '/api/produce') return json(await produce(db, await readBody(request)), { status: 201 });
    if (url.pathname === '/api/dispatch') return json(await dispatch(db, await readBody(request)), { status: 201 });
    if (url.pathname === '/api/receive') {
      const result = await receive(db, await readBody(request));
      // 200 for a replay, 201 for a submission that wrote something. A device
      // reconciling its offline queue can tell the two apart without reading
      // the body.
      return json(result, { status: result.duplicate ? 200 : 201 });
    }
    return null;
  }

  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const allowed = ROUTES[url.pathname];
    if (allowed && !allowed.includes(request.method)) {
      return json({ error: `method not allowed: use ${allowed.join(' or ')} on ${url.pathname}` }, {
        status: 405,
        headers: { allow: allowed.join(', ') },
      });
    }
    if (!['GET', 'POST'].includes(request.method)) return error(405, 'method not allowed');

    try {
      const response = await route(request, env, url);
      if (response) return response;
    } catch (err) {
      if (err instanceof BadRequest) return error(400, err.message);
      throw err;
    }

    return error(
      404,
      `not found: ${request.method} ${url.pathname}. Try /api/health, ` +
        `/api/catalog?action=${CATALOG_ACTIONS[0]}, /api/ledger?action=${LEDGER_ACTIONS[0]} ` +
        'or POST /api/receive',
    );
  },
};
