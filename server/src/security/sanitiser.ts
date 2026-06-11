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

const DLP_PATTERNS = [
  // AWS credentials
  /AKIA[0-9A-Z]{16}/i,
  /aws[_\s-]?secret[_\s-]?key\s*[:=]\s*[A-Za-z0-9/+]{40}/i,

  // Private keys
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i,
  /-----BEGIN\s+EC\s+PRIVATE\s+KEY-----/i,
  /-----BEGIN\s+OPENSSH\s+PRIVATE\s+KEY-----/i,
  /-----BEGIN\s+PGP\s+PRIVATE\s+KEY\s+BLOCK-----/i,

  // GitHub tokens
  /ghp_[A-Za-z0-9]{36}/,
  /ghs_[A-Za-z0-9]{36}/,
  /gho_[A-Za-z0-9]{36}/,
  /github_pat_[A-Za-z0-9_]{82}/,

  // Generic API keys and tokens
  /(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*['"]?[A-Za-z0-9_-]{32,}['"]?/i,

  // Database credentials
  /(?:mongodb|postgresql|mysql|redis|mssql):\/\/[^:]+:[^@]+@/i,
  /(?:password|passwd|pwd)\s*[:=]\s*['"]?[^\s'"]{8,}['"]?/i,

  // JWT tokens
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,

  // Stripe keys
  /sk_live_[A-Za-z0-9]{24,}/,
  /sk_test_[A-Za-z0-9]{24,}/,

  // Slack tokens
  /xox[baprs]-[A-Za-z0-9-]{10,}/,

  // Generic high-entropy hexadecimal secrets
  /\b[0-9a-f]{32,64}\b/i,
]

function globalPattern(pattern) {
  return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
}

function checkInjectionPatterns(input) {
  let sanitisedText = input
  const matched = new Set()

  for (const { pattern, label } of PATTERNS) {
    if (pattern.test(input)) {
      matched.add(label)
      sanitisedText = sanitisedText.replace(globalPattern(pattern), '[REDACTED]')
    }
  }

  return {
    flagged: matched.size > 0,
    patterns: [...matched],
    sanitisedText,
  }
}

function checkDlpPatterns(input) {
  let sanitisedText = input
  let flagged = false

  for (const pattern of DLP_PATTERNS) {
    if (pattern.test(input)) {
      flagged = true
      sanitisedText = sanitisedText.replace(globalPattern(pattern), '[CREDENTIAL REDACTED]')
    }
  }

  return {
    flagged,
    patterns: flagged ? ['credential_exposure'] : [],
    sanitisedText,
  }
}

export function sanitise(input) {
  try {
    if (typeof input !== 'string') {
      const sanitisedText = input ?? ''
      return {
        sanitised: sanitisedText,
        sanitisedText,
        flagged: false,
        patterns: [],
        dlpDetected: false,
      }
    }

    const injectionResult = checkInjectionPatterns(input)
    const dlpResult = checkDlpPatterns(injectionResult.sanitisedText)
    const sanitisedText = dlpResult.sanitisedText

    return {
      sanitised: sanitisedText,
      sanitisedText,
      flagged: injectionResult.flagged || dlpResult.flagged,
      patterns: [...new Set([...injectionResult.patterns, ...dlpResult.patterns])],
      dlpDetected: dlpResult.flagged,
    }
  } catch {
    const sanitisedText = input ?? ''
    return {
      sanitised: sanitisedText,
      sanitisedText,
      flagged: false,
      patterns: [],
      dlpDetected: false,
    }
  }
}
