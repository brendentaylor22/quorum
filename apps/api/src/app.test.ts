import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe('health endpoints', () => {
  it('reports liveness and readiness', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'quorum-api-'));
    const app = await buildApp({ databasePath: join(directory, 'quorum.db') });
    apps.push(app);

    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'ok' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ready' });
  });

  it('returns not found without built static assets', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'quorum-api-'));
    const app = await buildApp({
      databasePath: join(directory, 'quorum.db'),
      staticDirectory: join(directory, 'missing'),
    });
    apps.push(app);

    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(
      404,
    );
  });
});
