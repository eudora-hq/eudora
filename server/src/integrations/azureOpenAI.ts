/**
 * Azure OpenAI audit integration.
 *
 * Pulls Azure Monitor or Log Analytics activity and normalizes it for
 * Eudora's audit trail.
 */

const MANAGEMENT_SCOPE = 'https://management.azure.com/.default'
const LOG_ANALYTICS_SCOPE = 'https://api.loganalytics.io/.default'

async function getAzureToken(config, scope = MANAGEMENT_SCOPE) {
  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        scope,
      }),
    }
  )

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.error_description || `Azure auth failed: ${response.status}`)
  }

  const data = await response.json()
  return data.access_token
}

export async function testConnection(config) {
  try {
    const token = await getAzureToken(config)
    const url = new URL(
      `https://management.azure.com/subscriptions/${encodeURIComponent(config.subscriptionId)}` +
      `/resourceGroups/${encodeURIComponent(config.resourceGroup)}` +
      `/providers/Microsoft.CognitiveServices/accounts/${encodeURIComponent(config.resourceName)}`
    )
    url.searchParams.set('api-version', '2023-05-01')

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) throw new Error(`Resource not found: ${response.status}`)

    const data = await response.json()
    return {
      success: true,
      resourceName: data.name,
      location: data.location,
    }
  } catch (error) {
    return { success: false, error: error.message }
  }
}

export async function pullAuditLogs(config, since) {
  const sinceISO = new Date(since || Date.now() - 24 * 60 * 60 * 1000).toISOString()

  if (config.workspaceId) {
    return pullLogAnalyticsEvents(config, sinceISO)
  }

  return pullActivityLogEvents(config, sinceISO)
}

async function pullLogAnalyticsEvents(config, sinceISO) {
  const token = await getAzureToken(config, LOG_ANALYTICS_SCOPE)
  const resourceName = escapeKqlString(config.resourceName)
  const query = `
    AzureDiagnostics
    | where ResourceProvider == "MICROSOFT.COGNITIVESERVICES"
    | where ResourceType == "ACCOUNTS"
    | where Resource == toupper("${resourceName}")
    | where TimeGenerated >= datetime(${sinceISO})
    | project TimeGenerated, OperationName, CallerIPAddress, identity_claim_oid_g,
              requestModel_s, requestPromptTokens_d, responseCompletionTokens_d,
              httpStatusCode_d, durationMs_d
    | order by TimeGenerated desc
    | limit 1000
  `
  const response = await fetch(
    `https://api.loganalytics.io/v1/workspaces/${encodeURIComponent(config.workspaceId)}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    }
  )
  if (!response.ok) throw new Error(`Log Analytics query failed: ${response.status}`)

  const data = await response.json()
  const columns = data.tables?.[0]?.columns?.map(column => column.name) || []
  const rows = data.tables?.[0]?.rows || []

  return rows.map(row => {
    const entry = Object.fromEntries(columns.map((column, index) => [column, row[index]]))
    return {
      timestamp: parseTimestamp(entry.TimeGenerated),
      operation: entry.OperationName || 'azure_openai_request',
      callerIp: entry.CallerIPAddress || null,
      userId: entry.identity_claim_oid_g || null,
      model: entry.requestModel_s || null,
      promptTokens: entry.requestPromptTokens_d ?? null,
      completionTokens: entry.responseCompletionTokens_d ?? null,
      statusCode: entry.httpStatusCode_d ?? null,
      durationMs: entry.durationMs_d ?? null,
    }
  })
}

async function pullActivityLogEvents(config, sinceISO) {
  const token = await getAzureToken(config)
  const url = new URL(
    `https://management.azure.com/subscriptions/${encodeURIComponent(config.subscriptionId)}` +
    '/providers/Microsoft.Insights/eventtypes/management/values'
  )
  url.searchParams.set('api-version', '2015-04-01')
  url.searchParams.set(
    '$filter',
    `eventTimestamp ge '${sinceISO}' and resourceGroupName eq '${config.resourceGroup.replaceAll("'", "''")}'`
  )

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) throw new Error(`Activity log fetch failed: ${response.status}`)

  const data = await response.json()
  return (data.value || [])
    .filter(event => event.resourceProviderName?.value === 'Microsoft.CognitiveServices')
    .map(event => ({
      timestamp: parseTimestamp(event.eventTimestamp),
      operation: event.operationName?.localizedValue
        || event.operationName?.value
        || 'azure_openai_request',
      callerIp: event.httpRequest?.clientIpAddress || null,
      userId: event.caller || null,
      model: null,
      promptTokens: null,
      completionTokens: null,
      statusCode: event.status?.value || event.httpRequest?.method || null,
      durationMs: null,
    }))
}

function parseTimestamp(value) {
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : Date.now()
}

function escapeKqlString(value) {
  return String(value || '').replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}
