import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { encrypt, decrypt } from '../encryption.js'

const VALID_KEY = 'a'.repeat(64) // 64 hex chars = 32 bytes

beforeAll(() => {
  process.env.ENCRYPTION_KEY = VALID_KEY
})

afterAll(() => {
  delete process.env.ENCRYPTION_KEY
})

describe('encrypt / decrypt', () => {
  it('decrypt(encrypt(plaintext)) returns the original plaintext', () => {
    const plaintext = 'sk-ant-supersecret-key-12345'
    const { ciphertext, iv } = encrypt(plaintext)
    expect(decrypt(ciphertext, iv)).toBe(plaintext)
  })

  it('encrypting the same plaintext twice produces different ciphertexts (random IV)', () => {
    const plaintext = 'same-input'
    const first = encrypt(plaintext)
    const second = encrypt(plaintext)
    expect(first.ciphertext).not.toBe(second.ciphertext)
    expect(first.iv).not.toBe(second.iv)
  })

  it('decrypt throws when the ciphertext is tampered', () => {
    const { ciphertext, iv } = encrypt('original')
    const buf = Buffer.from(ciphertext, 'base64')
    buf[0] ^= 0xff // flip first byte of the actual ciphertext
    const tampered = buf.toString('base64')
    expect(() => decrypt(tampered, iv)).toThrow()
  })

  it('decrypt throws when the IV is wrong', () => {
    const { ciphertext } = encrypt('original')
    // Use a different (random) IV — GCM auth tag will not verify
    const wrongIv = Buffer.alloc(12, 0x01).toString('base64')
    expect(() => decrypt(ciphertext, wrongIv)).toThrow()
  })

  it('encrypt throws a clear error when ENCRYPTION_KEY is missing', () => {
    const saved = process.env.ENCRYPTION_KEY
    delete process.env.ENCRYPTION_KEY
    try {
      expect(() => encrypt('test')).toThrow(/ENCRYPTION_KEY/)
    } finally {
      process.env.ENCRYPTION_KEY = saved
    }
  })

  it('encrypt throws a clear error when ENCRYPTION_KEY is not 64 hex chars', () => {
    const saved = process.env.ENCRYPTION_KEY
    process.env.ENCRYPTION_KEY = 'tooshort'
    try {
      expect(() => encrypt('test')).toThrow(/64-character/)
    } finally {
      process.env.ENCRYPTION_KEY = saved
    }
  })
})
