export const INTENT_TYPES = {
  CODING:        'coding',
  GENERAL_CHAT:  'general_chat',
  DATA_ANALYSIS: 'data_analysis',
  DOCUMENT_QA:   'document_qa',
  COMPLIANCE:    'compliance',
  CUSTOM:        'custom',
}

export const INTENT_TAG_MAP = {
  coding:        ['coding', 'code', 'programming', 'development', 'general'],
  general_chat:  ['general', 'chat'],
  data_analysis: ['data', 'analysis', 'analytics', 'csv', 'general'],
  document_qa:   ['document', 'docs', 'knowledge', 'general'],
  compliance:    ['compliance', 'legal', 'regulatory', 'dora', 'gdpr', 'general'],
  custom:        ['general'],
}