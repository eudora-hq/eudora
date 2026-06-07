import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEudoraFetch, wrapAnthropic, wrapOpenAI } from './index'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('wrapOpenAI', () => {
  it('routes chat completions through Eudora and preserves other properties', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'chatcmpl-test' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = wrapOpenAI({ models: { list: 'native' } }, {
      proxyKey: 'eudora-proxy-test',
    })

    const result = await client.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    expect(result).toEqual({ id: 'chatcmpl-test' })
    expect(client.models).toEqual({ list: 'native' })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.geteudora.com/proxy/openai/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer eudora-proxy-test',
        }),
      }),
    )
  })

  it('surfaces Eudora proxy errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ message: 'Request blocked' }),
    }))
    const client = wrapOpenAI({}, { proxyKey: 'eudora-proxy-test' })

    await expect(client.chat.completions.create({})).rejects.toThrow('Request blocked')
  })
})

describe('wrapAnthropic', () => {
  it('routes messages through the Anthropic proxy', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'msg-test' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = wrapAnthropic({}, { proxyKey: 'eudora-proxy-test' })

    await client.messages.create({ model: 'claude-test', messages: [] })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.geteudora.com/proxy/anthropic/v1/messages',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer eudora-proxy-test',
        }),
      }),
    )
  })
})

describe('createEudoraFetch', () => {
  it('rewrites provider URLs and replaces provider authorization', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    const eudoraFetch = createEudoraFetch({
      proxyKey: 'eudora-proxy-test',
      baseUrl: 'https://eudora.example.com/',
    })

    await eudoraFetch('https://api.openai.com/v1/chat/completions', {
      headers: { Authorization: 'Bearer provider-key' },
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://eudora.example.com/proxy/openai/v1/chat/completions')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer eudora-proxy-test')
  })
})
