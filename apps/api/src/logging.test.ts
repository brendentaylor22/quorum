import { HOST_TOKEN_HEADER } from '@quorum/contracts';
import { describe, expect, it } from 'vitest';
import { REDACTED, loggerOptions, redactCapabilityPath } from './logging.js';

const TOKEN = 'a'.repeat(64);
const PHRASE = 'copper-harbor-vivid-lantern-quiet-ember';

describe('redactCapabilityPath', () => {
  it('removes the token from every capability route', () => {
    expect(redactCapabilityPath(`/api/invites/${PHRASE}`)).toBe(
      `/api/invites/${REDACTED}`,
    );
    expect(redactCapabilityPath(`/api/invites/${PHRASE}/join`)).toBe(
      `/api/invites/${REDACTED}/join`,
    );
    expect(redactCapabilityPath(`/api/host/${TOKEN}`)).toBe(
      `/api/host/${REDACTED}`,
    );
    expect(redactCapabilityPath(`/api/host/${TOKEN}/join`)).toBe(
      `/api/host/${REDACTED}/join`,
    );
    expect(redactCapabilityPath(`/join/${PHRASE}`)).toBe(`/join/${REDACTED}`);
    expect(redactCapabilityPath(`/host/${TOKEN}`)).toBe(`/host/${REDACTED}`);
  });

  it('keeps the route shape and query string, which is what a log is for', () => {
    expect(redactCapabilityPath(`/host/${TOKEN}?round=2`)).toBe(
      `/host/${REDACTED}?round=2`,
    );
  });

  it('leaves paths that carry no capability alone', () => {
    for (const url of [
      '/api/rooms',
      '/api/rooms/abc123/results?round=1',
      '/api/catalog',
      '/health/ready',
      '/',
    ]) {
      expect(redactCapabilityPath(url)).toBe(url);
    }
  });

  it('redacts only the token segment, never the rest of the path', () => {
    expect(redactCapabilityPath(`/api/host/${TOKEN}/join`)).toContain('/join');
    expect(redactCapabilityPath(`/api/host/${TOKEN}`)).not.toContain(TOKEN);
  });
});

describe('logger configuration', () => {
  it('serializes a request without its capability token', () => {
    const line = loggerOptions.serializers.req({
      method: 'GET',
      url: `/api/host/${TOKEN}`,
      ip: '203.0.113.7',
    });

    expect(JSON.stringify(line)).not.toContain(TOKEN);
    expect(line.url).toBe(`/api/host/${REDACTED}`);
  });

  it('censors the header and cookie that carry the other capabilities', () => {
    expect(loggerOptions.redact.paths).toContain(
      `req.headers["${HOST_TOKEN_HEADER}"]`,
    );
    expect(loggerOptions.redact.paths).toContain('req.headers.cookie');
    expect(loggerOptions.redact.paths).toContain('res.headers["set-cookie"]');
  });
});
