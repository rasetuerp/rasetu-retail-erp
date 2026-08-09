# ARCHITECTURE.md

## Current status (Round 9, 2026-08-01)

This doc was written Day 1 as a forward-looking design. The system has since gone through 8
rounds of real iteration; the sections below still describe the correct high-level architecture,
with two corrections and one major addition:

- **License system is NOT "as-is" from GoBilling** (the reuse table below originally said so) —
  RaSetu built its own Supabase-hosted system: a single `licenses` table keyed by `machine_id`
  (simpler than GoBilling's separate device-bindings table), Ed25519-signed offline-verifiable
  tokens (30-day TTL, signed by `supabase/functions/_shared/jwt.ts`), and a 4-hour background
  re-validation pulse (`electron/main.ts`'s `runLicenseRevalidation()`, mirroring GoBilling's own
  interval and grace-day constants but implemented independently). See
  [COMMERCIAL.md](COMMERCIAL.md) for the licensing model this supports.
- **Auth/roles were substantially extended in Round 3**: PIN-based login, per-user permissions,
  Super Admin vs company-admin split (`backend/src/lib/auth-middleware.ts`,
  `src/components/pages/UsersPage.tsx`) — not present in the original Day-1 plan.
- **Multi-company storage is being extended in Round 9**: a single license can now own multiple
  companies, each with its own independently-chosen storage location (this machine's drive, or a
  removable/external drive) — see "Multi-company storage" below. This is new territory with no
  GoBilling precedent (GoBilling has no equivalent feature); it's modeled on Tally's multi-company
  pattern per the customer's own request.

Round-by-round feature summary (what actually shipped, not just what Day 1 planned):
Round 2 — UI/design token pass. Round 3 — PIN auth, roles, Users page. Round 4 — per-company
SQLite databases, license activation, sync worker. Round 5 — inline customer/item search in
billing, family-grouped parties. Round 6 — Draft/Held/Estimate invoice lifecycle, receipt
settings, bill-level discounts. Round 7 — Label Designer (WYSIWYG free-drag canvas), backup
system (local + Cloudflare R2 + Google Drive folder + external drive), license status card in
Settings. Round 8 — onboarding flow redesign (license → company-first picker → shop/profile/owner
wizard → login). Round 9 — infra audit, license grace messaging, multi-company portable storage,
this docs catch-up.

## Decision: Electron desktop + local-first sync + LAN mobile access

| Option | Verdict | Why |
|---|---|---|
| Pure web app (cloud) | Rejected for v1 | Browsers cannot send raw ZPL to TSC or ESC/POS to Epson. Indian shops have unreliable internet. Billing must never stop. |
| Pure offline desktop | Rejected | No multi-device, no mobile add-on revenue, no cloud backup story. |
| **Electron + SQLite local + Supabase sync + LAN PWA** | **Chosen** | Reuses GoBilling's printer bridge, licensing, auto-update, Express+Prisma backend. Offline-first by default; sync when online. |

**Updates:** GitHub Releases + electron-updater (proven in GoBilling — keep as-is).

## Sync design (v1 — deliberately minimal)

- Local SQLite is the source of truth for daily operation.
- A `SyncQueue` table logs every create/update/delete (row id, table, action, timestamp, synced flag).
- Background worker pushes the queue to Supabase (Postgres) when online; pulls remote
  changes by `updatedAt > lastSyncAt`.
- Conflict rule (fixed, non-negotiable): **last-write-wins by timestamp**, except
  invoices — a posted invoice is immutable (see [SCHEMA.md](SCHEMA.md)), so invoice conflicts cannot occur.
- **v1 scope is one-way push (backup to cloud) only.** Two-way multi-device sync is
  Phase 2. Sell "cloud backup included" now, "multi-branch sync" later.

## Mobile

- **v1:** same-WiFi access via the existing Vite/Express server on LAN — responsive
  pages for stock view, quick stock add, sales view. Free. This is a genuine
  differentiator vs Vyapar/Marg — lead with it in demos.
- **Phase 2:** remote mobile via Supabase-backed API, paid add-on (₹99–199/user/month).

## Platform strategy: one core, many verticals

Do not fork the codebase per vertical — that is what made the jewellery ERP
expensive to maintain. Instead:

- **Core engine (~90%):** company/party/item masters, stock, purchase, GST billing,
  payments, ledger, reports, printing, licensing, sync. Identical for every vertical.
- **Vertical Profile (~10%):** one JSON config per business type
  (`config/profiles/profile-<vertical>.json`) controlling:
  - Item attribute set (cloth: size/color/brand/fabric; hardware: brand/model/unit; steel: weight/gauge/length)
  - Unit types (PCS, MTR, SET, KG, BOX) and whether decimal qty is allowed
  - Default HSN groups and GST rates (cloth: 5% below ₹1,000 MRP / 12% above; hardware/electronics: mostly 18%; steel: 18%)
  - Label template defaults and barcode content
  - Terminology ("Design No." vs "Model No." vs "Grade")

This mirrors the WhatsApp Provider Profile JSON pattern already proven in GoBilling.
Cloth store v1 ships with `profile-cloth.json`. Selling to a hardware shop later means
a new profile file + testing — not new code.

## What is reused from GoBilling (`C:\GoBilling\GoBilling\gobilling-erp`)

| GoBilling asset | Reuse in RaSetu | Notes |
|---|---|---|
| Electron shell, NSIS installer, auto-updater, GitHub Releases pipeline | As-is | `electron/main.ts`, `electron-builder.yml` |
| Express + Prisma + SQLite backend pattern | As-is, new schema | `backend/src/app.ts`, `backend/src/index.ts`, `backend/src/db/client.ts` |
| License concept (Supabase Edge Functions, machine ID, offline grace, pulse re-check) | Adapted, own schema | `electron/license-verify.ts` — RaSetu's own `licenses` table + Ed25519 tokens, not GoBilling's tables. See "Current status" above. |
| TSC printer bridge (`gb:printer-print-raw` IPC, ZPL, Direction=0, 648 dots width) | As-is | `electron/printer-driver.ts`, `electron/printer-api.ts` |
| Module licensing (`hasModule()` hook, sidebar guards, MODULE_REGISTRY tree-shaking) | As-is | see [COMMERCIAL.md](COMMERCIAL.md) |
| Shared lib helpers: async-handler, audit-log, auth-middleware, jwt, password, http-error | As-is | `backend/src/lib/` |
| InvoiceGST page structure (customer select, item rows, GST table, payment modes, drafts) | Adapted | remove purity/HUID/old-gold, add size/color/MRP, add inclusive-of-GST mode |
| Label Designer presets + print queue | v1: templates + settings only, no drag-and-drop | `electron/label-templates.ts` as starting point |
| SetupWizard, CustomerMaster, SupplierMaster, Dashboard, Sidebar patterns | Adapted | |
| Coding rules (inline styles, no cross-page imports, defaultValue+onBlur, lucide-react, en-IN formatting) | As-is | formalized in [RULES.md](RULES.md) |

**Not reused (jewellery-specific, left behind):** girvi, karigars, chit-tracker,
bullion-tracker, old-gold, hand-loans, rent-tracker, salary-accounts, borrowings,
jewellery-accounting. None of these map to retail v1 scope.

## Multi-company storage (Round 9)

One license key can own multiple companies (unlimited — see [COMMERCIAL.md](COMMERCIAL.md)),
Tally-style: each company has its own fully separate database and records, never connected to
another company's data, and every company has identical features. This has no GoBilling
precedent (confirmed by grepping GoBilling's codebase for removable-drive/multi-company
handling — nothing exists there); it's modeled on Tally's multi-company pattern per the
customer's own request, not ported from anywhere.

**Storage choice, per company, fixed at creation:** "This computer" (default — unchanged
`<userData>/companies/<id>.db` formula, see `backend/src/db/company-registry.ts`) or a
removable/external drive, picked from `GET /system/drives` at creation time
(`SetupWizardPage.tsx`'s Shop Setup step). Relocating an existing company to a different drive
later is **not built** — see [PENDING.md](PENDING.md).

**Why drive letters aren't the identifier.** Windows drive letters aren't stable across
reboots/plug order (a pendrive can be `E:` today, `F:` tomorrow). `drivelist` (the npm package)
enumerates physical disks and their current mountpoints but — confirmed by inspecting its
actual output before committing to this design — does **not** expose a stable per-volume
identifier. The identifier actually used is PowerShell's `Get-Volume -DriveLetter X | UniqueId`
(a `\\?\Volume{guid}\` string tied to the formatted volume, not the drive letter), captured once
at company-creation time and stored as `Company.volumeId` (`backend/prisma/catalog/schema.prisma`).
Presence is re-checked every time by re-running this same lookup and matching on `volumeId`, never
by trusting a stored path — see `backend/src/lib/drives.ts` for the full reasoning and
`backend/src/lib/company-storage.ts` for the resolve-and-cache logic.

**Company visibility follows drive presence.** `GET /companies` (used by the shop-picker,
`SetupWizardPage.tsx`) only returns a company if it's internal, or external with its drive
currently plugged in — exactly the behavior requested: *"if this pendrive is not present then it
will not show xyz2 company to select."* Login routes (`auth.ts`, `auth-super.ts`) re-verify this
independently (`ensureCompanyStorageAvailable()`) so manual company-ID entry can't bypass it.

**License vs. data — two different things that both need to be present.** The *license* stays
machine-bound (see "Current status" above) regardless of where a company's *data* physically
lives. Moving a company's pendrive to a different PC does **not** transfer the license — that PC
needs its own valid activation before it can open the data at all. A shop owner with one license
and two companies (one on this PC, one on a pendrive) can only use the pendrive company on a
machine that itself has a valid RaSetu license.

**Drive removed mid-session** — verified against real hardware (2026-08-01, a real USB drive,
plugged/unplugged repeatedly). The backend responds with a distinct `DRIVE_DISCONNECTED` code
(`backend/src/app.ts`'s `isDriveDisconnectedError()`, plus a fast dedicated check in
`company-registry.ts`'s `getCompanyClient()` — see below); the frontend (`src/lib/api.ts`'s
`onDriveDisconnected` handler, wired in `App.tsx`) shows a blocking message rather than letting
pages keep failing silently against data that just went offline.

The hardware test caught two real bugs the design review alone couldn't have found, both fixed
the same day:
1. **Stale connection after reconnect.** A Prisma client opened against a volume that later
   disappeared doesn't self-heal once the drive comes back — every request kept failing with the
   same error until the whole backend process was restarted. Fixed by dropping the cached client
   (`resetCompanyClient()`) at every login/support-entry into an external company
   (`company-storage.ts`'s `ensureCompanyStorageAvailable()`, `auth-super.ts`'s enter route) — login
   is the natural choke point since it's the first real DB touch after a possible
   disconnect/reconnect cycle.
2. **Second disconnect lost the friendly message.** Once fix #1 started proactively dropping
   cached clients, a *second* disconnect (with no client cached yet) fell through
   `getCompanyClient()`'s original `fs.existsSync` check into a generic "Company not found" 404 —
   correct in the literal sense, but not routed through the nice drive-disconnected messaging.
   Fixed by tracking which company IDs are known to be external
   (`company-registry.ts`'s `knownExternalCompanyIds`, populated wherever a company resolves as
   external, never cleared) so `getCompanyClient()` can tell "never created" apart from "known
   external company, just not reachable right now" and respond with the right one of the two.

Residual known gap (documented, not fixed): if the backend process starts fresh while an external
company's drive happens to be unplugged, that company simply won't appear in `GET /companies` at
all (correct) — but if it's reached anyway via manual company-ID entry before ever being seen as
available in that process, `knownExternalCompanyIds` won't have learned about it yet and it'll get
the generic 404 instead of the friendly message once. Narrow edge case, doesn't affect the normal
shop-picker flow.

**Backups** (`electron/main.ts`'s `listCompanyDbFiles()`) enumerate companies via the backend's
`GET /companies` (which already resolves each company's current real path) instead of scanning a
fixed folder, falling back to the old internal-only directory scan if the backend can't be
reached — one destination failing must never block the others, same philosophy as the rest of the
Round 7 backup system.
