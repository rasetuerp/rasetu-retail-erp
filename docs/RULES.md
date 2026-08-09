# RULES.md — Non-negotiable coding rules

Committed Day 1. Formalized from what worked in GoBilling. Enforced for the whole sprint.

1. **Inline style objects only** — no Tailwind, no CSS frameworks.
2. **No cross-page imports** — every page declares its types inline.
3. **Number inputs:** `defaultValue` + `onBlur`, never `onChange`; hide spinners via CSS.
4. **Icons:** lucide-react only.
5. **Formatting:** currency via `toLocaleString('en-IN')`, 2 decimals. Qty: 3 decimals
   max, display controlled by the vertical profile (see [ARCHITECTURE.md](ARCHITECTURE.md)).
6. **Every DB write goes through the API layer** — no direct SQLite access from the renderer.
7. **Every mutation writes `AuditLog` + `SyncQueue` entries** — one shared helper wraps all three; never write them separately.
8. **Every list/report page uses the shared export toolbar** (`exportUtils.ts`, built Day 3) — no custom export code anywhere else.
9. **New feature requests → [PHASE2.md](PHASE2.md)**, with date, requester, estimate. Never into the sprint.
10. **Schema changes after Day 1 require stopping and re-planning** — treat as an incident, not a tweak. The schema in [SCHEMA.md](SCHEMA.md) / `backend/prisma/schema.prisma` is frozen. In practice this means: log the change in [SCHEMA.md](SCHEMA.md)'s dated "Schema changes after Day 1" section (see Round 5/7 entries) — never silently edit the model with no record.
11. **One page = one file** — `App.tsx` MainApp + PageContent + `setActiveTab` pattern (as in GoBilling).
12. **Daily end-of-day:** commit, build installer, smoke-test billing + one thermal print.
13. **Cloud storage (R2) access is always license-gated, credential-scoped, and quota-capped —
    never loosen any of these three without a deliberate, documented decision:**
    - **License-gated:** `supabase/functions/backup-upload/` must always verify a valid,
      usable license (`checkLicenseUsable()`) before issuing an R2 presigned URL. Never make
      this endpoint (or any future one touching R2) reachable without that check — it's the
      only thing standing between the public internet and our storage bill.
    - **Credential-scoped:** the R2 API token used by `backup-upload` must be scoped to
      *only* the `rasetu-backups` bucket, never account-wide — created via Cloudflare's R2
      API token UI with a bucket-specific scope, not a global token. R2 credentials are Edge
      Function secrets only; they must never ship inside the desktop app or any client code.
    - **Quota-capped, in code, not just by convention:** `MAX_BYTES_PER_MACHINE` (200MB per
      backup file) and `MAX_TOTAL_BYTES_PER_LICENSE` (500MB total across every company one
      license owns, added Round 9 once multi-company-per-license made per-company retention
      alone insufficient — see `backup-upload/index.ts`) must both stay enforced server-side.
      Raising either number is a deliberate pricing/risk decision — log it here with the date
      and reason, don't just bump the constant.
    - **Cloudflare's Budget Alert is monitoring, not protection** — it emails you past a
      spend threshold but does not stop billing or usage. It's a useful early-warning
      backstop (set one — see `docs/DEPLOY.md`), but the actual protection is the three
      points above. Never treat a Budget Alert as a substitute for the code-level caps.

    **Why:** added Round 9 (2026-08-01) after the user raised a concrete worry — Cloudflare R2
    autopay is tied to a real payment method with no hard spending cap, and Round 9's new
    unlimited-companies-per-license feature removed the implicit ceiling per-company
    retention used to provide. A leaked license key or a bug must have a known, small
    maximum cost, not an unbounded one.

    **Change log:**
    - 2026-08-01 — `MAX_TOTAL_BYTES_PER_LICENSE` set to 2GB initially, then revised down to
      **500MB the same day** after the user questioned whether 2GB was too generous. Reasoning
      that held up: a single backup file is already capped at 200MB and only the newest 7 per
      company are kept, but a *real* shop's SQLite backup is typically a few MB to a few tens
      of MB — nowhere near that ceiling — so even a customer with 5+ companies stays
      comfortably under 500MB in legitimate use. 500MB still gives ~15–25x headroom over
      realistic usage while cutting worst-case abuse cost by 4x versus 2GB. Local backups are
      unaffected either way (this cap only limits the cloud copy) — don't take that safety net
      into account when second-guessing this number, i.e. don't loosen it just because "worst
      case the customer still has local backups."

