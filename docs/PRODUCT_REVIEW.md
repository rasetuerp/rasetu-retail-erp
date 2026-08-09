# PRODUCT_REVIEW.md — Round 13 full-app audit

A page-by-page review of every screen in RaSetu, done from three angles: what an experienced
Indian retail shop owner would actually ask before trusting the screen with their business, how
the feature would be pitched to them with an eye on what competing billing software (Vyapar, Marg
ERP, Zoho Books) already treats as table stakes, and what came out of it — fixed now vs. logged for
later. Quick fixes were implemented directly in the same round; deferred items are also logged in
[PENDING.md](PENDING.md) so future rounds have one place to pull from.

This is a living document — re-run this exercise whenever a page gets a significant rework, not
just once.

## Dashboard

**Shop owner asks:** "Can I tell at a glance if today was a good day, and is anything urgent I need
to act on right now?"

**Pitch:** Today's Sales (with a day-over-day trend arrow and a 7-day sparkline), Outstanding
balance, Low Stock count, an urgency-sorted Alerts panel (low stock + overdue parties, clickable
through to the party), and a Recent Activity feed merging invoices and payments.

**Gaps found:** No quick-action shortcuts to the most common tasks (new bill, new purchase, new
item) — Vyapar and Marg both lead their home screen with exactly this. No month-over-month
comparison (only day-over-day). No GST filing due-date reminder.

