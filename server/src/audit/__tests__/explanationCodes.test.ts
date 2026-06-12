import { describe, expect, it } from 'vitest'
import { deriveExplanationCode } from '../explanationCodes.ts'

describe('deriveExplanationCode', () => {
  it('maps guard blocks to guard violations', () => {
    expect(deriveExplanationCode('guard_block', {})).toBe('guard_violation')
  })

  it('maps ordinary chat messages to allowed', () => {
    expect(deriveExplanationCode('chat_message', {})).toBe('allowed')
  })

  it('maps login events to auth events', () => {
    expect(deriveExplanationCode('login', {})).toBe('auth_event')
  })

  it('maps scope violations deterministically', () => {
    expect(deriveExplanationCode('scope_violation', {})).toBe('scope_violation')
  })

  it('maps PII metadata before the default action result', () => {
    expect(deriveExplanationCode('chat_message', { piiDetected: true })).toBe('pii_detected')
  })
})
