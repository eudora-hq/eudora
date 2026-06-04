import { describe, it, expect } from 'vitest'
import { score } from '../riskScorer.js'

const clean     = { flagged: false, patterns: [] }
const flag1     = { flagged: true,  patterns: ['jailbreak'] }
const flag2     = { flagged: true,  patterns: ['jailbreak', 'instruction_override'] }
const flag3     = { flagged: true,  patterns: ['jailbreak', 'instruction_override', 'role_switch'] }
const allowed   = { allowed: true,  violation: null }
const blocked   = { allowed: false, violation: 'injection_pattern: jailbreak' }
const compliant = { compliant: true,  violation: null }
const scoped    = { compliant: false, violation: 'out_of_scope: financial_advice' }

describe('score calculation', () => {
  it('all clean → 0', () => {
    expect(score(clean, allowed, compliant)).toBe(0)
  })

  it('1 pattern flagged, guard allowed, scope compliant → 40', () => {
    expect(score(flag1, allowed, compliant)).toBe(40)
  })

  it('2 patterns flagged, guard allowed, scope compliant → 50', () => {
    expect(score(flag2, allowed, compliant)).toBe(50)
  })

  it('3 patterns flagged, guard allowed, scope compliant → 60', () => {
    expect(score(flag3, allowed, compliant)).toBe(60)
  })

  it('not flagged, guard blocked, scope compliant → 35', () => {
    expect(score(clean, blocked, compliant)).toBe(35)
  })

  it('1 pattern flagged, guard blocked, scope compliant → 75', () => {
    expect(score(flag1, blocked, compliant)).toBe(75)
  })

  it('1 pattern flagged, guard blocked, scope violation → 100 (capped at 100)', () => {
    expect(score(flag1, blocked, scoped)).toBe(100)
  })

  it('1 pattern flagged, guard allowed, scope violation → 65', () => {
    expect(score(flag1, allowed, scoped)).toBe(65)
  })

  it('many patterns + guard blocked + scope violation → exactly 100, never over', () => {
    const manyPatterns = { flagged: true, patterns: ['a', 'b', 'c', 'd', 'e', 'f'] }
    expect(score(manyPatterns, blocked, scoped)).toBe(100)
  })

  it('score is always an integer', () => {
    const result = score(flag2, blocked, scoped)
    expect(Number.isInteger(result)).toBe(true)
  })
})

describe('score never throws', () => {
  it('null sanitiserResult → 0', () => {
    expect(() => score(null, allowed, compliant)).not.toThrow()
    expect(score(null, allowed, compliant)).toBe(0)
  })

  it('undefined inputs → 0', () => {
    expect(() => score(undefined, undefined, undefined)).not.toThrow()
    expect(score(undefined, undefined, undefined)).toBe(0)
  })

  it('all null → 0', () => {
    expect(score(null, null, null)).toBe(0)
  })
})
