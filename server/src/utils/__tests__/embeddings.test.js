import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cosineSimilarity,
  generateEmbedding,
  generateEmbeddingWithMetadata,
} from '../embeddings.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('embeddings', () => {
  it('uses OpenAI text-embedding-3-small when a key is available', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateEmbeddingWithMetadata('compliance policy', {
      provider: 'openai',
      apiKey: 'sk-test',
    })

    expect(result).toEqual({
      embedding: [0.1, 0.2, 0.3],
      model: 'openai:text-embedding-3-small',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/embeddings',
      expect.objectContaining({
        body: expect.stringContaining('"model":"text-embedding-3-small"'),
      })
    )
  })

  it('uses the configured Ollama endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: [0.4, 0.5] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const embedding = await generateEmbedding(
      'local policy',
      null,
      'ollama',
      'http://nas.local:11434/'
    )

    expect(embedding).toEqual([0.4, 0.5])
    expect(fetchMock).toHaveBeenCalledWith(
      'http://nas.local:11434/api/embeddings',
      expect.any(Object)
    )
  })

  it('falls back to a normalized 768-dimensional local vector', async () => {
    const result = await generateEmbeddingWithMetadata('risk controls risk controls', {
      provider: 'fallback',
    })

    expect(result.model).toBe('fallback:tfidf-768')
    expect(result.embedding).toHaveLength(768)
    expect(cosineSimilarity(result.embedding, result.embedding)).toBeCloseTo(1)
  })

  it('returns zero similarity for incompatible dimensions', () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0)
  })
})
