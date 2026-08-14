import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  capabilitiesMatch,
  hashCapability,
  issueCapability,
  issuePublicId,
  resolveTokenSecret,
  secureCookies,
} from './capabilities.js';

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe('capabilities', () => {
  it('issues distinct tokens with at least 128 bits of entropy', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => issueCapability()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(Buffer.from(token, 'base64url').length).toBeGreaterThanOrEqual(16);
    }
    expect(Buffer.from(issuePublicId(), 'base64url').length).toBe(16);
  });

  it('derives stable keyed hashes that differ per key', () => {
    const token = issueCapability();
    const secretA = Buffer.from('a'.repeat(32), 'utf8');
    const secretB = Buffer.from('b'.repeat(32), 'utf8');
    expect(hashCapability(secretA, token)).toBe(hashCapability(secretA, token));
    expect(hashCapability(secretA, token)).not.toBe(
      hashCapability(secretB, token),
    );
    expect(hashCapability(secretA, token)).not.toContain(token);
  });

  it('compares capabilities without leaking length mismatches', () => {
    expect(capabilitiesMatch('abc', 'abc')).toBe(true);
    expect(capabilitiesMatch('abc', 'abd')).toBe(false);
    expect(capabilitiesMatch('abc', 'abcd')).toBe(false);
  });
});

describe('token secret', () => {
  it('uses a configured secret and rejects a weak one', () => {
    delete process.env.QUORUM_TOKEN_SECRET_FILE;
    process.env.QUORUM_TOKEN_SECRET = 'x'.repeat(40);
    expect(resolveTokenSecret().toString('utf8')).toBe('x'.repeat(40));
    process.env.QUORUM_TOKEN_SECRET = 'too-short';
    expect(() => resolveTokenSecret()).toThrow(/at least 32/u);
  });

  it('reads a mounted secret file before the environment variable', () => {
    const directory = mkdtempSync(join(tmpdir(), 'quorum-secret-file-'));
    const secretFile = join(directory, 'token-secret');
    writeFileSync(secretFile, `${'m'.repeat(64)}\n`);
    process.env.QUORUM_TOKEN_SECRET = 'x'.repeat(40);
    process.env.QUORUM_TOKEN_SECRET_FILE = secretFile;
    expect(resolveTokenSecret().toString('utf8')).toBe('m'.repeat(64));

    writeFileSync(secretFile, 'short');
    expect(() => resolveTokenSecret()).toThrow(/at least 32/u);
  });

  it('fails closed in production without a configured secret', () => {
    delete process.env.QUORUM_TOKEN_SECRET;
    delete process.env.QUORUM_TOKEN_SECRET_FILE;
    process.env.NODE_ENV = 'production';
    expect(() => resolveTokenSecret()).toThrow(/required in production/u);
    expect(secureCookies()).toBe(true);
  });

  it('keeps insecure cookies out of production builds', () => {
    process.env.NODE_ENV = 'production';
    process.env.QUORUM_ALLOW_INSECURE_COOKIES = '1';
    expect(secureCookies()).toBe(true);
    process.env.NODE_ENV = 'development';
    expect(secureCookies()).toBe(false);
    delete process.env.QUORUM_ALLOW_INSECURE_COOKIES;
    expect(secureCookies()).toBe(true);
  });

  it('persists a development secret with restrictive permissions', () => {
    delete process.env.QUORUM_TOKEN_SECRET;
    delete process.env.QUORUM_TOKEN_SECRET_FILE;
    process.env.NODE_ENV = 'development';
    const databaseFile = join(
      mkdtempSync(join(tmpdir(), 'quorum-secret-')),
      'quorum.db',
    );
    const first = resolveTokenSecret(databaseFile);
    const second = resolveTokenSecret(databaseFile);
    expect(second.equals(first)).toBe(true);
    const secretFile = join(
      databaseFile.replace(/quorum\.db$/u, ''),
      'dev-token-secret',
    );
    expect(statSync(secretFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(secretFile, 'utf8')).toBe(first.toString('hex'));
  });
});
