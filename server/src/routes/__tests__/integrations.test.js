import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'

const azureMocks = vi.hoisted(() => ({
  testConnection: vi.fn(),
  pullAuditLogs: vi.fn(),
}))

const githubMocks = vi.hoisted(() => ({
  testGithubConnection: vi.fn(),
  pullCopilotAuditLogs: vi.fn(),
  getCopilotUsageStats: vi.fn(),
}))

vi.mock('../../integrations/azureOpenAI.js', () => azureMocks)
vi.mock('../../integrations/githubCopilot.js', () => githubMocks)

import integrationsRoutes from '../integrations.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrations = [
  '001_initial_schema.sql',
  '002_agent_ownership.sql',
  '007_notifications.sql',
  '008_integrations.sql',
].map(file => readFileSync(resolve(__dirname, `../../db/migrations/${file}`), 'utf8'))

const azureConfig = {
  tenantId: 'azure-tenant-id',
  clientId: 'azure-client-id',
  clientSecret: 'super-secret',
  subscriptionId: 'subscription-id',
  resourceGroup: 'production-rg',
  resourceName: 'production-openai',
  workspaceId: 'workspace-id',
}

const githubConfig = {
  org: 'eudora-org',
  token: 'github_pat_secret',
}

let app
let db
let tenantId
let userId

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = 'ab'.repeat(32)
  azureMocks.testConnection.mockReset()
  azureMocks.pullAuditLogs.mockReset()
  githubMocks.testGithubConnection.mockReset()
  githubMocks.pullCopilotAuditLogs.mockReset()
  githubMocks.getCopilotUsageStats.mockReset()

  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrations.forEach(migration => db.exec(migration))

  tenantId = nanoid()
  userId = nanoid()
  db.prepare(`
    INSERT INTO tenants (id, name, plan, created_at)
    VALUES (?, 'Integration Tenant', 'enterprise', ?)
  `).run(tenantId, Date.now())
  db.prepare(`
    INSERT INTO users (id, tenant_id, email, password_hash, role)
    VALUES (?, ?, 'owner@example.com', 'hash', 'owner')
  `).run(userId, tenantId)

  app = Fastify({ logger: false })
  app.decorate('db', db)
  app.addHook('preHandler', async (request) => {
    request.tenantId = tenantId
    request.user = { userId, tenantId, role: 'owner' }
  })
  await app.register(integrationsRoutes, { prefix: '/integrations' })
  await app.ready()
})

afterEach(async () => {
  delete process.env.ENCRYPTION_KEY
  if (app) await app.close()
  if (db) db.close()
})

async function createIntegration() {
  azureMocks.testConnection.mockResolvedValue({
    success: true,
    resourceName: azureConfig.resourceName,
    location: 'westeurope',
  })
  return app.inject({
    method: 'POST',
    url: '/integrations/azure-openai',
    payload: { name: 'Production Azure', config: azureConfig },
  })
}

async function createGithubIntegration() {
  githubMocks.testGithubConnection.mockResolvedValue({
    success: true,
    org: githubConfig.org,
    plan: 'business',
  })
  return app.inject({
    method: 'POST',
    url: '/integrations/github-copilot',
    payload: { name: 'Copilot Business', config: githubConfig },
  })
}

