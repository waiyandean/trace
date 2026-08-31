# trace — project plan

Ground-up rebuild of ingredient traceability, from goods intake through to
dispatch, with quantities that reconcile in both directions.

Status: planning. Nothing built yet. No schema is final until P0 ships.

## Why the previous attempt failed

This matters more than any technology choice, because it is the thing the
rebuild has to avoid repeating.

In the old system every form owned its own spreadsheet tab, and that tab was
authoritative. The traceability ledger was built *afterwards*, by joining those
tabs together on ingredient name plus a typed batch code. Ledger writes were
deliberately secondary — wrapped in try/catch, explicitly required never to
fail a staff submission — so the ledger could only ever be an inference about
what the forms meant, made after the fact.

That inference worked when staff typed a batch code that happened to match a
delivery exactly. It failed whenever they did not, and the measured failure
rate was high: across the full historical rebuild, of 12,731 recorded
ingredient uses only 5,054 had an exact batch-code match, and of those 2,593
matched more than one delivery row and had to be recorded as ambiguous. The
result was 1,946 lots and 1,186 movements that exist but connect to nothing.

Those are not bugs to be fixed individually. They are what a derived ledger
produces when the forms underneath it were never designed to capture lot
identity in the first place.

**The rebuild inverts this.** The ledger is the source of truth. A form is a
user interface that writes a transaction into the ledger, and nothing else. No
form owns a table of its own. If the transaction cannot be written, the
submission has not happened and the user is told so.

## The model

Everything the system needs to record is the same shape: a signed quantity
event against an identified lot.

| Operation | Movement type | Effect |
| --- | --- | --- |
| Receive a delivery | `RECEIVE` | opens a lot, positive quantity |
| Move stock between storage areas | `MOVE` | changes location, quantity neutral |
| Waste, trim, spillage, QC reject | `WASTE` | negative |
| Use an ingredient in a batch | `CONSUME` | negative, points at the lot produced |
| Make a batch | `PRODUCE` | opens a lot, positive |
| Use a product inside another product | `CONSUME` + `PRODUCE` | no special case needed |
| Combine two lots into one container | `COMBINE` | closes the parents, opens a lot with two parents |
| Send stock to a customer | `DISPATCH` | negative |
| Put stock on hold / release it | `HOLD` / `RELEASE` | status change |
| Weekly count | `ADJUST` | signed correction to match reality |

Two tables carry all of it: **lots** (what physically exists) and **movements**
(append-only, every change to any lot). Stock on hand, backward trace, forward
trace and mass balance are all *queries over movements*. None of them is a
stored figure that can drift out of step with the events beneath it.

Consequences worth stating explicitly:

- **A product lot and an ingredient lot are the same kind of object.** That is
  what makes product-into-product work with no extra machinery: garlic oil is
  produced as a lot, then consumed as an ingredient by a broth batch, using the
  same two movement types as any delivered ingredient.
- **A split across two lots is just two `CONSUME` movements.** There is no
  separate allocation table. The rule that the parts must add up to the
  quantity consumed is a validation applied when the transaction is written.
- **A merge is modelled, not hidden.** Staff will tip two deliveries of onions
  into one tub. `COMBINE` records that as a new lot with both parents, so a
  trace through it returns *"one of these two deliveries"*, naming both, rather
  than silently picking one. Precision drops; integrity does not. Silently
  picking a winner is exactly what produced the old system's 2,593 ambiguous
  matches that read as facts.
- **The weekly count is what closes the books.** A count compares what the
  ledger computes against what is physically there and writes the difference as
  an `ADJUST` movement. Without this, variance accumulates indefinitely and the
  numbers become fiction within months. The old stockcheck was a third,
  separately keyed catalog that was never joined to anything, so it could never
  play this role.

## Decisions taken (2026-08-27, Dean)

| Decision | Choice | Reasoning |
| --- | --- | --- |
| Scope | Traceability chain only | Goods intake, storage, batching, waste, dispatch and the weekly count move to trace. Compliance, cleaning, temperature and knife-check forms stay in the `forms` repo untouched, because they never touch a lot and moving them would add risk with no traceability benefit. |
| Stack | Cloudflare Workers + D1 | Same infrastructure, deploy pipeline and domain already in use. The resource-limit crash that hit the old ledger was caused by reading the entire ledger into the Worker and joining it in JavaScript, not by a D1 limit; querying properly removes it. |
| Offline | Offline-first capture | Production-floor wifi is documented as unreliable. Capture forms queue locally and sync, with an idempotency key on every submission so that a replay is a no-op rather than a duplicate. |
| History | Clean start, legacy read-only | The old Sheets and D1 ledger are frozen as an archive. The new system holds only what it can prove. Importing history that is 40–70% ambiguous on its joins would put exactly the uncertainty this project exists to remove inside the new system on day one. |

## Labelling and scanning

Findings from the 2026-08-27 design session. **The printing half is being taken
forward as a separate workstream before it is planned into a phase here**, so
nothing below is committed to a phase yet.

### The label carries three things

```
┌─────────────────────────┐
│  CHICKEN FEET           │  item name, readable across a room
│  ▓▓▓▓▓  Use by 04/09/26 │  QR encoding the lot id, plus the date
│  ▓▓▓▓▓                  │
│  K7M4QP                 │  short code, typeable as a fallback
└─────────────────────────┘
```

The short code matters more than it looks. Lot selection is meant to be
mandatory before a batch completes, so if a scan is the *only* way to identify
a lot, a dead camera or a frosted label blocks a shift — and a blocked shift is
how a mandatory rule gets routed around. Six characters, no ambiguous glyphs
(no `0`/`O`, no `1`/`I`), turns a failed scan into a short type-in.

### Reading the label

The iPad camera works, in Safari, over HTTPS, with a JavaScript decode library
(`zxing-js` or `html5-qrcode`). Safari does not support the browser-native
`BarcodeDetector`, so the library route is the only one available; it is mature
and small. Camera access from a home-screen-installed PWA was broken on older
iOS and later fixed — since these forms run as PWA shortcuts, **that needs
testing on the actual iPads rather than assuming**.

**QR, not a 1D barcode.** QR carries error correction of up to 30%, so it
survives grease, condensation, a curled label on a round tub, and being read at
an angle in poor light. A 1D barcode needs to be flat, clean and square-on,
which is not a description of anything in a kitchen.

Handheld Bluetooth scanners pair as a keyboard, so they need no code at all and
beat a two-handed iPad for speed, aim and cold-room ergonomics. Roughly £40–90
each for a 2D-capable unit (1D-only models cannot read QR at all). The
trade is another device to charge, pair, drop and clean. Rule of thumb: the
camera is fine for one to five scans; a fourteen-line delivery at the door in
the cold is where a handheld starts paying for itself.

Nothing here is settled until it is measured on the real iPads, in the chill,
with gloves on, against a condensation-covered label.

### Intake cannot rely on a supplier label

Not all incoming goods carry a scannable code, and some carry no code, no lot
reference and no printed expiry at all. The design does not depend on them:
**the lot id is system-generated, so it cannot be missing.** The delivery date
becomes the lot code, and the use-by comes from the item's shelf-life rule
whenever nothing is printed on the box.

