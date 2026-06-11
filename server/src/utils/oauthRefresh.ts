import { encrypt, decrypt } from './encryption.ts'
import { adaptDatabase } from '../db/index.ts'

export async function refreshOAuthToken(db, apiKeyId, tenantId) {
  db = adaptDatabase(db)
  const row = await db.get('SELECT * FROM api_keys WHERE id = ?', [apiKeyId])
  if (!row || row.tenant_id !== tenantId) {
    throw new Error('API key not found or access denied')
  }

  // More than 5 minutes remaining — no refresh needed
  if (row.oauth_expires_at - Date.now() > 5 * 60 * 1000) {
    return row
  }

  const refreshToken = decrypt(row.oauth_refresh_token_encrypted, row.oauth_refresh_token_iv)

  const response = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: process.env.OPENAI_OAUTH_CLIENT_ID,
      client_secret: process.env.OPENAI_OAUTH_CLIENT_SECRET,
    }),
  })

  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.error_description || body.error || 'Token refresh failed')
  }

  const { access_token, expires_in } = await response.json()

  const { ciphertext, iv } = encrypt(access_token)
  const newExpiresAt = Date.now() + expires_in * 1000

  await db.query(`
    UPDATE api_keys
       SET oauth_access_token_encrypted = ?,
           oauth_access_token_iv = ?,
           oauth_expires_at = ?
     WHERE id = ?
  `, [ciphertext, iv, newExpiresAt, apiKeyId])

  return {
    ...row,
    oauth_access_token_encrypted: ciphertext,
    oauth_access_token_iv: iv,
    oauth_expires_at: newExpiresAt,
  }
}