describe('Azure OpenAI integration routes', () => {
  it('tests Azure credentials', async () => {
    azureMocks.testConnection.mockResolvedValue({
      success: true,
      resourceName: 'production-openai',
      location: 'westeurope',
    })

    const response = await app.inject({
      method: 'POST',
      url: '/integrations/azure-openai/test',
      payload: { config: azureConfig },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      success: true,
      resourceName: 'production-openai',
      location: 'westeurope',
    })
    expect(azureMocks.testConnection).toHaveBeenCalledWith(azureConfig)
  })

  it('rejects incomplete Azure configuration', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/integrations/azure-openai/test',
      payload: { config: { tenantId: 'azure-tenant-id' } },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('missing_config')
    expect(azureMocks.testConnection).not.toHaveBeenCalled()
  })

  it('saves encrypted configuration and never returns it from the list', async () => {
    const created = await createIntegration()

    expect(created.statusCode).toBe(201)
    const stored = db.prepare('SELECT config FROM integrations WHERE id = ?')
      .get(created.json().id)
    expect(stored.config).not.toContain(azureConfig.clientSecret)
    expect(JSON.parse(stored.config)).toMatchObject({
      ciphertext: expect.any(String),
      iv: expect.any(String),
    })

    const listed = await app.inject({ method: 'GET', url: '/integrations' })
    expect(listed.statusCode).toBe(200)
    expect(listed.json()).toEqual([
      expect.objectContaining({
        id: created.json().id,
        name: 'Production Azure',
        type: 'azure_openai',
      }),
    ])
    expect(listed.json()[0]).not.toHaveProperty('config')
  })

  it('syncs Azure events into the Eudora audit trail', async () => {
    const created = await createIntegration()
    const integrationId = created.json().id
    const timestamp = Date.now() - 1000
    azureMocks.pullAuditLogs.mockResolvedValue([
      {
        timestamp,
        operation: 'Chat Completions',
        callerIp: '192.0.2.10',
        userId: 'azure-user',
        model: 'gpt-4o',
        promptTokens: 20,
        completionTokens: 10,
        statusCode: 200,
        durationMs: 450,
      },
    ])

    const response = await app.inject({
      method: 'POST',
      url: `/integrations/${integrationId}/sync`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ imported: 1, total: 1 })
    expect(azureMocks.pullAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({ clientSecret: azureConfig.clientSecret }),
      expect.any(Number)
    )

    const audit = db.prepare(`
      SELECT action, metadata, ts FROM audit_log WHERE tenant_id = ?
    `).get(tenantId)
    expect(audit.action).toBe('azure_openai_chat_completions')
    expect(audit.ts).toBe(timestamp)
    expect(JSON.parse(audit.metadata)).toMatchObject({
      source: 'azure_openai',
      integrationId,
      integrationName: 'Production Azure',
      model: 'gpt-4o',
    })

    const integration = db.prepare(`
      SELECT last_sync_status, last_sync_count FROM integrations WHERE id = ?
    `).get(integrationId)
    expect(integration).toMatchObject({
      last_sync_status: 'success',
      last_sync_count: 1,
    })
  })

  it('records failed sync status', async () => {
    const created = await createIntegration()
    azureMocks.pullAuditLogs.mockRejectedValue(new Error('Azure unavailable'))

    const response = await app.inject({
      method: 'POST',
      url: `/integrations/${created.json().id}/sync`,
    })

    expect(response.statusCode).toBe(500)
    expect(response.json()).toMatchObject({
      error: 'sync_failed',
      message: 'Azure unavailable',
    })
    expect(
      db.prepare('SELECT last_sync_status FROM integrations WHERE id = ?')
        .get(created.json().id).last_sync_status
    ).toBe('failed: Azure unavailable')
  })

  it('deletes only an integration in the current tenant', async () => {
    const created = await createIntegration()

    const response = await app.inject({
      method: 'DELETE',
      url: `/integrations/${created.json().id}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ deleted: true })
    expect(
      db.prepare('SELECT id FROM integrations WHERE id = ?').get(created.json().id)
    ).toBeUndefined()
  })
})

describe('GitHub Copilot integration routes', () => {
  it('tests GitHub organization credentials', async () => {
    githubMocks.testGithubConnection.mockResolvedValue({
      success: true,
      org: 'eudora-org',
      plan: 'business',
    })

    const response = await app.inject({
      method: 'POST',
      url: '/integrations/github-copilot/test',
      payload: { config: githubConfig },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      success: true,
      org: 'eudora-org',
      plan: 'business',
    })
    expect(githubMocks.testGithubConnection).toHaveBeenCalledWith(githubConfig)
  })

  it('saves GitHub credentials encrypted', async () => {
    const response = await createGithubIntegration()

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      name: 'Copilot Business',
      type: 'github_copilot',
      status: 'active',
    })
    const stored = db.prepare('SELECT config FROM integrations WHERE id = ?')
      .get(response.json().id)
    expect(stored.config).not.toContain(githubConfig.token)
    expect(JSON.parse(stored.config)).toMatchObject({
      ciphertext: expect.any(String),
      iv: expect.any(String),
    })
  })

  it('syncs Copilot events into the Eudora audit trail', async () => {
    const created = await createGithubIntegration()
    const timestamp = Date.now() - 500
    githubMocks.pullCopilotAuditLogs.mockResolvedValue([
      {
        timestamp,
        action: 'copilot.access_granted',
        actor: 'octocat',
        repo: 'eudora/app',
        userLogin: 'developer',
        data: { editor: 'vscode' },
      },
    ])

    const response = await app.inject({
      method: 'POST',
      url: `/integrations/${created.json().id}/sync`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ imported: 1, total: 1 })
    expect(githubMocks.pullCopilotAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining(githubConfig),
      expect.any(Number)
    )

    const audit = db.prepare(`
      SELECT action, metadata, ts
      FROM audit_log
      WHERE tenant_id = ?
    `).get(tenantId)
    expect(audit.action).toBe('github_copilot_copilot_access_granted')
    expect(audit.ts).toBe(timestamp)
    expect(JSON.parse(audit.metadata)).toMatchObject({
      source: 'github_copilot',
      integrationId: created.json().id,
      integrationName: 'Copilot Business',
      actor: 'octocat',
      repo: 'eudora/app',
    })
  })
})