| What the case carries | What staff do | Result |
| --- | --- | --- |
| GS1-128 with lot and expiry | scan, confirm quantity | a lot |
| Plain barcode only | scan for the item, type quantity and dates | a lot |
| Readable text, no barcode | pick the item, type quantity and dates | a lot |
| Nothing at all | pick the item, type quantity, use-by from the rule | a lot |

All four paths end identically. A supplier's GS1-128 label — which encodes GTIN
`(01)`, batch `(10)` and expiry `(17)` — is therefore a typing accelerator
where it exists, never a foundation. Worth photographing a few real Lynas cases
to find out how common it is; likely present on manufacturer-packed ambient
goods and absent on butchery and fresh produce.

### Applying labels without mixing them up

Incoming goods do not arrive with the label we need, so the sequence is: enter
the line, the system opens the lot, print, apply.

Note that **one delivery line is one lot but many physical boxes** — ten cases
of chicken feet need ten labels, all pointing at the same lot. Label count
follows case count, so a fourteen-line delivery may be sixty labels.

That creates a mixup risk: printing a batch of labels and then walking round
sticking them on invites putting the chicken feet label on the pork belly.
Scanning our own label back afterwards does *not* catch this — it only reads
back what was printed, and the system has no independent way to know which box
it is looking at. A scan-in step only earns its place if it captures something
new, such as binding to the supplier's own barcode, or confirming a putaway
location.

Three sequencing options, in increasing safety:

| | Speed | Mixup risk | Printer needed |
| --- | --- | --- | --- |
| Enter all lines, print all, apply | fast | high | yes |
| Enter one line, print one, apply, repeat | slower | low | yes, at the door |
| Stick a pre-printed blank QR on the box, scan it, then enter the line | fast | none | no |

The third is worth serious consideration for the pilot: binding happens at the
moment of scanning a label that is *already physically on the box*, so a mixup
is structurally impossible rather than merely unlikely. Pre-printed unique QR
rolls are cheap. The cost is that the label carries no human-readable
information — mitigated by the fact that the supplier's own label already names
the product, and staff already handwrite a date code.

### Reprinting, and what the archive is for

Labels fall off, smudge, and get thrown away with the outer packaging they were
stuck to. Discarding an outer box is the sharpest case: the supplier's own
label goes in the bin with it, so from that moment **our label is the only
identity the contents have**, and the four inner bags each need one.

So reprinting is a routine operation, not an exception, and it has one hard
rule: **a reprint carries the same short code as the original.** It must never
mint a new lot. Minting one would split a single delivery into two lots, break
the quantity balance, and produce two partial genealogies where there should be
one — the exact failure this project exists to remove.

The flow is: find the lot (by ingredient, batch code, delivery date, or by
scanning a surviving label), say how many labels are needed and why, and print.

Reprints are logged with their count and reason — damaged, lost, smudged, outer
packaging discarded, decanted, split across locations, or a case broken down.
Without that, the number of labels in existence drifts away from the number of
cases received, and nobody can answer why a ten-case delivery has fourteen
labels.

**Breaking a case down is the common one, and it is not a stock movement.**
Sugar arrives as fifteen 1 kg packets in clear plastic; once a few are used the
wrapper comes off and the remaining packets go on the shelf loose. Sesame oil
arrives as six 2 litre bottles in a case, and once it is part-used the bottles
come out to save space. In both, nothing is consumed — quantity, lot and
balance are all unchanged, and only the physical presentation differs. So a
reprint must be able to produce any number of labels **without implying a
movement**, or tidying a shelf would book phantom consumption.

It follows that a lot's label count is not fixed at intake. One case is one
label on arrival and eleven labels once it is broken down, all carrying the
same short code. The system can help without guessing: it already holds pack
size for unit conversion, so it knows a sugar case is fifteen 1 kg packets, and
can offer the remaining balance as a suggested count for staff to confirm.

One label format covers both. Dean confirmed 2026-08-28 that the current
100 x 50 mm stock physically fits every loose item, 2 litre bottles included,
so no smaller template or second stock is needed.

**The archived ZPL and the reprint do different jobs, and should not be
confused.**

- The **archive** is evidence: the exact payload sent to the printer, captured
  at print time, about 1 KB. It is immutable, and its value is that it can
  disagree with the current record.
- A **reprint** is regenerated from the lot record, not replayed from the
  archive, so it reflects any correction made since. Replaying the archive
  would faithfully reproduce a label that is now wrong.

Where the two differ, that difference is itself meaningful: it means the record
changed after the label was printed, which is precisely what the amendment
trail should already explain.

This also makes a rendered image of the label pointless to store. An image
generated from the record cannot disagree with the record, so it evidences
nothing, while the ZPL is smaller, exact, and reproduces the label pixel for
pixel whenever anyone wants to look at it.

### Loose goods, decanting and re-labelling

The hardest case is not a missing barcode, it is goods with no surface to label
— a crate of onions tipped into a tub. Rules that handle it:

- Label the container the goods live in, not the goods.
- Decanting into a new tub requires re-labelling: a new physical label bound to
  the *same* lot. This needs an explicit re-label flow, also used for a damaged
  or lost label.
- Combining two lots in one container is recorded as `COMBINE`, per the model
  section above.

### Printing

**Current state:** labels are designed and printed manually through Zebra
Designer on a Windows laptop. This is the thing to move away from — it is
off to one side of the workflow, needs a specific machine, and cannot be driven
by a form submission.

**Target:** Zebra ZT231 on Ethernet, sent ZPL generated directly by the Worker
when a goods-in line is saved.

Confirmed specifications (2026-08-27): 203 dpi, ZPL and ZPL II, 10/100 Ethernet
built in, USB, USB Host and RS-232, 256 MB RAM and 256 MB Flash, a 4.3" colour
touchscreen, metal frame and industrial duty cycle. A 300 dpi variant of the
same model exists, so confirm which unit is on site — it changes QR sizing.

ZPL is plain text, so generating it is a template string with no driver, SDK or
print dialog involved:

```
^XA
^FO30,30^A0N,50,50^FDCHICKEN FEET^FS
^FO30,95^BQN,2,6^FDQA,L7F3A9C^FS
^FO230,110^A0N,35,35^FDUse by 04/09/26^FS
^FO230,155^A0N,70,70^FDK7M4QP^FS
^FO30,290^A0N,28,28^FDLynas  inv 009298395  27/08/26^FS
^XZ
```

At 203 dpi the QR magnification wants to be around 5–6 so it stays readable
through condensation.

**The obstacle:** a Cloudflare Worker cannot reach a printer on the kitchen
LAN. There is no route to a NAT'd private address, and Workers' outbound TCP
only reaches public addresses. Something has to bridge the gap. Three options:

1. **A local agent that polls.** A small always-on machine in the kitchen asks
   the Worker for pending print jobs every few seconds and writes the returned
   ZPL to the printer's port 9100. No firewall rules, no inbound connection, no
   tunnel configuration; if the agent stops, jobs queue and print when it
   returns. Costs a few seconds of latency, which does not matter for a label,
   and a small machine to run it on.
