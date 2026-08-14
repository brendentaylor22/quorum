import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/browser/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: [
        'apps/api/src/**/*.ts',
        'packages/catalog/src/**/*.ts',
        'packages/contracts/src/**/*.ts',
        'packages/database/src/**/*.ts',
        'packages/ranking/src/**/*.ts',
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
