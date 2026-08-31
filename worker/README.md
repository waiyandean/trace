# trace worker — P0

The Cloudflare Worker and D1 database behind trace. P0 is foundations only:
the catalog tables and a read-only API over them. There are no capture forms,
no lots and no movements yet — those arrive with P1, along with the offline
queue and idempotency keys.

## Layout

- `wrangler.toml` — Worker and D1 configuration.
- `migrations/` — schema, applied with `wrangler d1 migrations apply`.
- `src/index.js` — routing; the whole public surface is listed at the top.
- `src/catalog/handlers.js` — the catalog reads.
- `test/` — `node --test`, run against a fake D1 binding.

## Endpoints

    GET /api/health                    binding and migration check
    GET /api/catalog?action=items      &kind=ingredient|packaging|product
    GET /api/catalog?action=locations
    GET /api/catalog?action=suppliers
    GET /api/catalog?action=customers
    GET /api/catalog?action=staff
    GET /api/catalog?action=conversions &item=<item id>

Every catalog action takes `&active=all` to include retired rows; the default
is active rows only.

## Working on it

    npm install
    npm run migrate:local     # apply migrations to the local D1
    npm run dev               # wrangler dev, against the local D1
    npm test

## Before the first deploy

`wrangler.toml` carries a placeholder `database_id`. Create the database and
paste the id it prints in:

    npx wrangler d1 create trace
    npm run migrate           # applies migrations to the remote database

This is a new, deliberately empty database. The old `forms-traceability` D1
and the Google Sheets before it are frozen as a read-only archive, and nothing
is imported from them (see `../PLAN.md`, "History").

## Catalog data

The catalog is populated by import, not by hand and never by invention. The
importer is not written yet: it is waiting on the source Dean nominates for
the item, supplier and conversion lists.
