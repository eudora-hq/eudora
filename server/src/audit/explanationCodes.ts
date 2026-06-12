export const EXPLANATION_CODES = {
  ALLOWED:            'allowed',
  GUARD_VIOLATION:    'guard_violation',
  SCOPE_VIOLATION:    'scope_violation',
  INJECTION_DETECTED: 'injection_detected',
  PII_DETECTED:       'pii_detected',
  AUTH_EVENT:         'auth_event',
  ADMIN_ACTION:       'admin_action',
  SYSTEM_EVENT:       'system_event',
} as const

export type ExplanationCode = typeof EXPLANATION_CODES[keyof typeof EXPLANATION_CODES]

export function deriveExplanationCode(
  action: string,
  metadata: Record<string, any>
): ExplanationCode {
  if (action === 'guard_block') return EXPLANATION_CODES.GUARD_VIOLATION
  if (action === 'scope_violation') return EXPLANATION_CODES.SCOPE_VIOLATION
  if (action === 'injection_detected') return EXPLANATION_CODES.INJECTION_DETECTED
  if (metadata.piiDetected === true) return EXPLANATION_CODES.PII_DETECTED
  if (action === 'login' || action === 'logout') return EXPLANATION_CODES.AUTH_EVENT
  if (action.startsWith('agent_') || action.startsWith('api_key_')) {
    return EXPLANATION_CODES.ADMIN_ACTION
  }
  if (action === 'cron_run' || action === 'workflow_run') {
    return EXPLANATION_CODES.SYSTEM_EVENT
  }
  return EXPLANATION_CODES.ALLOWED
}
