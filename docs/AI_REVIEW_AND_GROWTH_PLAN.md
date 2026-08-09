# AI_REVIEW_AND_GROWTH_PLAN.md

Last reviewed: 2026-08-08

Purpose: give humans and AI agents a stable, phase-wise way to review, plan, and grow RaSetu without wasting time on unrelated files, stale sprint assumptions, or unsafe release claims.

This is a documentation and readiness review only. It does not authorize code changes by itself. Implementation must happen in later phases with a small written scope, validation commands, and updated docs in the same round.

## Phase 0 - Read first, edit last

Before any AI or human changes code, read these files in order:

1. `README.md` - product summary and documentation map.
2. `docs/RULES.md` - non-negotiable engineering and documentation rules.
3. `docs/ARCHITECTURE.md` - current architecture, local-first model, licensing, multi-company storage.
4. `docs/SCHEMA.md` - data model and dated schema change log.
5. `docs/PENDING.md` - deferred technical decisions and known gaps.
6. `docs/PRODUCT_REVIEW.md` - page-by-page product audit and competitive gaps.
7. `docs/DEPLOY.md` - build, release, license, printer, and on-site checklist.

Do not read `node_modules`, `backend/node_modules`, `dist`, `dist-electron`, `backend/dist`, generated Prisma clients, logo output folders, or binary database files unless the task explicitly requires them.

## Phase 1 - Application structure review

| Area | Purpose | Important paths |
|---|---|---|
| Desktop shell | Electron window, backend process, updater, native backup and printer IPC | `electron/main.ts`, `electron/preload.cts`, `electron/printer-api.ts`, `electron/printer-driver.ts` |
| Frontend | Vite + React single-page ERP UI | `src/App.tsx`, `src/components/pages/*`, `src/lib/*` |
| Local backend | Express API, auth, per-company Prisma access, reports, mutation logging | `backend/src/app.ts`, `backend/src/routes/*`, `backend/src/lib/*`, `backend/src/db/*` |
| Data model | Catalog DB plus one SQLite DB per company | `backend/prisma/catalog/schema.prisma`, `backend/prisma/company/schema.prisma` |
| Cloud functions | License activation/validation, password reset support flow, sync push, R2 backup upload | `supabase/functions/*` |
| Product docs | Scope, architecture, schema, deploy, pending work, product audit | `docs/*` |

Observed model:

- The app is local-first. Daily billing must continue even when internet is unreliable.
- The Electron main process starts a local backend and owns native capabilities: printer bridge, backups, license snapshot, updater.
- The renderer must not access SQLite directly. It talks to the backend through `src/lib/api.ts`.
- The backend uses a catalog SQLite database for company discovery and a separate SQLite database per company for operational data.
- Supabase is used for licensing, backup upload authorization, password reset verification, and one-way sync/backup flows.

## Phase 2 - Development model review

Current commands verified on 2026-08-08:

| Command | Result | Meaning |
|---|---|---|
| `npm run lint` | Passed with 21 warnings | No lint errors, but React hook/purity warnings need cleanup before tightening CI |
| `npm run build` | Passed | Frontend TypeScript/Vite production build works |
| `npm --prefix backend run build` | Passed | Backend TypeScript build works |
| `npm run preelectron` | Passed | Electron TypeScript build works |
| `npm audit --omit=dev --audit-level=moderate` | Failed | Root production dependency audit reports moderate/high/critical issues |
| `npm audit --omit=dev --audit-level=moderate` in `backend` | Failed | Backend production dependency audit reports high `xlsx` issues |

Important gap: root `npm run build` does not build the backend or Electron. Deployment readiness must use the wider validation set in this document, not only root `npm run build`.

## Phase 3 - Safety and security review

High-priority findings:

1. Dependency audit is not clean.
   Root audit reports vulnerable `dompurify` through `jspdf`/`jspdf-autotable`, vulnerable `js-yaml`, and vulnerable `xlsx`. Backend audit reports vulnerable `xlsx`. `xlsx` currently has no audit fix available, so the future fix may need dependency replacement, strict import validation, file-size limits, or isolated parsing rules.

2. Backend binds to `0.0.0.0` and uses open `cors()`.
   This may be intentional for LAN mobile access, but it needs a documented threat model and production rule: allowed origins, LAN exposure expectations, token handling, and whether LAN clients are officially supported in v1.

3. Session tokens are stored in frontend `localStorage`.
   This is common for an Electron/local app, but it raises the impact of any XSS or renderer injection. Because PDF/HTML/export libraries are present and `innerHTML` is used in label barcode preview, dependency XSS issues matter more than usual.

