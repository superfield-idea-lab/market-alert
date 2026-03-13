import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'vite.config.test.ts'],
    exclude: ['tests/component/**'],
  },
});
