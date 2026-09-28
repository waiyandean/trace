## Update, 2026-09-28: where trace stands, and where to resume

Read this block first; everything below it, including the 2026-09-16 update,
is older. `PLAN.md` is the plan of record and stays more current than this
file — its status line and several dated paragraphs (open question 9, P1)
were updated today to match what is actually live.

**Everything is deployed and live at `trace.deanops.uk`, gated by Cloudflare
Access then a per-person PIN.** P0 through P6 are built; PIN sign-in
(identify by PIN alone, with a name-grid fallback), the header nav, and a
2026-09-25 rework of Goods In (batch ingredient selection, multiple use-by
dates per ingredient, a default-storage-location rule, device
self-registration) are all live as of today. Latest deploy: version
`4b399e68`, 2026-09-28T09:19 UTC. 416 tests pass.

**The single most important thing to know: the branch this is all built on,
`worker/identify-by-pin`, has never been pushed to GitHub.** It branched from
`main` several sessions ago and has grown to roughly 30 commits, all local to
this machine. `origin/main` still only has the print/P6 work from
2026-09-21 — nothing from the auth build onward exists anywhere but this
laptop's `.git`. If this machine were lost, the deployed Worker's source
would be unrecoverable from GitHub. **This should be pushed and a PR opened
before anything else**, even before the items below.

**Only Dean has a PIN set on the remote database.** Nine other active staff
have none, so nobody else can sign in on the live app yet. Run
`PIN_PEPPER=… node scripts/set-pin.mjs --remote --all` from `worker/`, in a
real terminal with the Kobas codes ready — see `worker/README.md`'s
Authentication section for the exact command. Confirmed today:
`AUTH_SECRET` and `PIN_PEPPER` are already set as Worker secrets (from the
2026-09-24 session), so this is the only step left before the whole kitchen
can sign in.

**A device has already self-registered against the remote database** —
`Device 1`, id `01M3C5T6G19BYNJR8VC0CWP74C` — most likely from testing
during the six 2026-09-25 commits rather than the real iPad. Worth checking
which device this actually is before the real iPad's first use, since a
second device would self-register as `Device 2` and the app would then show
a device picker where today it shows none.

**Today's session (2026-09-28) reviewed six commits made outside any
session on 2026-09-25** (`655bc6e` through `5f3c094`) that Dean asked for a
second look at, since they had not gone through this repo's usual
commit-message and `PLAN.md` discipline. Found and fixed one real bug:
device self-registration called `POST /api/devices` from raw page load,
before anyone could have signed in, and that endpoint needs a signed-in
token the same as every other write — a genuinely fresh device lost that
race every time, silently. Fixed by hooking registration onto the same
session-change event the sign-in chip already listens to
(`onSessionChange` in `lib/signin.js`), so it only ever fires once someone
is actually signed in. Verified against the real running server (the
browser extension was not connected this session): refused with no token,
accepted once signed in. `PLAN.md`'s P1 section and open question 9 now
record what those six commits actually did, which they did not do
themselves.

**Also fixed today, before the review:** the print relay address was still
an editable text field on Goods In, Stock and Batches, the exact mistake
`labels/app.js` already had fixed once (2026-09-18) for the same reason —
one relay for this domain, so retyping it only breaks printing for
everybody. `lib/relay.js` is now the one place the fixed address and the
read-only status pill live, shared by all three forms. Whether to print at
all stayed a real, kept choice: a checkbox now, not a blank field that
happened to mean the same thing. Long button labels wrapping to two lines
on a phone (not the deliberate 44px tap-target minimum, which stayed
untouched) are fixed with a stack-full-width rule below 520px. The header
nav scrolls sideways rather than wrapping on a narrow screen, and the
current tab carries a GitHub-style underline. None of this has been
checked on the real iPad yet — only verified with a same-origin iframe at a
simulated 390px width, since `resize_window` does not actually narrow this
browser's real viewport in this environment (checked directly).

**Resume here, in order:**
1. Push `worker/identify-by-pin` to GitHub and open a PR against `main`.
   This is the priority — everything else assumes the code is recoverable
   from somewhere other than this one laptop.
2. Set every other active staff member's PIN
   (`set-pin.mjs --remote --all`).
