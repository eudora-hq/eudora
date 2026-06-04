import { useState, useEffect } from 'react'
import api from '../api/client'

export function useTierLimits() {
  const [usage, setUsage] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get('/billing/usage')
      .then(res => setUsage(res.data))
      .catch(() => setUsage(null))
      .finally(() => setLoading(false))
  }, [])

  const isAtLimit = (metric) => {
    if (!usage) return false
    const m = usage.metrics?.[metric]
    if (!m) return false
    return isFiniteLimit(m.limit) && m.used >= m.limit
  }

  const percentUsed = (metric) => {
    if (!usage) return 0
    const m = usage.metrics?.[metric]
    if (!m || !isFiniteLimit(m.limit)) return 0
    return Math.min(100, Math.round((m.used / m.limit) * 100))
  }

  return { usage, loading, isAtLimit, percentUsed }
}

function isFiniteLimit(limit) {
  return limit !== Infinity && limit !== 'Infinity' && limit !== null && limit !== undefined
}
