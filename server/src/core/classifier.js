import getDb from '../db/client.js'
import { adaptDatabase } from '../db/index.js'
import { decrypt } from '../utils/encryption.js'
import { INTENT_TYPES } from '../../../shared/constants/intentTypes.js'
import { refreshOAuthToken } from '../utils/oauthRefresh.js'
import { tunnelBaseUrl } from '../services/tunnelService.js'

export class InvalidApiKeyError extends Error {
  constructor(msg = 'Invalid API key') {
    super(msg)
    this.name = 'InvalidApiKeyError'
  }
}

export class ProviderRateLimitError extends Error {
  constructor(msg = 'Provider rate limit exceeded') {
    super(msg)
    this.name = 'ProviderRateLimitError'
  }
}

export class ProviderUnavailableError extends Error {
  constructor(msg = 'Provider unavailable') {
    super(msg)
    this.name = 'ProviderUnavailableError'
  }
}

const SYSTEM_PROMPT =
  'You are an intent classifier. Respond with ONLY a valid JSON object in this exact format: {"intent":"<intent>","confidence":<number>}\n' +
  'The intent must be one of: coding, general_chat, data_analysis, document_qa, compliance, custom\n' +
  'Do not include any other text, explanation, or formatting. Only the JSON object.'

const VALID_INTENTS = new Set(Object.values(INTENT_TYPES))
const FALLBACK = { intent: 'general_chat', confidence: 0 }

function checkStatus(res) {
  if (res.status === 401) throw new InvalidApiKeyError()
  if (res.status === 429) throw new ProviderRateLimitError()
  if (res.status === 500 || res.status === 503) throw new ProviderUnavailableError()
}

export async function classify(userMessage, apiKeyId, tenantId) {
  try {
    const db = adaptDatabase(getDb())
    const row = await db.get('SELECT * FROM api_keys WHERE id = ?', [apiKeyId])
    if (!row || row.tenant_id !== tenantId) throw new Error('API key not found or access denied')

    let decryptedKey = null
    let activeRow = row

    if (row.auth_type === 'oauth') {
      activeRow = await refreshOAuthToken(db, apiKeyId, tenantId)
      decryptedKey = decrypt(activeRow.oauth_access_token_encrypted, activeRow.oauth_access_token_iv)
    } else if (row.key_encrypted) {
      decryptedKey = decrypt(row.key_encrypted, row.key_iv)
    }

    const { provider } = activeRow
    let responseText

    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': decryptedKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 50,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userMessage }],
        }),
      })
      checkStatus(res)
      const data = await res.json()
      responseText = data.content[0].text

    } else if (provider === 'openai' || provider === 'openai_oauth') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${decryptedKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: 50,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
        }),
      })
      checkStatus(res)
      const data = await res.json()
      responseText = data.choices[0].message.content

    } else if (provider === 'gemini') {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${decryptedKey}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: userMessage }] }],
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            generationConfig: { maxOutputTokens: 50 },
          }),
        }
      )
      checkStatus(res)
      const data = await res.json()
      responseText = data.candidates[0].content.parts[0].text

    } else if (provider === 'ollama' || provider === 'tunnel') {
      const baseUrl = provider === 'tunnel'
        ? tunnelBaseUrl(activeRow.tunnel_id)
        : activeRow.base_url
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: activeRow?.model_name || 'qwen2.5-coder:14b',
          stream: false,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
        }),
      })
      checkStatus(res)
      const data = await res.json()
      responseText = data.message.content

    } else if (provider === 'custom') {
      const headers = { 'content-type': 'application/json' }
      if (decryptedKey) headers.Authorization = `Bearer ${decryptedKey}`
      const res = await fetch(`${activeRow.base_url}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: activeRow?.model_name || 'qwen2.5-coder:14b',
          max_tokens: 50,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
        }),
      })
      checkStatus(res)
      const data = await res.json()
      responseText = data.choices[0].message.content

    } else {
      throw new Error(`Unsupported provider: ${provider}`)
    }

    const parsed = JSON.parse(responseText)
    if (!VALID_INTENTS.has(parsed.intent)) throw new Error('Invalid intent value')
    return { intent: parsed.intent, confidence: parsed.confidence }

  } catch {
    return FALLBACK
  }
}