4. Electron security baseline is partly good but incomplete in docs.
   Good: `contextIsolation: true`, `nodeIntegration: false`, narrow preload bridge. Needs explicit release rule: never add broad IPC channels, never expose filesystem primitives directly to the renderer, validate IPC payloads in main/backend before filesystem or printer actions.

5. Backup and license protections are already documented and should remain hard gates.
   R2 uploads are license-gated and capped in `supabase/functions/backup-upload/index.ts`. R2 credentials are Edge Function secrets, not app-bundled secrets.

6. No automated test suite is declared.
   Current confidence comes from TypeScript/lint/build plus manual smoke tests. For long-term AI-safe growth, add focused tests around GST math, invoice posting/cancel/return, stock movements, backup restore, auth permissions, and drive disconnect handling.

## Phase 4 - Documentation gaps to close

| Missing doc/rule | Why it matters | Suggested owner file |
|---|---|---|
| Deployment readiness checklist | Prevents saying "ready" after only a frontend build | `docs/DEPLOY.md` plus this doc |
| Security threat model | LAN backend, Electron bridge, local token storage, backups, cloud functions need shared assumptions | New `docs/SECURITY.md` in a future phase |
| Test strategy | No clear testing pyramid or required smoke cases | New `docs/TESTING.md` in a future phase |
| Environment setup | Required `.env` values and which secrets are safe to ship are spread across code/docs | New `docs/ENVIRONMENT.md` in a future phase |
| AI working rules | Future agents need a minimal context path and explicit no-go folders | `docs/RULES.md`, this doc |
| Release evidence template | Each release should record commands run, audit result, installer path, printer smoke, license smoke | `docs/DEPLOY.md` or new release notes file |

## Phase 5 - AI-safe implementation rules

Use this sequence for every future implementation round:

1. State the phase and exact scope before editing.
2. Read only the relevant docs and source files listed above.
3. Confirm whether schema, licensing, security, backup, GST, printer, or deployment behavior is touched.
4. If schema changes are needed, stop and update `docs/SCHEMA.md` with a dated entry before implementation is considered complete.
5. If a user-facing flow changes, update the relevant product/training/deploy doc in the same round.
6. If a security-sensitive surface changes, update or create `docs/SECURITY.md`.
7. Run the smallest meaningful validation first, then the deployment gates if release is requested.
8. Record unresolved items in `docs/PENDING.md`; do not leave them only in chat.
9. Do not claim deployment readiness unless all required gates pass or the exceptions are explicitly documented and accepted.

## Phase 6 - Deployment readiness gate

As of 2026-08-08, this project is not fully deployment ready because production dependency audit fails.

Minimum gate before customer deployment:

- `npm run lint` has zero errors. Warnings must either be fixed or accepted in release notes.
- `npm run build` passes.
- `npm --prefix backend run build` passes.
- `npm run preelectron` passes.
- `npm audit --omit=dev --audit-level=moderate` passes, or each finding has a documented mitigation and explicit owner acceptance.
- Backend `npm audit --omit=dev --audit-level=moderate` passes, or each finding has a documented mitigation and explicit owner acceptance.
- Full installer command is run before release: `npm run build:electron`.
- Manual smoke tests pass: license activation/startup/offline grace, create/open company, login/PIN/login expiry, create item/party/invoice, post invoice and verify stock/ledger/GST totals, print thermal receipt and label, local backup and restore, external-drive company behavior if used, and cloud backup if enabled.

## Phase 7 - Recommended implementation order

1. Security/dependency phase: decide on `xlsx` mitigation or replacement, upgrade/fix `js-yaml`, review `jspdf`/`jspdf-autotable` and DOMPurify exposure, and document LAN/CORS threat model.
2. Deployment discipline phase: expand `docs/DEPLOY.md` with the release gate from this doc, add a release evidence template, run `npm run build:electron`, and record output path.
3. Test foundation phase: add tests for GST calculation, invoice lifecycle, stock movement, permissions, and backup restore.
4. Product gap phase: start with `docs/PENDING.md` top items: invoice/report date filters, label batch printing/search, Label Designer undo/redo and unsaved guard.
5. Growth phase: add new vertical profiles only after profile-specific acceptance tests exist. Keep core engine shared; avoid per-vertical forks.

## Current verdict

The app has a coherent architecture and the core compile checks pass. It should not be called deployment ready today because production dependency audit fails and the full installer build/smoke checklist was not completed in this review.

The next safe milestone is: close or formally accept dependency/security findings, add the missing security/deployment docs, then run the full `build:electron` and manual smoke gate.
