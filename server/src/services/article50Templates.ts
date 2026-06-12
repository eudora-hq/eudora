export const ARTICLE50_TEMPLATES = {
  general: {
    name: 'General (EU AI Act Article 50)',
    regulations: ['EU AI Act Article 50'],
    disclosureStatement: 'This interaction was processed by an AI system. The natural person was informed of AI involvement at or before the time of first interaction, in accordance with Article 50(1) of Regulation (EU) 2024/1689.',
    requiredFields: ['interaction_timestamp', 'disclosure_made', 'output_summary'],
    retentionYears: 3,
  },
  healthcare: {
    name: 'Healthcare (EU AI Act + HIPAA-aligned)',
    regulations: ['EU AI Act Article 50', 'EU AI Act Annex III (high-risk)', 'HIPAA §164.312'],
    disclosureStatement: 'AI-assisted clinical decision support was used in this interaction. The responsible clinician reviewed and is accountable for the final decision, in accordance with EU AI Act Article 50 and Annex III high-risk system requirements (Regulation (EU) 2024/1689).',
    requiredFields: ['interaction_timestamp', 'disclosure_made', 'output_summary', 'human_review_confirmed'],
    retentionYears: 10,
    highRisk: true,
  },
  financial: {
    name: 'Financial Services (EU AI Act + DORA + MiFID II)',
    regulations: ['EU AI Act Article 50', 'DORA Article 17', 'MiFID II Article 25'],
    disclosureStatement: 'AI assistance was used in this financial decision or communication. This disclosure is made in accordance with EU AI Act Article 50(1) (Regulation (EU) 2024/1689). Records are maintained in accordance with DORA Article 17 operational resilience requirements.',
    requiredFields: ['interaction_timestamp', 'disclosure_made', 'output_summary', 'risk_score'],
    retentionYears: 7,
    highRisk: true,
  },
  hr_legal: {
    name: 'HR / Legal (EU AI Act Article 50)',
    regulations: ['EU AI Act Article 50', 'EU AI Act Annex III §4 (employment high-risk)'],
    disclosureStatement: 'AI tools were used in this HR or legal workflow. Human oversight was maintained throughout. Records are retained in accordance with EU AI Act Article 50 (Regulation (EU) 2024/1689) and applicable national employment law.',
    requiredFields: ['interaction_timestamp', 'disclosure_made', 'output_summary', 'human_review_confirmed'],
    retentionYears: 5,
    highRisk: true,
  },
}

export function getArticle50Template(templateId = 'general') {
  return ARTICLE50_TEMPLATES[templateId] || null
}
