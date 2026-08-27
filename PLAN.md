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
| Send stock to a customer | `DISPATCH` | negative |
| Put stock on hold / release it | `HOLD` / `RELEASE` | status change |
| Weekly count | `ADJUST` | signed correction to match reality |

Two tables carry all of it: **lots** (what physically exists, and where) and
**movements** (append-only, every change to any lot). Stock on hand, backward
trace, forward trace and mass balance are all *queries over movements*. None of
them is a stored figure that can drift out of step with the events beneath it.

Three consequences worth stating explicitly:

- **A product lot and an ingredient lot are the same kind of object.** That is
  what makes product-into-product work with no extra machinery: garlic oil is
  produced as a lot, then consumed as an ingredient by a broth batch, using the
  same two movement types as any delivered ingredient.
- **A split across two lots is just two `CONSUME` movements.** There is no
  separate allocation table. The rule that the parts must add up to the
  quantity consumed is a validation applied when the transaction is written.
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

## Schema sketch

Indicative, not final. Names and columns will be settled in P0.

**Catalog**

- `items` — one row per ingredient, packaging item or product. Carries
  `kind`, `base_unit` (`kg` | `L` | `Units`), shelf-life rule, active flag.
  Ingredients and products share this table; that is what makes
  product-into-product free.
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

- `lots` — system-generated opaque id, item, human-visible lot code, supplier
  lot and supplier, received or produced timestamp, use-by, current location,
  status (`open` | `closed` | `held` | `written_off`). **No quantity column.**
  Quantity is derived from movements, so the two can never disagree.
- `movements` — append-only. Lot, type, signed quantity in the item's base
  unit, counterpart lot (the genealogy edge), location, when it happened, when
  it was recorded, staff, reason, note, and the submission event it came from.

**Submission and audit**

- `events` — the envelope for one form submission: kind, staff, timestamps, the
  raw payload as received, and a unique client-generated idempotency key. This
  key is what makes offline sync safe: a resend of an already-accepted
  submission is rejected as a duplicate rather than written twice. The old
  system's 67 duplicate Goods Intake rows came from exactly this gap.
- `amendments` — corrections are never edits. A correction writes a
  compensating movement plus an amendment row recording what changed, the
  before and after values, the reason, who requested it and who approved it.

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

## Open questions

These need Dean's answer before the phase that depends on them.

1. **Scannable lot labels (blocks P1/P3).** The design brief calls for a
   scannable label on each received case so production can scan the physical
   lot rather than type a code. That needs a decision on hardware: label
   printer and stock, or an on-screen code scanned by the iPad camera, or a
   handwritten code with a scannable sheet. Label printing was explicitly
   deferred in the old project; this project's brief reverses that, so it needs
   confirming rather than assuming.
2. **Count granularity (blocks P5).** Staff physically count "how much of X is
   in the freezer", not per lot. Traceability wants per lot. Options are
   counting by lot where cases are individually labelled and falling back to
   item-plus-location for loose or decanted stock, or apportioning a
   item-level variance across that item's open lots by a stated rule. This is
   an operational decision, not just a technical one.
3. **The supervised exception workflow (blocks P3).** Lot selection is meant to
   be mandatory before a batch can complete. There will still be cases where
   the physical lot genuinely is not in the system. What that escape hatch
   looks like, and who is allowed to use it, determines whether staff comply
   with the rule or route around it.
4. **Authentication.** The current forms use a staff picker with no real login.
   An audit trail naming who recorded and who approved an amendment is weaker
   if anyone can pick any name. Whether that changes, and to what, is open.
5. **Packaging.** The old rebuild deliberately excluded packaging lines. Does
   packaging get lot-tracked here, or stay out of scope?
6. **Shelf-life ownership.** Which product shelf lives are fixed rules, and
   where the approved figures come from, so that a derived use-by is derived
   from something authoritative.

## Constraints carried over

- Kitchen staff use the current forms daily on production-floor iPads and
  phones. Nothing in this project may take those offline or lose a submission.
  The old system remains authoritative until Dean cuts over deliberately.
- No fabricated or inferred data anywhere, in any environment. Where a link
  cannot be proven it is recorded as unproven, never guessed. This is the
  discipline the old ledger applied to ambiguous matches, and it is the whole
  reason to rebuild rather than paper over.
- Test writes go against a copy, never production data.
