<div align="center">

# Eudora

**Open-source proxy for AI agents and LLM applications**

Records every model interaction, performs DLP checks, detects prompt injection attempts, and preserves per-run decision traces.

Works with OpenAI, Anthropic, Azure OpenAI, Ollama, and existing agents with minimal changes.

Self-hosted. MIT licensed.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-417%20passing-brightgreen)](.github/workflows/ci.yml)
[![Self-hostable](https://img.shields.io/badge/self--host-free%20forever-blue)](docs/self-hosting.md)
![Node.js](https://img.shields.io/badge/node-22-339933?logo=node.js&logoColor=white)
![React](https://img.shields.io/badge/react-18-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/typescript-blue?logo=typescript)
![OpenAI](https://img.shields.io/badge/OpenAI-supported-black?logo=openai)
![Anthropic](https://img.shields.io/badge/Anthropic-supported-orange)
![Ollama](https://img.shields.io/badge/Ollama-supported-000000)

</div>

---

## Quick start

**Prerequisites:** Node.js 18+, Git

```bash
git clone https://github.com/eudora-hq/eudora.git
cd eudora
npm install && cd server && npm install && cd ..
cp .env.example server/.env
```

Edit `server/.env`:

```bash
JWT_SECRET=any-random-string-32-chars-or-more
ENCRYPTION_KEY=64-char-hex-string   # openssl rand -hex 32
SELF_HOSTED=true
# Optional: use Postgres instead of the default SQLite database
# DATABASE_URL=postgresql://user:password@host:5432/eudora
```

```bash
# Start backend (port 3001)
cd server && npm run dev

# Start frontend (port 5173) in a new terminal
npm run dev
```

Open `http://localhost:5173` and register. The setup wizard will detect Ollama if you have it running.

**Python SDK**

```bash
pip install eudora-sdk
```

```python
from openai import OpenAI
from eudora import wrap_openai

# Before: direct to OpenAI, nothing recorded
# client = OpenAI(api_key="sk-...")

# After: one line change, everything audited
client = wrap_openai(
    OpenAI(api_key="sk-..."),
    proxy_key="eudora-proxy-..."
)

response = client.chat.completions.create(
    model="gpt-4",
    messages=[{"role": "user", "content": "..."}]
)
# Every call is now: DLP checked, injection scanned, traced
```

**Node.js SDK**

```bash
npm install @eudora/sdk
```

```javascript
import OpenAI from 'openai'
import { wrapOpenAI } from '@eudora/sdk'

const client = wrapOpenAI(
  new OpenAI({ apiKey: process.env.OPENAI_KEY }),
  { proxyKey: 'eudora-proxy-...' }
)
```

Or change one line in any existing agent:

```python
# Before
client = OpenAI(base_url="https://api.openai.com/v1", api_key="sk-...")

# After
client = OpenAI(base_url="https://api.geteudora.com/proxy/openai/v1", api_key="eudora-proxy-...")
```

---

## Architecture

```
Your application or agent
         |
         v
   Eudora Proxy
         |
   +-----+-----+
   |           |
DLP scan   Injection detection
   |           |
   +-----+-----+
         |
   Intent classification
         |
   Context retrieval
         |
   Risk scoring (0-100)
         |
   Audit log + trace
         |
         v
OpenAI / Anthropic / Azure OpenAI / Ollama
```

The pipeline runs on every request before it reaches the model. If the request is blocked, it never leaves Eudora.

## Screenshots

**Command Center**
![Command Center](docs/screenshots/command-center.png)

**Workflow Builder** (React Flow canvas, fetch URL, agent nodes, run history)
![Workflow Canvas](docs/screenshots/workflow-canvas.png)

**Audit Log and Compliance Reports** (SHA-256 signed PDF export)
![Audit Log](docs/screenshots/audit-log.png)



---

## What it records

Every request produces a trace entry:

```
Run #4821   2026-06-05 14:23:11
Agent       Finance Analyst
Owner       alice@company.eu (verified human)
Intent      compliance (0.94 confidence)
Context     2 files loaded
DLP         CLEAN
Injection   CLEAN
Risk score  8 / 100
Guard       ALLOWED
Scope       COMPLIANT
Output      847 tokens, 2341ms
Hash        sha256:a7f3c2...
```

Flagged runs include the full reasoning chain. All traces are SHA-256 signed and append-only.

---

## DLP: credentials before the model sees them

Eudora scans every prompt for credentials and secrets before forwarding. When detected, the credential is replaced with `[CREDENTIAL REDACTED]` and an audit event is logged. The actual value never reaches the model.

Patterns detected:

- AWS Access Key IDs (AKIA...)
- PEM private keys (RSA, EC, OpenSSH, PGP)
- GitHub tokens (ghp_, ghs_, gho_)
- Database connection strings with embedded passwords
- JWT tokens
- Stripe live and test keys
- Slack tokens
- Generic `api_key=`, `secret=`, `password=` patterns
- High-entropy hex strings

---

## Features

**Security**
- 24-pattern prompt injection sanitiser
- Risk scoring 0-100 on every request
- Scope enforcement (agent stays within its defined purpose)
- DLP with 15+ credential patterns

**Audit**
- Append-only audit log enforced at database trigger level
- SHA-256 content hashing on every entry
- Per-run decision traces with full reasoning chain
- Human accountability chain (every action traces to a named human owner)
- Signed PDF compliance reports with per-run traces

**Integrations**
- Proxy mode for OpenAI, Anthropic, Azure OpenAI, custom endpoints
- Python SDK (`pip install eudora-sdk`)
- Node.js SDK (`npm install @eudora/sdk`)
- Azure OpenAI audit log import
- GitHub Copilot Business audit log import
- Webhook outputs, RSS feed monitoring, REST API calls in workflows

**Platform**
- Visual workflow builder (React Flow canvas)
- Cron-scheduled agent jobs
- Context file management with intent-based retrieval
- Team invites and seat management
- MFA (TOTP), OAuth login (Google, GitHub)
- Usage analytics dashboard
- System health monitoring
- Self-hosted setup wizard with Ollama detection

---

## Database backends

SQLite remains the default for self-hosted deployments. Set `DATABASE_URL` to use Postgres for cloud deployments that need concurrent writers. Railway supplies `DATABASE_URL` automatically when its Postgres addon is provisioned.

Railway backend environment checklist:

- `JWT_SECRET`
- `ENCRYPTION_KEY`
- `CLIENT_URL`
- `DATABASE_URL` (optional, required only when using Postgres)

Audit logs remain append-only on both backends. SQLite uses database triggers and Postgres installs equivalent trigger functions during migration.

Write attempts on existing audit rows are rejected at the trigger level, not the application level. This means the protection holds even if application code is compromised.

For a system where the audit log is the product, simplicity and verifiability matter more than scale.

---

## Why no vector database

Eudora uses intent classification and tag-based context retrieval rather than embeddings and semantic search by default.

This keeps self-hosted deployments lightweight and avoids an additional infrastructure dependency. If you have an OpenAI key or Ollama with `nomic-embed-text`, Eudora will use embeddings automatically. If not, the TF-IDF fallback works without any extra setup.

Running a 14B model locally stays viable.

---

## Self-hosted vs Cloud

Self-hosted is free forever. All features included. No limits, no trial, no feature gates.

|  | Self-hosted | Cloud |
|---|---|---|
| Cost | Free forever | from €99/mo |
| Features | Everything | Tier-based |
| Data | Your server | EU-hosted |
| Limits | None | Plan-based |
| Support | Community | SLA |

See [docs/self-hosting.md](docs/self-hosting.md) for Docker Compose setup, environment variables, and Ollama integration.

---

## Compliance context

Eudora is used by teams working under DORA (EU Digital Operational Resilience Act) and the EU AI Act. The audit trail, accountability chain, and decision traces are designed around what operational resilience assessments require in practice.

If you are not in a regulated industry, most of these features still apply: the DLP catches real credential leaks, the injection detection catches real attacks, and the audit trail is useful for debugging agent behavior.

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, Tailwind CSS, Zustand, React Flow |
| Backend | Node.js 22, Fastify, better-sqlite3 |
| Security | AES-256-GCM, JWT, bcrypt, SHA-256 |
| AI providers | Anthropic, OpenAI, Gemini, Ollama, Azure OpenAI, Custom |
| Payments | Stripe (cloud only) |
| Testing | Vitest (417 passing) |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Report vulnerabilities to [security@geteudora.com](mailto:security@geteudora.com) or see [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
