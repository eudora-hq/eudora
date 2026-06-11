import { randomBytes } from 'crypto'

const EXPIRY_MS = 10 * 60 * 1000 // 10 minutes
const states = new Map() // state -> expiry timestamp

function cleanup() {
  const now = Date.now()
  for (const [state, expiry] of states) {
    if (expiry < now) states.delete(state)
  }
}

export function createState() {
  cleanup()
  const state = randomBytes(32).toString('hex')
  states.set(state, Date.now() + EXPIRY_MS)
  return state
}

export function validateState(state) {
  const expiry = states.get(state)
  states.delete(state) // one-time use: delete regardless of outcome
  if (!expiry) return false
  if (expiry < Date.now()) return false
  return true
}
