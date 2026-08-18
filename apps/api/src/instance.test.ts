import { instanceInfoSchema, type InstanceInfo } from '@quorum/contracts';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { instanceInfo } from './instance.js';
import { RateLimiter } from './rate-limit.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe('instanceInfo', () => {
  it('offers the upstream source for an unmodified deployment', () => {
    const info = instanceInfo({});

    expect(info.licence).toBe('AGPL-3.0-or-later');
    expect(info.sourceUrl).toContain('github.com');
    expect(info.modified).toBe(false);
  });

  it('offers the operator their own source when they name one', () => {
    // The AGPL's offer is only meaningful if a fork can point at its own code.
    const info = instanceInfo({
      QUORUM_SOURCE_URL: 'https://git.example.org/me/quorum',
    });

    expect(info.sourceUrl).toBe('https://git.example.org/me/quorum');
    expect(info.modified).toBe(true);
  });

  it('ignores an empty setting rather than offering an empty link', () => {
    expect(instanceInfo({ QUORUM_SOURCE_URL: '   ' }).modified).toBe(false);
  });

  it('leaves room creation public unless an operator closes it', () => {
    expect(instanceInfo({}).roomCreation).toBe('public');
    expect(instanceInfo({ QUORUM_ROOM_CREATION: '' }).roomCreation).toBe(
      'public',
    );
  });

  it('closes room creation when the operator asks', () => {
    expect(
      instanceInfo({ QUORUM_ROOM_CREATION: 'operator' }).roomCreation,
    ).toBe('operator');
    expect(
      instanceInfo({ QUORUM_ROOM_CREATION: ' OPERATOR ' }).roomCreation,
    ).toBe('operator');
  });

  it('reads an unrecognised value as closed, never as open', () => {
    // A typo in the one setting that restricts access must not fail open.
    expect(
      instanceInfo({ QUORUM_ROOM_CREATION: 'opreator' }).roomCreation,
    ).toBe('operator');
  });
});

describe('GET /api/instance', () => {
  it('answers without a capability, because the offer is owed to anyone', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'quorum-instance-'));
    const app = await buildApp({
      databasePath: join(directory, 'quorum.db'),
      staticDirectory: join(directory, 'missing'),
      rateLimiter: new RateLimiter({ scale: 0 }),
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/instance' });

    expect(response.statusCode).toBe(200);
    const parsed = instanceInfoSchema.safeParse(response.json<InstanceInfo>());
    expect(parsed.success).toBe(true);
  });
});
