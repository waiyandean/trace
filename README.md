# trace

Ground-up rebuild of ingredient traceability and kitchen production
records. Replaces the current `forms` repo's forms/Sheets stack entirely —
this is not an addition to that system, it is its planned successor.

## Why a new repo

The existing system (see background below) is a patchwork of independent
forms writing to independent Google Sheets tabs, with traceability bolted
on afterwards as a join layer. That join layer works, but the underlying
forms were never designed for lot-level traceability, which is the source
of most of the gaps recorded in the background docs. This project starts
from the traceability requirement and designs the forms and data model
around it, rather than the other way round.

## Status

P0 in progress (2026-08-31). Scope, stack, offline model and history
handling are decided (2026-08-27); schema and phases are drafted. The Worker,
the D1 catalog schema and a read-only catalog API now exist in `worker/`,
with the migration applied locally and its constraints verified. The catalog
itself is still empty, pending the source for the item, supplier and
conversion lists. Label artwork and ZPL live in `labels/` and print correctly
over USB; the network path to the printer is still open.

**Read `PLAN.md` first** — it carries the model, the decisions and their
reasoning, the delivery phases, and the open questions still blocking
specific phases.

## Background reading (other repos, not part of this one)

- `forms` repo, `TRACEABILITY.md` — the current system's traceability
  ledger (Goods Intake → Lots/Movements on Cloudflare D1 → Batching →
  Dispatch). Phases T1, T3, T7, T8, T9 shipped and verified in production;
  T2 code-complete; T4/T6 code-complete pending a supervised production
  submission; T5 (waste/hold log) not started. Read this for what data
  model and gaps already exist, not as something this project extends.
- `aahq-doc` repo (private, iCloud), `HANDOFF.md`, "Post-audit project —
  rebuild traceability from the ground up" section — the design brief this
  project is meant to satisfy: scannable lot labels, mandatory lot
  selection before a batch completes, split-lot allocation, FEFO/FIFO
  picker, controlled unit conversions, immutable records with an explicit
  amendment trail, and built-in mass-balance/recall reports.

## Hard constraints (carried over, still apply)

- Kitchen staff use the current forms daily on production-floor
  iPads/phones. The old system stays live and authoritative until this one
  is verified end to end and Dean cuts over deliberately. Nothing here
  should be assumed to replace it before that decision is made.
- No fabricated data, ever, in test or production paths — see the old
  system's traceability decisions for why (ambiguous-exact matches are
  recorded as ambiguous, not guessed).
