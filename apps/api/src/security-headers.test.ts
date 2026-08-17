import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { RateLimiter } from './rate-limit.js';
import {
  contentSecurityPolicy,
  registerSecurityHeaders,
} from './security-headers.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

async function createApp(): Promise<FastifyInstance> {
  const directory = mkdtempSync(join(tmpdir(), 'quorum-headers-'));
  const app = await buildApp({
    databasePath: join(directory, 'quorum.db'),
    staticDirectory: join(directory, 'missing'),
    rateLimiter: new RateLimiter({ scale: 0 }),
  });
  apps.push(app);
  return app;
}

function directives(policy: string): Map<string, string> {
  return new Map(
    policy.split(';').map((part) => {
      const [name, ...values] = part.trim().split(/\s+/u);
      return [name ?? '', values.join(' ')];
    }),
  );
}

describe('content security policy', () => {
  it('refuses script from anywhere but this origin, with no inline or eval', () => {
    const script = directives(contentSecurityPolicy()).get('script-src');

    expect(script).toBe("'self'");
    expect(script).not.toContain('unsafe-inline');
    expect(script).not.toContain('unsafe-eval');
  });

  it('locks down the directives an injection would reach for', () => {
    const found = directives(contentSecurityPolicy());

    expect(found.get('default-src')).toBe("'self'");
    expect(found.get('connect-src')).toBe("'self'");
    expect(found.get('object-src')).toBe("'none'");
    expect(found.get('base-uri')).toBe("'none'");
    expect(found.get('frame-ancestors')).toBe("'none'");
    expect(found.get('form-action')).toBe("'self'");
  });

  it('allows the poster CDN, and the one the catalog actually recorded', () => {
    const images = directives(
      contentSecurityPolicy('https://images.example.org/t/p/'),
    ).get('img-src');

    expect(images).toContain("'self'");
    expect(images).toContain('data:');
    expect(images).toContain('https://images.example.org');
    // The documented default survives a refresh that moves the host.
    expect(images).toContain('https://image.tmdb.org');
  });

  it('ignores a base URL that will not parse rather than emitting a broken policy', () => {
    const images = directives(contentSecurityPolicy('not a url')).get(
      'img-src',
    );

    expect(images).toContain('https://image.tmdb.org');
    expect(images).not.toContain('not a url');
  });
});

describe('response headers', () => {
  it('sends the hardening headers on an API response', async () => {
    const app = await createApp();

    const response = await app.inject({ method: 'GET', url: '/api/catalog' });

    expect(response.headers['content-security-policy']).toContain(
      "default-src 'self'",
    );
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(response.headers['cross-origin-resource-policy']).toBe(
      'same-origin',
    );
    expect(response.headers['permissions-policy']).toContain('geolocation=()');
  });

  it('sends them on an error too, where a leak would matter just as much', async () => {
    const app = await createApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/invites/unknown-token-that-does-not-exist',
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['content-security-policy']).toBeDefined();
  });

  it('asserts HSTS only where cookies are already Secure', async () => {
    // Development over plain-HTTP localhost must not pin a browser to HTTPS
    // for a year, or the next `npm run dev` is unreachable. Production, where
    // cookies are Secure, always asserts it.
    const insecure = Fastify();
    registerSecurityHeaders(insecure, { secure: false });
    insecure.get('/', () => ({ ok: true }));

    const secure = Fastify();
    registerSecurityHeaders(secure, { secure: true });
    secure.get('/', () => ({ ok: true }));

    try {
      const relaxed = await insecure.inject({ method: 'GET', url: '/' });
      const strict = await secure.inject({ method: 'GET', url: '/' });

      expect(relaxed.headers['strict-transport-security']).toBeUndefined();
      expect(strict.headers['strict-transport-security']).toContain(
        'max-age=31536000',
      );
    } finally {
      await insecure.close();
      await secure.close();
    }
  });
});