2. **Cloudflare Tunnel.** `cloudflared` on that same machine exposes a tiny
   local print service privately, and the Worker posts to it with a service
   token. Instant rather than polled, and uses infrastructure already in use,
   but still needs the local machine plus tunnel configuration.
3. **The printer connects out by itself, via Zebra Cloud Connect (Weblink).**
   The printer opens an outbound, TLS-encrypted WebSocket to a configured URL,
   which is designed precisely for printers behind NAT. It needs no local
   machine, no tunnel and no firewall rules, which makes it the most attractive
   of the three. On the Cloudflare side a Durable Object holds the connection,
   using the WebSocket Hibernation API so an idle printer costs nothing, and
   the Worker hands jobs to that object to push down the socket.

   **Checked 2026-08-27 and it looks supported.** Zebra's documentation states
   that all Link-OS printers support Weblink except a few legacy models and the
   Link-OS *Basic* tier, naming the ZD220, ZD230 and ZT111. The ZT231 is not on
   that list, and the ZT111 named on it is the Basic-tier model directly below
   it, so the ZT231 should have it. Configuration is a JSON string pushed to
   the printer with Zebra's Printer Setup Utility, which exists for Windows,
   Android and iOS — so this does not tie the setup to the Windows laptop.
   Confirm on the actual unit via its own menu before committing to this route.

   One cost to check first: whether Durable Objects require a paid Workers plan
   on this account.

**The offline tension.** The system is offline-first, but printing is
synchronous: staff are stood at the door holding the box and need the label
now. If the network is down the submission queues and no label prints, so the
one thing the whole system depends on has not happened.

This makes the pre-printed roll a *fallback underneath* the printer rather than
a competing alternative:

| Network | Path |
| --- | --- |
| Up | form → Worker → printer → label with item, dates and QR |
| Down | take a pre-printed QR from the roll, apply it, scan to bind |

Both end with a labelled box carrying a scannable id.

For the offline path to work at all, **the lot id must be mintable on the iPad
rather than assigned by the server** — otherwise there is no id to bind a
label to while offline. Lot ids should therefore be ULIDs or similar, generated
client-side, using the same mechanism that already has to mint idempotency
keys. This has to be decided before P1, because getting it wrong means offline
intake cannot print.

## How intake and batching work today

Described by Dean, 2026-08-28. This is the current practice the rebuild has to
replace, and it explains the gap better than the data analysis does.

**The lifecycle stock actually has (Dean, 2026-08-31).** Two short paths, and
almost nothing else:

    ingredient   goods in ─→ batching
                          └→ waste

    product      batching ─→ storage ─→ dispatch
                                     └→ waste

An ingredient is received and then either goes into a batch or is thrown away.
A batch produces a product, which is stored and then either sent to a customer
or binned. Nothing routinely moves between areas in either path.

That is worth stating because it bounds what the forms have to be good at. The
two journeys above need to be quick and hard to get wrong; everything else —
moving stock between areas, combining lots — is an exception that needs to be
possible and does not need to be fast.

**Stock is not routinely moved (Dean, 2026-08-31).** Frozen ingredients go
from the freezer straight to batching, chilled from the fridge straight to
batching, ambient from the dry store. A `MOVE` is the exception rather than a
step in the normal day: it covers a genuine relocation, not the ordinary
journey from storage to production.

Two things follow, and the second is the one that matters.

The stock screen orders its actions by how often each is used, with the move
last. And **batching consumes stock from the storage area it is already in**,
rather than requiring it to be moved to a production location first. Modelling
production as a place stock has to arrive at would put a `MOVE` in front of
every batch that nobody performs in the kitchen, and a step staff do not
actually take is a step they will skip — leaving the ledger describing a
journey that did not happen. The `production` location kind stays in the
schema for the case where something genuinely is staged, but the recipe path
does not depend on it.

**Where the iPad actually is.** Goods-in is the one form taken outside — to
the van, the yard, the back door — and the wifi drops out there (Dean,
2026-08-31). Batching and the weekly count stay indoors on wifi and do not
have that problem. That is why the offline work is concentrated here rather
than spread across every form: the device pre-holds its short codes, mints its
own lot ids, queues submissions and caches the app, precisely because the one
form that must keep working is the one most likely to have no network. P3 and
P5 can be built expecting a connection, and should not pay for machinery they
do not need.

**Receiving a delivery**

1. Staff check the invoice.
2. They print a Goods In label for **each case** of each ingredient. The labels
   are premade per ingredient, with the name, supplier and allergens already on
   them. The delivery date is autofilled with today's date, and the batch
   number likewise.
3. Labels go on the cases, and the cases go into storage.
4. Separately, the delivery is recorded in the Goods In form, including the
   use-by date.

**Batching**

1. Staff take the ingredients they need.
2. They read the batch number off the label.
3. They record the batch number, quantity and use-by date on the batching form.

### What that tells us

- **Printing the label and recording the delivery are two disconnected acts, in
  two different systems.** This is the structural break. The label cannot carry
  an identifier the record knows about, because at the moment the label prints
  there is no record to refer to. Every later attempt to join the two is
  therefore an inference, which is exactly what the old ledger was.
- **The batch number is autofilled as today's date**, so every case of one
  ingredient received on a given day carries the same code. Two deliveries of
  the same ingredient on the same day are indistinguishable on the box. That is
  a property of the scheme, not a data-entry error, and it is why 2,593 of
  5,054 exact historical matches named more than one delivery.
- **The use-by is captured in the form but cannot be on a premade label**,
  since it varies per delivery. So at batching, staff read the batch number
  from our label and the use-by from somewhere else — the supplier's packaging
  or memory. Two of the three things they record come from different places.
- **A premade label per ingredient means picking the right roll.** Take the
  wrong template and the case is mislabelled with a real ingredient's name,
  which is worse than an unlabelled one.

### What P1 changes, and what it deliberately does not

The one structural change is that **printing and recording become a single
act**: staff enter the delivery line once, and the system opens the lot,
records it, and prints that case's labels from the same transaction. Everything
else follows from that.

- Labels gain the lot's short code and QR, and the **real use-by**, so all
  three things batching needs are on one label in one place.
- Name, supplier and allergens are still filled in automatically, now from the
  catalog rather than from a saved label template — which also removes the
  wrong-roll error.
- **A code identifies a delivery line, not a case.** Three cases of chicken
  carcass off one pallet are one lot with one code, and still three labels —
  they are the same stock, from the same delivery, with the same use-by, and
  giving them three codes would invent a distinction that exists only because
  we printed it. Where the difference is real the line is split: the same
  ingredient added twice with different use-by dates, or going to different
  areas, becomes two lots with two codes and one shared batch number
  (confirmed with Dean, 2026-08-31). The form warns — but does not refuse —
  when a line is duplicated with the same date and the same place, since that
  produces two lots nothing can tell apart afterwards.
