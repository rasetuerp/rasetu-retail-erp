# SCHEMA.md — Data Model & Document Lifecycle

**Frozen Day 1.** Source of truth: `backend/prisma/schema.prisma`. Do not edit that
file during the sprint — see [RULES.md](RULES.md) #10.

## Models

`Company`, `User`, `VerticalProfile`, `Party` (type CUSTOMER/SUPPLIER, gstin, phone,
address, balance, dob, anniversary, notes — `phone` is deliberately not unique, see
Round 5 note below), `Item` (sku, barcode, hsn, category, brand, size, color, unit,
purchaseRate, mrp, sellingRate, gstRate, gstInclusive, stockQty, minStock, isActive),
`StockMovement` (itemId, type PURCHASE/SALE/ADJUST/DAMAGE/OPENING, qty, refType,
refId), `Invoice` (number, date, partyId, status DRAFT/HELD/POSTED/CANCELLED,
subtotal, discount, roundOff, cgst, sgst, igst, total, oldBalance, newBalance,
dueDate, loyaltyEarned), `InvoiceItem` (..., gstOverrideReason), `Payment` (mode —
free-text since Round 5, amount, ref, invoiceId?, partyId), `Purchase`,
`PurchaseItem`, `CreditNote`, `LedgerEntry` (partyId, debit, credit, refType, refId,
balance), `AuditLog`, `SyncQueue`, `Setting`.

## Field rules

