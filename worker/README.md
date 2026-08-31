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
source is the `Weekly Stock Check Records` workbook the kitchen already
maintains — its `Ingredients`, `FinishedProducts` and `map` tabs.

    python3 scripts/import_catalog.py "~/Downloads/Weekly Stock Check Records.xlsx" \
        --report scripts/catalog-import-report.txt
    npx wrangler d1 execute trace --local --file scripts/catalog.sql

The generated `scripts/catalog.sql` upserts on the workbook's own ids, so a
re-import updates rows instead of duplicating them, and it never overwrites a
column the workbook cannot answer with a null.

Read `scripts/catalog-import-report.txt` after every import. It lists what the
workbook could not answer — rows skipped for want of a base unit, conversions
withheld because two columns of the workbook disagree, and the columns that
are null because the source has no such field. Those are decisions for the
kitchen, not for the importer, and nothing fills them in by guessing.

Still empty, because this workbook does not carry them: `locations`,
`suppliers`, `customers` and `staff`. The workbook names three storage areas
(Dry Store, Fridge, Freezer) and two sites (Glasgow, Edinburgh), but not how
the two combine, which is what a location row has to say.