- **The batch number stays exactly as it is**, printed on the label and stored
  on the lot. Nothing staff currently read disappears; it simply stops being
  the thing the system joins on. Its format is **ddmmyy** (Dean, 2026-08-31),
  so a delivery on 31 August 2026 carries `310826`, whatever the supplier's
  own batch number happens to be — that is a different fact, and it belongs in
  the lot's `supplier_lot` rather than on our label. The form derives it from
  the delivery's arrival date rather than offering a field, so it cannot be
  mistyped, and a delivery keyed the next morning still carries the date it
  actually arrived.
- The label count stays one per case, as now.

At batching, reading the batch number becomes scanning the label, with the
short code as a typed fallback and the batch number still accepted — resolving
uniquely where it can, and asking which lot where it cannot, rather than
guessing.

## Schema sketch

Indicative, not final. Names and columns will be settled in P0.

**Catalog**

- `items` — one row per ingredient, packaging item or product. Carries
  `kind`, `base_unit` (`kg` | `L` | `Units`), a shelf-life in days that
  defaults to seven, and **two storage requirements rather than one**: how the
  item is kept unopened, and how it must be kept once opened. Several
  ingredients are ambient on the shelf but have to be refrigerated after
  opening, so the two genuinely differ, and the Date Opened label prints the
  after-opening one. Items also carry a flag for whether their label needs the
  oval health mark. **Corrected 2026-08-31 (Dean): the mark follows animal
  origin, so it sits on the raw meat and bone ingredients — chicken carcass,
  wings and feet, hind feet, femur bones, pork fat, chicken fillet and pork
  belly — and not, as an earlier version of this plan said, on the broths as
  finished products.** It is a compliance determination held per item and never
  inferred from a recipe. Getting the storage tag wrong puts an opened jar back on a dry
  shelf, which is the error the label exists to prevent, so the label shows the
  post-opening state in its storage tag as well as spelling out the
  instruction. Ingredients and products share this table; that is what
  makes product-into-product free. The shelf life is a fallback used only when
  a delivery arrives with no printed date, so it needs a sensible default
  rather than fifty agreed figures before the catalog can be filled.
- `locations` — storage areas, with a kind (ambient, chill, freezer,
  production, dispatch).
- `suppliers`, `customers`, `staff`.
- `unit_conversions` — the controlled conversions master. Per item, how a case
  relates to a unit and a unit to the base unit. The old system read these live
  from a spreadsheet owned by another system; trace owns them.
- `recipes` / `recipe_lines` — which items a product is made from, its expected
  yield, and the shelf-life rule that derives a finished-product use-by from
  its production date.

**Ledger**

- `lots` — client-minted ULID, item, human-visible lot code, short fallback
  code, supplier lot and supplier, received or produced timestamp, use-by,
  status (`open` | `closed` | `held` | `written_off`), parent lots where the
  lot came from a `COMBINE`, and whether the use-by was printed by the supplier
  or derived from the item's shelf-life rule. **No quantity column and no location column** —
  both are derived from movements, so neither can disagree with the events
  beneath it.
- `movements` — append-only. Lot, type, signed quantity in the item's base
  unit, counterpart lot (the genealogy edge), location, when it happened, when
  it was recorded, staff, reason, note, and the submission event it came from.

Stock on hand is a balance **per lot per location**, not per lot: part of a
delivery routinely goes to the freezer while the rest stays in chill, and a
single location field on the lot cannot represent that. `MOVE` movements carry
a from-location and a to-location.

**Submission and audit**

- `events` — the envelope for one form submission: kind, staff, timestamps, the
  raw payload as received, and a unique client-generated idempotency key. This
  key is what makes offline sync safe: a resend of an already-accepted
  submission is rejected as a duplicate rather than written twice. The old
  system's 67 duplicate Goods Intake rows came from exactly this gap.
- `amendments` — corrections are never edits. A correction writes a
  compensating movement plus an amendment row recording what changed, the
  before and after values, the reason, who requested it and who approved it.

**Printing**

- `print_jobs` — queued label jobs with the exact ZPL sent, status, count and
  timestamps, plus a reason where the job is a reprint. A queue rather than a
  direct call, so that a printer or agent outage delays labels instead of
  failing submissions, and an archive as well as a queue, since the payload as
  sent is the evidence of what was printed.

## Delivery phases

Each phase should end in something a person can actually use, and each ends
with tests plus a supervised real submission before its line is ticked.

