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

## Schema sketch

Indicative, not final. Names and columns will be settled in P0.

**Catalog**

- `items` — one row per ingredient, packaging item or product. Carries
  `kind`, `base_unit` (`kg` | `L` | `Units`), and a **required** shelf-life
  rule. Ingredients and products share this table; that is what makes
  product-into-product free. The shelf-life rule is required rather than
  optional because it is the only source of a use-by for goods that arrive with
  no printed date.
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
  lot came from a `COMBINE`. **No quantity column and no location column** —
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

- `print_jobs` — queued label jobs with their generated ZPL, status and
  timestamps. A queue rather than a direct call, so that a printer or agent
  outage delays labels instead of failing submissions.

## Delivery phases

Each phase should end in something a person can actually use, and each ends
with tests plus a supervised real submission before its line is ticked.

- **P0 — Foundations.** Worker, D1, migrations, staff identity, and the catalog
  tables (items, locations, suppliers, units and conversions). No capture forms
  yet. Ends with the catalog populated and readable.
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
2. **Client-minted lot ids (blocks P1).** Confirm ULIDs generated on the device
   rather than server-assigned ids, so that offline intake can bind a label.
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
5. **Shelf-life ownership (blocks P0).** Now upgraded from a nice-to-have: the
   shelf-life rule is the only source of a use-by for goods that arrive
   undated, so every item needs one. Which figures are approved, and where they
   come from, needs settling before the catalog is populated.
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
