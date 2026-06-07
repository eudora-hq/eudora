const FALLBACK_DIMENSIONS = 768
const OPENAI_MODEL = 'text-embedding-3-small'
const OLLAMA_MODEL = 'nomic-embed-text'

export async function generateEmbedding(text, apiKey, provider = 'openai', baseUrl) {
  const result = await generateEmbeddingWithMetadata(text, {
    apiKey,
    provider,
    baseUrl,
  })
  return result.embedding
}

export async function generateEmbeddingWithMetadata(text, {
  apiKey = null,
  provider = 'openai',
  baseUrl,
} = {}) {
  const truncated = String(text || '').substring(0, 8000)

  if (provider === 'openai' && apiKey) {
    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          input: truncated,
        }),
      })
      if (response.ok) {
        const data = await response.json()
        if (Array.isArray(data.data?.[0]?.embedding)) {
          return {
            embedding: data.data[0].embedding,
            model: `openai:${OPENAI_MODEL}`,
          }
        }
      }
    } catch {
      // Fall through to the deterministic local embedding.
    }
  }

  if (provider === 'ollama') {
    const ollamaUrl = (baseUrl || process.env.OLLAMA_URL || 'http://localhost:11434')
      .replace(/\/+$/, '')
    try {
      const response = await fetch(`${ollamaUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_MODEL, prompt: truncated }),
      })
      if (response.ok) {
        const data = await response.json()
        if (Array.isArray(data.embedding)) {
          return {
            embedding: data.embedding,
            model: `ollama:${OLLAMA_MODEL}`,
          }
        }
      }
    } catch {
      // Fall through to the deterministic local embedding.
    }
  }

  return {
    embedding: simpleTFIDF(truncated),
    model: 'fallback:tfidf-768',
  }
}

function simpleTFIDF(text) {
  const words = text.toLowerCase().match(/\b\w+\b/g) || []
  const frequencies = new Map()
  for (const word of words) {
    frequencies.set(word, (frequencies.get(word) || 0) + 1)
  }

  const vector = new Array(FALLBACK_DIMENSIONS).fill(0)
  const divisor = Math.max(words.length, 1)
  for (const [word, count] of frequencies) {
    const index = Math.abs(hashCode(word)) % FALLBACK_DIMENSIONS
    vector[index] += count / divisor
  }
  return normalise(vector)
}

function hashCode(value) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index)
    hash |= 0
  }
  return hash
}

function normalise(vector) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  return magnitude > 0 ? vector.map(value => value / magnitude) : vector
}

export function cosineSimilarity(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length) {
    return 0
  }

  let dot = 0
  let magnitudeA = 0
  let magnitudeB = 0
  for (let index = 0; index < vecA.length; index += 1) {
    dot += vecA[index] * vecB[index]
    magnitudeA += vecA[index] * vecA[index]
    magnitudeB += vecB[index] * vecB[index]
  }

  const magnitude = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB)
  return magnitude > 0 ? dot / magnitude : 0
}
