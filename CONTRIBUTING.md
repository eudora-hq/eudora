# Contributing to Eudora

Thank you for your interest in contributing. This document explains how to get started.

## Development setup

```bash
git clone https://github.com/eudora-hq/eudora.git
cd eudora
npm install && cd server && npm install && cd ..
cp .env.example server/.env
# Edit server/.env — set JWT_SECRET and ENCRYPTION_KEY
```

Run tests:

```bash
cd server && npm run test
```

Run lint:

```bash
cd server && npm run lint
```

## Project structure

```text
eudora/
├── src/                    # React frontend
│   ├── api/                # Axios client with JWT refresh
│   ├── components/         # Layout, Sidebar, TierGate, PlanModal
│   ├── hooks/              # useTierLimits, useSelfHosted
│   ├── pages/              # All page components
│   └── store/              # Zustand stores (auth, agents, onboarding)
├── server/
│   └── src/
│       ├── audit/          # Audit logger, trace recorder
│       ├── billing/        # canAccess, tier limits, feature flags
│       ├── core/           # Classifier, context retriever, model relay
│       ├── db/             # Schema, migrations, client
│       ├── middleware/     # Auth, tenant scope, trial expiry, rate limiter
│       ├── routes/         # All API routes
│       ├── scheduler/      # Cron runner
│       ├── security/       # Sanitiser, guard layer, scope enforcer, risk scorer
│       ├── utils/          # Encryption, auth helpers, ownership chain
│       └── workflow/       # Execution engine
└── e2e/                    # Playwright end-to-end tests
```

## Architecture decisions

**Why SQLite?**

Single-file database, zero configuration, sufficient for most self-hosted deployments. The architecture is designed so SQLite can be swapped for PostgreSQL with minimal changes.

**Why append-only audit log?**

Regulatory requirements. The `audit_log` table has a DB-level trigger that prevents UPDATE and DELETE. This cannot be bypassed by the application layer.

**Why ownership chain?**

DORA requires that every automated AI action be traceable to a human decision-maker. The ownership chain validates at write time that every agent ultimately has a human owner.

## Submitting changes

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Write tests for new functionality
4. Run `cd server && npm run test && npm run lint` — must pass
5. Submit a pull request with a clear description

## What we're looking for

- Bug fixes with regression tests
- Performance improvements
- Additional AI provider support
- Documentation improvements
- Security findings (see SECURITY.md)

## What we're not looking for (yet)

- Database changes without migration scripts
- Breaking changes to the audit log schema
- Changes to the append-only constraint

## Code style

- ESLint config in `server/.eslintrc.cjs`
- Prettier config in `.prettierrc`
- Run `npm run lint` before submitting
