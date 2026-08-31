import { json, error, BadRequest } from './http.js';
import { handleCatalog, CATALOG_ACTIONS } from './catalog/handlers.js';

// The `trace` Worker. P0 serves the catalog, read-only:
//
//   GET /api/health              binding and migration check
//   GET /api/catalog?action=…    items | locations | suppliers | customers
//                                | staff | conversions
//                                items also takes &kind=ingredient|packaging|product
//                                conversions takes &item=<item id>
//                                all take &active=all to include retired rows
//
// Capture endpoints (and with them the offline queue, idempotency keys and the
// ledger tables) arrive in P1. The old `forms` system stays authoritative
// until Dean cuts over, so nothing here writes anything a kitchen relies on.

// A cheap statement that fails loudly if the binding is missing or the
// migrations have not been applied to whichever database is bound.
async function health(db) {
  const row = await db.prepare('SELECT COUNT(*) AS items FROM items').first();
  return { ok: true, items: row.items };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method !== 'GET') return error(405, 'method not allowed');

    try {
      if (url.pathname === '/api/health') return json(await health(env.DB));
      if (url.pathname === '/api/catalog') return json(await handleCatalog(env.DB, url));
    } catch (err) {
      if (err instanceof BadRequest) return error(400, err.message);
      throw err;
    }

    return error(404, `not found: ${url.pathname}. Try /api/health or /api/catalog?action=${CATALOG_ACTIONS[0]}`);
  },
};
