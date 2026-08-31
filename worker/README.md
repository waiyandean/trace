# trace worker — P1

The Cloudflare Worker and D1 database behind trace.

P0 built the catalog and a read-only API over it. P1 adds the ledger — events,
lots, movements and the short-code pool — and the goods intake endpoint that
writes to them. Recording a delivery and printing its labels are now one act
rather than two disconnected ones, which is the structural change the whole
rebuild rests on.

## Layout

- `wrangler.toml` — Worker and D1 configuration.
- `migrations/` — schema, applied with `wrangler d1 migrations apply`.
- `src/index.js` — routing; the whole public surface is listed at the top.
- `src/catalog/handlers.js` — the catalog reads.
- `src/ledger/receive.js` — goods intake: validation, idempotency, the write.
- `src/ledger/units.js` — converting what was keyed into the item's base unit.
- `src/ledger/codes.js` — the short-code pool issued per device.
- `src/ledger/reads.js` — lots, stock on hand, and code lookup.
- `test/` — `node --test`, run against a fake D1 binding.

## Endpoints

    GET /api/health                    binding and migration check
    GET /api/catalog?action=items      &kind=ingredient|packaging|product
    GET /api/catalog?action=locations
    GET /api/catalog?action=suppliers
    GET /api/catalog?action=customers
    GET /api/catalog?action=staff
    GET /api/catalog?action=conversions &item=<item id>

    GET  /api/ledger?action=lots       &item=<item id> &status=open|all|held|…
    GET  /api/ledger?action=stock      &item=<item id> &location=<location id>
    GET  /api/lookup?code=<code>       resolve a scanned or typed code
    GET  /api/codes?device=<device id> the codes that device still holds
    POST /api/codes                    {device_id, want} — top that pool up
    POST /api/receive                  book a delivery

Every catalog action takes `&active=all` to include retired rows; the default
is active rows only. Items out of scope at Glasgow are held as inactive rows
rather than removed, so they stay out of every picker without disappearing
from the record.

## Booking a delivery

`POST /api/receive` takes one submission and books the whole delivery, or none
of it:

    {
      "event_id":        "<ULID minted on the device>",
      "idempotency_key": "<minted with the submission, never reused>",
      "device_id":       "trace:goods-in-ipad",
      "staff_id":        "trace:nikin",
      "occurred_at":     "2026-08-31T09:14:00Z",
      "supplier_id":     "trace:lynas",
      "invoice":         "009298395",
      "lines": [
        {
          "lot_id":      "<ULID minted on the device>",
          "item_id":     "mpv4uvjvdk38",
          "short_code":  "K7M4QP",
          "quantity":    3,
          "unit":        "case",
          "location_id": "trace:walk-in-fridge",
          "use_by":      "2026-09-04",
          "batch_code":  "2026-08-31"
        }
      ]
    }

It answers `201` for a submission that wrote something and `200` with
`"duplicate": true` for the replay of one already accepted, so a device
draining an offline queue can retry safely and tell the two apart.

Three things about that shape are decisions rather than convenience:

- **Ids are minted on the device**, as ULIDs, so a lot can be created with no
  network at all. The server never assigns one.
- **`short_code` is optional.** It comes from the pool the device already
  holds and has already printed. If the pool ran dry offline, the lot is still
  booked and simply has no printed code yet — a relabel, not lost data.
- **`use_by` is optional, and its absence means something.** A date supplied
  is the supplier's printed date and is recorded as theirs. No date means the
  item's shelf life fills in, recorded as `shelf_life_rule`, so it is always
  possible to ask later which lots were dated by evidence and which by rule.

Everything else refuses rather than assumes. An unknown item, an inactive
location, a unit with no recorded conversion, a short code belonging to
another device, a lot id already booked — each is a `400` naming what is
wrong. A guess at intake is a wrong balance for the life of the lot.

## Devices

A device must be registered before it can hold codes or submit anything, so
that a typo in a device name cannot quietly mint a second pool:

    npx wrangler d1 execute trace --local --command \
      "INSERT INTO devices (id, name) VALUES ('trace:goods-in-ipad', 'Goods In iPad')"

There is no admin endpoint for this yet; it is a deliberate, occasional act.

## Working on it

    npm install
    npm run migrate:local     # apply migrations to the local D1
    npm run dev               # wrangler dev, against the local D1
    npm test

## Deployed

    https://trace.waiyandean.workers.dev

There is **no authentication** (PLAN.md open question 7). While P0 was
deployed that meant anyone with the URL could read the catalog. P1's endpoints
write, so the same gap now means anyone with the URL could book a delivery
that never happened. The P1 code is therefore not deployed: the live Worker is
still the P0 read-only build until authentication is settled.

To deploy:

    npm run migrate           # applies migrations to the remote database
    npx wrangler d1 execute trace --remote --file scripts/catalog.sql
    npm run deploy

The database is a new, deliberately empty one. The old `forms-traceability` D1
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

Where the workbook cannot answer — base units for the bulk meat and bones,
which items carry the oval health mark — the kitchen's answer is recorded in
`scripts/catalog-overrides.json`, with the date and the person who gave it.
The importer applies those on top of the workbook. Add to that file rather
than editing the generated SQL, which is overwritten on every run.

Read `scripts/catalog-import-report.txt` after every import. It lists what
nothing has yet answered: rows skipped for want of a base unit, conversions
not written, and the columns still null because neither the workbook nor the
overrides say. Those are decisions for the kitchen, not for the importer, and
nothing fills them in by guessing.

`locations`, `suppliers` and `staff` are listed in the overrides in full
rather than derived from the workbook: four Glasgow storage areas, Lynas and
Tazaki, and ten people. Only Glasgow is in scope.

`customers` is still empty. Dispatch is P4 and nothing needs it yet.
