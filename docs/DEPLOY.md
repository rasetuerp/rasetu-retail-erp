# DEPLOY.md — Build, Release, License, Printer Calibration

## Current status (Round 9, 2026-08-01) — infra config checklist

These are the concrete open items found this round comparing RaSetu's config against GoBilling's.

- [x] **Supabase account mismatch — resolved by decision (2026-08-01).** The Supabase MCP connector
  stays connected to the "GoBilling" account; the user chose to handle any Supabase-side changes
  manually (dashboard or `npx supabase` CLI logged into their own `rasetuerp` account) rather than
  reconnect Claude's connector. RaSetu's actual project (`doopelkfucwiogrylysj`) confirmed live and
  owned by the `rasetuerp` account. Not an open item — this is the intended setup going forward.
- [x] **GitHub release repo confirmed (2026-08-01).** Real account is `rasetuerp` (not `Rasetu` —
  `electron-builder.yml` was wrong and has been corrected). Repo `rasetu-retail-erp-updates` exists
  under that account, public, empty. `publish: { provider: github, owner: rasetuerp, repo:
  rasetu-retail-erp-updates }`.
- [x] **Cloudflare R2 configured (2026-08-01).** Bucket `rasetu-backups` created under the user's
  existing Cloudflare account (same account as GoBilling's buckets, kept separate via a
  bucket-scoped API token — see [RULES.md](RULES.md) #13). Secrets (`R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`) set in Supabase; `backup-upload`
  function deployed via `npx supabase functions deploy backup-upload` (CLI logged into the
  `rasetuerp` account, project linked with `--project-ref doopelkfucwiogrylysj`). A Cloudflare
  Budget Alert was also set as an early-warning backstop (monitoring only, not a hard cap — see
  RULES.md #13 for why that distinction matters).

## Build

```
npm run db:generate          # prisma generate
npm run db:migrate           # apply schema.prisma migrations (Day 1 only, then frozen)
npm run build:client-app     # tsc -b, backend build, vite build, electron preload build, electron-builder --dir
npm run build:electron       # full pipeline incl. lint:release, template DB, runtime services -> installer
```

Installer output: `release-customer/RaSetu-ERP-Setup-*.exe` (mirrors GoBilling's
`build:electron` pipeline — see `electron-builder.yml`).

## Release

- GitHub Releases + `electron-updater`, same pipeline as GoBilling.
- Version bump in `package.json`, tag, push — updater picks it up on next app launch.
- Daily end-of-day during the sprint: commit, build installer, smoke-test billing +
  one thermal print (RULES.md #12).

## License issue

- Trial keys: `RTL-TRIAL-...`, 15/30-day, generated via RaSetu's own Supabase Edge Functions
  (`supabase/functions/license-activate`, `license-validate` — see
  [COMMERCIAL.md](COMMERCIAL.md)'s "Current status" for the real (not GoBilling-identical) schema).
- Paid keys: bound to machine ID on first activation. Offline behavior (Round 9): soft grace for 7
  days (benign), hard warning with a named reconnect-by date up to the signed token's 30-day
  `validUntil`, then blocked until one successful online check-in.
- Module flags set per [COMMERCIAL.md](COMMERCIAL.md) at key-issue time.
- Round 9: a license can now own multiple companies (unlimited), each with its own storage
  location — see [ARCHITECTURE.md](ARCHITECTURE.md)'s "Multi-company storage" section.

## Printer calibration

**Do this at your own office before the Day-10 site visit — never debug printers at
the customer's shop for the first time.**

1. Confirm TSC model and label roll size with the customer on Day 0.
2. Test print all 3 label templates (small tag, medium tag, shelf label) at the
   confirmed roll size — check darkness, alignment, barcode scan-back.
3. Test print all 3 thermal receipt layouts on the Epson model in use.
4. Test print both A4/A5 GST invoice layouts.
5. Package known-good printer settings (darkness, Direction=0, dots width) into the
   Setup Wizard defaults so Day 10 on-site setup is just "select printer model."

## On-site Day 10 checklist

Install → printer calibration → masters import (from the Excel item list collected
Day 0) → staff training ([TRAINING.md](TRAINING.md)) → collect sign-off + setup fee →
leave the one-page cheat sheet.
