# trace worker — P1

The Cloudflare Worker and D1 database behind trace.

P0 built the catalog and a read-only API over it. P1 adds the ledger — events,
lots, movements and the short-code pool — the goods intake endpoint that
writes to them, and the form staff actually use. Recording a delivery and
printing its labels are now one act rather than two disconnected ones, which
is the structural change the whole rebuild rests on.

## Layout

- `wrangler.toml` — Worker and D1 configuration.
- `migrations/` — schema, applied with `wrangler d1 migrations apply`.
- `src/index.js` — routing; the whole public surface is listed at the top.
- `src/catalog/handlers.js` — the catalog reads.
- `src/ledger/receive.js` — goods intake: validation, idempotency, the write.
- `src/ledger/units.js` — converting what was keyed into the item's base unit.
- `src/ledger/codes.js` — the short-code pool issued per device.
- `src/ledger/reads.js` — lots, stock on hand, and code lookup.
- `public/index.html` — the goods intake form, served from the same origin.
- `public/goods-in.js` — the form's wiring to the DOM.
- `public/lib/offline.js` — id minting, the queue, the pool. No DOM, so it is
  unit tested.
- `test/` — `node --test`, run against a fake D1 binding.

## Endpoints

    GET /api/health                    binding and migration check
    GET /api/catalog?action=items      &kind=ingredient|packaging|product
    GET /api/catalog?action=locations
    GET /api/catalog?action=suppliers
    GET /api/catalog?action=customers
    GET /api/catalog?action=staff
    GET /api/catalog?action=conversions &item=<item id>
    GET /api/catalog?action=item_suppliers &supplier=<supplier id>

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

## The form

    /            the goods intake form

Served as static assets from the same origin as the API, so there is no CORS
and no second thing to keep deployed in step. `run_worker_first` in
`wrangler.toml` keeps `/api/*` with the Worker.

It is offline-first in the literal sense: everything needed to accept a
delivery is on the device before the network is asked for anything.

- **The catalog is cached** in `localStorage` and refreshed whenever there is
  a connection. With no connection the cache is used and its age is shown,
  because a week-old catalog is workable but might be missing a new
  ingredient, and the person keying the delivery is entitled to know that.
- **Short codes are already held.** The device keeps a pool of 200 and tops it
  up below 40, so a line gets its printed code with no round trip. An empty
  pool does not stop intake: the line is booked without a code and relabelled
  later.
- **The submission is written to the queue before it is sent.** A dead battery
  or a closed lid costs nothing already keyed. Retries carry the same
  idempotency key, so they are safe; a submission the server refuses is parked
  in the queue with the reason where a person will see it, rather than being
  dropped.
- **Only convertible units are offered.** The unit list per item comes from
  the conversions master, so the form cannot put a refusal in front of
  somebody holding a box.
- **The picker is narrowed to the chosen supplier.** Fifty-five tiles become
  twenty-six under Lynas. An ingredient the supplier only provides as an
  emergency backup is still there, under its own heading at the end, rather
  than mixed into the everyday grid or hidden: a backup delivery is a real
  thing that happens. An ingredient nobody has mapped shows under every
  supplier rather than none, and a "Show everything" button is always there —
  a filter must never be the reason a delivery cannot be booked in.
- **Ingredients are picked from a grid of photographs**, not a list to
  scroll. Staff recognise their stock by the picture faster than by the name,
  and the kitchen already has a photograph of every ingredient. Tiles are
  grouped fridge, freezer, dry store — the order somebody walks the kitchen —
  and an item whose storage nobody has decided gets its own group rather than
  being quietly filed under one.
- **A location is chosen only where there is one to choose.** An item that
  must be chilled has exactly one chilled area, so it is preselected. An
  ambient item is not: the dry store and the allergen-free shelf both fit, and
  picking between them for somebody would be a guess about allergens.
- **Ids are minted on the device** as ULIDs, so a lot exists the moment the
  person says it does.

Labels are not printed from here yet — that is the separate workstream in
`../labels/`. The form shows each line's short code so it can be written on
the case in the meantime.

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
          "batch_code":  "310826"
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

## Ingredient photographs

`public/photos/<item id>.jpg`, copied once from the kitchen's existing catalog
and committed here, so the form serves them from its own origin and works
offline. This is a copy, not a live dependency: the old stack stays a frozen
archive.

    npm run dev                      # in another terminal, so the API answers
    python3 scripts/import_photos.py

Matching is by item id, which both catalogs share because both came from the
same workbook, so a photograph lands on the item it was taken of and nothing
is matched by guessing at a name. Read
`scripts/photo-import-report.txt` afterwards: 59 of 64 ingredients have one.
Chicken Fillet and Pork Belly have no photograph in the source at all, and
three more are Google Drive links from before the kitchen moved its images to
R2 which Drive will not serve to anyone not signed in. Those five show their
name on a plain tile. A stand-in picture of a different ingredient would be
worse than none.

## Which supplier sells what

    npm run dev                      # in another terminal
    python3 scripts/import_item_suppliers.py "~/Downloads/Goods In Records.xlsx"
    npx wrangler d1 execute trace --local --file scripts/item-suppliers.sql

Built from two sources in the kitchen's own Goods In Records, kept apart and
labelled on each row: `registered` is its maintained supplier list, and
`delivered` is the fact that the supplier has actually delivered that item —
2,600-odd real deliveries. Where both apply, `delivered` wins, because a
pairing the history proves is stronger than one only written down.

Where the records cannot say, the kitchen's answer is taken from
`scripts/catalog-overrides.json` — the same file the catalog importer reads —
and recorded as `decided`, so a decision is never mistaken for evidence.

The relationship is many-to-many, because seven ingredients genuinely arrive
from both Lynas and Tazaki. They are not equal pairings: Tazaki is the normal
source and Lynas is who the kitchen falls back to when Tazaki cannot supply,
so those rows carry `role = 'backup'`. Only a person can draw that line — the
history cannot tell "bought here every week" apart from "bought here twice in
an emergency" — so it comes from the overrides file.

Read `scripts/item-suppliers-report.txt`; it lists the shared seven with their
roles, and every workbook name that matches no catalog item. All 55 active
ingredients have a supplier. Nothing is matched approximately — the two
spreadsheets spell several things differently, and a fuzzy match would put an
ingredient behind the wrong supplier and hide it at the door.

## Devices

A device must be registered before it can hold codes or submit anything, so
that a typo in a device name cannot quietly mint a second pool:

    npx wrangler d1 execute trace --local --command \
      "INSERT INTO devices (id, name) VALUES ('trace:goods-in-ipad', 'Goods In iPad')"

There is no admin endpoint for this yet; it is a deliberate, occasional act.
`GET /api/catalog?action=devices` lists them, which is how the form knows what
exists.

The kitchen has one iPad, so the form does not ask which device it is: where
exactly one device is registered it uses it, and the row stays hidden.
Choosing the only candidate is not a guess. The concept stays in the schema
regardless — short codes are reserved per device so two devices can never mint
the same one — and the choice appears on its own the day a second device is
registered. A remembered device that is no longer registered is dropped rather
than carried on with, since it would fail at the first submission.

## Working on it

    npm install
    npm run migrate:local     # apply migrations to the local D1
    npm run dev               # wrangler dev, against the local D1
    npm test

`npm run dev` serves the form at `http://localhost:8799/` and the API beneath
it, both against the local database. Register a device first (below) or the
form has nothing to be.

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
