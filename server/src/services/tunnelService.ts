import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { customAlphabet } from 'nanoid'
import { adaptDatabase } from '../db/index.ts'

const createTunnelId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 21)
export const TUNNEL_HOST = 'tunnel.geteudora.com'
export const TUNNEL_SERVER_PORT = 7000
export const TUNNEL_STALE_AFTER_MS = 90_000

export function hashTunnelKey(tunnelKey) {
  return createHash('sha256').update(tunnelKey).digest('hex')
}

export function tunnelBaseUrl(tunnelId) {
  return `http://${tunnelId}.${TUNNEL_HOST}`
}

export function generateFrpcConfig({
  tunnelId,
  tunnelKey,
  localHost = '127.0.0.1',
  localPort = 11434,
}) {
  return `serverAddr = "${TUNNEL_HOST}"
serverPort = ${TUNNEL_SERVER_PORT}

auth.method = "token"
auth.token = "${tunnelKey}"

[[proxies]]
name = "${tunnelId}"
type = "http"
localIP = "${localHost}"
localPort = ${localPort}
customDomains = ["${tunnelId}.${TUNNEL_HOST}"]`
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`
}

export function generateInstallCommand(frpcConfig) {
  const config = shellQuote(frpcConfig)
  return `brew install frp && frpc -c <(echo ${config})
# or save to file:
mkdir -p ~/.eudora && echo ${config} > ~/.eudora/frpc.toml && frpc -c ~/.eudora/frpc.toml`
}

function validateTunnelInput({ name, localHost, localPort }) {
  const normalizedName = String(name || '').trim()
  const normalizedHost = String(localHost || '127.0.0.1').trim()
  const normalizedPort = Number(localPort ?? 11434)

  if (!normalizedName) throw new Error('name_required')
  if (normalizedName.length > 100) throw new Error('name_too_long')
  if (!/^[a-zA-Z0-9._:[\]-]+$/.test(normalizedHost)) throw new Error('invalid_local_host')
  if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
    throw new Error('invalid_local_port')
  }

  return {
    name: normalizedName,
    localHost: normalizedHost,
    localPort: normalizedPort,
  }
}

export async function createTunnel(db, {
  tenantId,
  name,
  localHost = '127.0.0.1',
  localPort = 11434,
}) {
  db = adaptDatabase(db)
  const input = validateTunnelInput({ name, localHost, localPort })
  const id = createTunnelId()
  const tunnelKey = randomBytes(16).toString('hex')
  const createdAt = Date.now()

  await db.query(
    `INSERT INTO tunnels (
      id, tenant_id, name, tunnel_key, local_port, local_host,
      status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'inactive', ?)`,
    [
      id,
      tenantId,
      input.name,
      hashTunnelKey(tunnelKey),
      input.localPort,
      input.localHost,
      createdAt,
    ]
  )

  const frpcConfig = generateFrpcConfig({
    tunnelId: id,
    tunnelKey,
    localHost: input.localHost,
    localPort: input.localPort,
  })

  return {
    id,
    name: input.name,
    local_port: input.localPort,
    local_host: input.localHost,
    status: 'inactive',
    tunnel_url: tunnelBaseUrl(id),
    tunnel_key: tunnelKey,
    frpc_config: frpcConfig,
    install_command: generateInstallCommand(frpcConfig),
    created_at: createdAt,
  }
}

export async function listTunnels(db, tenantId) {
  db = adaptDatabase(db)
  return db.all(
    `SELECT id, name, local_port, local_host, status, last_seen_at, created_at
     FROM tunnels
     WHERE tenant_id = ?
     ORDER BY created_at DESC`,
    [tenantId]
  )
}

export async function deleteTunnel(db, tenantId, tunnelId) {
  db = adaptDatabase(db)
  return db.query(
    'DELETE FROM tunnels WHERE id = ? AND tenant_id = ?',
    [tunnelId, tenantId]
  )
}

export async function getTunnelStatus(db, tenantId, tunnelId, now = Date.now()) {
  db = adaptDatabase(db)
  const tunnel = await db.get(
    `SELECT id, status, last_seen_at
     FROM tunnels
     WHERE id = ? AND tenant_id = ?`,
    [tunnelId, tenantId]
  )
  if (!tunnel) return null

  const stale = tunnel.last_seen_at && Number(tunnel.last_seen_at) < now - TUNNEL_STALE_AFTER_MS
  if (stale && tunnel.status !== 'inactive') {
    await db.query(
      "UPDATE tunnels SET status = 'inactive' WHERE id = ? AND tenant_id = ?",
      [tunnelId, tenantId]
    )
    tunnel.status = 'inactive'
  }
  return tunnel
}

export async function recordHeartbeat(db, tunnelId, suppliedKey, now = Date.now()) {
  db = adaptDatabase(db)
  const tunnel = await db.get(
    'SELECT id, tunnel_key FROM tunnels WHERE id = ?',
    [tunnelId]
  )
  if (!tunnel || !suppliedKey) return false

  const suppliedHash = Buffer.from(hashTunnelKey(suppliedKey), 'hex')
  const storedHash = Buffer.from(tunnel.tunnel_key, 'hex')
  if (
    suppliedHash.length !== storedHash.length ||
    !timingSafeEqual(suppliedHash, storedHash)
  ) {
    return false
  }

  await db.query(
    "UPDATE tunnels SET status = 'active', last_seen_at = ? WHERE id = ?",
    [now, tunnelId]
  )
  return true
}

export async function markStaleTunnels(db, now = Date.now()) {
  db = adaptDatabase(db)
  return db.query(
    `UPDATE tunnels
     SET status = 'inactive'
     WHERE status = 'active'
       AND (last_seen_at IS NULL OR last_seen_at < ?)`,
    [now - TUNNEL_STALE_AFTER_MS]
  )
}

export function startTunnelMonitor(db: any, logger: any = console) {
  const timer = setInterval(() => {
    markStaleTunnels(db).catch((err) => {
      logger.error?.(`[tunnels] stale monitor failed: ${err.message}`)
    })
  }, 60_000)
  timer.unref?.()
  return () => clearInterval(timer)
}
