import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'
import { setDbForTests } from '../db/index.js'
import { relay } from '../core/modelRelay.js'
import tunnelsRoutes, {
  resetHeartbeatRateLimitsForTests,
} from '../routes/tunnels.js'
import apiKeysRoutes from '../routes/apiKeys.js'
import {
  TUNNEL_STALE_AFTER_MS,
  createTunnel,
  hashTunnelKey,
  markStaleTunnels,
} from '../services/tunnelService.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migration001 = readFileSync(
  resolve(__dirname, '../db/migrations/001_initial_schema.sql'),
  'utf8'
)
const migration015 = readFileSync(
  resolve(__dirname, '../db/migrations/015_tunnels.sql'),
  'utf8'
)
const migration013 = readFileSync(
  resolve(__dirname, '../db/migrations/013_model_selection.sql'),
  'utf8'
)

let app
let db
let tenantId

beforeEach(async () => {
  resetHeartbeatRateLimitsForTests()
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(migration001)
  db.exec(migration013)
  db.exec(migration015)

  tenantId = nanoid()
  db.prepare(
    "INSERT INTO tenants (id, name, plan, created_at) VALUES (?, 'Tunnel Tenant', 'professional', ?)"
  ).run(tenantId, Date.now())
  db.prepare(
    "INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, 'owner@example.com', 'hash', 'owner')"
  ).run('tunnel-owner', tenantId)
  setDbForTests(db)

  app = Fastify({ logger: false })
  app.decorate('db', db)
  app.addHook('preHandler', async (request) => {
    request.tenantId = tenantId
    request.user = { userId: 'tunnel-owner', tenantId, role: 'owner' }
  })
  await app.register(tunnelsRoutes, { prefix: '/v1/tunnels' })
  await app.register(apiKeysRoutes, { prefix: '/api-keys' })
  await app.ready()
})

afterEach(async () => {
  if (app) await app.close()
  setDbForTests(null)
  vi.unstubAllGlobals()
  if (db) db.close()
})

