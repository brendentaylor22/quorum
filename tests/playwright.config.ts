import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = process.env.QUORUM_BROWSER_TEST_PORT ?? '3210';
// Each run gets a throwaway database so browser evidence never depends on
// leftover rooms.
const databasePath = join(
  mkdtempSync(join(tmpdir(), 'quorum-browser-')),
  'quorum.db',
);

export default defineConfig({
  testDir: 'browser',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: process.env.CI === undefined ? 'list' : 'github',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'node apps/api/dist/main.js',
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    url: `http://127.0.0.1:${port}/health/ready`,
    reuseExistingServer: false,
    env: {
      HOST: '127.0.0.1',
      PORT: port,
      QUORUM_DATABASE_PATH: databasePath,
      // Plain-HTTP localhost only; production always sets Secure cookies.
      QUORUM_ALLOW_INSECURE_COOKIES: '1',
    },
  },
});
