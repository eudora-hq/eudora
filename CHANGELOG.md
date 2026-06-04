# Changelog

All notable changes to Eudora are documented here.

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
