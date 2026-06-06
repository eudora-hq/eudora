import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { nanoid } from 'nanoid'

process.env.ENCRYPTION_KEY = 'f'.repeat(64)

const resendMocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  send: vi.fn(),
}))

vi.mock('resend', () => ({
  Resend: function Resend(apiKey) {
    resendMocks.constructor(apiKey)
    this.emails = {
      send: resendMocks.send,
    }
  },
}))

vi.mock('../../security/sanitiser.js', () => ({
  sanitise: vi.fn((input) => ({ sanitised: input, flagged: false, patterns: [] })),
}))
vi.mock('../../security/guardLayer.js', () => ({
  guard: vi.fn(() => ({ allowed: true, violation: null })),
}))
vi.mock('../../security/scopeEnforcer.js', () => ({
  enforceScope: vi.fn(() => ({ compliant: true, violation: null })),
}))
vi.mock('../../core/contextRetriever.js', () => ({
  retrieve: vi.fn().mockResolvedValue({ files: [], tokensEstimate: 0, excluded: [] }),
}))
vi.mock('../../audit/auditLogger.js', () => ({
  log: vi.fn(),
  AUDIT_ACTIONS: { WORKFLOW_RUN: 'workflow_run', CHAT_MESSAGE: 'chat_message' },
}))
vi.mock('../../core/modelRelay.js', () => ({
  relay: vi.fn(async (composed) => {
    const input = composed.messages[1].content
    return {
      content: `output for ${input}`,
      tokensUsed: { input: 10, output: 5, total: 15 },
    }
  }),
}))

import { relay } from '../../core/modelRelay.js'
import { log } from '../../audit/auditLogger.js'
import { executeWorkflow } from '../executionEngine.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationSql = readFileSync(
  resolve(__dirname, '../../db/migrations/001_initial_schema.sql'),
  'utf8'
)
const migration002Sql = readFileSync(
  resolve(__dirname, '../../db/migrations/002_agent_ownership.sql'),
  'utf8'
)

let db
let tenantId
let workflowId
let runId
let agentIds

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(migrationSql)
  db.exec(migration002Sql)

  tenantId = nanoid()
  const userId = nanoid()
  db.prepare(
    'INSERT INTO tenants (id, name, plan, trial_ends_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(tenantId, 'Workflow Tenant', 'professional', Date.now() + 14 * 24 * 60 * 60 * 1000, Date.now())
  db.prepare(
    'INSERT INTO users (id, tenant_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, tenantId, 'workflow@test.com', 'hash', 'owner')

  agentIds = [nanoid(), nanoid(), nanoid()]
  const insertAgent = db.prepare(
    'INSERT INTO agents (id, tenant_id, name, purpose, model_provider, system_prompt, owner_type, owner_id, owner_chain, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  agentIds.forEach((id, index) => {
    insertAgent.run(id, tenantId, `Agent ${index + 1}`, 'Execute workflow task', 'openai', `System ${index + 1}`, 'human', userId, '[]', Date.now())
  })

  workflowId = nanoid()
  runId = nanoid()
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  if (db) db.close()
})

function createWorkflow({ edges }) {
  const nodes = agentIds.map((agentId, index) => ({
    id: `n${index + 1}`,
    agentId,
    label: `Node ${index + 1}`,
    position: { x: index * 100, y: 0 },
  }))

  createCustomWorkflow({ nodes, edges })
}

