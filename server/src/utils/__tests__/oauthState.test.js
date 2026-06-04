import { describe, it, expect, afterEach, vi } from 'vitest'
import { createState, validateState } from '../oauthState.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('oauthState', () => {
  it('createState() returns a non-empty string', () => {
    const state = createState()
    expect(typeof state).toBe('string')
    expect(state.length).toBeGreaterThan(0)
  })

  it('validateState() returns true for a just-created state', () => {
    const state = createState()
    expect(validateState(state)).toBe(true)
  })

  it('validateState() returns false when called a second time (one-time use)', () => {
    const state = createState()
    validateState(state) // consume it
    expect(validateState(state)).toBe(false)
  })

  it('validateState() returns false for an unknown state', () => {
    expect(validateState('random-unknown-state')).toBe(false)
  })

  it('returns false for a state whose expiry is in the past', () => {
    vi.useFakeTimers()
    const state = createState() // expiry = now + 10 min
    vi.advanceTimersByTime(11 * 60 * 1000) // advance 11 minutes past expiry
    expect(validateState(state)).toBe(false)
  })
})
