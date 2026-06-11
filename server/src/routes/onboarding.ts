import { adaptDatabase } from '../db/index.ts'
import { relay } from '../core/modelRelay.ts'

const AGENT_SYSTEM_PROMPT = `You are an AI agent configuration generator. Given a description of what an agent should do,
generate a JSON object with exactly these fields:
{
  "name": "short agent name in 2-3 words ALL CAPS",
  "purpose": "one sentence describing what this agent does",
  "systemPrompt": "detailed system prompt for the agent (3-5 sentences)",
  "suggestedTags": ["tag1", "tag2", "tag3"]
}
Return ONLY the JSON object. No other text.`

function extractJson(text) {
  const trimmed = String(text || '').trim()
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  try {
    return JSON.parse(unfenced)
  } catch {
    const start = unfenced.indexOf('{')
    const end = unfenced.lastIndexOf('}')
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(unfenced.slice(start, end + 1))
    }
    throw new Error('invalid_json')
  }
}

function fallbackAgent(intent) {
  const cleanIntent = String(intent || 'Run a helpful AI workflow').trim()
  const words = cleanIntent
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join(' ')
    .toUpperCase()

  return {
    name: words || 'CUSTOM AGENT',
    purpose: `This agent helps with: ${cleanIntent}.`,
    systemPrompt: `You are a focused AI agent built to help with ${cleanIntent}. Ask clarifying questions when the task is ambiguous. Provide concise, structured answers with practical next steps. Stay within the user's stated scope and avoid inventing facts.`,
    suggestedTags: ['custom', 'onboarding', 'agent'],
  }
}

function normalizeAgentConfig(config, intent) {
  const fallback = fallbackAgent(intent)
  return {
    name: typeof config.name === 'string' && config.name.trim() ? config.name.trim().toUpperCase() : fallback.name,
    purpose: typeof config.purpose === 'string' && config.purpose.trim() ? config.purpose.trim() : fallback.purpose,
    systemPrompt: typeof config.systemPrompt === 'string' && config.systemPrompt.trim()
      ? config.systemPrompt.trim()
      : fallback.systemPrompt,
    suggestedTags: Array.isArray(config.suggestedTags) && config.suggestedTags.length
      ? config.suggestedTags.slice(0, 5).map((tag) => String(tag).trim()).filter(Boolean)
      : fallback.suggestedTags,
  }
}

function parseCronIntent(intent) {
  const text = String(intent || '').toLowerCase()

  if (text.includes('every hour')) {
    return {
      schedule: '0 * * * *',
      preset: 'every_hour',
      humanLabel: 'Every hour',
      suggestedPrompt: 'Run your scheduled task',
    }
  }

  if (text.includes('every morning')) {
    return {
      schedule: '0 9 * * *',
      preset: 'daily_9am',
      humanLabel: 'Every day at 9:00 AM',
      suggestedPrompt: 'Summarise the morning briefing',
    }
  }

  if (text.includes('every day') || text.includes('daily')) {
    return {
      schedule: '0 9 * * *',
      preset: 'daily_9am',
      humanLabel: 'Every day at 9:00 AM',
      suggestedPrompt: 'Run your daily task',
    }
  }

  if (text.includes('every monday') || text.includes('weekly')) {
    return {
      schedule: '0 9 * * 1',
      preset: 'weekly_monday',
      humanLabel: 'Every Monday at 9:00 AM',
      suggestedPrompt: 'Weekly summary',
    }
  }

  if (text.includes('every month')) {
    return {
      schedule: '0 9 1 * *',
      preset: 'monthly',
      humanLabel: '1st of every month at 9:00 AM',
      suggestedPrompt: 'Monthly report',
    }
  }

  return {
    schedule: '0 9 * * *',
    preset: 'daily_9am',
    humanLabel: 'Every day at 9:00 AM',
    suggestedPrompt: intent,
  }
}

export default async function onboardingRoutes(fastify) {
  const db = adaptDatabase(fastify.db)

  fastify.post('/generate-agent', async (request, reply) => {
    const { intent, apiKeyId } = request.body || {}

    if (!intent || typeof intent !== 'string') {
      return reply.code(400).send({ error: 'intent is required' })
    }
    if (!apiKeyId) {
      return reply.code(400).send({ error: 'apiKeyId is required' })
    }

    const key = await db.get('SELECT id, tenant_id FROM api_keys WHERE id = ?', [apiKeyId])
    if (!key) return reply.code(404).send({ error: 'api_key_not_found' })
    if (key.tenant_id !== request.tenantId) return reply.code(403).send({ error: 'forbidden' })

    try {
      const { content } = await relay({
        messages: [
          { role: 'system', content: AGENT_SYSTEM_PROMPT },
          { role: 'user', content: intent },
        ],
      }, apiKeyId, request.tenantId)

      return reply.send(normalizeAgentConfig(extractJson(content), intent))
    } catch (err) {
      if (err.message === 'invalid_json' || err instanceof SyntaxError) {
        return reply.send(fallbackAgent(intent))
      }
      throw err
    }
  })

  fastify.post('/generate-cron', async (request, reply) => {
    const { intent, agentId } = request.body || {}

    if (!intent || typeof intent !== 'string') {
      return reply.code(400).send({ error: 'intent is required' })
    }
    if (!agentId) {
      return reply.code(400).send({ error: 'agentId is required' })
    }

    const agent = await db.get('SELECT id, tenant_id FROM agents WHERE id = ?', [agentId])
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })
    if (agent.tenant_id !== request.tenantId) return reply.code(403).send({ error: 'forbidden' })

    return reply.send(parseCronIntent(intent))
  })
}
