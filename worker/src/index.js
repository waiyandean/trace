import { json, error, BadRequest } from './http.js';
import { handleCatalog, CATALOG_ACTIONS } from './catalog/handlers.js';
import { handleLedger, LEDGER_ACTIONS, lookupCode } from './ledger/reads.js';
import { issueCodes, poolFor } from './ledger/codes.js';
import { receive } from './ledger/receive.js';
import { openDeviations, closeDeviation } from './ledger/deviations.js';

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
//
// The old `forms` system stays authoritative until Dean cuts over, so nothing
// here is yet the kitchen's record of anything.
//
// There is still no authentication (PLAN.md open question 7). With P1 this
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
