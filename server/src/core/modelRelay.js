import getDb from '../db/client.js'
import { decrypt } from '../utils/encryption.js'
import { refreshOAuthToken } from '../utils/oauthRefresh.js'
import { resolveModel } from '../utils/resolveModel.js'

export class InvalidApiKeyError extends Error {
  constructor(provider) {
    super(`Invalid API key for provider: ${provider}`)
    this.name = 'InvalidApiKeyError'
    this.provider = provider
  }
}

export class ProviderRateLimitError extends Error {
  constructor(provider) {
    super(`Rate limit exceeded for provider: ${provider}`)
    this.name = 'ProviderRateLimitError'
    this.provider = provider
  }
}

export class ProviderUnavailableError extends Error {
  constructor(provider) {
    super(`Provider unavailable: ${provider}`)
    this.name = 'ProviderUnavailableError'
    this.provider = provider
  }
}

function checkStatus(res, provider) {
  if (res.status === 401) throw new InvalidApiKeyError(provider)
  if (res.status === 429) throw new ProviderRateLimitError(provider)
  if (res.status === 500 || res.status === 503) throw new ProviderUnavailableError(provider)
  if (!res.ok) throw new Error(`Provider ${provider} returned HTTP ${res.status}`)
}

export async function relay(composedPrompt, apiKeyId, tenantId, modelOverride = null) {
  const db = getDb()
  const row = await db.get('SELECT * FROM api_keys WHERE id = ?', [apiKeyId])
  if (!row || row.tenant_id !== tenantId) throw new Error('API key not found or access denied')

  const { provider } = row
  const configuredModel = resolveModel({ model_override: modelOverride }, row)

  // Resolve credential — scoped here, never stored beyond this function
  let activeRow = row
  if (row.auth_type === 'oauth') {
    activeRow = await refreshOAuthToken(db, apiKeyId, tenantId)
  }

  const credential =
    row.auth_type === 'oauth'
      ? decrypt(activeRow.oauth_access_token_encrypted, activeRow.oauth_access_token_iv)
      : activeRow.key_encrypted
        ? decrypt(activeRow.key_encrypted, activeRow.key_iv)
        : null

  let content
  let tokensUsed
  let resolvedModel

  if (provider === 'anthropic') {
    resolvedModel = configuredModel || 'claude-sonnet-4-20250514'
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': credential,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: resolvedModel,
        max_tokens: 4096,
        system: composedPrompt.messages[0].content,
        messages: [{ role: 'user', content: composedPrompt.messages[1].content }],
      }),
    })
    checkStatus(res, provider)
    const data = await res.json()
    content = data.content[0].text
    tokensUsed = {
      input: data.usage.input_tokens,
      output: data.usage.output_tokens,
      total: data.usage.input_tokens + data.usage.output_tokens,
    }

  } else if (provider === 'openai' || provider === 'openai_oauth') {
    resolvedModel = configuredModel || 'gpt-4o'
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: resolvedModel,
        max_tokens: 4096,
        messages: composedPrompt.messages,
      }),
    })
    checkStatus(res, provider)
    const data = await res.json()
    content = data.choices[0].message.content
    tokensUsed = {
      input: data.usage.prompt_tokens,
      output: data.usage.completion_tokens,
      total: data.usage.total_tokens,
    }

  } else if (provider === 'gemini') {
    resolvedModel = configuredModel || 'gemini-2.0-flash'
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(resolvedModel)}:generateContent?key=${credential}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: composedPrompt.messages[1].content }] }],
          systemInstruction: { parts: [{ text: composedPrompt.messages[0].content }] },
          generationConfig: { maxOutputTokens: 4096 },
        }),
      }
    )
    checkStatus(res, provider)
    const data = await res.json()
    content = data.candidates[0].content.parts[0].text
    tokensUsed = {
      input: data.usageMetadata.promptTokenCount,
      output: data.usageMetadata.candidatesTokenCount,
      total: data.usageMetadata.totalTokenCount,
    }

  } else if (provider === 'ollama') {
    resolvedModel = configuredModel || activeRow.model_name || 'qwen2.5-coder:14b'
    const headers = { 'content-type': 'application/json' }
    if (credential) headers.Authorization = `Bearer ${credential}`
    const res = await fetch(`${activeRow.base_url}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: resolvedModel,
        stream: false,
        messages: composedPrompt.messages,
      }),
    })
    checkStatus(res, provider)
    const data = await res.json()
    content = data.message.content
    tokensUsed = {
      input: data.prompt_eval_count || 0,
      output: data.eval_count || 0,
      total: (data.prompt_eval_count || 0) + (data.eval_count || 0),
    }

  } else if (provider === 'custom') {
    resolvedModel = configuredModel || 'default'
    const headers = { 'content-type': 'application/json' }
    if (credential) headers.Authorization = `Bearer ${credential}`
    const res = await fetch(`${activeRow.base_url}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: resolvedModel,
        max_tokens: 4096,
        messages: composedPrompt.messages,
      }),
    })
    checkStatus(res, provider)
    const data = await res.json()
    content = data.choices[0].message.content
    tokensUsed = {
      input: data.usage?.prompt_tokens || 0,
      output: data.usage?.completion_tokens || 0,
      total: data.usage?.total_tokens || 0,
    }

  } else {
    throw new Error(`Unsupported provider: ${provider}`)
  }

  return { content, tokensUsed, resolvedModel }
}