- **P0 — Foundations.** Worker, D1, migrations, staff identity, and the catalog
  tables (items, locations, suppliers, units and conversions). No capture forms
  yet. Ends with the catalog populated and readable.

  **Progress 2026-08-31.** `worker/` holds the Worker, `wrangler.toml`, the
  first migration (`items`, `locations`, `suppliers`, `customers`, `staff`,
  `unit_conversions`) and a read-only `/api/catalog` over them, with unit
  tests against a fake D1 binding. The migration applies to a local D1 and its
  constraints were checked there: the health-mark flag is rejected on anything
  that is not a product, and a conversion cannot reference an item that does
  not exist. Items carry both storage requirements, the seven-day shelf-life
  fallback, and the health-mark flag as decided above.

  **Catalog imported 2026-08-31** from the `Weekly Stock Check Records`
  workbook the kitchen already maintains (`Ingredients`, `FinishedProducts`
  and `map` tabs), by `worker/scripts/import_catalog.py`. 91 items — 64
  ingredients and 27 products — plus two ingredients the workbook does not
  carry, and 114 conversions, four locations, two suppliers and ten staff,
  loaded into the local database and read back through the API. Items keep the workbook's own ids,
  so a re-import updates rows rather than duplicating them.

  Where the workbook cannot answer, the kitchen's answers are recorded in
  `worker/scripts/catalog-overrides.json` with the date and the person who
  gave them, and the importer applies them on top of the workbook. Nothing is
  derived that the evidence does not support, and the importer's report lists
  everything still open:

  - **Five ingredients had no base unit in the workbook, and Dean supplied
    them 2026-08-31**: Chicken Carcass (8 kg case), Femur Bones, Hind Feet and
    Pork Fat (10 kg cases), all measured in kg, and Rajah Whole Red Chillies
    as 5 × 200 g. The first four are bulk — a case is a weight with no
    countable item in it — so they convert case to kg in a single hop rather
    than through an item. All 62 ingredients now import.
  - **The workbook's `1 x …` case sizes are a Kobas artefact, resolved
    2026-08-31 (Dean).** Nine items had a Case Size reading `1 x <size>`
    against an Items per Case of 6 to 48: Curry Laksa Paste, Ground Bean
    Sauce, Mae Ploy Red Curry Paste, Peeled Garlic, Red Bean Curd, Shimaya
    Konbudashi, Shio G, Shio Paitan and Toban Djan Chilli Bean Sauce. Kobas
    was set up differently and that column was written for it. Items per Case
    is the authority for the case count everywhere; the Case Size string is
    read only for the item size after the `x`.
  - **After-opening storage — resolved 2026-08-31 (Dean).** The workbook has
    no such column, and it is the one the Date Opened label prints, so it
    could not be inferred. Dean's rule settles it: an item is kept as it was
    unopened, except for hoi sin sauce and white miso, which move to the
    fridge. That is now recorded as a rule with its three exceptions rather
    than copied value by value, so a reader can see which items were decided
    and which follow the rule. Hoi sin is two catalog rows, the 20 kg tub and
    the cans; both are treated as exceptions, since they differ only in pack
    format. All 64 ingredients now have both storage columns.

  - **Product storage — resolved 2026-08-31 (Dean).** The workbook records no
    storage for finished products at all. Six go to the freezer: Tonkotsu
    Broth, Chicken Broth and the four Frozen Ramen lines. Five are
    shelf-stable and go to ambient: Chilli Oil, Garlic Oil, Teriyaki Sauce,
    Spicy Teriyaki and Soba Sauce. The remaining sixteen go to the walk-in
    fridge, recorded as a default rather than named one by one. Every item in
    the catalog now carries both storage requirements.

    Two products are **out of scope at Glasgow** and were excluded on the same
    day: Ikigai Chicken Broth and Green Oil. They are imported as inactive
    rather than skipped. Skipping would let a later import add them back
    without anyone noticing, and the catalog reads return active rows only, so
    an inactive row is already invisible to a picker while the reason stays on
    the record. 89 of the 91 items are active.

    The columns stay nullable all the same. Null means "not yet determined",
    and a new item added before anyone has decided where it lives must be
    distinguishable from one deliberately left with no requirement.
  - **The health mark is now set, and it corrected the plan.** Dean's list is
    eight raw animal items, all of them ingredients and none of them products:
    chicken carcass, wings and feet, hind feet, femur bones, pork fat, chicken
    fillet and pork belly. The schema had a constraint restricting the flag to
    products, taken from the wording in the schema sketch above; that
    constraint was wrong and has been removed. Six of the eight are in the
    catalog and are flagged. Chicken Fillet and Pork Belly were absent from
    the workbook and were added from the overrides on Dean's figures: chicken
    fillet as 2 × 2.5 kg per case, pork belly sold per kg with no fixed case,
    both kept in the Walk In Fridge,
    so it carries no case conversion at all — recorded as a decision rather
    than left looking like an omission. The flag stays null on the other 83
    items, meaning not yet determined rather than no mark.

  **Locations and suppliers settled 2026-08-31 (Dean).** Only Glasgow is in
  scope, with four storage areas: Dry Store and the Dry Store Allergen Free
  Shelf (both ambient), the Walk In Fridge (chill) and the Walk In Freezer
  (freezer). Edinburgh is out of scope, so the workbook's two sites do not
  become locations. Suppliers are Lynas and Tazaki.

  That supplier list was checked against the `Goods In Records` sheet Dean
  supplied, and the history agrees with it: all 2,675 delivery rows are from
  those two. Its Suppliers tab also lists **Alfa Wholesale**, named against
  Coconut Milk, Tahini and Chicken Feet but present in no delivery, and
  **Kite Packaging**, which supplies packaging only. Neither is imported;
  Kite becomes relevant only if packaging is brought into scope, which is
  still the open question "Packaging".

  **Staff settled 2026-08-31 (Dean)**, as ten people: Nikin, Nilesh, Surendra,
  Mateus, Paulo, Siku, Rogerio, Aaron, Dean and Gunjesh. The list was taken
  from Dean rather than from the Goods In Records sheet deliberately. That
  sheet holds the names as free text with the same person spelled several ways
  — Nikin, Nikin Shrestha and Nikn; Nilesh and Nilesh Shrestha; Aaron and
  Aarom; Dean and dean — and importing it would have put exactly the ambiguity
  this project exists to remove into the audit trail on day one. One canonical
  row per person is what an amendment trail needs to name. How a person proves
  they are that row is still the open question "Authentication".

  `customers` remains empty; dispatch is P4 and nothing needs it yet.

  **The remote database exists as of 2026-08-31** (`trace`, WEUR), with the
  migration applied and the catalog loaded: 91 items, 114
  conversions, four locations, two suppliers and ten staff, read back from the
  remote database to confirm. The Worker itself is not deployed
  yet, because a workers.dev deploy would put the catalog on a public URL with
  no authentication, and authentication is still the open question "Authentication".
