import { describe, expect, it } from 'vitest'
import { resolveModel } from '../resolveModel.js'

describe('resolveModel', () => {
  it('prefers the agent override over the connection default', () => {
    expect(resolveModel(
      { model_override: 'gpt-4o-mini' },
      { default_model: 'gpt-4o' }
    )).toBe('gpt-4o-mini')
  })

  it('uses the connection default when the agent has no override', () => {
    expect(resolveModel(
      { model_override: null },
      { default_model: 'qwen2.5:14b' }
    )).toBe('qwen2.5:14b')
  })

  it('returns null when neither model is configured', () => {
    expect(resolveModel({ model_override: null }, { default_model: null })).toBeNull()
  })

  it('treats an empty agent override as unset', () => {
    expect(resolveModel(
      { model_override: '' },
      { default_model: 'claude-sonnet-4-20250514' }
    )).toBe('claude-sonnet-4-20250514')
  })
})
