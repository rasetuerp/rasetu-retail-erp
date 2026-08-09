# SPRINT_PLAN.md — 10-Day Step-by-Step Build Guide

## Current status (Round 9, 2026-08-01)

This was the Day-1 plan for a literal 10-day single-customer sprint. In practice the v1 scope
below (Days 1–9) shipped, then the project continued as an ongoing iterative build organized into
numbered "Rounds" rather than a Day-10 on-site go-live — see
[ARCHITECTURE.md](ARCHITECTURE.md)'s "Current status" section for the round-by-round feature
summary. Treat the day-by-day plan below as the historical v1 baseline, not the live schedule.

Cross-reference: [SCOPE.md](SCOPE.md) for what's in scope, [RULES.md](RULES.md) for how to build it,
[ARCHITECTURE.md](ARCHITECTURE.md) for what's already ported from GoBilling.

## Day 0 — before any code

- Get a literal WhatsApp "confirmed" from the customer on the exact [SCOPE.md](SCOPE.md) v1 list.
- Collect: logo, GSTIN, item list Excel, label size samples, a receipt sample they like.
- Confirm which TSC printer model and label roll size they already own.

## Day 1 — foundation (this scaffold)

- [x] Repo setup from GoBilling skeleton, jewellery pages stripped.
- [x] Prisma schema finalized ([backend/prisma/schema.prisma](../backend/prisma/schema.prisma)) — do not touch again without stopping to re-plan.
- [x] `docs/RULES.md` committed.
- [x] `config/profiles/profile-cloth.json` created.
- [ ] Run `npm install`, `npm run db:generate`, `npm run db:migrate` to materialize the SQLite DB.
- [ ] Company + Setup Wizard: wire the stub in `src/components/pages/` to `POST /api/companies` and `POST /api/setup`.

## Day 2 — Item Master

- Item Master page: quick-entry grid + Excel import (reuse `xlsx` dependency already in `package.json`).
- `StockMovement` engine: every stock-affecting write (purchase, sale, adjust, damage,
  opening) goes through one helper that writes the movement row — never adjust
  `Item.stockQty` directly from a route handler.

## Day 3 — shared infrastructure

- Build `src/lib/exportUtils.ts` once: Print CSS + jsPDF + SheetJS toolbar. Every
  list/report page uses this from here on — never write export code again (RULES.md #8).
- Party master + ledger engine (`Party`, `LedgerEntry` models).
- Audit log helper (`backend/src/lib/audit-log.ts`, already ported) — wire it into
  the shared mutation wrapper alongside `SyncQueue` writes (RULES.md #7).

## Day 4 — Barcode Labels

- Port `electron/label-templates.ts` down to 3 fixed templates (small tag, medium
  tag, shelf label) + a settings panel (logo on/off, darkness, font size, alignment).
- Print queue + TSC test prints — **do this at your own office**, not the customer's
  shop (see [DEPLOY.md](DEPLOY.md)).

## Day 5–6 — GST Billing (the heart; budget for overflow)

- Inclusive/exclusive GST toggle, MRP slab logic (5%/12% for cloth), CGST/SGST/IGST split.
- Discounts (% and flat), round-off, reverse adjustment (type final amount, back-calculate discount).
- Multiple payment modes with references, part payments.
- Old balance / new balance display, due date, loyalty points (earn only).
- Draft / Hold / Recall.
- **Day 6 evening:** wire thermal (Epson ESC/POS, 3 layouts) + A4/A5 GST invoice (2 layouts) print output.
- **If behind:** cut in this order — loyalty earn → hold bill → A5 layout → alerts.
  Never cut billing correctness, GST pack, or printing.

## Day 7 — Purchase Entry

- Party bill entry, auto stock-in via the Day-2 `StockMovement` engine.
- GST input capture (needed for GSTR-2B/3B reconciliation).
- Cancel/credit-note flow per [SCHEMA.md](SCHEMA.md) lifecycle table.
- Period lock setting (locks a month after GST filing).

## Day 8 — Reports + GST Pack

- Sales (day/period/item/party), Purchase, Stock (current + low), Outstanding/Credit
  reports — all on the Day-3 `exportUtils.ts` toolbar.
- GST Report Pack generator per [GST-SPEC.md](GST-SPEC.md).

## Day 9 — Licensing, sync, dry run

- Wire trial/subscription licensing per [COMMERCIAL.md](COMMERCIAL.md).
- `SyncQueue` push worker to Supabase (one-way backup only — see [ARCHITECTURE.md](ARCHITECTURE.md)).
- Dashboard + alerts (low stock, payment due, bill due date).
- Full billing dry-run with the customer's real item data.
- Build the installer.

## Day 10 — On-site go-live

Install → printer calibration → masters import → staff training
([TRAINING.md](TRAINING.md)) → collect sign-off + setup fee → leave the cheat sheet.

## Standing rules for every day

- Anything not on [SCOPE.md](SCOPE.md) → log to [PHASE2.md](PHASE2.md), never into today's work.
- End of day: commit, build installer, smoke-test billing + one thermal print.
