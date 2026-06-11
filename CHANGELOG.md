# Changelog

All notable changes to Eudora are documented here.

## [1.1.0] — 2026-06-11

### Added

**Postgres Support (F032)**
- Opt-in Postgres backend via `DATABASE_URL` environment variable — SQLite remains the default
- Full DDL transformation layer: SQLite → Postgres (AUTOINCREMENT→SERIAL, INTEGER→BIGINT, triggers→plpgsql functions)
- Placeholder rewriting (`?` → `$N`) with quote and comment awareness
- Labeled dollar-quote tags for plpgsql functions to avoid JavaScript string replacement collisions
- INTEGER columns mapped to BIGINT to safely hold millisecond timestamps
- Idempotent migration runner for both backends
- Railway `DATABASE_URL` auto-provisioning documented

**Eudora Tunnel (frp Integration)**
- `/v1/tunnels` CRUD API with hashed one-time keys (plain key shown once, bcrypt hash stored)
- Heartbeat authentication and rate limiting (10 requests/minute per tunnel)
- Stale tunnel monitor — marks tunnels inactive after 90 seconds without a heartbeat
- Generated `frpc.toml` config and install command on tunnel creation
- Tunnel connection provider routed through `{id}.tunnel.geteudora.com`
- Tunnel management UI with gated sidebar navigation
- 8 tunnel tests covering the full lifecycle

**TypeScript Migration (F033)**
- Incremental TypeScript coverage for `audit/auditLogger.ts`, `reports/complianceReport.ts`, `routes/proxy.ts`
- Typed audit, report, and proxy interfaces
- `tsconfig.json` with `allowImportingTsExtensions` for Node 22 native TS strip
- CI typecheck step, Node 22 upgrade
- No suppression directives (`@ts-ignore`, `@ts-expect-error`)

**Compliance Report Improvements**
- Article 50 report now includes User Input column alongside AI Output
- `inputSummary` captured from proxy requests and stored in audit metadata
- PDF column layout fixed to fit within page width (600px → 515px total)
- RFC 3161 timestamp status rendered as `VERIFIED` (removed stray checkmark glyph that rendered as apostrophe in Helvetica)

## [1.0.0] — 2026

### Added

**Foundation**

- Multi-tenant authentication with JWT, refresh token rotation, and bcrypt password hashing
- AES-256-GCM encryption for all sensitive data at rest
- API key management for Anthropic, OpenAI, Gemini, Ollama, and custom endpoints
- OpenAI OAuth flow for ChatGPT/Codex subscription users
- Per-tenant rate limiting

**AI Pipeline**

- Intent classifier routing to all supported providers
- Tag-based context retrieval with token budget enforcement
- Prompt composer assembling structured messages with labelled context injection
- Model relay with typed errors (InvalidApiKeyError, ProviderRateLimitError, ProviderUnavailableError)
- Chat endpoint with full pipeline integration

**Security Layer**

- 24-pattern injection sanitiser with [REDACTED] replacement
- Guard layer blocking injection, jailbreak, role-switch, purpose-override, and role-impersonation attempts
- Scope enforcer flagging out-of-scope AI responses (financial, medical, legal, political)
- Risk scorer (0–100) combining sanitiser, guard, and scope signals
- Append-only audit logger with SHA-256 content hashing (enforced at DB trigger level)
- Per-run trace recorder

**Human Accountability**

- Agent ownership chain — every agent must have a chain terminating at a human user
- Cycle detection, maximum depth (10), cross-tenant rejection
- Every audit entry records initiated_by_user_id and agent_chain

**Frontend**

- Dark terminal aesthetic with emerald green (#10b981) primary
- AI-assisted onboarding (describe intent → AI generates agent config → review → deploy)
- Chat interface with neural trace panel (risk score, context vectors, token distribution)
- Agent Fleet with template gallery (15 pre-built templates including 8 compliance-specific)
- Context Manager with encrypted file storage
- Audit Log with filtering, pagination, and export
- Usage Dashboard with tier-aware metrics

**Workflow Builder**

- Visual multi-agent canvas (React Flow)
- Topological execution engine with conditional edges
- Per-node results and run history

**Cron Jobs**

- Full cron editor with preset cards and custom 5-field editor
- Live schedule preview with next-3-runs display
- Scheduler engine (node-cron) — full secured pipeline on every scheduled run
- Run history with trace data

**Monetization**

- 14-day trial with data export on expiry
- Stripe integration (checkout, webhooks, plan updates, Customer Portal)
- Plan comparison modal
- Self-hosted mode — all features, no limits, no expiry

**Agent Templates**

- 7 general templates: Email Assistant, Coding Assistant, Document Q&A, Meeting Summariser, DevOps Assistant, Customer Support Bot, Research Assistant
- 8 compliance templates: DORA Operational Resilience Auditor, AI Incident Classifier, Policy Compliance Checker, Risk Assessment Assistant, Regulatory Change Monitor, Vendor Assessment Bot, Audit Preparation Assistant
