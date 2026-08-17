import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilityTokenSchema } from '@quorum/contracts';
import {
  INVITE_PHRASE_WORDS,
  capabilitiesMatch,
  hashCapability,
  issueCapability,
  issueInviteCapability,
  issuePublicId,
  resolveTokenSecret,
  secureCookies,
} from './capabilities.js';
import { INVITE_WORDS } from './invite-words.js';

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
});

/**
 * The invite is the one capability held below the 128-bit floor, so its
 * entropy is asserted rather than assumed. See `docs/phase-0/threat-model.md`
 * T01 for why the reduction is bounded to this one token.
 */
describe('invite phrases', () => {
  it('carries at least 77 bits from a list that has not shrunk', () => {
    // Fewer words, or a shorter list, silently weakens every invite link.
    expect(INVITE_WORDS.length).toBeGreaterThanOrEqual(7772);
    expect(new Set(INVITE_WORDS).size).toBe(INVITE_WORDS.length);
    const bits = INVITE_PHRASE_WORDS * Math.log2(INVITE_WORDS.length);
    expect(bits).toBeGreaterThanOrEqual(77);
  });

  it('reads as hyphenated words and nothing else', () => {
    const vocabulary = new Set(INVITE_WORDS);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const phrase = issueInviteCapability();
      const words = phrase.split('-');
      expect(words).toHaveLength(INVITE_PHRASE_WORDS);
      for (const word of words) expect(vocabulary.has(word)).toBe(true);
      // Every phrase has to survive the shared capability route validation.
      expect(capabilityTokenSchema.safeParse(phrase).success).toBe(true);
    }
  });

  it('does not repeat itself', () => {
    const phrases = new Set(
      Array.from({ length: 500 }, () => issueInviteCapability()),
    );
    expect(phrases.size).toBe(500);
  });

  it('draws across the whole word list, not just its front', () => {
    // A modulo of random bytes would bias towards low indices; `randomInt`
    // rejects instead. 3000 draws from 7772 words should not cluster.
    const indices = Array.from({ length: 500 }, () =>
      issueInviteCapability()
        .split('-')
        .map((word) => INVITE_WORDS.indexOf(word)),
    ).flat();
    const late = indices.filter(
      (index) => index >= INVITE_WORDS.length / 2,
    ).length;
    // Binomial over 3000 draws: p = 0.5, so 0.45–0.55 is ~30 sigma of slack.
    expect(late / indices.length).toBeGreaterThan(0.45);
    expect(late / indices.length).toBeLessThan(0.55);
  });
});

describe('capability hashing', () => {
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
