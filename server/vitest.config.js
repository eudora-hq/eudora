import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'src/**/__tests__/**/*.test.{js,ts}',
      'src/tests/**/*.test.{js,ts}',
    ],
    reporters: ['verbose'],
    isolate: true,
  },
})
