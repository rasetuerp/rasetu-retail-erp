# PHASE2.md — Change Request Register

Every new request that comes in during or after the sprint goes here, not into the
build. Standard response to the customer: *"Noted, added to Phase 2 — you'll have
it in the first monthly update."* The auto-updater makes this credible.

For granular, technical deferred-decision tracking (e.g. "not building X this round, revisit
later"), see [PENDING.md](PENDING.md) instead — this doc is for customer-facing feature requests.

## How to log a request

| Date | Requester | Request | Estimate | Priced? | Status |
|---|---|---|---|---|---|

## Shipped since this doc was written (remove from backlog below)

- ~~Drag-and-drop label designer~~ — **shipped Round 7** as `LabelDesignerPage.tsx`, a full WYSIWYG
  free-drag canvas (not a port of GoBilling's — GoBilling's own designer was judged architecturally
  inadequate per its own `docs/PRINT_DESIGNER_STATUS.md`, so RaSetu's was built independently).
- ~~Drag-and-drop receipt/A4 layout designer~~ — **shipped Round 7** as the thermal receipt section
  designer (same round as the label designer).

## Known Phase 2 backlog (the upsell menu)

- Loyalty redemption + tiers
- Customer follow-up/marketing CRM module
- WhatsApp integration (port the provider-agnostic engine)
- Two-way multi-device sync
- Remote mobile app (paid add-on, ₹99–199/user/month)
- Salesman-wise commission
- Size-color matrix grid entry
- E-invoice / E-way bill
- Hardware / electronics / steel vertical profiles
- Tally XML export (already researched for GoBilling)

## Rule

New feature requests are **never** added to the current sprint. Log here with date,
requester, and estimate — then price it and schedule it as a post-go-live update.
Schema changes specifically follow the stricter rule in [RULES.md](RULES.md) #10.
