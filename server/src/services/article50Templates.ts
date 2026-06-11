export const ARTICLE50_TEMPLATES = {
  general: {
    name: 'General (EU AI Act Article 50)',
    regulations: ['EU AI Act Article 50'],
    disclosureStatement: 'This interaction was processed by an AI system. The user was or should have been informed of AI involvement.',
    requiredFields: ['interaction_timestamp', 'disclosure_made', 'output_summary'],
    retentionYears: 3,
  },
  healthcare: {
    name: 'Healthcare (EU AI Act + HIPAA-aligned)',
    regulations: ['EU AI Act Article 50', 'EU AI Act Annex III (high-risk)', 'HIPAA §164.312'],
    disclosureStatement: 'AI-assisted clinical decision support was used. The responsible clinician reviewed and is accountable for the final decision.',
    requiredFields: ['interaction_timestamp', 'disclosure_made', 'output_summary', 'human_review_confirmed'],
    retentionYears: 10,
    highRisk: true,
  },
  financial: {
    name: 'Financial Services (EU AI Act + DORA + MiFID II)',
    regulations: ['EU AI Act Article 50', 'DORA Article 17', 'MiFID II Article 25'],
    disclosureStatement: 'AI assistance was used in this financial decision or communication. Records are maintained per DORA operational resilience requirements.',
    requiredFields: ['interaction_timestamp', 'disclosure_made', 'output_summary', 'risk_score'],
    retentionYears: 7,
    highRisk: true,
  },
  hr_legal: {
    name: 'HR / Legal (EU AI Act Article 50)',
    regulations: ['EU AI Act Article 50', 'EU AI Act Annex III §4 (employment high-risk)'],
    disclosureStatement: 'AI tools were used in this HR or legal workflow. Human oversight was maintained. Records retained per Article 50 requirements.',
    requiredFields: ['interaction_timestamp', 'disclosure_made', 'output_summary', 'human_review_confirmed'],
    retentionYears: 5,
    highRisk: true,
  },
}

export function getArticle50Template(templateId = 'general') {
  return ARTICLE50_TEMPLATES[templateId] || null
}