- **P1 — Receive.** Goods intake form opening lots and writing `RECEIVE`
  movements, offline queue and idempotency in place from the first form rather
  than retrofitted. Ends with a real delivery booked in.

  **Progress 2026-08-31.** The ledger and the intake endpoint are built and
  run against a local database; `migrations/0002_ledger.sql` adds `events`,
  `devices`, `lots`, `movements` and `short_codes`, and `POST /api/receive`
  books a delivery. Reads to go with it: `/api/ledger?action=lots` with the
  balance attached and first-expiring first, `/api/ledger?action=stock` per
  lot per location, and `/api/lookup?code=` for a scanned or typed code.

  Four things in it are worth recording, because each is a decision the schema
  now enforces rather than a convention someone has to remember.

  - **Recording and printing became one act.** A submission carries the short
    code the device has already popped from its pool and printed, and the same
    transaction opens the lot and binds that code to it. There is no later
    join between a label and a record to get wrong, which was the structural
    break in the old system.
  - **`movements` are append-only in the database**, not by convention. Two
    triggers reject any `UPDATE` or `DELETE` with the message that a
    correction is a compensating movement. `lots` carries no quantity and no
    location column, so a balance is always the sum of the movements and
    cannot drift from them. Both were checked by trying it.
  - **Idempotency is a fingerprint, not just a key.** `events` stores a
    SHA-256 of the canonical payload beside the client's key. A resend of an
    accepted submission is answered with what it wrote and writes nothing; a
    reused key carrying different content is a 400 rather than a silent
    duplicate or a silent overwrite. A lot id that already exists is refused
    the same way and names the event that booked it.
  - **The use-by records its own source**, as the open question "Shelf-life ownership" requires. A date
    supplied by the form is the supplier's printed date; its absence means the
    item's shelf life filled in, and the lot says which. The conversion from
    what staff keyed — "3 case" — to the base unit runs only over conversions
    somebody entered, in both directions, and an unconvertible unit is a
    refusal naming the missing hop rather than a guess. What was keyed is
    stored beside the converted figure, so a wrong factor found later can be
    told apart from a wrong entry.

  Verified locally end to end: a two-line Lynas delivery booked, three cases
  of chicken carcass converting to 24 kg and two of femur bones to 20 kg, the
  first dated from the box and the second by the seven-day rule; the same
  submission replayed and refused as a duplicate; the stock view showing both
  lots in their areas; and a batch-code lookup returning both lots at once,
  which is the ambiguity that scheme has always had and the reason the system
  no longer joins on it. 51 tests pass.

  **Not deployed.** The live Worker is still the P0 read-only build. P1's
  endpoints write, so deploying them to a URL with no authentication would let
  anyone book a delivery that never happened. That is the open question "Authentication", and it
  now blocks the deployment rather than merely being untidy. The remote
  database has not been migrated either, so nothing about the live state has
  changed.

  **The form, 2026-08-31.** `worker/public/` holds the goods intake form,
  served as static assets from the same origin as the API. It is offline-first
  in the literal sense rather than the aspirational one: the catalog is cached
  on the device, the short codes are already held, and the submission is
  written to a local queue before anything is sent. Losing the kitchen wifi
  mid-delivery slows the labels down; it cannot lose the delivery.

  Four behaviours in it are the offline design rather than polish. The unit
  list per item comes from the conversions master, so the form cannot offer a
  unit the server will refuse while somebody is stood holding a box. A code is
  taken from the pool at the moment the line is added, because that is when
  the label is written, and handed back if the line is removed. An empty pool
  books the lot anyway and says it has no code. A submission the server
  refuses is parked in the queue with the reason showing, never dropped —
  a delivery that vanished silently is the failure this project exists to
  remove.

  Driven end to end against a local database: a Lynas delivery keyed through
  the form reached the ledger as a lot with its short code bound and 24 kg in
  the walk-in fridge. 74 tests pass, including the queue, the pool, id minting
  and the submission shape.

  **The picker is a grid of photographs, 2026-08-31 (Dean).** Staff recognise
  their stock by the picture faster than by reading a name off a list, and the
  current forms already work that way. `worker/scripts/import_photos.py`
  copies the kitchen's existing ingredient photographs into
  `worker/public/photos/`, once, matched by item id — both catalogs share ids
  because both came from the same workbook, so a photograph lands on the item
  it was taken of and nothing is matched by guessing at a name. They are
  committed and served from trace's own origin, so the picker works offline
  and the old stack stays a frozen archive rather than becoming a live
  dependency.

  59 of the 64 ingredients have one. Chicken Fillet and Pork Belly have no
  photograph in the source, and three others are Google Drive links from
  before the kitchen moved its images into R2 which Drive will not serve to
  anyone not signed in. Those five show their name on a plain tile: a stand-in
  picture of a different ingredient would be worse than no picture.

  Tiles are grouped fridge, freezer, dry store — the order somebody walks the
  kitchen — with an item whose storage nobody has decided in its own group
  rather than quietly filed under one. Choosing an item preselects where it
  goes only where there is one area of that kind; an ambient item is left
  unset, because the dry store and the allergen-free shelf both fit and
  choosing between them for somebody would be a guess about allergens.

  Labels are still not printed from the form. That is the separate workstream
  in `labels/`, and until it lands the form shows each line's short code to be
  written on the case by hand — which is no worse than today, where the code
  is a date.

  **The device identifies itself, and its section is a footnote (Dean,
  2026-08-31).** Nothing in it is an instruction, so it sits at the foot of
  the page rather than above the work: the codes held, the catalog's age and
  the running app version are for the moment somebody asks why the iPad is
  behaving oddly.

  Going further — letting a device register *itself* on first use, so the
  choice could never appear even with several devices — is deliberately not
  done yet. Registration is currently a deliberate act in the database, and
  that is the only thing presently stopping anyone who loads the URL from
  minting a device and a code pool. It becomes safe once there is
  authentication, and should be revisited then.

  **The form does not ask which device it is (Dean, 2026-08-31).** The kitchen
  has one iPad, so where exactly one device is registered the form uses it and
  the row stays hidden — choosing the only candidate is not a guess. The
  concept stays in the schema, because short codes are reserved per device and
  two devices must never be able to mint the same one; the choice reappears by
  itself the day a second device is registered. A remembered device that is no
  longer registered is dropped rather than carried on with, since it would
  fail at the first submission anyway.

  **The picker narrows to the chosen supplier (Dean, 2026-08-31)**, which
  turns sixty-odd tiles into twenty-odd. `item_suppliers` (migration 0003)
  holds the mapping, built by `worker/scripts/import_item_suppliers.py` from
  two sources in the kitchen's own Goods In Records, labelled per row: its
  maintained supplier list, and the 2,600-odd deliveries that prove a supplier
  has actually delivered an item. Where both apply the history wins.

  **Suppliers do share ingredients, and the schema reflects the records rather
  than the premise.** Seven ingredients arrive from both Lynas and Tazaki —
  Japanese Soy Sauce, Mirin Style Seasoning, Rice Vinegar, Shimaya Konbudashi
  and Toban Djan Chilli Bean Sauce each with deliveries from both, plus Ground
  Bean Sauce and Red Bean Curd where the maintained list says Lynas and only
  Tazaki has ever delivered. The table is therefore many-to-many; a single
  supplier column could not hold that without discarding one of the two on no
  evidence.

  **Resolved 2026-08-31 (Dean): all seven are primarily Tazaki, with Lynas as
  an emergency backup when Tazaki cannot supply.** Both pairings are real, so
  neither is dropped; migration 0004 adds `role` to distinguish them. Only a
  person could draw that line — the delivery history cannot tell "bought here
  every week" apart from "bought here twice in an emergency" — so it is
  recorded in the overrides with its provenance rather than derived.

  The picker uses it to be clean and complete at once. Under Tazaki the seven
  are ordinary stock. Under Lynas they appear at the end under "Backup only —
  normally Tazaki", set apart from the everyday grid but still one tap away,
  because a Lynas delivery of them is a real thing that happens and hiding it
  would strand somebody at the door. Lynas shows 26 everyday tiles and 7
  backups; Tazaki shows 29.

  **The twelve ingredients with no supplier are now settled (Dean,
  2026-08-31).** Chicken Fillet comes from Lynas; Tahini and Dried Bird Eye
  Chillies from Tazaki. The other nine — Carrots, Chicken Powder, Chinese
  Leaves, Dark Soy Sauce, Hoi Sin Sauce Cans, Medium Eggs, Sriracha Chilli
  Sauce, Tomato Ketchup and Tomato Puree Paste — are used at Edinburgh only
  and are out of scope at Glasgow. They are imported inactive with that
  reason, the same treatment as Ikigai Chicken Broth and Green Oil, rather
  than deleted: a skip would let a later import add them back unnoticed.
  Glasgow now holds 55 active ingredients and every one of them has a
  supplier.

  Those three answers live in `catalog-overrides.json` alongside the rest of
  the kitchen's decisions, and the importer records them as `decided` rather
  than as `delivered` or `registered`. A person saying so is a good source; it
  is simply not the same source as a delivery note, and the row says which.

  Twenty-eight names in the workbook match no catalog ingredient — mostly
  packaging, or the same thing spelled differently — and are left out rather
  than matched approximately. The picker also always offers "Show everything",
  so a filter can never be the reason a delivery cannot be booked in.

  **The form opens with no network, 2026-08-31.** `worker/public/sw.js` caches
  the app and the photographs, so a reload on dead kitchen wifi gets the form
  rather than a browser error. That was the last real offline hole: ids were
  already minted on the device, short codes already pre-issued, and
  submissions already queued before being sent, but none of it helped if the
  page itself could not load.

  Two choices in it are deliberate. The app is fetched network-first with the
  cache only as a fallback, because cache-first would reintroduce the failure
  the `forms` repo already suffered — a fix deployed, the iPad still serving
  last week's code, and nobody able to tell by looking. The cache name carries
  a version, a deploy deletes the old one, and the running version is shown on
  screen. And `/api/*` is never intercepted: the queue is the only retry
  mechanism, and a second one hidden in the cache layer would make a stuck
  submission impossible to reason about.

  The routing was checked against a fake cache and network rather than assumed
  — offline, a navigation and the app's scripts come from the cache, a
  photograph comes from the cache without even attempting the network, and an
  API call is left alone to fail into the queue. Two things that only bite
  offline were found that way: `/index.html` is answered with a 307 to `/` by
  Workers' static assets, and a cached redirect cannot satisfy a navigation,
  so the shell caches `/`.

  A note against expectations: iOS Safari has no Background Sync, so a queued
  submission sends when somebody next opens the form rather than silently in
  the background. For a form opened at every delivery that is not a practical
  difference, but it is not what the phrase means elsewhere. The form should
  also be added to the home screen — iOS clears site data after seven unused
  days, installed web apps are exempt, and the queue lives in that storage.

  **The food-safety checks, 2026-08-31.** The ledger recorded a delivery's
  traceability and none of its compliance, which would have made trace a
  downgrade on the form it replaces. All 411 of the kitchen's goods intake
  records carry a vehicle condition and three attestations, 235 a chilled van
  reading, 168 a frozen one and 201 a product probe. Migration 0005 adds the
  limits as data, the per-delivery checks, every reading taken, and the
  deviations a breach opens; the form asks for them and a screen closes them.

  Nothing about it was invented. Chilled at 5 rather than the legal 8 is
  Dean's line, and every historical reading is 4 or 5, so 5 catches drift
  while it is still drift. Frozen at -18 and the half-hour recheck window come
  off the kitchen's own deviation record. Which lines are probed is read from
  the history rather than ruled on: it probes chicken feet and femur bones and
  never oil or noodles, so chilled and frozen stock is probed and ambient is
  not — decided from the catalog, so the form never asks and a line that
  should carry a reading cannot arrive without one.

  **A breach holds the stock rather than noting it.** That is the one place
  this departs from current practice, and deliberately: the kitchen's existing
  deviation had a recheck due at 14:02 and taken seven days later. Nothing was
  wrong with the decision — the stock came back at -19 — but nothing chased it
  either. A held lot now cannot be used until somebody records a second
  reading, an outcome and their name; resolving is refused unless that reading
  is actually within limit; a warm van holds every lot of its class in the
  load, because one good probe does not clear a load that travelled warm; and
  a lot held by two readings stays held until both are closed.

  Three faults were found by exercising it rather than reading it. The item
  lookup did not select `storage_unopened`, so every item looked ambient and
  every temperature check was silently skipped — the worst kind, since it
  passed. Readings were written before the lots they point at, which SQLite
  rejects because foreign keys are checked per statement. And the vehicle
  condition relied on a browser's "first option wins" default for a compliance
  field, which is now set explicitly.

  Still to do before P1 can be called finished: authentication, registering
  the real iPad, and the supervised real delivery that ends the phase.
  Authentication is deferred until the whole system is built (Dean,
  2026-08-31), so P1 cannot formally close until then — everything is proven
  locally in the meantime.
