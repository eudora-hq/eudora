import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { createHash, randomBytes } from 'crypto'

export function hashPassword(password) {
  return bcrypt.hash(password, 12)
}

export function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash)
}

export function generateAccessToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
  })
}

export function verifyAccessToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET)
}

export function generateRefreshToken() {
  const raw = randomBytes(64).toString('hex')
  const hashed = hashRefreshToken(raw)
  return { raw, hashed }
}

export function hashRefreshToken(raw) {
  return createHash('sha256').update(raw).digest('hex')
}
