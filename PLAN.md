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
- **The batch number stays exactly as it is**, printed on the label and stored
  on the lot. Nothing staff currently read disappears; it simply stops being
  the thing the system joins on.
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
  after-opening one. Products additionally carry a flag for whether their label
  needs the oval health mark: the broths do, most sauces and oils do not, and
  which is which is a compliance determination held per item rather than
  inferred from the recipe. Getting that wrong puts an opened jar back on a dry
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

  Two things remain before the line is ticked. The remote database does not
  exist yet — `wrangler.toml` carries a placeholder `database_id` until
  `wrangler d1 create trace` is run. And the catalog is empty: the importer is
  waiting on the source for the item, supplier and conversion lists, since
  nothing here may be invented to fill it.
- **P1 — Receive.** Goods intake form opening lots and writing `RECEIVE`
  movements, offline queue and idempotency in place from the first form rather
  than retrofitted. Ends with a real delivery booked in.
- **P2 — Store, move, waste.** Location tracking, `MOVE` between areas, and the
  waste/hold log that the old project never started. Waste is early here, not
  late, because without it stock can only ever go missing rather than be
  accounted for.
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
4. **The supervised exception workflow (blocks P3).** Lot selection is meant to
   be mandatory before a batch can complete. There will still be cases where
   the physical lot genuinely is not in the system. What that escape hatch
   looks like, and who is allowed to use it, determines whether staff comply
   with the rule or route around it.
5. **Shelf-life ownership — resolved 2026-08-28 (Dean).** The use-by is read
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
6. **Decant and merge discipline.** The system can model `COMBINE` honestly,
   but how often staff combine lots determines how much trace precision is
   lost in practice. Worth observing before assuming it is rare.
7. **Authentication.** The current forms use a staff picker with no real login.
   An audit trail naming who recorded and who approved an amendment is weaker
   if anyone can pick any name. Whether that changes, and to what, is open.
8. **Packaging.** The old rebuild deliberately excluded packaging lines. Does
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
