import { describe, expect, it } from 'vitest';
import {
  capabilityTokenSchema,
  displayNameSchema,
  publicIdSchema,
  sessionCookieName,
  swipeRequestSchema,
} from './index.js';

describe('displayNameSchema', () => {
  it('trims and normalises an ordinary name', () => {
    expect(displayNameSchema.parse('  Ana  ')).toBe('Ana');
  });

  it('rejects empty, over-long, and control or bidi names', () => {
    for (const value of [
      '',
      '   ',
      'a'.repeat(41),
      'evil‮name',
      'tab\tname',
      'zero​width',
    ]) {
      expect(displayNameSchema.safeParse(value).success).toBe(false);
    }
  });

  it('accepts non-Latin scripts and emoji within the length limit', () => {
    expect(displayNameSchema.parse('さくら')).toBe('さくら');
    expect(displayNameSchema.parse('Ana 🎬')).toBe('Ana 🎬');
  });
});

describe('capability and identifier schemas', () => {
  it('requires opaque high-entropy shapes', () => {
    expect(capabilityTokenSchema.safeParse('short').success).toBe(false);
    expect(capabilityTokenSchema.safeParse('a'.repeat(43)).success).toBe(true);
    expect(publicIdSchema.safeParse('../etc/passwd').success).toBe(false);
    expect(publicIdSchema.safeParse('a'.repeat(22)).success).toBe(true);
  });

  it('scopes the session cookie name to one room', () => {
    expect(sessionCookieName('room-1')).toBe('quorum_session_room-1');
    expect(sessionCookieName('room-1')).not.toBe(sessionCookieName('room-2'));
  });

  it('accepts only LEFT and RIGHT swipes', () => {
    const exposureId = 'a'.repeat(22);
    expect(
      swipeRequestSchema.safeParse({ exposureId, choice: 'RIGHT' }).success,
    ).toBe(true);
    expect(
      swipeRequestSchema.safeParse({ exposureId, choice: 'MAYBE' }).success,
    ).toBe(false);
  });
});
