import { randomBytes, createCipheriv, createDecipheriv } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12       // 96-bit IV, recommended for GCM
const AUTH_TAG_LENGTH = 16 // 128-bit authentication tag (GCM default)

function getMasterKey() {
  const hex = process.env.ENCRYPTION_KEY
  if (!hex) {
    throw new Error('ENCRYPTION_KEY environment variable is required')
  }
  if (hex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)')
  }
  return Buffer.from(hex, 'hex')
}

export function encrypt(plaintext) {
  const key = getMasterKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  // Store auth tag appended to ciphertext so decrypt can extract it
  const combined = Buffer.concat([encrypted, authTag])

  return {
    ciphertext: combined.toString('base64'),
    iv: iv.toString('base64'),
  }
}

export function decrypt(ciphertext, iv) {
  const key = getMasterKey()
  const combined = Buffer.from(ciphertext, 'base64')
  const ivBuffer = Buffer.from(iv, 'base64')

  // Auth tag is the last AUTH_TAG_LENGTH bytes
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH)
  const encrypted = combined.subarray(0, combined.length - AUTH_TAG_LENGTH)

  const decipher = createDecipheriv(ALGORITHM, key, ivBuffer)
  decipher.setAuthTag(authTag)

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
  return decrypted.toString('utf8')
}
