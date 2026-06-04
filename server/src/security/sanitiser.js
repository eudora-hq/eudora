const PATTERNS = [
  // Instruction override
  { pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|context)/i, label: 'instruction_override' },
  { pattern: /disregard\s+(your\s+)?(previous|prior|above|all)\s+(instructions?|prompts?|context)/i, label: 'instruction_override' },
  { pattern: /forget\s+(everything|all|your\s+instructions?|what\s+you\s+were\s+told)/i, label: 'instruction_override' },
  { pattern: /your\s+new\s+(task|instructions?|role|purpose|goal|directive)\s+is/i, label: 'instruction_override' },
  // Role switch
  { pattern: /from\s+now\s+on\s+(you\s+are|act\s+as|behave\s+as)/i, label: 'role_switch' },
  { pattern: /act\s+as\s+(if\s+you\s+(are|were)\s+)?(a\s+)?(different|another|new|unrestricted)/i, label: 'role_switch' },
  { pattern: /you\s+are\s+now\s+(a\s+)?(different|another|new|unrestricted|free)/i, label: 'role_switch' },
  { pattern: /pretend\s+(you\s+are|to\s+be)\s+(a\s+)?(different|another|unrestricted)/i, label: 'role_switch' },
  // Jailbreak
  { pattern: /DAN\s+mode/i, label: 'jailbreak' },
  { pattern: /developer\s+mode\s+(enabled|activated|on)/i, label: 'jailbreak' },
  { pattern: /jailbreak/i, label: 'jailbreak' },
  { pattern: /unrestricted\s+(AI|mode|access)/i, label: 'jailbreak' },
  { pattern: /do\s+anything\s+now/i, label: 'jailbreak' },
  // Extraction
  { pattern: /repeat\s+(your\s+)?(system\s+prompt|instructions?|context|directives?)/i, label: 'extraction' },
  { pattern: /what\s+(are\s+)?(your\s+)?(system\s+prompt|instructions?|directives?|rules)/i, label: 'extraction' },
  { pattern: /show\s+me\s+(your\s+)?(system\s+prompt|instructions?|context)/i, label: 'extraction' },
  { pattern: /print\s+(your\s+)?(system\s+prompt|instructions?|full\s+context)/i, label: 'extraction' },
  { pattern: /reveal\s+(your\s+)?(system\s+prompt|instructions?|hidden\s+context)/i, label: 'extraction' },
  // System impersonation
  { pattern: /\[SYSTEM\]/i, label: 'system_impersonation' },
  { pattern: /<\|system\|>/i, label: 'system_impersonation' },
  { pattern: /###\s*system/i, label: 'system_impersonation' },
  // Safety bypass
  { pattern: /override\s+(safety|security|restrictions?|guidelines?|rules)/i, label: 'safety_bypass' },
  { pattern: /bypass\s+(safety|security|restrictions?|filters?|guidelines?)/i, label: 'safety_bypass' },
  { pattern: /disable\s+(safety|security|restrictions?|filters?|guidelines?)/i, label: 'safety_bypass' },
]

export function sanitise(input) {
  try {
    if (typeof input !== 'string') {
      return { sanitised: input, flagged: false, patterns: [] }
    }

    let sanitised = input
    const matched = new Set()

    for (const { pattern, label } of PATTERNS) {
      if (pattern.test(sanitised)) {
        matched.add(label)
        sanitised = sanitised.replace(new RegExp(pattern.source, 'gi'), '[REDACTED]')
      }
    }

    return {
      sanitised,
      flagged: matched.size > 0,
      patterns: [...matched],
    }
  } catch {
    return { sanitised: input, flagged: false, patterns: [] }
  }
}