**Fixed now:** Added New Bill / New Purchase / New Item buttons next to the page title
(`src/App.tsx`'s `onNavigate` prop threaded through to `DashboardPage.tsx`).

**Deferred:** Month-over-month comparison view; GST due-date reminder banner (needs a due-date
rule per state/filing frequency — real scope, not a quick fix).

## GST Billing

**Shop owner asks:** "Can my cashier bill a walk-in customer in under 30 seconds, and can I trust
the tax math without checking it by hand?"

**Pitch:** Barcode/SKU/category/size/colour search-driven product grid, per-line rate/discount/GST%
override for admins, bill-level discount, Hold/Estimate/Post flows, thermal + A4/A5 printing with a
real on-screen preview before committing to paper, and an inline "+ Add new item" for stock that
hasn't been catalogued yet.

**Gaps found:** The inline add-item form was a thin, inconsistent subset of Item Master's fields
(no SKU auto-generation, no category picker, no HSN/barcode/GST-inclusive) — a cashier adding a new
product mid-sale produced a lower-quality catalog record than one added properly. No preview step
before either print — printing was a one-way trip to the printer/browser dialog.

**Fixed now:** Inline add-item form brought to full field parity with Item Master (SKU auto/manual
toggle, CategoryPicker, Brand, Unit, Purchase Rate, Min Stock, HSN, Barcode, GST inclusive, GST%
dropdown, collapsible advanced/legal-metrology details). Added a Preview step for both thermal and
A4/A5 printouts, rendering the actual printable output on-screen with Print now / Close.

**Deferred:** None significant — this page was already close to competitor parity; see
[PENDING.md](PENDING.md) for smaller polish notes if any turn up later.

## Invoice History

**Shop owner asks:** "If a customer disputes a bill from three months ago, can I find it in ten
seconds, and can I take a payment or process a return without leaving this screen?"

**Pitch:** Status-tab filtering (Posted/All/Estimates/Cancelled), number/customer search, full
line-item detail view, record-payment against a posted invoice with due-date editing, Sales Return
with per-line quantity capped at what was sold, Estimate→Invoice conversion, and printing (thermal
+ A4/A5) from the same detail view.

**Gaps found:** No pagination or date-range filter — a shop running for a year gets one
unpaginated table. No way to cancel a Posted invoice from this page (cancellation apparently isn't
reachable here at all). No CSV/Excel/PDF export (Reports has this, Invoices doesn't). Search only
fires on blur/Enter, not live.

**Deferred (all real scope, not quick fixes):** Date-range filter + pagination on the invoice list;
export buttons matching Reports' pattern; a Cancel-invoice action if one doesn't already exist
elsewhere in the flow — needs its own audit to confirm before building.

## Item / Stock Master

**Shop owner asks:** "When I add 'Cotton Shirt, Blue, size L' today, will next month's 'Cotton
Shirt, Blue, size M' get a SKU that's obviously part of the same family, without me having to
invent a numbering scheme myself?"

**Pitch:** SKU auto-generated as ShopCode-Category-Year-Serial via a searchable/creatable Category
picker, full field set (unit, rates, opening/min stock, HSN, barcode, GST%), a collapsible
legal-metrology block for label printing, and inline stock adjustment/edit per row.

**Gaps found:** The SKU field auto-filled on category pick but had no explicit lock — clearing it
after picking a category silently left it blank with no visual cue the auto-format was "off."
Duplicate SKUs (in the rare case of manual entry) fell through to a generic "record already exists"
error instead of naming the field.

**Fixed now:** Explicit Auto/Manual SKU toggle (Auto = read-only, filled from `/next-sku`; Manual =
freely editable, no auto-fill call). Backend now returns a specific "This SKU already exists in
this shop" message on collision.

**Deferred:** None new from this round's pass — this page's remaining gaps are already tracked
where they were found (see Bulk Stock Entry below for one shared with it).

## Bulk Stock Entry

**Shop owner asks:** "I just received 40 shirts in 5 sizes and 4 colours — can I onboard all of
them without typing the same brand/rate/GST 40 times?"

**Pitch:** Fill shared details once (category, brand, rates, GST, legal-metrology), generate N
rows, edit only what differs (SKU/size/colour/opening stock) per row, save in one transactional
call, then batch-print labels for the new items.

**Gaps found:** No HSN field at all (Item Master has one), and GST% was a plain free-typed number
instead of the same slab dropdown Item Master uses — same underlying data, inconsistent input
widgets across the two item-creation surfaces. Same SKU-auto-fill-without-a-lock gap as Item
Master.

**Fixed now:** Added HSN as a shared field (legitimate here — one HSN code typically covers a whole
batch of the same product type). Switched GST% to the same slab dropdown as Item Master. Added the
same Auto/Manual SKU toggle (Manual always uses the `${base}-${counter}` scheme and skips
`/next-sku` entirely). Deliberately did **not** add Barcode as a shared field — `Item.barcode` is
globally unique, so one shared value across N generated rows would fail on the second insert;
barcodes stay per-row/blank here, same as before (they're generated later via Label Designer).

**Deferred:** None new.

## Purchase Entry

**Shop owner asks:** "When a new supplier walks in with a bill, can I record them properly — GSTIN
and all — without stopping to go set them up in Parties first?"

**Pitch:** Supplier picker + inline quick-add, item search, per-line qty/rate editing, Purchase
Return (Debit Note) mirroring Invoice History's Sales Return pattern.

**Gaps found:** The inline "+ New supplier" quick-add only captured Name and Phone — a supplier bill
usually needs GSTIN for input-tax-credit records, and an opening balance if this supplier already
had outstanding dues before RaSetu was set up.

**Fixed now:** Quick-add now captures GSTIN, Address, and Opening Balance too, matching the fields
already on Parties & Ledger's own inline add-form (minus Credit Limit, which is a customer-facing
control, not part of this ask).

**Deferred:** None new.

## Parties & Ledger

**Shop owner asks:** "Can I see at a glance whether a regular customer is a good payer, without the
page being cluttered with numbers I don't check often?"

**Pitch:** Combined customer/supplier list + a per-party profile/ledger panel showing lifetime
value, invoice count, average bill, last visit, and a full debit/credit ledger.

**Gaps found:** Credit Limit was shown as a profile stat tile on the ledger panel even though it's
an input you set once and rarely reference day-to-day — it didn't belong next to the
activity-focused stats, and cluttered the panel.

**Fixed now:** Removed the Credit Limit stat tile from the ledger/profile panel. The field itself is
untouched everywhere it's actually used: the Add Party form, the Edit Party form, the backend
schema, and Billing's checkout warning banner when a bill would push a customer over their limit.

**Deferred:** None new.

## Reports & GST Pack

**Shop owner asks:** "When my accountant asks for last month's numbers, can I get them without
scrolling through my shop's entire history?"

**Pitch:** Eight report tabs (Sales, Stock, Reorder Suggestions, Stock Valuation, Outstanding aging,
GST Pack, Receipts & Vouchers, Dead Stock), every table with Print/Excel/PDF export.

**Gaps found:** No date-range filter on Sales/Payments reports — always all-time. GST month picker
was a free-text field (`placeholder="2026-07"`) inviting typos with no format validation. No
item/party filter on Sales.

**Fixed now:** GST month field switched from free text to a native month picker (matches the
existing `YYYY-MM` state format exactly, so no backend change needed).

**Deferred (real scope):** Date-range filter across Sales/Payments reports — this is the single
biggest gap vs. Vyapar/Marg for any shop older than a few months, and should be a priority next
round. Item/party filter on Sales. GSTR-1/GSTR-3B file-format export (current GST Pack is
informational, not filing-ready).

## Barcode Labels

**Shop owner asks:** "After a purchase entry, can I print labels for just the new stock without
hunting through every item in my catalog one at a time?"

**Pitch:** Template + item picker with a live scaled label preview, copies count, direct print via
the desktop bridge.

**Gaps found:** Only one item at a time — no batch flow on this dedicated page (Bulk Stock Entry has
its own batch-print step right after creation, but a shop wanting to reprint labels for existing
items later has no batch option here). Item picker is a plain alphabetical `<select>` with no
search — unusable once a catalog has hundreds of SKUs.

**Deferred (real scope):** Multi-select + batch print on this page; search/filter on the item
picker. Both are meaningful UI work, not a one-line fix — logged for next round.

## Label Designer

**Shop owner asks:** "If I spend twenty minutes designing a label and my hand slips while dragging
an element, do I lose all of it?"

**Pitch:** Full WYSIWYG canvas — drag-position text/barcode/QR/line/rectangle elements, bind them to
item/company fields, size presets, font/align controls, template CRUD with a confirmation dialog
before delete, live preview against a real item.

**Gaps found:** No undo/redo. No "unsaved changes" warning when switching templates or navigating
away. No z-order controls when elements overlap. No arrow-key nudge for fine positioning.

**Deferred (real scope):** Undo/redo and an unsaved-changes guard are the two that matter most (data
loss risk); z-order and keyboard nudge are polish. None are safe to bolt on as a one-line quick fix
given the canvas's existing drag-state management — logged for a dedicated pass.

## Team & Access

**Shop owner asks:** "If I hire someone new, can I give them exactly the access I want, and if
things don't work out, can I lock them out immediately without losing their sales history?"

**Pitch:** Add staff with per-tab permission checklist, deactivate (not delete — preserves who-sold-
what history), password reset / PIN clear, inline permission editing.

**Gaps found:** Deactivate had no confirmation dialog despite being a real access-locking action —
inconsistent with Label Designer's own delete-confirmation precedent elsewhere in the app. No
username-availability check while typing (only surfaces as an error after full submit).

**Fixed now:** Deactivate now asks for confirmation before proceeding (Reactivate doesn't, since
it's not destructive).

**Deferred:** Live username-availability check — minor, not a data-risk issue, lower priority.

## Settings

**Shop owner asks:** "If I rename a field or delete a category I don't use anymore, am I about to
break something on items I already have in stock?"

**Pitch:** Six sections (now seven) via a left sub-menu — Shop Profile, Item Fields & Categories,
Billing & Receipts, License, Account & Security, and the new Help & FAQ.

**Gaps found:** Category "Remove" and custom Item Field "Remove" both deleted immediately on click
with **no confirmation dialog** — a real data-loss risk for a misclick, and inconsistent with Label
Designer's own template-delete confirmation elsewhere in the app.

**Fixed now:** Both now confirm before deleting, with copy that explains the actual (mild)
consequence — existing items keep their data either way, they just stop being pickable/showing on
new-item forms.

**Deferred:** No audit/history of settings changes (who changed the invoice prefix, when) — real
scope, logged for later if it becomes a real support pain point.

## Setup Wizard (pre-login)

**Shop owner asks:** "If I forget my password on a Monday morning with a shop full of customers,
how fast can I get back in?"

**Pitch:** Company-first login (skips the picker when there's only one shop), password or 4-digit
PIN login, a guided new-shop wizard (storage picker → profile → owner account → optional PIN
setup), and a self-service Forgot Password/PIN flow (submit a request online, RaSetu support
issues a code, redeem it — no live call needed at redemption).

**Gaps found:** The forgot-password flow requires an asynchronous human review step (submit →
wait for support to issue a code) rather than an instant self-service reset — a real UX gap
against mainstream software's "we emailed you a link" flow, though a deliberate tradeoff given
this app's offline-first, no-email-on-file design (see Round 12's design decision).

**Deferred:** Instant self-service reset (e.g. email/SMS OTP) would need the app to collect and
verify a recovery contact at signup, which is a genuine product decision, not a quick fix — flagged
for the PM summary below, not built this round.

---

## Summary: what's fixed vs. what's next

**Fixed this round (13 changes across 8 pages):** Dashboard quick actions; Billing print preview +
inline add-item field parity; Item Master / Bulk Stock Entry / Billing SKU auto-manual lock +
duplicate-SKU error message; Bulk Stock Entry HSN + GST dropdown; Purchase Entry supplier
GSTIN/address/opening-balance; Parties ledger credit-limit tile removed; Reports GST month picker;
Settings category/field delete confirmations; Team & Access deactivate confirmation; the new Help &
FAQ system itself.

**Deferred — see [PENDING.md](PENDING.md) for the technical detail on each:**
1. Date-range filtering on Invoice History and Reports (Sales/Payments) — the single most
   competitively-important gap found this round.
2. Batch label printing + item search on the Barcode Labels page.
3. Undo/redo and an unsaved-changes guard on Label Designer.
4. GSTR-1/GSTR-3B filing-ready export (current GST Pack is informational only).
5. Self-service (non-support-mediated) password reset — a deliberate current tradeoff, worth
   revisiting as a product decision, not a bug.
6. Settings change audit/history.
