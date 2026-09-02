# trace — handoff

Where the project is, what to pick up, and the things that will bite you if
nobody says them. Read `PLAN.md` for the model and the reasoning; this is the
shorter, staler-faster document about state.

Last updated 2026-09-02.

## State

| Phase | State |
| --- | --- |
| P0 Foundations | Complete. Catalog imported, deployed. |
| P1 Receive | Complete, not deployed. Goods-in form, compliance checks, offline. |
| P2 Store, move, waste | Complete, not deployed. Stock screen. |
| P3 Produce | Ledger and forms built, not deployed. Two gaps below. |
| P4 Dispatch | Not started. |
| P5 Count | Not started. Blocked on count granularity. |
| P6 Reports | Partial: one-step-back and mass balance exist as API reads. |
| P7 Parallel run | Not started. |

184 tests pass (`npm test` in `worker/`). Eleven migrations.

**Nothing is deployed past P0.** The live Worker at
`https://trace.waiyandean.workers.dev` is still the read-only catalog build
from 2026-08-31, and the remote database has only migration 0001 applied.
Everything since runs locally. That is deliberate: the endpoints write, and
authentication is deferred to the end of the build (Dean, 2026-08-31).

## Running it

    cd worker
    npm install
    npm run migrate:local
    npx wrangler d1 execute trace --local --file scripts/catalog.sql
    npx wrangler d1 execute trace --local --file scripts/item-suppliers.sql
    npx wrangler d1 execute trace --local --file scripts/recipes.sql
    npx wrangler d1 execute trace --local --command \
      "INSERT INTO devices (id, name) VALUES ('trace:goods-in-ipad', 'Goods In iPad')"
    npm run dev

Four screens: `/` goods in, `/stock`, `/batching`, `/batches`.

A device row is needed or the goods-in form has nothing to be — short codes
are issued per device.

## What to pick up next

1. **Finish P3.** Two things are built but unproven end to end in a browser:
   the open-batches screen and packing. Both were driven through a DOM shim,
   not Safari. Layout on the iPad has never been checked on any screen.
2. **P4 Dispatch.** Consumes product lots and inherits their recorded use-by
   rather than calculating a new one.
3. **Authentication, then deploy.** Cloudflare Access on the workers.dev
   hostname, hostname-based rather than Worker-level — a Worker-level policy
   breaks WebSockets, which the printer path will need.

## Things that will bite you

**Nothing the form can work out is filled in for anybody.** This is a rule,
not a preference, and it is in PLAN.md. A pre-filled figure records that the
form was submitted, not that anybody checked. It has already been violated
once (the lot picker) and caught once (the attestations start unticked).

**Three CSS bugs of one family have already happened**: `display: flex` on a
dialog defeating its closed state, `appearance: none` stripping a checkbox's
tick, and a class with `display` beating the `hidden` attribute. There are
tests for all three. If a control is inexplicably visible or invisible, look
at `app.css` before the JavaScript.

**Workers' static assets answer `/x.html` with a 307 to `/x`.** A cached
redirect cannot satisfy a navigation, so the service worker precaches the
extensionless path. This only fails offline, which is the one time nobody can
debug it.

**Bump `VERSION` in `public/sw.js` on every deploy.** The running version is
shown on the goods-in screen so an iPad can be asked what it has, rather than
guessed at.

**The importers delete what they no longer produce.** `import_catalog.py`
removes conversions it stops generating; `import_recipes.py` replaces a
recipe's lines wholesale. Upserting alone left a corrected factor sitting in
the database with nothing to say it was stale.

**Test data lives in the local D1 only.** The append-only trigger refuses a
plain `DELETE FROM movements`, which is it working. To wipe, delete
`.wrangler/state/v3/d1` and re-run the load above.

## Open questions, and who they block

Numbered as in PLAN.md. Renumbering breaks nothing now — references are by
name.

- **Label printing path.** Separate workstream. ZPL proven over USB; the
  network path to the printer is not chosen.
- **Count granularity.** Blocks P5.
- **Density.** Five recipe lines cannot be checked against what was used.
  Dean will verify by weighing. Nothing else is blocked.
- **Decant and merge discipline.** Partly answered — yakisoba is decanted
  whole, which is the harmless kind.
- **Authentication.** Deferred to the end of the build. Blocks every
  deployment.
- **Packaging.** Still out of scope.

Resolved and worth not relitigating: lot identity and short codes, shelf-life
ownership, opening a pack, the supervised exception workflow (proceed and
record as unproven).

## Known gaps in what is built

- **Two products have no recipe** in the batching system: Green Curry Sauce
  and Tom Yum Tare. They are shown greyed in the picker with the reason.
- **BBQ Seasoning and Beef Tataki** are still counted in `Units` because they
  fit none of the three groups Dean named.
- **Five recipe lines** cannot be converted — the density question.
- **Spring onion** has no bunch weight, so its recipe line stays unconvertible.
- **The QR scanning path does not exist.** The lot picker takes a typed short
  code or batch number, and a scanner would feed the same field.
- **No form is a real PWA test yet.** Everything has been driven through a DOM
  shim in Node, which catches wiring and logic but not layout.
