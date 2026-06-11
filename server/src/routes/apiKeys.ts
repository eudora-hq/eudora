import { adaptDatabase } from '../db/index.ts'
import { nanoid } from 'nanoid'
import { encrypt, decrypt } from '../utils/encryption.ts'
import { refreshOAuthToken } from '../utils/oauthRefresh.ts'
import { tunnelBaseUrl } from '../services/tunnelService.ts'

const REQUIRE_KEY = new Set(['anthropic', 'openai', 'gemini'])
const REQUIRE_URL = new Set(['ollama', 'custom'])

export default async function apiKeysRoutes(fastify) {
  const db = adaptDatabase(fastify.db)
  const apiKeyColumns = new Set((await db.columns('api_keys')).map((col) => col.name))
  const hasModelName = apiKeyColumns.has('model_name')
  const hasDefaultModel = apiKeyColumns.has('default_model')
  const hasTunnelId = apiKeyColumns.has('tunnel_id')

  // POST /api-keys
  fastify.post('/', async (request, reply) => {
    const {
      provider,
      auth_type = 'key',
      label,
      key,
      base_url,
      default_model,
      tunnel_id,
    } = request.body || {}

    if (!provider) return reply.code(400).send({ error: 'provider is required' })
    if (!label) return reply.code(400).send({ error: 'label is required' })

    if (provider === 'openai_oauth') {
      return reply.code(400).send({ error: 'OAuth keys are created via the OAuth flow, not this endpoint' })
    }
    if (REQUIRE_KEY.has(provider) && !key) {
      return reply.code(400).send({ error: `key is required for provider ${provider}` })
    }
    if (REQUIRE_URL.has(provider) && !base_url) {
      return reply.code(400).send({ error: `base_url is required for provider ${provider}` })
    }
    if (provider === 'tunnel') {
      if (!hasTunnelId) return reply.code(503).send({ error: 'tunnels_not_available' })
      if (!tunnel_id) return reply.code(400).send({ error: 'tunnel_id is required' })
      const tunnel = await db.get(
        'SELECT id FROM tunnels WHERE id = ? AND tenant_id = ?',
        [tunnel_id, request.tenantId]
      )
      if (!tunnel) return reply.code(404).send({ error: 'tunnel_not_found' })
    }

    let key_encrypted: any = null
    let key_iv: any = null
    if (key) {
      const { ciphertext, iv } = encrypt(key)
      key_encrypted = ciphertext
      key_iv = iv
    }

    const id = nanoid()
    const created_at = Date.now()
    const columns = [
      'id', 'tenant_id', 'user_id', 'provider', 'auth_type', 'label',
      'base_url', 'key_encrypted', 'key_iv',
    ]
    const values = [
      id, request.tenantId, request.user.userId, provider, auth_type, label,
      base_url ?? null, key_encrypted, key_iv,
    ]
    if (hasModelName) {
      columns.push('model_name')
      values.push(request.body.model_name ?? null)
    }
    if (hasDefaultModel) {
      columns.push('default_model')
      values.push(default_model?.trim() || null)
    }
    if (hasTunnelId) {
      columns.push('tunnel_id')
      values.push(provider === 'tunnel' ? tunnel_id : null)
    }
    columns.push('created_at')
    values.push(created_at)

    await db.query(
      `INSERT INTO api_keys (${columns.join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})`,
      values
    )

    return reply.code(201).send({
      id,
      provider,
      auth_type,
      label,
      base_url: base_url ?? null,
      default_model: default_model?.trim() || null,
      ...(hasTunnelId ? { tunnel_id: provider === 'tunnel' ? tunnel_id : null } : {}),
      created_at,
    })
  })

  // POST /api-keys/test
  fastify.post('/test', async (request, reply) => {
    const { id } = request.body || {}

    const row = await db.get('SELECT * FROM api_keys WHERE id = ?', [id])
    if (!row) return reply.code(404).send({ error: 'not_found' })
    if (row.tenant_id !== request.tenantId) return reply.code(403).send({ error: 'forbidden' })

    // For OAuth keys, refresh the access token if needed and use it
    if (row.auth_type === 'oauth') {
      const start = Date.now()
      let success = false
      let errorMsg
      try {
        const fresh = await refreshOAuthToken(db, id, request.tenantId)
        const accessToken = decrypt(fresh.oauth_access_token_encrypted, fresh.oauth_access_token_iv)
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        })
        success = res.status < 500
      } catch (err) {
        errorMsg = err.message
        success = false
      }
      const latencyMs = Date.now() - start
      return reply.send({ success, latencyMs, ...(errorMsg ? { error: errorMsg } : {}) })
    }

    let decryptedKey: any = null
    if (row.key_encrypted) {
      decryptedKey = decrypt(row.key_encrypted, row.key_iv)
    }

    const start = Date.now()
    let success = false
    let errorMsg

    try {
      let res
      if (row.provider === 'anthropic') {
        res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': decryptedKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-3-haiku-20240307',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        })
        // Any response (even 400) means the key reached the server
        success = res.status < 500
      } else if (row.provider === 'openai') {
        res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${decryptedKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        })
        success = res.status < 500
      } else if (row.provider === 'gemini') {
        res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${decryptedKey}`
        )
        success = res.ok
      } else if (row.provider === 'ollama') {
        res = await fetch(`${row.base_url}/api/tags`)
        success = res.ok
      } else if (row.provider === 'tunnel') {
        res = await fetch(`${tunnelBaseUrl(row.tunnel_id)}/api/tags`)
        success = res.ok
      } else if (row.provider === 'custom') {
        res = await fetch(`${row.base_url}/v1/models`)
        success = res.ok
      }
    } catch (err) {
      errorMsg = err.message
      success = false
    }

    const latencyMs = Date.now() - start
    return reply.send({ success, latencyMs, ...(errorMsg ? { error: errorMsg } : {}) })
  })

  // GET /api-keys
  fastify.get('/', async (request, reply) => {
    const tunnelColumn = hasTunnelId ? ', tunnel_id' : ''
    const rows = await db.all(
        `SELECT id, provider, auth_type, label, base_url, default_model${tunnelColumn},
          key_encrypted IS NOT NULL AS has_key, created_at
         FROM api_keys WHERE tenant_id = ?`
      , [request.tenantId])
    return reply.send(rows)
  })

  // PATCH /api-keys/:id
  fastify.patch('/:id', async (request, reply) => {
    const { id } = request.params
    const { base_url, default_model } = request.body || {}
    const row = await db.get(`
      SELECT id, tenant_id, provider
      FROM api_keys
      WHERE id = ?
    `, [id])

    if (!row) return reply.code(404).send({ error: 'not_found' })
    if (row.tenant_id !== request.tenantId) {
      return reply.code(403).send({ error: 'forbidden' })
    }
    const updatingBaseUrl = base_url !== undefined
    const updatingModel = default_model !== undefined
    if (!updatingBaseUrl && !updatingModel) {
      return reply.code(400).send({ error: 'no_updates' })
    }
    if (updatingBaseUrl && row.provider !== 'ollama') {
      return reply.code(400).send({ error: 'provider_not_supported' })
    }

    let normalizedUrl: any = null
    if (updatingBaseUrl) {
      let parsed
      try {
        parsed = new URL(base_url)
      } catch {
        return reply.code(400).send({ error: 'invalid_base_url' })
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return reply.code(400).send({ error: 'invalid_base_url' })
      }
      normalizedUrl = base_url.replace(/\/+$/, '')
    }

    const existing = await db.get(
      'SELECT base_url, default_model FROM api_keys WHERE id = ? AND tenant_id = ?',
      [id, request.tenantId]
    )
    await db.query(`
      UPDATE api_keys
      SET base_url = ?, default_model = ?
      WHERE id = ? AND tenant_id = ?
    `, [updatingBaseUrl ? normalizedUrl : existing.base_url,
      updatingModel ? (default_model?.trim() || null) : existing.default_model,
      id,
      request.tenantId])

    const updated = await db.get(
      'SELECT id, provider, base_url, default_model FROM api_keys WHERE id = ? AND tenant_id = ?'
    , [id, request.tenantId])
    return reply.send(updated)
  })

  // DELETE /api-keys/:id
  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params

    const row = await db.get('SELECT id, tenant_id FROM api_keys WHERE id = ?', [id])
    if (!row) return reply.code(404).send({ error: 'not_found' })
    if (row.tenant_id !== request.tenantId) return reply.code(403).send({ error: 'forbidden' })

    // Nullify any agents using this key before deleting
    await db.query('UPDATE agents SET api_key_id = NULL WHERE api_key_id = ? AND tenant_id = ?', [id, request.tenantId])
    await db.query('DELETE FROM api_keys WHERE id = ?', [id])
    return reply.send({ success: true })
  })
}
