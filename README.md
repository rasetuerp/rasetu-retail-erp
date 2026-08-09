# Rasetu Retail ERP (RetailBilling by Rasetu)

Cloth store v1, generic retail later. Electron desktop app, SQLite local-first,
Supabase cloud backup, LAN mobile access. Built by porting proven infrastructure
from GoBilling (`C:\GoBilling\GoBilling\gobilling-erp`) — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for what was reused and why.

**Delivery commitment:** 10 days for Cloth Store v1 (see [docs/SPRINT_PLAN.md](docs/SPRINT_PLAN.md)).

## The one rule that governs everything else

Scope grows *while* building — that's what delayed the jewellery ERP. Three freezes
fix it, and they override every other decision in this repo:

1. **Scope Freeze** — v1 list in [docs/SCOPE.md](docs/SCOPE.md) is frozen. New requests go to
   [docs/PHASE2.md](docs/PHASE2.md), not the sprint.
2. **Schema Freeze** — [backend/prisma/schema.prisma](backend/prisma/schema.prisma) is finalized Day 1.
   No schema changes during the sprint (see [docs/SCHEMA.md](docs/SCHEMA.md)).
3. **Template-First** — 3 fixed receipt layouts, 3 fixed label templates, a settings panel.
   No drag-and-drop builder in v1 (that's a Phase 2 port).

## Documentation map

| Doc | Purpose |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Structure plan: why Electron+SQLite+Supabase, vertical-profile strategy, what's reused from GoBilling |
| [docs/SCOPE.md](docs/SCOPE.md) | The frozen v1 feature list |
| [docs/PHASE2.md](docs/PHASE2.md) | Change-request register / upsell pipeline |
| [docs/RULES.md](docs/RULES.md) | Coding rules — non-negotiable, enforced from Day 1 |
| [docs/SCHEMA.md](docs/SCHEMA.md) | Data model + document lifecycle (edit/cancel/delete) rules |
| [docs/GST-SPEC.md](docs/GST-SPEC.md) | GST Report Pack sheet-by-sheet spec |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Build, release, license issue, printer calibration |
| [docs/TRAINING.md](docs/TRAINING.md) | Day-10 staff training script + cheat sheet |
| [docs/SPRINT_PLAN.md](docs/SPRINT_PLAN.md) | Day-by-day step-by-step build guide |
| [docs/COMMERCIAL.md](docs/COMMERCIAL.md) | Licensing/pricing model |
| [docs/AI_REVIEW_AND_GROWTH_PLAN.md](docs/AI_REVIEW_AND_GROWTH_PLAN.md) | Phase-wise review plan, AI-safe working rules, documentation gaps, deployment readiness gate |

## Repo layout

```
RaSetu/
├── electron/              # main.ts, preload, printer-driver, license-verify — ported from GoBilling
├── backend/
│   ├── src/
│   │   ├── routes/        # one file per resource (parties, items, invoices, ...)
│   │   ├── validation/    # zod/schema validators per resource
│   │   ├── lib/           # audit-log, async-handler, auth-middleware, jwt, password, http-error
│   │   ├── db/            # prisma client singleton
│   │   └── app.ts, index.ts
│   └── prisma/schema.prisma
├── src/                    # React/Vite frontend, one page = one file (see RULES.md #11)
│   └── components/pages/
├── config/profiles/        # vertical profile JSON configs (profile-cloth.json first)
├── scripts/                 # build/release helper scripts
└── docs/
```

## Current status

Day 1 scaffold: folder structure, documentation set, Prisma schema, cloth vertical
profile, and infra ported from GoBilling (electron shell, backend bootstrap, shared
lib helpers). Business-logic routes are stubbed with TODOs mapped to the v1 scope —
see [docs/SPRINT_PLAN.md](docs/SPRINT_PLAN.md) Day 2 onward for what fills them in and in what order.