- All money as `Decimal` (12,2 precision in practice — Prisma+SQLite supports Decimal, confirmed against GoBilling's existing schema).
- All qty as `Decimal` (10,3) — steel/fabric-by-metre needs decimals even though cloth
  pieces don't. **The vertical profile controls UI display, not the schema.**
- Indian FY handling (Apr–Mar) for invoice numbering: `INV/2026-27/0001`, sequential
  and gap-free per company per FY (required for GSTR-1 "Documents Issued" table).

## Document lifecycle — this is a GST compliance question, not just UX

| Document | Edit | Cancel | Delete | Notes |
|---|---|---|---|---|
| Draft bill | Yes, full | Yes | Yes | Drafts are free-form |
| Posted invoice, same day, GST report not filed | Yes, with audit log entry | Yes (stock reverses, number retained as "Cancelled") | **Never** | Invoice numbers must stay sequential & gap-free |
| Posted invoice, after day close / filed period | No | Via Credit Note only | No | Credit/debit notes are the legal correction path |
| Purchase entry | Yes, until month locked | Yes | No | |
| Stock adjustment / damage | Yes, same day | — | No | Reason field mandatory |
| Payments/receipts | Yes, until day close | Yes | No | |
| Master data (items, parties) | Yes | — | Soft-delete only (`isActive=false`) | Hard delete breaks historical reports |

- **Audit log:** every edit/cancel writes who, what, when, old value → new value
  (`AuditLog` model). One Prisma model + one shared helper (RULES.md #7) — cheap to
  build, saves you when a customer disputes data.

## Schema changes after Day 1 (RULES.md #10 exceptions log)

Applied to `backend/prisma/company/schema.prisma` — pushed via `prisma db push`
(no tracked migration history exists for this schema; it was set up via `db push`
in Round 4, not `prisma migrate dev`) to `template.db` and every existing
per-company `.db` file.

- **Round 5 (2026-07-26):**
  - `Party.dob`, `Party.anniversary`, `Party.notes` (all nullable) — supports one
    phone number linked to multiple family members ("family" = every `Party` row
    sharing a phone; `phone` was already non-unique, no constraint change needed)
    plus free-text marketing notes per person, deliberately not a rigid `size`
    column.
  - `InvoiceItem.gstOverrideReason` (nullable) — set only when an ADMIN/SUPER_ADMIN
    manually overrides the auto-computed slab GST% for a line; null means the rate
    came from `clothSlabGstRate(mrp)` as normal. Kept for GST-filing audit.
  - `Payment.mode` changed from a fixed `PaymentMode` enum to a plain `String`,
    validated at the Zod/route layer against an admin-editable list stored in
    `Setting` (key `'payment-modes'`) instead of a DB-level enum.
- **Round 5 follow-up (2026-07-27):**
  - `InvoiceStatus` gained `ESTIMATE` — a non-tax quotation, same Invoice/
    InvoiceItem shape (needs identical line items + GST breakdown), own
    sequential `EST/<fy>/<seq>` number assigned at creation (never GST-filed,
    never touches stock or the party's ledger). Convertible into a real
    POSTED invoice later via the existing `/post` endpoint, same as
    Draft/Held today. SQLite doesn't enforce enum values at the DB level, so
    this particular change needed no per-company `db push` — only
    `prisma generate` to teach the client the new value.
- **Round 10, Configurable item fields, Phase A (2026-08-02):** `Item` gains `customFields Json?`
  — holds values for shop-added custom item fields (Settings → Item Fields). Field *definitions*
  (key/label/required) live in a per-company `Setting` (`key: 'item-fields'`), not the schema —
  this column just stores whatever a shop's own custom fields hold per item, keyed to match. The
  existing `category`/`brand`/`size`/`color` stay real columns, unaffected — this is only for
  fields a shop adds themselves. Pushed via `prisma db push` to `template.db` **and**, for the
  first time this round, to a real live company database (`prisma db push` with a
  `COMPANY_DATABASE_URL` override pointed at the specific `.db` file under
  `RASETU_DATA_DIR/companies/`) — this is a genuinely additive, nullable column with no default,
  so no data-loss risk, but it's the first schema change this session that had to reach an
  already-created company rather than just the template. Confirmed no items existed yet on that
  company, so there was nothing to lose either way — still did the real push rather than assuming.
- **Round 11, Category master + auto-numbered SKUs (2026-08-02):** Two additive schema changes:
  - Catalog `Company` gains `shopCode String?` — the shop-identity prefix used in auto-generated
    SKUs (`ShopCode-CategoryCode-Year-Serial`, e.g. `FTS-SHI-26-0001`). Null until the shop sets one
    in Settings; both Settings and the SKU-generation endpoint independently fall back to the same
    `abbreviateToCode(company.name)` suggestion so the feature works before that.
  - Company schema gains a new `SkuCounter` model (`companyId`, `categoryCode`, `year`,
    `lastSerial`, `@@unique([companyId, categoryCode, year])`) — a real table rather than another
    `Setting`-JSON blob, because bulk item creation must hand out several sequential serials
    atomically in one request, which a read-modify-write JSON blob can't guarantee safely.
  - The Category master itself (name + code pairs) is **not** a schema change — it's a `Setting`
    (`key: 'item-categories'`, same pattern as `item-fields`), auto-seeded from a company's existing
    distinct `Item.category` text values the first time it's requested. `Item.category` itself stays
    the plain string column it always was; picking a category from the new searchable dropdown just
    fills it with that category's name, same as typing always did — no FK, no migration risk to
    existing data.
  - Pushed via `prisma db push` to both `template.db`/`catalog.db` and the user's real live
    catalog.db + "Shree Testiles" company `.db` (Electron stopped first to release file locks, same
    precedent as the Round 10 Phase A `customFields` push).
- **Round 10, Item Master field cleanup (2026-08-02):** Not a schema change. The user got confused
  live in the app about which Item/Stock Master fields are cloth-specific vs. universal — turned
  out the app already had a vertical-profile mechanism built for exactly this
  (`config/profiles/*.json`'s `itemAttributes` list, designed so a future hardware/electronics
  profile — see `docs/PHASE2.md` — could declare a different field set) but `ItemMasterPage.tsx`
  never read it; every field was hardcoded JSX. `ItemMasterPage.tsx` now fetches the vertical
  profile and renders `category`/`brand`/`size`/`color` (cloth's current `itemAttributes`) from
  that list dynamically instead of hardcoding them, and its `Unit` dropdown now sources its
  options from `profile.units.allowed` instead of being missing entirely (previously every item
  silently saved `unit: "PCS"` with no way to pick `MTR`). Also surfaced and fixed: `brand`,
  `unit`, `purchaseRate`, and `barcode` are real `Item` columns already fully accepted by
  `backend/src/routes/items.ts`'s `createItemSchema` (single + bulk create) but were never
  captured by the form at all — `purchaseRate` silently stayed `0` (understating the Stock
  Valuation report) until a Purchase Entry happened. No backend change was needed for any of
  this — pure frontend gap. `BulkStockEntryPage.tsx` got the same `Unit` dropdown + label-field
  rename for consistency (it already had Brand/Purchase Rate, ahead of `ItemMasterPage.tsx`).
  Also renamed the label/legal collapsible's `Commodity` → "Legal name (for label)" and `Type` →
  "Sub-type (for label)" with an inline hint, since both were easily confused with `Category`
  as originally labeled. `profile-cloth.json`'s `itemAttributes` had a `fabric` entry with no
  matching `Item` column at all — removed rather than left declaring a field the form can't
  actually save (revisit with a real migration if/when fabric is genuinely needed).
- **Round 10, Electron launch verification (2026-08-02):** Not a schema change — four real bugs
  found and fixed while actually running the packaged app for the first time this round (never
  caught by `tsc`, since all four are runtime-only failures):
  - **`window.rasetu` was never defined — the preload script silently failed to load, so
    `LicenseGate` (`src/App.tsx`) treated the desktop app as the plain browser preview and skipped
    straight past license activation into Shop Setup.** `main.ts` pointed `webPreferences.preload`
    at `dist-electron/preload.cjs`, but `tsc` (via `tsconfig.electron.json`, `module: NodeNext`,
    root `package.json`'s `"type": "module"`) was compiling `preload.ts` to plain `preload.js` —
    the `.cjs` file never existed, so Electron's preload load failed quietly (no crash, no visible
    error) and nothing was ever exposed on `window`. There was also a **stale hand-maintained
    duplicate**, `electron/preload.cjs` (committed source, not a build artifact — someone had tried
    to solve this exact problem by manually mirroring `preload.ts` in CJS), which had badly drifted
    out of sync (missing the entire backup system, update system, window controls, `printBatch`)
    and wasn't even the file `main.ts` pointed at. Deleted that duplicate. Real fix: Electron
    preload scripts must be CommonJS regardless of the app's own module type (an Electron
    requirement, not a choice) — renamed `preload.ts` → `preload.cts` (TypeScript's own
    always-CommonJS extension, which `NodeNext` always emits as `.cjs` regardless of the nearby
    `package.json`), added `electron/**/*.cts` to `tsconfig.electron.json`'s `include`. Now a
    single source of truth generates the real `.cjs` on every build — nothing to manually keep in
    sync.
  - **Electron's dev-mode window loaded a completely different, unrelated app (GoBilling).**
    `electron/main.ts` hardcoded `loadURL('http://localhost:5173')`, while `vite.config.ts`
    deliberately had no `strictPort` ("fall back to a free port when 5173 is taken by an unrelated
    process" — a prior-round decision that only considered the browser-preview workflow). On this
    machine port 5173 was already held by a separate, unrelated GoBilling dev server; RaSetu's own
    Vite silently fell back to 5174, and Electron loaded whatever was actually on 5173 — GoBilling's
    real UI, under the RaSetu window chrome. Fixed by giving RaSetu's dev server a dedicated port
    (`5183`) with `strictPort: true` (fail loudly on a real conflict instead of silently drifting
    to the wrong server) and pointing `main.ts`'s hardcoded `loadURL` at the same port. Also updated
    in `.claude/launch.json`.
  - **`electron/main.ts`'s named imports of `electron-updater` and `node-machine-id` crashed the
    main process on load.** Both are CommonJS packages whose actual named exports are buried
    inside a bundled/UMD wrapper that Node's static CJS→ESM interop can't see — `import { X } from
    'pkg'` throws `SyntaxError: Named export 'X' not found`. Fixed by importing the default export
    and destructuring: `import pkg from 'pkg'; const { X } = pkg;` (Node's own suggested fix).
    Applies to `autoUpdater` and `machineIdSync` specifically — not a signal that every CJS import
    needs this treatment (e.g. `serialport` in `printer-api.ts` wasn't touched, no evidence it's
    broken).
  - **`backend`'s production/packaged build never contained the Prisma-generated client at all.**
    `npm run build` was just `tsc -p tsconfig.json`, which only compiles `.ts` under `src/` — it
    never copies `src/generated/{catalog-client,company-client}` (pre-built `.js`/`.d.ts` plus the
    native `query_engine-windows.dll.node` binary) into `dist/`. Since `electron-builder.yml`
    packages *only* `backend/dist/**/*` for the real installer (`backend/src/**/*` is explicitly
    excluded), this meant **every installed copy of the app would have shipped broken** —
    `company-registry.ts` (and anything else importing the generated client) would fail at runtime
    with `ERR_MODULE_NOT_FOUND`. Invisible in day-to-day dev because `npm run backend:dev` runs via
    `tsx` straight from `src/`, which resolves `src/generated` fine — only surfaced because
    Electron's `main.ts` always spawns the compiled `backend/dist/index.js`, even in dev. Fixed by
    adding `backend/scripts/copy-generated.mjs` (a plain `fs.cpSync(..., { recursive: true })`) and
    wiring it into `backend/package.json`'s `build` script: `tsc -p tsconfig.json && node
    scripts/copy-generated.mjs`.
- **Round 10, Phase 2 (2026-08-02):**
  - `CreditNote` gained a child `CreditNoteItem` model (mirrors `InvoiceItem`) — previously
    `CreditNote` had only a lump `amount` with no line-item detail, so a "Sales Return" could
    never actually reverse stock. This is what makes returns functional.
  - New `DebitNote`/`DebitNoteItem` models — Purchase Return, structurally parallel to
    `CreditNote`/`CreditNoteItem` and `Purchase`/`PurchaseItem`. Did not exist before this round.
  - `StockMovementType` gained `SALES_RETURN` and `PURCHASE_RETURN`. Deliberately did **not** add
    a separate `SCRAP` type — scrap is `DAMAGE` with a free-text reason, same mechanics.
  - `Party` gained `creditLimit` (nullable Decimal, default 0 = no limit) — advisory only, Billing
    warns but never blocks posting.
  - `Payment` gained `direction` (`"IN" | "OUT"`, default `"IN"`) — reporting/labeling only
    (powers a Receipts-vs-Payment-Vouchers view), auto-set from party type, does **not** change
    the existing balance/ledger arithmetic in `payments.ts`.
  - Pushed via `prisma db push` to `template.db` (still on the clean slate from Phase 1, no live
    company data to migrate).
  - **Not a schema change, but a real adjacent fix found while building Purchase Return:**
    `purchases.ts`'s create/cancel handlers never wrote a `LedgerEntry` or touched `Party.balance`
    at all — a purchase never actually increased what the shop owes the supplier, so a Debit
    Note's own ledger entry would have had nothing correct to reduce. Fixed to mirror
    `invoices.ts`'s own `/post` pattern exactly (purchase = debit, increases balance; cancel/
    Debit Note = credit, decreases it — same "credit reduces balance" convention `payments.ts`
    already established).
  - Step 5/7 close-out: `PartiesPage.tsx` gained a `creditLimit` input on add/edit and an
    All/Customers/Suppliers tab filter (in-memory, `?type=` already existed server-side);
    `BillingPage.tsx` shows a non-blocking amber warning when a cart would push a party's balance
    past their `creditLimit`; `PurchasePage.tsx` gained a "+ New supplier" inline-create (mirrors
    `BillingPage.tsx`'s customer inline-create); `reports.ts`'s `/outstanding` `agingBucket` is now
    also used to sort `ReportsPage.tsx`'s Outstanding tab worst-first. Not a schema change: a new
    `customMessage` `ReceiptSectionKey` (`invoicePrint.ts`, `receiptSettingsSchema` in
    `invoices.ts`) plus `ReceiptSettings.customMessageText` — a free-form multi-line receipt field
    (offers/terms), separate from the existing single-line `exchangePolicyText`/`footerText`.
  - **Real bug found and fixed during live verification (not present in `tsc`):** both
    `InvoicesPage.tsx`'s Sales Return form and `PurchasePage.tsx`'s Purchase Return form read
    `e.currentTarget.value` lazily *inside* the `setReturnQtys` functional state updater
    (`setReturnQtys((prev) => ({ ...prev, [line.itemId]: e.currentTarget.value }))`). React nulls
    a synthetic event's `currentTarget` once the handler that received it returns, so by the time
    React invokes the updater function the read throws `TypeError: Cannot read properties of null
    (reading 'value')`, crashing the whole page (blank screen, "error occurred in <InvoicesPage>"
    in the console). Reproduced live via the browser preview, not caught by `tsc` since it's a
    runtime-only failure. Fixed in both files by capturing `e.currentTarget.value` into a local
    `const` *before* calling `setReturnQtys`, then referencing the captured value inside the
    updater — the general fix for this pattern anywhere a synthetic event is read inside a
    deferred/async callback.
- **Round 10, Phase 1 (2026-08-01):**
  - `Item` (`backend/prisma/company/schema.prisma`) gained six optional legal-metrology label
    fields: `commodity`, `itemType`, `brandCode`, `styleCode`, `mfgDate` (DateTime), `netQtyLabel`
    (free text, e.g. "1 N" — deliberately not a real unit-conversion system, see the field's own
    comment for why). Added to reproduce a customer-supplied sample product label that needed
    fields beyond what `sku`/`brand`/`size`/`color`/`mrp` already covered. All optional and kept
    out of the primary quick-entry item form — surfaced only in a collapsible "Label / legal
    details" section (`ItemMasterPage.tsx`, `BulkStockEntryPage.tsx`) and as new bindable fields
    in the Label Designer (`src/lib/labelPrint.ts`'s `FIELD_OPTIONS`). Pushed via `prisma db push`
    to `template.db` (no existing per-company `.db` files needed the push — Round 10 started from
    a clean test-data slate).
- **Round 9 (2026-08-01):**
  - Catalog `Company` model (`backend/prisma/catalog/schema.prisma`) gained `storageType`
    (`"internal" | "external"`, default `"internal"`), `dbDir` (external only — the fixed
    *relative* subpath under the volume root, not an absolute path), `volumeId` (external
    only — PowerShell `Get-Volume`'s stable `UniqueId`, not a drive letter, not a raw
    `drivelist` field — `drivelist` alone doesn't expose a per-volume identifier, confirmed
    by inspecting its actual output before choosing this design), `volumeLabel` (display
    only), `volumeMountHint` (display only, last-seen drive letter). Plus a
    `@@unique([volumeId, dbDir])` constraint so two companies can't collide on the same
    external location (nulls don't collide with each other on SQLite, so internal companies
    are unaffected). Supports Round 9's multi-company-per-license feature — a company's
    storage location is fixed at creation this round (relocating later is deferred, see
    `docs/PENDING.md`). Pushed via `prisma db push` to `catalog.db` only (this is the
    catalog schema, not the per-company schema — no per-company `.db` files are affected).
- **Round 7 (2026-07-30):**
  - New model `LabelTemplate` (`id`, `companyId`, `name`, `isDefault`, `widthMm`,
    `heightMm`, `elements` JSON-string, `printConfig` JSON-string) — replaces the
    old 3-name `'label-settings'` Setting key, which had no actual dimension or
    layout data behind it. A real column set (not another Setting-JSON blob) was
    warranted here because label designs are structured, queryable, listable
    records a shop owner creates/edits/deletes/duplicates, unlike a single
    flat settings object. Pushed via `prisma db push` to `template.db` and every
    existing per-company `.db` file.
- **Round 15 (2026-08-03):**
  - `CreditNote` gained `refundedAmount` (Decimal, default 0) — a running total of how much of a
    Sales Return has actually been paid back in cash, as opposed to left as store credit against
    the party's balance (which still happens unconditionally, same as before this round). New
    route `POST /credit-notes/:noteId/refund` (`credit-notes.ts`) validates `amount <= creditNote.amount
    - creditNote.refundedAmount`, logs a real `Payment` row (`direction: 'OUT'`) for the audit trail,
    and does `Party.balance += amount` directly — **not** via `POST /payments`'s generic `balance -=
    amount` math, which is only correct when a payment flows in the "natural" direction for that
    balance's current sign (settling what's owed). A return already pushed the balance the *other*
    way (shop owes the customer), so a cash refund must move it back up toward zero, the opposite
    of what the generic payments route does. Pushed via `prisma db push` to `template.db` and the
    real live company database, with the established backup-and-verify-row-count discipline.
  - Not a schema change: `payments.ts`'s private `getPaymentModes` helper was exported so the new
    refund route can validate a refund's mode against the same admin-editable payment-modes list
    without duplicating the lookup. New company-wide `GET /stock/movements` endpoint (distinct
    from the existing per-item `GET /stock/movements/:itemId`), filtered to `ADJUST`/`DAMAGE` only,
    plus `GET /credit-notes` and `GET /debit-notes` enriched with `party`/`invoice`/`purchase`
    includes — together these back a new Reports → "Returns & Adjustments" tab that unifies Sales
    Returns, Purchase Returns, and stock Adjustments/Damage in one place (previously only viewable
    inline in three unrelated pages).
- **Period lock:** a `Setting` flag locks a month after GST filing; locked months
  become read-only for that company.
- **Print & export:** every list page and report uses the shared toolbar (Print,
  PDF, Excel) built once in `exportUtils.ts` on Day 3 (RULES.md #8).