- **P2 — Store, move, waste.** Location tracking, `MOVE` between areas, and the
  waste/hold log that the old project never started. Waste is early here, not
  late, because without it stock can only ever go missing rather than be
  accounted for.
  **Progress 2026-08-31.** The ledger side is built: `MOVE` between areas,
  `WASTE` against a controlled reason, and a hold that is not about
  temperature. `worker/public/stock.html` is the screen over them — what is in
  each area, first-expiring first, searchable by name or short code, with the
  three actions behind a tap.

  The rule underneath all of it is that a lot's balance at a location is the
  sum of its movements there and may never go below zero. A refusal names the
  figure rather than saying no, because the person is stood in front of the
  shelf and "there are 16" is the whole message. Held stock cannot be moved or
  wasted, only released, since moving it first is how a hold gets worked
  around.

  Waste reasons were chosen with Dean on 2026-08-31: out of date, damaged or
  spoiled, spillage or dropped. **Trim and preparation loss is deliberately
  not among them** — bones and peel are a yield matter belonging to the recipe
  at batching, and putting them in the waste log would bury the three reasons
  worth looking at under the one that is simply normal. A fourth reason exists
  for stock that failed a temperature check, which the system writes and
  nobody can choose; that closed the P1 gap where a disposed deviation changed
  a lot's status but left its quantity on the balance for ever.

  The stock screen is deliberately not offline-first. It is used inside, on
  wifi, at the racking, and it reads live balances a cached copy would get
  wrong the moment somebody else moved something — the distinction recorded
  under "Where the iPad actually is". It needs no device either: goods intake
  must name one because its short codes come from that device's pool, but
  moving stock is done on whatever is to hand.

- **P3 — Produce.** Recipe-driven batching with mandatory lot selection, split
  allocation across lots, and use-by derived once from the recipe rule rather
  than typed or auto-calculated per form.
- **P4 — Dispatch.** Consumes product lots and inherits their recorded use-by
  rather than calculating a new one. This closes the chain to the customer,
  which is the question an audit actually asks.
- **P5 — Count.** The weekly count: expected versus counted, variance written
  as `ADJUST`. This is what makes the balance self-correcting.
- **P6 — Reports.** One-step-back, one-step-forward, mass balance, and alerts
  for missing lots, negative balances and conflicting dates. Simple versions of
  these are built alongside P1–P5 to validate the data model as it grows; P6 is
  where they become the finished operational views.
- **P7 — Parallel run and cutover.** Old and new run together for an agreed,
  time-boxed period, reconciled daily, with a timed mock recall as the exit
  criterion. Old forms are retired only after that passes.

The old system stays live and authoritative throughout P0–P6. Staff are not
asked to double-enter until P7, and P7 is deliberately time-boxed because
double entry is a real cost that degrades both sets of records if it runs long.

**Label printing runs as a parallel workstream**, starting from the current
Zebra Designer and Windows laptop setup and ending with ZPL driven from a form
submission. It is not on the phase list above because it is being investigated
separately first. It does not block P0–P3 (see the open questions below).

## Open questions

These need Dean's answer before the phase that depends on them.

1. **Label printing path.** Being taken forward as a separate workstream.

   **Progress 2026-08-28.** The label side is proven. Three labels are
   written as ZPL and printing correctly on the ZT231 from the Windows
   machine over USB: the product packet label, and printed replacements for
   the Goods In and Date Opened forms that staff currently fill in by hand.
   Each carries the lot's short code and QR. Their content is still typed in
   by hand, which is what P1 replaces — the templates are ready to be
   generated from, not yet generated. Zebra Designer is no longer
   in the path. See `labels/` for the artwork, an image-to-ZPL converter, a
   layout linter and the findings — including that `^BY` is persistent printer
   state that silently displaces QR codes on later labels, which cost a
   morning and which generated labels must set explicitly. Print registration
   now lives on the printer rather than in the label format.

   What remains is the network path, not the label. Narrowed 2026-08-27: Zebra's Cloud Connect (Weblink) documentation indicates
   the ZT231 supports an outbound WebSocket, which would remove the need for
   any always-on machine in the kitchen. Still to confirm on the unit itself,
   along with whether Durable Objects need a paid Workers plan here.

   **Prove raw ZPL over port 9100 from the Windows laptop before choosing a
   bridge.** Every one of the three options ends with something writing ZPL to
   a socket, so if that does not work nothing else will. It also breaks the
   dependency on Zebra Designer immediately, well before any of this system
   exists, because any script on any machine can then print. Use Zebra Designer
   to *export* the ZPL for the label layout rather than writing coordinates by
   hand, and keep that output as the template.

   **Correction to an earlier version of this plan, which said
   scannable labels block P1 and P3: they do not.** The lot picker works
   without any scanning — "open lots of chicken feet, first-expiring first" is
   usually a one to three item list — and the short fallback code covers the
   rest. Scanning is an accuracy and speed upgrade that can be added once the
   hardware path is settled, so P1 to P3 can be built and run before it exists.