function createCustomWorkflow({ nodes, edges, description = 'Start prompt' }) {
  db.prepare(
    `INSERT INTO workflows (id, tenant_id, name, description, nodes, edges, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    workflowId,
    tenantId,
    'Workflow',
    description,
    JSON.stringify(nodes),
    JSON.stringify(edges),
    Date.now(),
    Date.now()
  )

  db.prepare(
    `INSERT INTO workflow_runs (id, tenant_id, workflow_id, status, trigger, node_results, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(runId, tenantId, workflowId, 'running', 'manual', '[]', Date.now())
}

function latestResults() {
  const row = db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId)
  return JSON.parse(row.node_results)
}

describe('executeWorkflow', () => {
  it('executes a 3-node linear workflow in topological order', async () => {
    createWorkflow({
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3' },
      ],
    })

    await executeWorkflow(workflowId, tenantId, db, runId)

    expect(latestResults().map(result => result.nodeId)).toEqual(['n1', 'n2', 'n3'])
    expect(db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId).status).toBe('success')
  })

  it('uses Node 1 output as input to Node 2', async () => {
    createWorkflow({
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3' },
      ],
    })

    await executeWorkflow(workflowId, tenantId, db, runId)

    expect(relay).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: 'output for Start prompt' }),
        ]),
      }),
      null,
      tenantId
    )
  })

  it('skips Node 3 when Node 2 output does not contain the condition string', async () => {
    createWorkflow({
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3', condition: 'APPROVED' },
      ],
    })

    await executeWorkflow(workflowId, tenantId, db, runId)

    const results = latestResults()
    expect(results.find(result => result.nodeId === 'n3').status).toBe('skipped')
    expect(relay).toHaveBeenCalledTimes(2)
  })

  it('executes Node 3 when Node 2 output contains the condition string', async () => {
    relay.mockImplementation(async (composed) => {
      const input = composed.messages[1].content
      return {
        content: input.includes('output for Start prompt') ? 'APPROVED next step' : `output for ${input}`,
        tokensUsed: { input: 10, output: 5, total: 15 },
      }
    })

    createWorkflow({
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3', condition: 'APPROVED' },
      ],
    })

    await executeWorkflow(workflowId, tenantId, db, runId)

    const results = latestResults()
    expect(results.find(result => result.nodeId === 'n3').status).toBe('success')
    expect(relay).toHaveBeenCalledTimes(3)
  })

  it('fetch_url node - successful fetch returns plain text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'text/html' },
      text: async () => '<html><body><script>ignore()</script><p>DORA compliance text</p></body></html>',
    }))

    createCustomWorkflow({
      nodes: [
        {
          id: 'fetch1',
          type: 'fetch_url',
          label: 'Fetch Source',
          config: { url: 'https://example.com/dora' },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    })

    await executeWorkflow(workflowId, tenantId, db, runId)

    const result = latestResults()[0]
    expect(result.status).toBe('success')
    expect(result.output).toBe('DORA compliance text')
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'url_fetched',
        metadata: expect.objectContaining({
          url: 'https://example.com/dora',
          workflowId,
        }),
      }),
      db
    )
  })

  it('fetch_url node - timeout returns failed status', async () => {
    const timeoutError = new Error('abort')
    timeoutError.name = 'AbortError'
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(timeoutError))

    createCustomWorkflow({
      nodes: [
        {
          id: 'fetch1',
          type: 'fetch_url',
          label: 'Fetch Source',
          config: { url: 'https://example.com/slow' },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    })

    await executeWorkflow(workflowId, tenantId, db, runId)

    const result = latestResults()[0]
    expect(result.status).toBe('failed')
    expect(result.error).toBe('timeout')
  })

  it('fetch_url node - max 10 URLs per run enforced', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'text/plain' },
      text: async () => 'Fetched source text',
    })
    vi.stubGlobal('fetch', fetchMock)

    createCustomWorkflow({
      nodes: Array.from({ length: 11 }, (_, index) => ({
        id: `fetch${index + 1}`,
        type: 'fetch_url',
        label: `Fetch ${index + 1}`,
        config: { url: `https://example.com/source-${index + 1}` },
        position: { x: index * 100, y: 0 },
      })),
      edges: [],
    })

    await executeWorkflow(workflowId, tenantId, db, runId)

    const results = latestResults()
    expect(fetchMock).toHaveBeenCalledTimes(10)
    expect(results.find(result => result.nodeId === 'fetch11')).toMatchObject({
      status: 'skipped',
      error: 'rate_limit',
    })
  })

  it('fetch_url node - invalid URL returns failed', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    createCustomWorkflow({
      nodes: [
        {
          id: 'fetch1',
          type: 'fetch_url',
          label: 'Fetch Source',
          config: { url: 'not-a-url' },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    })

    await executeWorkflow(workflowId, tenantId, db, runId)

    const result = latestResults()[0]
    expect(result.status).toBe('failed')
    expect(result.error).toBe('invalid_url')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('fetch_api node', () => {
  function createApiWorkflow(config) {
    createCustomWorkflow({
      nodes: [
        {
          id: 'api1',
          type: 'fetch_api',
          label: 'API Call',
          config,
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    })
  }

  it('GET request - success returns parsed JSON output', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 1, name: 'test' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    createApiWorkflow({ url: 'https://api.example.com/items/1', method: 'GET' })

    await executeWorkflow(workflowId, tenantId, db, runId)

    const result = latestResults()[0]
    expect(result).toMatchObject({
      status: 'success',
      output: '{\n  "id": 1,\n  "name": "test"\n}',
    })
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'api_called',
        metadata: expect.objectContaining({
          url: 'https://api.example.com/items/1',
          method: 'GET',
          statusCode: 200,
          workflowId,
        }),
      }),
      db
    )
  })

  it('POST request with body - body sent correctly', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ created: true }),
    })
    vi.stubGlobal('fetch', fetchMock)
    createApiWorkflow({
      url: 'https://api.example.com/items',
      method: 'POST',
      body: '{"key":"value"}',
    })

    await executeWorkflow(workflowId, tenantId, db, runId)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/items',
      expect.objectContaining({
        method: 'POST',
        body: '{"key":"value"}',
      })
    )
  })

  it('Bearer auth - Authorization header set correctly', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '{}',
    })
    vi.stubGlobal('fetch', fetchMock)
    createApiWorkflow({
      url: 'https://api.example.com/private',
      method: 'GET',
      authType: 'bearer',
      authValue: 'mytoken',
    })

    await executeWorkflow(workflowId, tenantId, db, runId)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/private',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer mytoken',
        }),
      })
    )
  })

  it('Basic auth - credentials are base64 encoded', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '{}',
    })
    vi.stubGlobal('fetch', fetchMock)
    createApiWorkflow({
      url: 'https://api.example.com/private',
      method: 'GET',
      authType: 'basic',
      authValue: 'user:password',
    })

    await executeWorkflow(workflowId, tenantId, db, runId)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/private',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from('user:password').toString('base64')}`,
        }),
      })
    )
  })

  it('API key auth - custom header set correctly', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '{}',
    })
    vi.stubGlobal('fetch', fetchMock)
    createApiWorkflow({
      url: 'https://api.example.com/private',
      method: 'GET',
      authType: 'apikey',
      authHeader: 'X-API-Key',
      authValue: 'secret',
      headers: 'Accept: application/json\nX-Workflow: eudora',
    })

    await executeWorkflow(workflowId, tenantId, db, runId)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/private',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json',
          'X-Workflow': 'eudora',
          'X-API-Key': 'secret',
        }),
      })
    )
  })

  it('HTTP 4xx error - returns failed status with error body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: 'not found' }),
    }))
    createApiWorkflow({ url: 'https://api.example.com/missing', method: 'GET' })

    await executeWorkflow(workflowId, tenantId, db, runId)

    expect(latestResults()[0]).toMatchObject({
      status: 'failed',
      error: 'http_error',
      output: expect.stringContaining('HTTP 404'),
    })
    expect(latestResults()[0].output).toContain('"error": "not found"')
  })

  it('Timeout - returns failed status with timeout error', async () => {
    const timeoutError = new Error('abort')
    timeoutError.name = 'AbortError'
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(timeoutError))
    createApiWorkflow({ url: 'https://api.example.com/slow', method: 'GET' })

    await executeWorkflow(workflowId, tenantId, db, runId)

    expect(latestResults()[0]).toMatchObject({
      status: 'failed',
      error: 'timeout',
      output: 'Request timed out',
    })
  })

  it('Invalid URL - returns failed without calling fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    createApiWorkflow({ url: 'not-a-url', method: 'GET' })

    await executeWorkflow(workflowId, tenantId, db, runId)

    expect(latestResults()[0]).toMatchObject({
      status: 'failed',
      error: 'invalid_url',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Large response - truncated at 50,000 characters', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => 'x'.repeat(60000),
    }))
    createApiWorkflow({ url: 'https://api.example.com/large', method: 'GET' })

    await executeWorkflow(workflowId, tenantId, db, runId)

    const result = latestResults()[0]
    expect(result.status).toBe('success')
    expect(result.output.length).toBeLessThanOrEqual(50100)
    expect(result.output).toContain('[Response truncated at 50,000 characters]')
  })
})

