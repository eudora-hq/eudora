<div align="center">

# Eudora

**AI Audit & Behavioral Compliance Layer**

*Govern what your AI agents did, said, and decided. Prove a human was accountable.*

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-302%20passing-brightgreen)](.github/workflows/ci.yml)
[![Self-hostable](https://img.shields.io/badge/self--host-free%20forever-blue)](docs/self-hosting.md)

</div>

---

## What is Eudora?

IGA platforms (SailPoint, Saviynt, CyberArk) govern **who** your AI agent is and what systems it can access. Eudora governs **what the agent did, said, and decided** — and proves a human was accountable for every action.

Built for regulated European industries and DORA (Digital Operational Resilience Act) compliance.

```text
IGA Platform                    Eudora
────────────────────────────────────────────────────
Who is this agent?              What did this agent do?
What can it access?             What did it say and decide?
Identity governance             AI behavior governance
Pre-run authorisation           Post-run accountability
```

## Features

- **Append-only audit trail** — every agent action logged with SHA-256 hashes. Tamper-proof at the database trigger level.
- **Human accountability chain** — every automated action traces back to a named human owner. Required for DORA compliance.
- **Prompt injection defence** — 24-pattern sanitiser, guard layer, risk scoring (0–100) on every interaction.
- **Per-run trace viewer** — intent classification, context injection map, token distribution, risk score per message.
- **BYOK** — Anthropic, OpenAI, Gemini, Ollama, or any OpenAI-compatible endpoint. You pay providers directly.
- **Cron-scheduled agents** — visual cron editor with live preview. Full audit trail on every scheduled run.
- **Multi-agent workflows** — visual canvas, topological execution, conditional edges.
- **Proxy mode** *(coming in v1.1)* — point existing agents at Eudora without rebuilding them.

## Self-hosted vs Cloud

Eudora is open core. **Self-hosted is free forever** with no limits, no trial, no feature gates.

|  | Self-hosted | Cloud |
|---|---|---|
| Cost | Free forever | €99–€999/mo |
| Features | Everything | Tier-based |
| Data | Your server | EU-hosted |
| Limits | None | Plan-based |
| Support | Community | SLA |

## Quick start

**Prerequisites:** Node.js 18+

```bash
git clone https://github.com/eudora-hq/eudora.git
cd eudora

# Install all dependencies
npm install && cd server && npm install && cd ..

# Configure environment
cp .env.example server/.env
```

Edit `server/.env` — at minimum set:

```bash
JWT_SECRET=any-random-string-32-chars-or-more
ENCRYPTION_KEY=64-char-hex-string  # generate: openssl rand -hex 32
SELF_HOSTED=true
```

```bash
# Start backend (port 3001)
cd server && npm run dev

# Start frontend (port 5173) — new terminal
cd .. && npm run dev
```

Open `http://localhost:5173`, register an account, and connect a model.

**Connecting a local Ollama model:**

```text
Provider: Ollama
Base URL: http://localhost:11434
Model name: qwen2.5-coder:14b  (or any model you have)
```

## Architecture

```text
Frontend (React + Vite)
│
▼
Backend (Node.js + Fastify)
│
├── Auth & Tenant isolation
├── API key encryption (AES-256-GCM)
│
└── Chat pipeline:
    sanitise → classify → retrieve → compose
    → guard → relay → scope → audit → trace
```

**Database:** SQLite (single file, zero configuration)

**Audit log:** Append-only enforced at DB trigger level — not just application level

## Compliance

Eudora is designed for DORA (Digital Operational Resilience Act) Article 11 operational resilience requirements:

- Immutable audit log with cryptographic content hashing
- Human accountability chain on every agent action (ownership chain validated at write time)
- Risk scoring on every AI interaction
- Full trace data for regulatory examination
- Data export for portability

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, Tailwind CSS, Zustand |
| Backend | Node.js, Fastify, better-sqlite3 |
| Security | AES-256-GCM, JWT, bcrypt, SHA-256 |
| AI providers | Anthropic, OpenAI, Gemini, Ollama, Custom |
| Payments | Stripe (cloud version only) |
| Testing | Vitest (302 tests), Playwright (E2E) |

## Self-hosting

See [docs/self-hosting.md](docs/self-hosting.md) for full instructions including Docker Compose, environment variables, and upgrade path.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

To report a security vulnerability, see [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
