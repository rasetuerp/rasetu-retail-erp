# SCOPE.md — v1 Frozen Feature List

**Status:** Frozen Day 0. Any change must go through [PHASE2.md](PHASE2.md) — never into the sprint.
**Customer confirmation date:** _(fill in — get a literal WhatsApp "confirmed" on this exact list before Day 1)_

## Current status (Round 9, 2026-08-01)

The v1 list below shipped, then the project kept going as an iterative build (see
[ARCHITECTURE.md](ARCHITECTURE.md)'s round-by-round summary). Notable **delivered beyond this v1
list**: multi-user PIN auth + roles (Round 3), license activation with offline grace (Round 4,
hardened Round 9), Draft/Held/Estimate invoice lifecycle (Round 6), the WYSIWYG Label Designer +
receipt section designer that item 4 below deliberately scoped out as "3 fixed templates" (Round
7), the local+R2+Google-Drive+external-drive backup system (Round 7), the company-first onboarding
redesign (Round 8), and multi-company-per-license with per-company storage location (Round 9). See
[PHASE2.md](PHASE2.md) for what moved from backlog to shipped.

1. **Setup Wizard** — company details, GSTIN, financial year, logo, printer selection, vertical profile.
2. **Multi-company** — company switcher; each company = separate SQLite file (cleanest isolation, simplest backup).
3. **Item/Stock Master** — cloth attributes (category, brand, size, color, HSN, purchase rate, MRP, selling rate, GST%, opening stock), quick-entry grid, import from Excel.
4. **Barcode Labels** — generate barcode per item, 3 fixed templates (small tag, medium tag, shelf label), settings: logo on/off, darkness, font size, alignment, preview, print queue, TSC printing.
5. **GST Billing:**
   - Customer select/quick-create, barcode scan or search to add items
   - Inclusive & exclusive GST pricing (cloth shops quote MRP inclusive — **this must be the default**)
   - Auto GST slab by MRP for cloth (5%/12% rule), CGST/SGST split, IGST for inter-state
   - Discount % and flat, round-off, reverse adjustment (type final amount, system back-calculates discount)
   - Multiple payment modes (Cash/UPI/Card/Cheque/Credit) with references, part payments
   - Old balance shown, new balance computed, due date, loyalty points (earn only in v1; redeem in Phase 2)
   - Save, Save as Draft, Hold bill (park & recall — essential in retail rush hours)
   - Thermal receipt (Epson ESC/POS, 3 fixed layouts) and A4/A5 GST invoice (2 fixed layouts)
6. **Purchase Entry** — party bill entry, auto stock-in, GST input capture (needed for GSTR reconciliation).
7. **Document lifecycle** — Edit / Cancel / Delete rules per [SCHEMA.md](SCHEMA.md), with audit log.
8. **Sold Item Register** — all sold items view, manual sold entry, damage/write-off entry with reason.
9. **Parties & Ledger** — customers + suppliers, party-wise ledger (bills, payments, running balance).
10. **Reports** — Sales (day/period/item/party), Purchase, Stock (current + low stock), Outstanding/Credit report. Every report: Print, PDF export, Excel export (one shared export utility).
11. **GST Report Pack — one click** (see [GST-SPEC.md](GST-SPEC.md)).
12. **Alerts** — low stock, payment due, bill due date (in-app dashboard list; WhatsApp is Phase 2).
13. **Licensing & trial** — 15/30-day trial keys, module flags, subscription expiry handling.

## What's explicitly out (see PHASE2.md)

Drag-and-drop label/receipt designers, loyalty redemption, CRM/follow-up module,
WhatsApp integration, two-way multi-device sync, remote mobile app, salesman
commission, size-color matrix grid entry, e-invoice/e-way bill, other vertical
profiles, Tally XML export.

## Pre-decided cut order if Days 5–6 (billing) overflow

If behind schedule, cut in this order: loyalty earn → hold bill → A5 layout → alerts.
**Never cut:** billing correctness, GST pack, printing.
