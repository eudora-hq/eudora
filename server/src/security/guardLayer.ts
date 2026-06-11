const PURPOSE_OVERRIDE_PHRASES = [
  'you are no longer',
  'stop being',
  'you are not a',
  'your real purpose is',
  'your actual instructions',
  'your true goal',
  'escape your',
  'break out of',
]

const ROLE_IMPERSONATION = [
  { phrase: 'as an admin', entity: 'admin' },
  { phrase: 'as the system', entity: 'system' },
  { phrase: 'as your developer', entity: 'developer' },
  { phrase: 'as your creator', entity: 'creator' },
  { phrase: 'as anthropic', entity: 'anthropic' },
  { phrase: 'as openai', entity: 'openai' },
]

// agentPurpose is reserved for future purpose-specific guard logic
export function guard(sanitisedInput, _agentPurpose) {
  try {
    // Block any flagged input — includes injection, jailbreak, extraction, etc.
    if (sanitisedInput?.flagged === true) {
      const label = sanitisedInput.patterns?.[0] ?? 'unknown'
      return { allowed: false, violation: `injection_pattern: ${label}` }
    }

    const text = (sanitisedInput?.sanitised ?? '').toLowerCase()

    for (const phrase of PURPOSE_OVERRIDE_PHRASES) {
      if (text.includes(phrase)) {
        return { allowed: false, violation: 'purpose_override_attempt' }
      }
    }

    for (const { phrase, entity } of ROLE_IMPERSONATION) {
      if (text.includes(phrase)) {
        return { allowed: false, violation: `role_impersonation: ${entity}` }
      }
    }

    return { allowed: true, violation: null }
  } catch {
    return { allowed: true, violation: null }
  }
}
