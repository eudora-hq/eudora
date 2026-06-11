/**
 * GitHub Copilot Business audit integration.
 *
 * Required token scopes:
 * - read:audit_log
 * - read:org
 */

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'Eudora',
}

function headers(token) {
  return {
    ...GITHUB_HEADERS,
    Authorization: `Bearer ${token}`,
  }
}

function normalizeTimestamp(value) {
  if (typeof value === 'number') {
    return value < 10_000_000_000 ? value * 1000 : value
  }
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : Date.now()
}

export async function testGithubConnection(config) {
  try {
    const response = await fetch(
      `https://api.github.com/orgs/${encodeURIComponent(config.org)}`,
      { headers: headers(config.token) }
    )
    if (!response.ok) throw new Error(`GitHub API error: ${response.status}`)

    const data = await response.json()
    return {
      success: true,
      org: data.login,
      plan: data.plan?.name || null,
    }
  } catch (error) {
    return { success: false, error: error.message }
  }
}

export async function pullCopilotAuditLogs(config, since) {
  const sinceISO = new Date(since || Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const events: any[] = []
  let nextUrl = buildAuditUrl(config.org, sinceISO)

  for (let page = 0; page < 10 && nextUrl; page += 1) {
    const response = await fetch(nextUrl, {
      headers: headers(config.token),
    })
    if (!response.ok) {
      throw new Error(`GitHub audit log error: ${response.status}`)
    }

    const data = await response.json()
    if (!Array.isArray(data) || data.length === 0) break

    events.push(...data.map(event => ({
      timestamp: normalizeTimestamp(event['@timestamp']),
      action: event.action || 'copilot_event',
      actor: event.actor || null,
      repo: event.repo || null,
      userLogin: event.user || event.actor || null,
      data: event.data || {},
    })))

    nextUrl = nextPageUrl(response.headers?.get?.('Link'))
  }

  return events
}

export async function getCopilotUsageStats(config) {
  const response = await fetch(
    `https://api.github.com/orgs/${encodeURIComponent(config.org)}/copilot/billing`,
    { headers: headers(config.token) }
  )
  if (!response.ok) return null
  return response.json()
}

function buildAuditUrl(org, sinceISO) {
  const params = new URLSearchParams({
    phrase: `action:copilot created:>=${sinceISO}`,
    include: 'all',
    order: 'desc',
    per_page: '100',
  })
  return `https://api.github.com/orgs/${encodeURIComponent(org)}/audit-log?${params}`
}

function nextPageUrl(linkHeader) {
  if (!linkHeader) return null
  const next = linkHeader
    .split(',')
    .map(part => part.trim())
    .find(part => part.endsWith('rel="next"'))
  return next?.match(/<([^>]+)>/)?.[1] || null
}
