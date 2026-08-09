# COMMERCIAL.md — Licensing & Pricing Model

## Current status (Round 9, 2026-08-01)

The license system actually built (Round 4, hardened Round 7) is RaSetu's own — not a direct
reuse of GoBilling's tables, though the mechanics are deliberately similar. See
[ARCHITECTURE.md](ARCHITECTURE.md)'s "Current status" section for the correction. Key facts:
Supabase-hosted `licenses` table keyed by `machine_id`; Ed25519-signed offline-verifiable tokens
(30-day TTL); a 4-hour background re-validation pulse while the app runs
(`electron/main.ts`'s `runLicenseRevalidation()`); user-facing offline-grace messaging (soft
grace within 7 days, hard warning with a reconnect-by date beyond that, block at token expiry)
added Round 9 to match GoBilling's own `offlineStatus()` messaging pattern.

**Round 9 addition — multi-company per license:** a single license key can now own multiple
companies (unlimited, no cap), each with its own independently-chosen storage location. See
[ARCHITECTURE.md](ARCHITECTURE.md)'s "Multi-company storage" section. Pricing-wise this is a genuine
upsell lever for later (e.g. a future per-company or per-storage-type add-on) but ships **unlimited
and unmetered** this round per the product decision — do not add a company-count license check
without a corresponding pricing/product decision first.

Configure in licensing from Day 1 (see [ARCHITECTURE.md](ARCHITECTURE.md) for the reused
GoBilling license system: Supabase Edge Functions, machine ID binding, 7-day grace
period, DEMO keys).

- **Trial:** 15 or 30-day key (`RTL-TRIAL-...`), full features, "Trial" watermark on printouts.
- **License key prefix convention (Round 10):** RaSetu is one of several Ratan Business Solutions
  products (GoBilling is another, separate codebase, its own `licenses` table). `license_key` has
  no format constraint or per-prefix logic in the DB or the edge functions — activation matches the
  key string exactly, nothing parses the prefix — so this is a naming convention only, not
  enforced code:
  - `RTL-...` — RaSetu-specific keys (what Round 4 originally issued; the seeded dev/test key is
    `RTL-TRIAL-DEV0-0001`).
  - `RBS-...` — Ratan Business Solutions umbrella keys: bundles, resellers, or future products not
    tied to one specific app. Activates RaSetu the same way an `RTL-` key does (same `licenses`
    row shape, same `checkLicenseUsable()` checks) — the prefix carries no different behavior yet,
    it only signals origin for support/reporting purposes when issuing keys by hand.
  - Both are accepted by `src/App.tsx`'s `LicenseGate` (the placeholder shows one `RTL-` example;
    a caption underneath notes `RBS-` also works).
- **Pricing structure** (encode as flags in the Supabase license record; amounts adjustable):
  - One-time setup fee (installation, masters import, label calibration, training)
  - Monthly / Annual subscription (annual = 10× monthly)
  - Annual AMC for one-time-license customers (support + updates)
  - Per additional user/terminal charge
  - Module-wise flags: `stock`, `labels`, `billing`, `purchase`, `reports`, `gst`, `mobile` — reuse the existing `hasModule()` system
  - Mobile remote access add-on (Phase 2, ₹99–199/user/month); same-WiFi mobile is free in v1 — a genuine differentiator vs Vyapar/Marg, lead with it in demos
- Revenue logic (reused from GoBilling): setup fees fund the sprint; subscriptions
  build the base toward a 50–80 active customer stability threshold.
