# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 1.x | ✅ |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Email: security@geteudora.com

Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fixes

You will receive a response within 48 hours. If the vulnerability is confirmed:

- We will work on a fix immediately
- We will credit you in the release notes (unless you prefer otherwise)
- We will release a patch as soon as the fix is ready

## Security architecture

**Encryption:** All API keys and sensitive data encrypted at rest with AES-256-GCM. Each record uses a random IV.

**Authentication:** JWT with 15-minute expiry. Refresh tokens are single-use and rotate on every use.

**Tenant isolation:** Every database query is scoped to the authenticated tenant at the middleware level. The `tenant_id` is extracted from the verified JWT — it cannot be overridden by query parameters or request body.

**Audit log:** The `audit_log` table has a database-level trigger that prevents UPDATE and DELETE operations. This cannot be bypassed by the application layer.

**Prompt injection defence:** 24 patterns covering instruction override, role switch, jailbreak, extraction, system impersonation, and safety bypass.

**Rate limiting:** Per-tenant rate limiting on all authenticated routes.

**Tunnel keys:** One-time tunnel keys are shown to the user exactly once and stored only as a bcrypt hash. Heartbeat authentication verifies against the hash. Rate limited to 10 requests per minute per tunnel.
