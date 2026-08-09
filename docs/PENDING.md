# PENDING.md — Deferred Decisions & Follow-Up Work

A running log of things that were **deliberately** scoped out of a round, so they're tracked
instead of forgotten. This is technical/granular — for customer-facing feature requests, use
[PHASE2.md](PHASE2.md) instead. Added Round 9 per [RULES.md](RULES.md) #14.

## How to use this doc

When a round explicitly decides "not building X now, doing Y instead" — log it here with the
round, the reason, and what a future round would need to know to pick it up. Remove an entry once
it's actually built (and note where, e.g. in [SCHEMA.md](SCHEMA.md)'s change log).

## Open items

- **Real scannable QR/barcode image on thermal receipts.** (Round 14) The receipt's
  "Scan / Pay" section (`src/lib/invoicePrint.ts`'s `sectionQrPlaceholder`) now shows the
  shop's real configured UPI text (Settings → Billing & Receipts → Payment / UPI Details)
  instead of a fake hardcoded placeholder — a shop owner can now actually set what prints
  there. It's still text, not a scannable graphic: `electron/printer-api.ts`'s
  `normalizeRawPrinterCommands` strips everything outside printable ASCII before sending to
  the print spooler, so binary QR/image commands can't currently pass through that pipeline
  safely. A real embedded QR would need either a font-based QR/barcode rendering approach
  compatible with raw ASCII, or a dedicated binary-safe send path (bypassing the ASCII
  normalizer with its own validation) — real scope, not attempted this round. Label
  Designer's QR element is unaffected (different pipeline — label printing already sends
  proper binary TSPL commands, see `printer-driver.ts`).
- **Date-range filtering on Invoice History and Reports (Sales/Payments).** (Round 13) Both
  currently fetch all-time data with no `from`/`to` narrowing in the UI (the backend report
  endpoints already accept `from`/`to` query params per `backend/src/routes/reports.ts` — this is a
  frontend-only gap). Flagged in [PRODUCT_REVIEW.md](PRODUCT_REVIEW.md) as the single
  highest-priority gap found in the Round 13 audit: any shop older than a few months gets an
  unpaginated, unfiltered table on both pages. Next round should add a date-range picker (reusing
  the pattern already established by `ReportsPage.tsx`'s GST month picker) plus pagination on
  `InvoicesPage.tsx`'s list.
- **Batch label printing + item search on the Barcode Labels page.** (Round 13) `LabelsPage.tsx`
  only supports one item at a time via a plain alphabetical `<select>` with no search — unusable
  once a catalog has hundreds of SKUs, and there's no way to reprint labels for a batch of existing
  items (Bulk Stock Entry has its own batch-print step right after creation, but that doesn't cover
  reprinting later). Needs multi-select UI + reuse of `BulkStockEntryPage.tsx`'s existing
  `handlePrintBatch`/`buildDataForItem` pattern from `src/lib/labelPrint.ts`.
- **Undo/redo and an unsaved-changes guard on Label Designer.** (Round 13) `LabelDesignerPage.tsx`'s
  drag-and-drop canvas has no undo/redo (a misplaced drag or accidental element delete has no
  recovery short of reloading) and no warning before switching templates or navigating away with
  unsaved changes. Real state-management work — needs an undo stack (element array snapshots) and
  a `beforeunload`/navigation guard, not a one-line fix.
- **GSTR-1/GSTR-3B filing-ready export.** (Round 13) The GST Pack (`ReportsPage.tsx`'s `gst` tab)
  is informational only — Print/Excel/PDF of a summary, not the actual government filing format.
  Would need research into the exact GSTR-1/3B JSON/Excel schema the GST portal accepts before
  scoping.
- **Self-service (non-support-mediated) password reset.** (Round 13, revisiting a Round 12 design
  decision) The current forgot-password flow requires RaSetu support to manually issue a reset
  code (see Round 12's plan) — a deliberate tradeoff given the app has no email/SMS on file for a
  shop's users today. An instant self-service reset (email or SMS OTP) would need the app to
  collect and verify a recovery contact at user-creation time first — a real product decision, not
  a quick fix. Flagged for the user's own prioritization, not built.
- **Settings change audit/history.** (Round 13) No record of who changed what in Settings (e.g. the
  invoice prefix, a category rename) or when. Lower priority than the above — only worth building
  if it becomes an actual support pain point.
- **Relocate a company's data to a different drive after creation.** (Round 9) A company's
  storage location (`storageType`/`dbDir`/`volumeId` on the catalog `Company` model — see
  [SCHEMA.md](SCHEMA.md)) is fixed at creation time in Round 9's multi-company-storage feature.
  Moving an existing company's files to a new location later (e.g. "this company was on drive C:,
  move it to a pendrive") is not built. To pick this up: needs a copy-verify-cleanup flow (copy the
  DB + backups to the new location, verify integrity, update the catalog row, only then delete the
  old copy — never delete-then-copy) and should reuse the existing "renderer builds the exact
  operation, main process executes it" pattern already used for backups
  (`electron/main.ts`'s `rt:backup-export-to`/`rt:backup-import-external` handlers are the closest
  existing precedent).
- **Company-count cap / plan tiers.** (Round 9) Companies-per-license is unlimited and unmetered by
  product decision this round. If a future pricing model wants a cap or per-company billing, it
  needs both a schema-level counter/limit check server-side (in the license-validate edge function,
  not just the client) and a [COMMERCIAL.md](COMMERCIAL.md) pricing decision first — don't add
  enforcement without both.
- **Supabase MCP account.** (Round 9) The Claude session's Supabase MCP connector is still
  connected to a different ("GoBilling") account than the one that owns the real RaSetu project —
  the user chose to keep it that way and handle Supabase changes manually (CLI/dashboard) rather
  than reconnect it. GitHub repo and Cloudflare R2 were both resolved this round (see
  [DEPLOY.md](DEPLOY.md)). Not expected to change unless the user decides otherwise.
- **`knownExternalCompanyIds` cold-start gap.** (Round 9, found during live hardware testing) If
  the backend process starts fresh while an external company's drive happens to be unplugged, and
  that company is reached via manual company-ID entry (not the shop-picker, which correctly
  wouldn't show it at all), it gets a generic "Company not found" 404 instead of the friendly
  drive-disconnected message once — `company-registry.ts`'s `knownExternalCompanyIds` hasn't
  learned about it yet in that fresh process. Narrow edge case; see
  [ARCHITECTURE.md](ARCHITECTURE.md)'s "Drive removed mid-session" section for the full context.
  Could be closed by seeding `knownExternalCompanyIds` from the catalog DB at backend startup
  instead of only learning it lazily.