3. Confirm what `Device 1` actually is, and register the real iPad
   properly (it will now self-register correctly the first time someone
   signs in on it, once its browser has never registered before).
4. Check the responsive fixes (nav scroll, stacked buttons) on the real
   iPad and phone, not just the iframe simulation.
5. First real sign-in and supervised delivery/batch/dispatch/count on the
   real iPad — this is what closes P1 through P5 (each phase's own
   progress note in `PLAN.md` says it cannot close until then).
6. Still open, unrelated to the above: the print relay has no password,
   and no Access application covers it (the browser calls it cross-origin,
   so Access is awkward there).

**Working in this repo.** `com.dean.git-autosync` stays disabled — pushes
are manual, commit promptly, nothing backs up automatically until pushed
(see the 2026-09-21 note further down, and now doubly true given point 1
above). The repo merges PRs with merge commits; branches are named
`worker/…`.

---

# Handoff: the label GUI (2026-09-02)

Context for a new session picking this up. Dean runs a small ramen kitchen and
production unit; `trace` is the traceability system being built for it, and
`PLAN.md` is the plan of record for that. This session did not work on the
ledger. It built the thing sitting beside it: **`labels/gui`, a local web app
that fills the kitchen's label templates in from the catalog and prints them**,
because labels were still being hand-edited as ZPL and copied to a Windows
machine by hand.

It is explicitly an interim tool. When the Worker generates labels from lot
records, it goes away.

---

## Update, 2026-09-16 (Dean)

Two things changed since this handoff was written, and the second is the one
that matters more than it looks.

**The Ethernet cable arrived and the printer is on the kitchen LAN**, at
`192.168.0.166`, port 9100. Raw ZPL sent straight there — no USB, no Windows
spooler, no bridge machine — printed correctly. `printers.py`'s `tcp` backend
had been written and waiting for this since before this handoff; it had never
actually been exercised until now. The Windows laptop's own copy still needs
its Settings screen pointed at `tcp` / `192.168.0.166` rather than whatever it
is on today. The printer's DHCP reservation, which this note originally
listed as still to do, has since been made (Dean, 2026-09-21), so
`192.168.0.166` is now the address it keeps and everything that depends on
it can rely on that.

