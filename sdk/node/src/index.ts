export interface EudoraOptions {
  proxyKey: string
  baseUrl?: string
  mode?: 'block' | 'observe' | 'report_only'
}

const DEFAULT_BASE_URL = 'https://api.geteudora.com'

function getBaseUrl(options: EudoraOptions): string {
  return (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

async function parseProxyResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { message?: string }
    throw new Error(error.message || `Eudora proxy error: ${response.status}`)
  }
  return response.json()
}

/**
 * Wrap an OpenAI client to route through Eudora for compliance auditing.
 *
 * @example
 * import OpenAI from 'openai'
 * import { wrapOpenAI } from '@eudora/sdk'
 *
 * const client = wrapOpenAI(new OpenAI({ apiKey: process.env.OPENAI_KEY }), {
 *   proxyKey: 'eudora-proxy-...'
 * })
 *
 * const response = await client.chat.completions.create({...})
 */
export function wrapOpenAI(client: any, options: EudoraOptions): any {
  const baseUrl = getBaseUrl(options)

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'chat') {
        return {
          completions: {
            create: async (params: any) => {
              const response = await fetch(`${baseUrl}/proxy/openai/v1/chat/completions`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${options.proxyKey}`,
                },
                body: JSON.stringify(params),
              })
              return parseProxyResponse(response)
            },
          },
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

/**
 * Wrap an Anthropic client to route through Eudora for compliance auditing.
 */
export function wrapAnthropic(client: any, options: EudoraOptions): any {
  const baseUrl = getBaseUrl(options)

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'messages') {
        return {
          create: async (params: any) => {
            const response = await fetch(`${baseUrl}/proxy/anthropic/v1/messages`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${options.proxyKey}`,
              },
              body: JSON.stringify(params),
            })
            return parseProxyResponse(response)
          },
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

/**
 * Generic HTTP fetch wrapper for fetch-based AI integrations.
 */
export function createEudoraFetch(options: EudoraOptions) {
  const baseUrl = getBaseUrl(options)

  return async function eudoraFetch(url: string, init?: RequestInit): Promise<Response> {
    let proxyUrl = url
    if (url.includes('api.openai.com')) {
      proxyUrl = url.replace('https://api.openai.com', `${baseUrl}/proxy/openai`)
    } else if (url.includes('api.anthropic.com')) {
      proxyUrl = url.replace('https://api.anthropic.com', `${baseUrl}/proxy/anthropic`)
    }

    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${options.proxyKey}`)

    return fetch(proxyUrl, {
      ...init,
      headers,
    })
  }
}
