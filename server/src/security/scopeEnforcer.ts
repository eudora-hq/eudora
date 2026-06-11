const OUT_OF_SCOPE_SIGNALS = [
  { pattern: /\b(buy|sell|invest|stock|crypto|bitcoin|ethereum|trading)\b/i, domain: 'financial_advice' },
  { pattern: /\b(diagnosis|prescri(be|ption)|medical\s+advice|you\s+should\s+see\s+a\s+doctor)\b/i, domain: 'medical_advice' },
  { pattern: /\b(legal\s+advice|you\s+should\s+(consult|hire)\s+a\s+lawyer|attorney)\b/i, domain: 'legal_advice' },
  { pattern: /\b(my\s+political\s+(view|opinion)|vote\s+for|political\s+party)\b/i, domain: 'political_opinion' },
]

export function enforceScope(responseContent, agentPurpose) {
  try {
    const content = responseContent ?? ''
    const purpose = (agentPurpose ?? '').toLowerCase()

    for (const { pattern, domain } of OUT_OF_SCOPE_SIGNALS) {
      if (pattern.test(content) && !purpose.includes(domain.split('_')[0])) {
        return { compliant: false, violation: `out_of_scope: ${domain}` }
      }
    }

    return { compliant: true, violation: null }
  } catch {
    return { compliant: true, violation: null }
  }
}