**Three of the five label types are now *also* printed by trace itself,
separately from this tool** — Goods In, P3's packet label, and Date Opened.
`worker/public/lib/zpl.js` builds them and prints the moment the matching
form action happens (a line added, a batch packed out, a lot marked opened),
carrying the lot's real short code and a QR, which this tool's own versions
of those three have never carried (`labels/gui`'s Goods In and Date Opened
were built before lots existed to give them one — see "No lot codes or QR on
Goods In and Date Opened" below, now stale for those two specifically).
`lib/zpl.js`'s own header explains why this is a separate module rather than
calling into `server.py`/`zpl.py` here even where Dean asked the packet label
to be laid out the same as this tool's product label. **Product Packet,
Product Box and Notice remain this tool's alone** — trace has no allergen
data and no SKU concept to build a customer-facing compliance label from.

Getting a browser to the printer needed a small new piece that has nothing to
do with this tool: `worker/scripts/print-relay.py`, a stdlib-only relay doing
for the browser what `printers.py`'s `print_tcp` already does for this app,
fronted by a Cloudflare Tunnel (`print-relay.deanops.uk`) because the form is
served over HTTPS and a browser refuses outright to call an HTTP endpoint
from there. Both it and this app are now installed as real Windows services
(`install-relay-service.bat`, `install-app-service.bat`) rather than needing
a terminal window left open, with an opt-in 4-hourly auto-update
(`install-auto-update.bat`) pulling from the same Drive folder `update.bat`
always has.

See `PLAN.md`, open question 1, for the fuller writeup — printing now spans
both this tool and trace's own forms, so it no longer fits in this file alone.

---

## Where things stand

Working and in daily reach: the app runs on the Windows laptop the Zebra ZT231
is plugged into, prints over the Windows spooler, and covers five label types.
Nothing on a label has to be typed except the batch on Date Opened — every
other value is either in the catalog or worked out from a date.

| Label type | Rows | Anything missing |
| --- | --- | --- |
| Goods In | 67 (60 ingredients, dual-supplier ones twice) | none |
| Date Opened | 17 (15 ingredients, dual-supplier ones twice) | none |
| Product Packet | 26 | SKU for Tonkotsu Broth Diluted |
| Product Box | 26 | SKU for Tonkotsu Broth Diluted |
| Notice | free text, no catalog | — |

## Running it

```
cd labels/gui
python3 server.py                 # http://localhost:8642
python3 check_layouts.py          # 19 cases, lints every format at its worst
./package.sh                      # rebuild the bundle in the shared Drive folder
```

On the Windows machine, `update.bat` pulls the latest from Drive and starts it.
`start.bat` just starts what is already there. Both keep their window open on
an error, which an earlier version did not, and that cost a debugging round.

Standard library only, deliberately: the machine this runs on is a kitchen
laptop somebody has to be able to set up again from nothing.

## How it is put together

| File | What |
| --- | --- |
| `server.py` | Routes, the form definitions, and what each field defaults to. |
| `zpl.py` | Builds all five formats from field values. The layout lives here. |
| `printers.py` | Four ways of getting ZPL to a printer. |
| `catalog.json` | The catalog, baked in so the tool needs no network. Generated. |
| `label-data.json` | Everything the catalog cannot answer. Partly generated. |
| `build_catalog.py` | Regenerates `catalog.json` from `worker/scripts/`. |
| `import_allergens.py` | Fills the allergen declarations from the Allergen Matrix. |
| `check_layouts.py` | Builds every format at its worst case and lints them. |
| `package.sh` | Assembles a self-contained copy in the shared Drive folder. |
| `../lint-zpl.py` | Bounding box per element; fails overlaps and margin breaks. |

`labels/gui/README.md` is the detailed version of all of this and explains why
each layout decision is what it is. Read it before changing a coordinate.

## Where the data comes from

Nothing in `labels/gui` is a source of truth except `label-data.json`, and even
that is half generated.

- **The catalog** — `worker/scripts/catalog.sql`, generated by
  `import_catalog.py` from `~/Downloads/Weekly Stock Check Records.xlsx` plus
  `catalog-overrides.json`. Kitchen decisions go in the overrides file, then
  the importer is re-run, then `build_catalog.py`. Never edit `catalog.json`.
- **Allergens** — the kitchen's own Allergen Matrix in the `forms` repo, at
  `apps/wiki/html/1.4 Allergen Management/1.4.1 Allergen Matrix.html`. Read by
  `import_allergens.py`. An allergen line is a compliance statement, so it
  comes from the document maintained as one and is never derived from an
  ingredient's name.
- **Photographs** — `worker/public/photos`, put there by
  `worker/scripts/import_photos.py`, which takes ingredients from the old
  batching API and products from the forms Worker's catalog. Matched by item
  id, because both catalogs came from the same workbook.

## Decisions taken this session (all Dean unless noted)

- **No lot codes or QR on Goods In and Date Opened.** Lots do not exist yet, and
  a printed code that resolves to nothing is worse than none. The space went to
  the batch and the dates. They come back when the ledger mints lots.
- **The QR on product labels carries the SKU**, being the only thing on the
  label that resolves to anything today. It should become a URL to the batch
  record once the trace endpoint is live, and not before.
- **`GLU` prints as "Gluten", not "Wheat"** — the hand-written artwork said
  Wheat, which is narrower than the matrix states.
- **Where the matrix names a cross-contact allergen the label names it**, and
  still ends "and other allergens".
- **The `M&R` prefix was dropped** from every product name and from the artwork.
- **Health mark is decided for every product**: the two broths and the four
  frozen ramen carry it, nothing else does. Written out as `false` rather than
  left null, so a considered absence stays distinguishable from an unasked
  question.
- **Shelf life** is 12 months for the broths and 6 for everything else, counted
  in whole months onto the first of that month.
- **Batch codes** — Goods In is the delivery date as `ddmmyy`; products are the
  packing date as `ddmm`, the run suffix `GA`, then the pot number for the
  broths, which are cooked several batches a day. This matches what the `forms`
  repo's `HANDOFF.md` already recorded independently.
- **Salt and MSG keep for three months once opened**, not the kitchen's blanket
  six weeks. Recorded in a new `decided` bucket in the overrides, so "somebody
  decided this one" stays distinguishable from "the default applied".
- **Goods In prints "See product packaging"** when no use-by is typed, rather
  than a blank that reads as one somebody forgot.
- **Date Opened leads with use-by and batch**, in the same positions Goods In
  uses. This inverts the handwritten form it replaces, which led with the
  opened date.
- **Tonkotsu Broth Diluted is a separate product** carrying a reversed
  `DILUTED` chip beside the name. The two are identical in the pouch and a word
  in the name does not survive being glanced at across a room. The chip is
  under 3% black, against the 41-48% that got reversed bands rejected earlier.

## Two places a label layout could be edited

`labels/gui/zpl.py` is the one that prints. The loose `.zpl` files in `labels/`
are the hand-built originals the design came from, kept as readable specimens,
and they have already drifted — they still carry the `M&R` prefix that was
dropped everywhere else. `labels/README.md` now says so at the top, but it is
worth knowing before opening either.

`sync-to-drive.sh` and `print-copies.sh` belong to that older route, where a
`.zpl` file was copied to Drive and sent with `copy /b`. The app replaced it.
They still work for putting a one-off specimen in front of the printer.

## Traps that have already bitten

- **`^FB` overprints, it does not truncate.** A block given fewer lines than it
  needs draws the overflow on top of the line above. It happened live while the
  Notice label was being written. `zpl.py` simulates the wrap and holds back
  10% of the line width.
- **`^BY` is persistent printer state** and silently displaces a later QR. Every
  format sets it. This is in the labels README and cost a morning before this
  session.
- **The QR grew past the margin** when its payload changed from a 7-character
  batch to a 14-character SKU. It is now sized to fit, from magnification 6 down
  to 4, and warns below 5.
- **`HERE.parents[1]`** threw `IndexError` on the Windows machine, where the
  folder sits at `C:\label-gui` with one parent. Python 3.11 underlines the
  expression in red, which reads like a syntax error and is not.
- **A minted product could not read `product_storage`**, so any product added
  through the overrides came out with no storage at all. Fixed in
  `import_catalog.py`.
- **`\\localhost\ZEBRA` stopped working** on the Windows machine with the share,
  spooler and Server service all apparently fine. Never diagnosed. The tool
  prints through the Windows spooler by name instead, which needs none of that.

## Open items

1. **The EAN-13 is 10 mm tall; GS1 asks for 18 mm.** It does not fit on 4x2
   stock alongside the dates, health mark and allergen box — there is no
   arrangement that makes it. `check_layouts.py` says so every run. It needs
   testing against a real till, and `PLAN.md` already has the retail frozen
   labels on a Brother printer and different stock, which is where a
   full-height symbol belongs.
2. **Eleven allergen declarations live in `import_allergens.py`'s `DECIDED`
   map**, not in the Allergen Matrix. The matrix is the document an auditor
   reads. Each should disappear from that map as it is added there; the import
   report lists them under their own heading so they are not forgotten.
3. **Allergens and the health mark belong in the trace catalog**, beside
   storage and shelf life, where the goods-in form and the recipe explosion can
   see them too. `label-data.json` is a holding pen.
4. **Tonkotsu Broth Diluted needs a SKU**, and its pack sizes were assumed from
   the concentrate rather than given.
5. **The frozen ramen print the catalog's internal name**, `Frozen Ramen :
   Hell Ramen`, which reads oddly on a retail box. A `label_name` fixes it.
6. **Done, 2026-09-16 — see the Update section at the top.** The Ethernet
   cable arrived and is proven. The DHCP reservation, the one piece still
   open then, was made on 2026-09-21 (Dean), so the address trace's own forms
   depend on will not move.
7. **Three ingredient photographs still fail to import** — Apple Juice, Ground
   White Pepper, Japanese Soy Sauce — because their sources are Google Drive
   links that are not publicly readable. Re-uploading them in stockcheck fixes
   it.

## What was deliberately not done

- **No service worker** on the page. It is served from the same machine it runs
  on, so a cache buys nothing and a stale one would go on serving the previous
  version after an update.
- **No border on the Notice label**, even though a warning is the obvious case
  for one. The border round the whole label is what tells Date Opened from
  Goods In across a room, and spending it twice takes that distinction away
  from the pair that actually gets confused.
- **No automatic Drive sync.** `update.bat` copies down on launch instead, so a
  running server never has its files swapped underneath it.
