import { instanceInfoSchema, type InstanceInfo } from '@quorum/contracts';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { instanceInfo, normaliseHostname } from './instance.js';
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

  it('reopens creation on the operator hostname, and nowhere else', () => {
    // The second hostname exists to carry an identity proxy. Everything else
    // reaching this origin — the hostname friends were sent, the container
    // name a neighbour on the network could use — stays closed.
    const environment = {
      QUORUM_ROOM_CREATION: 'operator',
      QUORUM_OPERATOR_HOSTNAME: 'start.quorum.example.org',
    };

    expect(
      instanceInfo(environment, 'start.quorum.example.org').roomCreation,
    ).toBe('public');
    expect(instanceInfo(environment, 'quorum.example.org').roomCreation).toBe(
      'operator',
    );
    expect(instanceInfo(environment, 'quorum:3000').roomCreation).toBe(
      'operator',
    );
    expect(instanceInfo(environment, undefined).roomCreation).toBe('operator');
  });

  it('matches the operator hostname the way a Host header presents it', () => {
    const environment = {
      QUORUM_ROOM_CREATION: 'operator',
      QUORUM_OPERATOR_HOSTNAME: ' Start.Quorum.Example.org ',
    };

    for (const host of [
      'start.quorum.example.org',
      'START.quorum.example.org',
      'start.quorum.example.org:443',
      'start.quorum.example.org.',
    ]) {
      expect(instanceInfo(environment, host).roomCreation).toBe('public');
    }

    // A neighbouring name that merely contains it is a different host.
    expect(
      instanceInfo(environment, 'start.quorum.example.org.evil.test')
        .roomCreation,
    ).toBe('operator');
  });

  it('needs the hostname to be set before it reopens anything', () => {
    // Unset is the default, and the default must not depend on what a caller
    // puts in a header.
    expect(
      instanceInfo({ QUORUM_ROOM_CREATION: 'operator' }, 'start.example.org')
        .roomCreation,
    ).toBe('operator');
    expect(
      instanceInfo(
        { QUORUM_ROOM_CREATION: 'operator', QUORUM_OPERATOR_HOSTNAME: '  ' },
        '',
      ).roomCreation,
    ).toBe('operator');
  });

  it('sends the operator page to the public hostname for its links', () => {
    const environment = {
      QUORUM_ROOM_CREATION: 'operator',
      QUORUM_OPERATOR_HOSTNAME: 'start.quorum.example.org',
      QUORUM_PUBLIC_URL: 'https://quorum.example.org/',
    };

    // Trailing slash removed, because the client appends `/host/<token>`.
    expect(
      instanceInfo(environment, 'start.quorum.example.org').publicUrl,
    ).toBe('https://quorum.example.org');

    // Nobody else is told, because nobody else needs redirecting: the page is
    // already on the hostname its links should carry.
    expect(
      instanceInfo(environment, 'quorum.example.org').publicUrl,
    ).toBeUndefined();
    expect(instanceInfo(environment).publicUrl).toBeUndefined();
    expect(
      instanceInfo({ QUORUM_PUBLIC_URL: 'https://quorum.example.org' })
        .publicUrl,
    ).toBeUndefined();
  });

  it('omits a public URL it cannot make a link out of', () => {
    // Rather than hand the client something it would prefix onto a host path.
    const environment = {
      QUORUM_ROOM_CREATION: 'operator',
      QUORUM_OPERATOR_HOSTNAME: 'start.quorum.example.org',
      QUORUM_PUBLIC_URL: 'quorum.example.org',
    };

    expect(
      instanceInfo(environment, 'start.quorum.example.org').publicUrl,
    ).toBeUndefined();
  });

  it('reads an unrecognised value as closed, never as open', () => {
    // A typo in the one setting that restricts access must not fail open.
    expect(
      instanceInfo({ QUORUM_ROOM_CREATION: 'opreator' }).roomCreation,
    ).toBe('operator');
  });
});

describe('normaliseHostname', () => {
  it('reduces a Host header to the name it names', () => {
    expect(normaliseHostname(' Quorum.Example.ORG:8443 ')).toBe(
      'quorum.example.org',
    );
    expect(normaliseHostname('quorum.example.org.')).toBe('quorum.example.org');
    expect(normaliseHostname('[::1]:3000')).toBe('[::1]');
    expect(normaliseHostname('[::1]')).toBe('[::1]');
    expect(normaliseHostname('localhost')).toBe('localhost');
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
