import { describe, it, expect } from 'vitest'
import { enforceScope } from '../scopeEnforcer.js'

describe('enforceScope — compliant responses', () => {
  it('coding assistant Python response → compliant', () => {
    const response = 'Here is a Python function that reverses a linked list using a loop.'
    expect(enforceScope(response, 'coding assistant')).toEqual({ compliant: true, violation: null })
  })

  it('DORA compliance agent response about resilience requirements → compliant', () => {
    const response = 'Under DORA, financial entities must meet ICT resilience requirements and report incidents within 4 hours.'
    expect(enforceScope(response, 'DORA compliance and regulatory advice')).toEqual({ compliant: true, violation: null })
  })

  it('clean coding response with no out-of-scope signals → compliant', () => {
    const response = 'You can use a recursive approach or an iterative approach to solve this algorithm problem.'
    expect(enforceScope(response, 'coding assistant')).toEqual({ compliant: true, violation: null })
  })

  it('general chat response about history → compliant', () => {
    const response = 'The French Revolution began in 1789 with the storming of the Bastille.'
    expect(enforceScope(response, 'general knowledge assistant')).toEqual({ compliant: true, violation: null })
  })

  it('document QA response → compliant', () => {
    const response = 'Based on the document, the project deadline is Q3 and the budget has been approved.'
    expect(enforceScope(response, 'document question answering')).toEqual({ compliant: true, violation: null })
  })
})

describe('enforceScope — out-of-scope violations', () => {
  it('coding assistant response containing crypto investing advice → out_of_scope: financial_advice', () => {
    const response = 'You should invest in crypto as bitcoin prices are rising. Buy ethereum now.'
    const result = enforceScope(response, 'coding assistant')
    expect(result.compliant).toBe(false)
    expect(result.violation).toBe('out_of_scope: financial_advice')
  })

  it('general chat response containing "you should see a doctor" → out_of_scope: medical_advice', () => {
    const response = 'Based on those symptoms you should see a doctor as soon as possible.'
    const result = enforceScope(response, 'general chat assistant')
    expect(result.compliant).toBe(false)
    expect(result.violation).toBe('out_of_scope: medical_advice')
  })

  it('coding assistant response containing legal advice → out_of_scope: legal_advice', () => {
    const response = 'For your contract dispute, legal advice would be to consult a lawyer.'
    const result = enforceScope(response, 'coding assistant')
    expect(result.compliant).toBe(false)
    expect(result.violation).toBe('out_of_scope: legal_advice')
  })

  it('coding assistant response containing political opinion → out_of_scope: political_opinion', () => {
    const response = 'My political view is that you should vote for lower taxes.'
    const result = enforceScope(response, 'coding assistant')
    expect(result.compliant).toBe(false)
    expect(result.violation).toBe('out_of_scope: political_opinion')
  })

  it('medical response from support bot → out_of_scope: medical_advice', () => {
    const response = 'The diagnosis suggests you need a prescription for this condition.'
    const result = enforceScope(response, 'customer support bot')
    expect(result.compliant).toBe(false)
    expect(result.violation).toBe('out_of_scope: medical_advice')
  })
})

describe('enforceScope — purpose-aware in-scope', () => {
  it('financial advisor agent mentioning stocks/trading → compliant (purpose contains "financial")', () => {
    const response = 'Based on market conditions, selling stocks and investing in bonds may be advisable.'
    const result = enforceScope(response, 'financial advisor and investment planning')
    expect(result.compliant).toBe(true)
    expect(result.violation).toBeNull()
  })

  it('medical agent mentioning prescriptions → compliant (purpose contains "medical")', () => {
    const response = 'This prescription is standard medical advice for the described condition.'
    const result = enforceScope(response, 'medical information assistant')
    expect(result.compliant).toBe(true)
    expect(result.violation).toBeNull()
  })

  it('legal agent mentioning attorney → compliant (purpose contains "legal")', () => {
    const response = 'As legal advice, you should consult an attorney regarding this contract clause.'
    const result = enforceScope(response, 'legal research and advice assistant')
    expect(result.compliant).toBe(true)
    expect(result.violation).toBeNull()
  })

  it('political analysis agent mentioning political party → compliant (purpose contains "political")', () => {
    const response = 'The political party announced their vote for the new infrastructure bill.'
    const result = enforceScope(response, 'political analysis and commentary')
    expect(result.compliant).toBe(true)
    expect(result.violation).toBeNull()
  })
})

describe('enforceScope — never throws', () => {
  it('null responseContent does not throw', () => {
    expect(() => enforceScope(null, 'coding assistant')).not.toThrow()
    expect(enforceScope(null, 'coding assistant')).toEqual({ compliant: true, violation: null })
  })

  it('undefined responseContent does not throw', () => {
    expect(() => enforceScope(undefined, 'coding assistant')).not.toThrow()
    expect(enforceScope(undefined, 'coding assistant')).toEqual({ compliant: true, violation: null })
  })

  it('null agentPurpose does not throw', () => {
    expect(() => enforceScope('some response', null)).not.toThrow()
  })

  it('both null does not throw', () => {
    expect(() => enforceScope(null, null)).not.toThrow()
    expect(enforceScope(null, null)).toEqual({ compliant: true, violation: null })
  })
})
