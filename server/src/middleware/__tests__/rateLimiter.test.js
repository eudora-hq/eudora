import { describe, it, expect, afterEach, vi } from 'vitest'
import { nanoid } from 'nanoid'
import { rateLimiter } from '../rateLimiter.js'
process.env.SELF_HOSTED = 'false'

afterEach(() => {
  vi.useRealTimers()
})

function makeRequest(tenantId, plan = 'trial') {
  return { tenantId, tenant: { plan } }
}

function makeReply() {
  const reply = {
    _code: null,
    _body: null,
    sent: false,
    code(c) {
      this._code = c
      return this
    },
    send(b) {
      this._body = b
      this.sent = true
      return this
    },
  }
  return reply
}

function callLimiter(tenantId, plan = 'trial') {
  const reply = makeReply()
  let passed = false
  rateLimiter(makeRequest(tenantId, plan), reply, () => {
    passed = true
  })
  return { reply, passed }
}

describe('rateLimiter', () => {
  it('59 requests in under 60s are all allowed (trial limit is 60)', () => {
    vi.useFakeTimers()
    const tenantId = nanoid()
    for (let i = 0; i < 59; i++) {
      const { reply, passed } = callLimiter(tenantId)
      expect(reply.sent).toBe(false)
      expect(passed).toBe(true)
    }
  })

  it('61st request in under 60s gets 429', () => {
    vi.useFakeTimers()
    const tenantId = nanoid()

    // First 60 succeed
    for (let i = 0; i < 60; i++) {
      const { reply } = callLimiter(tenantId)
      expect(reply.sent).toBe(false)
    }

    // 61st is rejected
    const { reply } = callLimiter(tenantId)
    expect(reply._code).toBe(429)
    expect(reply._body.error).toBe('rate_limit_exceeded')
    expect(typeof reply._body.retryAfter).toBe('number')
  })

  it('after the 60-second window passes, the tenant can make requests again', () => {
    vi.useFakeTimers()
    const tenantId = nanoid()

    // Fill the window to the limit
    for (let i = 0; i < 60; i++) {
      callLimiter(tenantId)
    }

    // Advance 61 seconds — all previous timestamps now outside the window
    vi.advanceTimersByTime(61 * 1000)

    const { reply, passed } = callLimiter(tenantId)
    expect(reply.sent).toBe(false)
    expect(passed).toBe(true)
  })
})
