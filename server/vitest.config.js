import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.js', 'src/tests/**/*.test.js'],
    reporters: ['verbose'],
    isolate: true,
  },
})