14. **Docs are updated in the same round as the change, not as later cleanup.** Any round that
    changes schema, architecture, licensing, or a user-facing flow updates the relevant doc(s)
    before that round is considered done — [SCHEMA.md](SCHEMA.md)'s dated append-log is the model to
    follow (append a dated entry, don't rewrite history). Deliberately deferred features/decisions
    go in [PENDING.md](PENDING.md) so they're tracked, not lost. This exists so a future session (AI
    or human) can read [RULES.md](RULES.md) + [ARCHITECTURE.md](ARCHITECTURE.md) + [SCHEMA.md](SCHEMA.md)
    + [PENDING.md](PENDING.md) and know the *actual current state* before building anything new —
    added Round 9 after 8 rounds of real feature work left every doc except SCHEMA.md untouched
    since Day 1.

15. **AI review and implementation must be phase-scoped.** Before an AI-assisted implementation
    round edits code, it must read the minimal current-state docs listed in
    [AI_REVIEW_AND_GROWTH_PLAN.md](AI_REVIEW_AND_GROWTH_PLAN.md), state the exact phase/scope, and
    avoid generated/build/vendor folders unless the task explicitly requires them. Unrelated
    discoveries go to [PENDING.md](PENDING.md), not into drive-by code changes. This exists to save
    future sessions from wasting tokens on stale sprint text, generated files, or unrelated
    refactors.

16. **Deployment readiness is a gate, not a feeling.** Do not call a build "deployment ready"
    unless the release gates in [AI_REVIEW_AND_GROWTH_PLAN.md](AI_REVIEW_AND_GROWTH_PLAN.md) pass
    or each exception is explicitly documented and accepted. At minimum, check frontend build,
    backend build, Electron TypeScript build, lint, production dependency audit, installer build,
    and the required manual smoke tests for license, company, billing, printing, backup, and any
    storage mode touched by the round.

## Why these exist

Rules 6–8 exist because retail billing is a GST compliance surface — every write
needs to be traceable and exportable, and building that per-page instead of once
is the single biggest way to blow the 10-day budget. Rules 9–10 exist because scope
and schema churn were the #1 hidden time-killers in the jewellery ERP (every schema
change breaks pages downstream). Rules 1–5, 11 exist purely for velocity and
consistency across a large page count built fast. Rule 13 exists because Cloudflare R2's
autopay has no hard spending cap — a leaked license key or a bug must have a known, small
maximum cost, not an unbounded one (see the rule itself for the full reasoning). Rule 14
exists because the "10-day sprint" framing this doc set was written under was superseded by
an ongoing round-by-round build (see [SPRINT_PLAN.md](SPRINT_PLAN.md)'s status note) — without
an explicit rule, docs drift stale exactly like they did between Day 1 and Round 9.
Rules 15â€“16 exist because long-running AI work needs a stable context path and a hard release
definition; otherwise every future session rediscovers the same structure, reads generated files,
and risks declaring readiness after only a partial build.

## Note on this doc set's original framing

This RULES.md/SCOPE.md/SPRINT_PLAN.md/COMMERCIAL.md/DEPLOY.md set was written Day 1 for a
literal 10-day single-customer sprint. The project instead became an ongoing iterative build
("Rounds"). The coding rules above (1–8, 11) still hold as-is. Where a doc's *content* (not its
rules) describes something that shipped differently than planned, look for a "Current status"
note near the top of that doc — added Round 9 — rather than trusting the original Day-1 text
literally.
