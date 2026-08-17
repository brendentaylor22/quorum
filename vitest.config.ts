import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/browser/**'],
    /*
     * Most of these tests build a real Fastify app over a real SQLite file and
     * run real migrations, and the suite runs under v8 coverage on however many
     * workers the machine offers. Vitest's 5s default is comfortable for a pure
     * function and not comfortable for that, so a loaded machine fails tests
     * that are not slow, only queued. The assertions are unchanged; only the
     * patience is.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: [
        'apps/api/src/**/*.ts',
        'packages/catalog/src/**/*.ts',
        'packages/contracts/src/**/*.ts',
        'packages/database/src/**/*.ts',
        'packages/ranking/src/**/*.ts',
        'packages/recommend/src/**/*.ts',
        'packages/tmdb/src/**/*.ts',
      ],
      exclude: ['**/*.test.ts', '**/main.ts', '**/cli.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 75,
      },
    },
  },
});