2. **Lot identity and short codes — resolved 2026-08-28 (Dean).** A lot carries
   two identifiers, and they do different jobs.

   The **internal id** is a ULID minted on the device. It needs no coordination
   with the server, so a lot can always be created, even offline with
   everything else unavailable. It is never printed and never typed.

   The **short code** is the six-character identity printed on the label, in an
   alphabet with the ambiguous glyphs removed. It must be unique, but the
   device cannot check uniqueness while offline at the goods-in door, which is
   exactly when it is needed. So the **server pre-issues a pool of short codes
   to each device** — a couple of hundred, already reserved server-side.
   Intake pops one and binds it to the ULID; the pool refills whenever the
   device is online and falls below a threshold. Pools are disjoint per device,
   so two devices cannot collide, and a code is never reused.

   Keeping the two separate is what makes the degradation safe. If a pool ever
   does run dry offline, the lot is still created and still records everything
   about the delivery — it simply has no printed code until one can be
   assigned, which is a relabel rather than lost data. Were the short code the
   primary key, an empty pool would stop intake entirely.
3. **Count granularity (blocks P5).** Staff physically count "how much of X is
   in the freezer", not per lot. Traceability wants per lot. Options are
   counting by lot where cases are individually labelled and falling back to
   item-plus-location for loose or decanted stock, or apportioning an
   item-level variance across that item's open lots by a stated rule. This is
   an operational decision, not just a technical one.
4. **Opening a pack — resolved 2026-08-31 (Dean).** Three things happen in
   this kitchen and the catalog could not tell them apart, so `items` now
   carries `opening_rule` and `days_after_opening`:

   - **`shortens`** — the pack states a period, so an opened pack's use-by is
     the earlier of its own date and that many days from opening.
   - **`no_change`** — opening changes how it is stored but not how long it
     lasts.
   - **`whole_pack`** — the pack is never partly used, so no Date Opened
     label is printed at all.

   **Fifteen ingredients get a Date Opened label** and every other ingredient
   is used whole: balsamic vinegar, cracked black pepper, cider vinegar, hoi
   sin sauce, japanese soy sauce, mirin, white miso, MSG, rapeseed oil, fine
   salt, sesame oil, syrup, tahini, ground white pepper and yuzu seasoning.
   All fifty-five active ingredients are now decided, none left undetermined.

   Two of the periods come from the supplier's own specification, found in
   the `forms` repo's ingredient spec documents rather than asked for:
   balsamic vinegar at three months, japanese soy sauce at eight weeks. The
   other thirteen say only "keep refrigerated once opened" with no period, so
   **the kitchen's own six-week rule applies** — tighter than the packs
   require, and recorded as the kitchen's decision rather than the supplier's
   so the two are never confused. Each row in the overrides says which of the
   two it came from.

   Three spec statements were deliberately not taken at face value. Granulated
   sugar's "use within 6 months" is about lumping rather than safety and is
   not a use-by. White miso's "use as soon as possible" and yakisoba sauce's
   "consume immediate" state urgency with no number, and a date cannot be
   derived from urgency.

   What remains is the event: recording that a pack was opened, and applying
   the rule to that lot's use-by. That belongs with P3, where the opened pack
   is what a batch is drawn from. Products are left undetermined — the fifteen
   are all ingredients, and whether an opened tub of chilli oil behaves the
   same way has not been asked.
5. **The supervised exception workflow (blocks P3).** Lot selection is meant to
   be mandatory before a batch can complete. There will still be cases where
   the physical lot genuinely is not in the system. What that escape hatch
   looks like, and who is allowed to use it, determines whether staff comply
   with the rule or route around it.
6. **Shelf-life ownership — resolved 2026-08-28 (Dean).** The use-by is read
   off the supplier's box wherever it is printed, and that always wins. Where
   there is none, which is mostly fresh produce, staff assign one week from
   delivery. So the shelf-life rule is a fallback rather than the primary
   source, and a single default of seven days covers the catalog, with
   per-item overrides added only where the kitchen knows better. **This
   unblocks P0**: the catalog does not need fifty-odd individually agreed
   shelf lives before it can be populated.

   One thing follows from it. A lot must record **which source its use-by came
   from** — printed by the supplier, or derived from the rule. Without that,
   neither question can be answered later: if a supplier's date proves wrong,
   which lots relied on it; and if seven days proves too generous for an
   ingredient, which lots were dated by the rule rather than by evidence. It is
   one column, and it is the difference between a date and a date you can
   defend to an auditor.
7. **Decant and merge discipline.** The system can model `COMBINE` honestly,
   but how often staff combine lots determines how much trace precision is
   lost in practice. Worth observing before assuming it is rare.
8. **Authentication.** The current forms use a staff picker with no real login.
   An audit trail naming who recorded and who approved an amendment is weaker
   if anyone can pick any name. Whether that changes, and to what, is open.
9. **Packaging.** The old rebuild deliberately excluded packaging lines. Does
   packaging get lot-tracked here, or stay out of scope?

## References

Printer and label work:

- [ZT231 specification sheet](https://www.zebra.com/us/en/products/spec-sheets/printers/industrial/zt231.html)
- [ZT231 support and downloads](https://www.zebra.com/us/en/support-downloads/printers/industrial/zt231.html)
- [Cloud Connect (Weblink) product page](https://www.zebra.com/us/en/software/printer-software/cloud-connect.html)
- [Weblink WebSocket developer documentation](https://developer.zebra.com/content/weblink-websocket)
- [Weblink WebSocket endpoint configuration (PDF)](https://techdocs.zebra.com/link-os/2-13/webservices/content/Weblink%20WebSocket%20Endpoint%20Configuration.pdf)

Background from the previous system, in other repositories:

- `forms` repo, `TRACEABILITY.md` — the abandoned ledger, its measured join
  rates, and the incidents worth not repeating.
- `aahq-doc` repo, `HANDOFF.md`, "Post-audit project — rebuild traceability
  from the ground up" — the design brief this project satisfies.

## Constraints carried over

- Kitchen staff use the current forms daily on production-floor iPads and
  phones. Nothing in this project may take those offline or lose a submission.
  The old system remains authoritative until Dean cuts over deliberately.
- No fabricated or inferred data anywhere, in any environment. Where a link
  cannot be proven it is recorded as unproven, never guessed. This is the
  discipline the old ledger applied to ambiguous matches, and it is the whole
  reason to rebuild rather than paper over.
- Test writes go against a copy, never production data.