describe('webhook_out node', () => {
  function createWebhookWorkflow(config, description = 'workflow result') {
    createCustomWorkflow({
      nodes: [
        {
          id: 'webhook1',
          type: 'webhook_out',
          label: 'Webhook Out',
          config,
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      description,
    })
  }

  it('auto mode - posts Eudora envelope with correct fields', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => 'ok',
    })
    vi.stubGlobal('fetch', fetchMock)
    createWebhookWorkflow({
      url: 'https://example.com/hook',
      payloadMode: 'auto',
    })

    await executeWorkflow(workflowId, tenantId, db, runId)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/hook',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'User-Agent': 'Eudora-Webhook/1.0',
          'X-Eudora-Workflow': workflowId,
        }),
      })
    )
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(requestBody).toMatchObject({
      source: 'eudora',
      workflowId,
      nodeId: 'webhook1',
      data: 'workflow result',
      tenantId,
    })
    expect(new Date(requestBody.timestamp).toISOString()).toBe(requestBody.timestamp)
    expect(latestResults()[0]).toMatchObject({
      status: 'success',
      output: expect.stringContaining('HTTP 200'),
    })
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'webhook_delivered',
        metadata: expect.objectContaining({
          url: 'https://example.com/hook',
          statusCode: 200,
          payloadMode: 'auto',
          workflowId,
          signed: false,
        }),
      }),
      db
    )
  })

  it('raw mode - sends input directly as body', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchMock)
    createWebhookWorkflow({
      url: 'https://example.com/hook',
      payloadMode: 'raw',
    }, 'plain text output')

    await executeWorkflow(workflowId, tenantId, db, runId)

    expect(fetchMock.mock.calls[0][1].body).toBe('plain text output')
  })

  it('custom mode - replaces {{input}} placeholder', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchMock)
    createWebhookWorkflow({
      url: 'https://example.com/hook',
      payloadMode: 'custom',
      customPayload: '{"text":"{{input}}"}',
    }, 'compliance alert')

    await executeWorkflow(workflowId, tenantId, db, runId)

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      text: 'compliance alert',
    })
  })

  it('with secret - adds signature and custom headers', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchMock)
    createWebhookWorkflow({
      url: 'https://example.com/hook',
      payloadMode: 'auto',
      secret: 'mysecret',
      headers: 'Authorization: Bearer token\nX-Custom: value',
    })

    await executeWorkflow(workflowId, tenantId, db, runId)

    expect(fetchMock.mock.calls[0][1].headers).toEqual(
      expect.objectContaining({
        Authorization: 'Bearer token',
        'X-Custom': 'value',
        'X-Eudora-Signature': expect.stringMatching(/^sha256=[0-9a-f]{64}$/),
      })
    )
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'webhook_delivered',
        metadata: expect.objectContaining({ signed: true }),
      }),
      db
    )
  })

  it('HTTP 4xx - returns failed status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'Bad Request',
    }))
    createWebhookWorkflow({
      url: 'https://example.com/hook',
      payloadMode: 'auto',
    })

    await executeWorkflow(workflowId, tenantId, db, runId)

    expect(latestResults()[0]).toMatchObject({
      status: 'failed',
      output: expect.stringContaining('HTTP 400'),
      error: 'http_error',
    })
  })

  it('timeout - returns failed with timeout error', async () => {
    const timeoutError = new Error('abort')
    timeoutError.name = 'AbortError'
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(timeoutError))
    createWebhookWorkflow({
      url: 'https://example.com/hook',
      payloadMode: 'auto',
    })

    await executeWorkflow(workflowId, tenantId, db, runId)

    expect(latestResults()[0]).toMatchObject({
      status: 'failed',
      output: 'Webhook timed out',
      error: 'timeout',
    })
  })

  it('missing URL - returns failed without calling fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    createWebhookWorkflow({ payloadMode: 'auto' })

    await executeWorkflow(workflowId, tenantId, db, runId)

    expect(latestResults()[0]).toMatchObject({
      status: 'failed',
      output: 'No webhook URL configured',
      error: 'missing_url',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('send_email node', () => {
  function createEmailWorkflow(config, description = 'Compliance workflow result') {
    createCustomWorkflow({
      nodes: [
        {
          id: 'email1',
          type: 'send_email',
          label: 'Send Email',
          config,
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      description,
    })
  }

  beforeEach(() => {
    process.env.RESEND_API_KEY = 're_test_key'
    process.env.RESEND_FROM = 'security@geteudora.com'
    resendMocks.send.mockResolvedValue({
      data: { id: 'test-email-id' },
      error: null,
    })
  })

  afterEach(() => {
    delete process.env.RESEND_API_KEY
    delete process.env.RESEND_FROM
  })

  it('sends email with correct recipient and subject', async () => {
    createEmailWorkflow({
      to: 'test@example.com',
      subject: 'Test Alert',
      from: 'alerts@example.com',
      fromName: 'Compliance Team',
      htmlMode: 'false',
    })

    await executeWorkflow(workflowId, tenantId, db, runId)

    expect(resendMocks.constructor).toHaveBeenCalledWith('re_test_key')
    expect(resendMocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Compliance Team <alerts@example.com>',
        to: ['test@example.com'],
        subject: 'Test Alert',
        text: 'Compliance workflow result',
        html: expect.stringContaining('EUDORA WORKFLOW ALERT'),
      })
    )
    expect(latestResults()[0]).toMatchObject({
      status: 'success',
      output: expect.stringContaining('test@example.com'),
    })
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'email_sent',
        metadata: expect.objectContaining({
          to: 'test@example.com',
          subject: 'Test Alert',
          messageId: 'test-email-id',
          workflowId,
        }),
      }),
      db
    )
  })

  it('missing recipient - returns failed without sending', async () => {
    createEmailWorkflow({ subject: 'Test Alert' })

    await executeWorkflow(workflowId, tenantId, db, runId)

    expect(latestResults()[0]).toMatchObject({
      status: 'failed',
      error: 'missing_to',
    })
    expect(resendMocks.send).not.toHaveBeenCalled()
  })

  it('invalid email format - returns failed', async () => {
    createEmailWorkflow({ to: 'not-an-email' })

    await executeWorkflow(workflowId, tenantId, db, runId)

    expect(latestResults()[0]).toMatchObject({
      status: 'failed',
      error: 'invalid_email',
    })
    expect(resendMocks.send).not.toHaveBeenCalled()
  })

  it('no RESEND_API_KEY - logs and returns success gracefully', async () => {
    delete process.env.RESEND_API_KEY
    createEmailWorkflow({ to: 'test@example.com' })

    await executeWorkflow(workflowId, tenantId, db, runId)

    expect(latestResults()[0]).toMatchObject({
      status: 'success',
      output: expect.stringContaining('RESEND_API_KEY'),
    })
    expect(resendMocks.send).not.toHaveBeenCalled()
  })

  it('Resend API error - returns failed with error message', async () => {
    resendMocks.send.mockResolvedValueOnce({
      data: null,
      error: { message: 'Provider rejected the message' },
    })
    createEmailWorkflow({ to: 'test@example.com' })

    await executeWorkflow(workflowId, tenantId, db, runId)

    expect(latestResults()[0]).toMatchObject({
      status: 'failed',
      error: 'send_failed',
      output: 'Email failed: Provider rejected the message',
    })
  })
})
