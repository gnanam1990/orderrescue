import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const resolve = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@orderrescue/domain': resolve('./packages/domain/src/index.ts'),
      '@orderrescue/journal': resolve('./packages/journal/src/index.ts'),
      '@orderrescue/adapter-binance': resolve('./packages/adapter-binance/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