describe('tunnel service and routes', () => {
  it('POST /v1/tunnels returns a one-time key and valid frpc TOML', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tunnels',
      payload: {
        name: 'Office Ollama',
        local_port: 11434,
        local_host: '127.0.0.1',
      },
    })

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.tunnel_key).toMatch(/^[a-f0-9]{32}$/)
    expect(body.frpc_config).toContain('serverAddr = "tunnel.geteudora.com"')
    expect(body.frpc_config).toContain(`name = "${body.id}"`)
    expect(body.frpc_config).toContain('localPort = 11434')
    expect(body.frpc_config).toContain(
      `customDomains = ["${body.id}.tunnel.geteudora.com"]`
    )
    expect(body.install_command).toContain('brew install frp')

    const stored = db.prepare('SELECT tunnel_key FROM tunnels WHERE id = ?').get(body.id)
    expect(stored.tunnel_key).toBe(hashTunnelKey(body.tunnel_key))
    expect(stored.tunnel_key).not.toBe(body.tunnel_key)
  })

  it('GET /v1/tunnels never returns the tunnel key', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/tunnels',
      payload: { name: 'Private Ollama' },
    })

    const response = await app.inject({ method: 'GET', url: '/v1/tunnels' })
    expect(response.statusCode).toBe(200)
    expect(response.json().tunnels).toHaveLength(1)
    expect(response.json().tunnels[0]).not.toHaveProperty('tunnel_key')
  })

  it('heartbeat authenticates the one-time key and marks the tunnel active', async () => {
    const tunnel = await createTunnel(db, {
      tenantId,
      name: 'Heartbeat tunnel',
    })

    const unauthorized = await app.inject({
      method: 'POST',
      url: `/v1/tunnels/${tunnel.id}/heartbeat`,
      headers: { authorization: 'Bearer wrong-key' },
    })
    expect(unauthorized.statusCode).toBe(401)

    const response = await app.inject({
      method: 'POST',
      url: `/v1/tunnels/${tunnel.id}/heartbeat`,
      headers: { authorization: `Bearer ${tunnel.tunnel_key}` },
    })
    expect(response.statusCode).toBe(200)

    const stored = db
      .prepare('SELECT status, last_seen_at FROM tunnels WHERE id = ?')
      .get(tunnel.id)
    expect(stored.status).toBe('active')
    expect(stored.last_seen_at).toBeGreaterThan(0)
  })

  it('heartbeat is limited to ten requests per minute per tunnel', async () => {
    const tunnel = await createTunnel(db, { tenantId, name: 'Limited tunnel' })
    for (let index = 0; index < 10; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/tunnels/${tunnel.id}/heartbeat`,
        headers: { authorization: `Bearer ${tunnel.tunnel_key}` },
      })
      expect(response.statusCode).toBe(200)
    }

    const limited = await app.inject({
      method: 'POST',
      url: `/v1/tunnels/${tunnel.id}/heartbeat`,
      headers: { authorization: `Bearer ${tunnel.tunnel_key}` },
    })
    expect(limited.statusCode).toBe(429)
  })

  it('marks active tunnels inactive after ninety seconds without a heartbeat', async () => {
    const now = Date.now()
    const tunnel = await createTunnel(db, { tenantId, name: 'Stale tunnel' })
    db.prepare(
      "UPDATE tunnels SET status = 'active', last_seen_at = ? WHERE id = ?"
    ).run(now - TUNNEL_STALE_AFTER_MS - 1, tunnel.id)

    await markStaleTunnels(db, now)

    expect(
      db.prepare('SELECT status FROM tunnels WHERE id = ?').get(tunnel.id).status
    ).toBe('inactive')
  })

  it('deletes only a tunnel belonging to the current tenant', async () => {
    const tunnel = await createTunnel(db, { tenantId, name: 'Delete tunnel' })
    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/tunnels/${tunnel.id}`,
    })
    expect(response.statusCode).toBe(200)
    expect(db.prepare('SELECT id FROM tunnels WHERE id = ?').get(tunnel.id))
      .toBeUndefined()
  })

  it('routes a tunnel connection through its public Ollama subdomain', async () => {
    const tunnel = await createTunnel(db, { tenantId, name: 'Relay tunnel' })
    const connectionId = nanoid()
    db.prepare(`
      INSERT INTO api_keys (
        id, tenant_id, user_id, provider, auth_type, label,
        default_model, tunnel_id, created_at
      ) VALUES (?, ?, 'tunnel-owner', 'tunnel', 'key', 'Tunnel', 'qwen2.5:14b', ?, ?)
    `).run(connectionId, tenantId, tunnel.id, Date.now())

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        message: { content: 'Tunnel response' },
        prompt_eval_count: 3,
        eval_count: 2,
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await relay({
      messages: [
        { role: 'system', content: 'System' },
        { role: 'user', content: 'Hello' },
      ],
    }, connectionId, tenantId)

    expect(fetchMock).toHaveBeenCalledWith(
      `http://${tunnel.id}.tunnel.geteudora.com/api/chat`,
      expect.any(Object)
    )
    expect(result).toMatchObject({
      content: 'Tunnel response',
      resolvedModel: 'qwen2.5:14b',
    })
  })

  it('creates a tunnel connection without storing the tunnel key', async () => {
    const tunnel = await createTunnel(db, { tenantId, name: 'Connection tunnel' })
    const response = await app.inject({
      method: 'POST',
      url: '/api-keys',
      payload: {
        provider: 'tunnel',
        label: 'Remote Ollama',
        tunnel_id: tunnel.id,
        default_model: 'llama3.2',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      provider: 'tunnel',
      tunnel_id: tunnel.id,
      default_model: 'llama3.2',
    })
    const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(response.json().id)
    expect(row.tunnel_id).toBe(tunnel.id)
    expect(row.key_encrypted).toBeNull()
  })
})
