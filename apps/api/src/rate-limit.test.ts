import { describe, expect, it } from 'vitest';
import {
  POLICIES,
  RateLimiter,
  resolveScale,
  scalePolicy,
  type RateLimitPolicy,
} from './rate-limit.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

function clock(start = 0): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

const policy: RateLimitPolicy = {
  name: 'test',
  rules: [
    { limit: 2, windowMs: SECOND },
    { limit: 3, windowMs: MINUTE },
  ],
};

describe('RateLimiter', () => {
  it('allows up to the burst limit and then refuses', () => {
    const time = clock();
    const limiter = new RateLimiter({ now: time.now });

    expect(limiter.check('a', policy).allowed).toBe(true);
    expect(limiter.check('a', policy).allowed).toBe(true);
    expect(limiter.check('a', policy).allowed).toBe(false);
  });

  it('refuses on the sustained rule even when the burst rule has room', () => {
    const time = clock();
    const limiter = new RateLimiter({ now: time.now });

    limiter.check('a', policy);
    limiter.check('a', policy);
    time.advance(SECOND + 1); // burst window rolls over, minute window does not
    expect(limiter.check('a', policy).allowed).toBe(true);
    expect(limiter.check('a', policy).allowed).toBe(false);
  });

  it('recovers when every window has passed', () => {
    const time = clock();
    const limiter = new RateLimiter({ now: time.now });

    limiter.check('a', policy);
    limiter.check('a', policy);
    expect(limiter.check('a', policy).allowed).toBe(false);

    time.advance(MINUTE + 1);
    expect(limiter.check('a', policy).allowed).toBe(true);
  });

  it('keeps separate keys and separate policies apart', () => {
    const time = clock();
    const limiter = new RateLimiter({ now: time.now });
    const other: RateLimitPolicy = { name: 'other', rules: policy.rules };

    limiter.check('a', policy);
    limiter.check('a', policy);

    expect(limiter.check('b', policy).allowed).toBe(true);
    expect(limiter.check('a', other).allowed).toBe(true);
  });

  it('does not extend a caller lockout when they keep hammering', () => {
    const time = clock();
    const limiter = new RateLimiter({ now: time.now });

    limiter.check('a', policy);
    limiter.check('a', policy);
    // A blocked caller retrying must not push their own reset further out, or
    // a shared address turns a rate limit into an unbounded lockout.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(limiter.check('a', policy).allowed).toBe(false);
    }
    time.advance(MINUTE + 1);
    expect(limiter.check('a', policy).allowed).toBe(true);
  });

  it('reports how long to wait, always at least a second', () => {
    const time = clock();
    const limiter = new RateLimiter({ now: time.now });

    limiter.check('a', policy);
    limiter.check('a', policy);
    time.advance(900);

    const decision = limiter.check('a', policy);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(decision.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('does not grow without bound as keys churn', () => {
    const time = clock();
    const limiter = new RateLimiter({ now: time.now });

    for (let index = 0; index < 12_000; index += 1) {
      limiter.check(`key-${index.toString()}`, policy);
      if (index === 6000) time.advance(MINUTE + 1);
    }

    expect(limiter.size()).toBeLessThan(12_000 * policy.rules.length);
  });

  it('is disabled entirely at scale zero', () => {
    const limiter = new RateLimiter({ scale: 0 });

    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(limiter.check('a', policy).allowed).toBe(true);
    }
    expect(limiter.size()).toBe(0);
  });

  it('multiplies every limit by the operator scale', () => {
    const limiter = new RateLimiter({ now: clock().now, scale: 2 });

    expect(limiter.check('a', policy).allowed).toBe(true);
    expect(limiter.check('a', policy).allowed).toBe(true);
    expect(limiter.check('a', policy).allowed).toBe(true);
    expect(limiter.check('a', policy).allowed).toBe(true);
    expect(limiter.check('a', policy).allowed).toBe(false);
  });
});

describe('scalePolicy', () => {
  it('never scales a limit below one, so a scale is not a silent lockout', () => {
    const scaled = scalePolicy(policy, 0.01);

    for (const rule of scaled.rules) expect(rule.limit).toBe(1);
  });

  it('leaves windows alone', () => {
    const scaled = scalePolicy(policy, 5);

    expect(scaled.rules.map((rule) => rule.windowMs)).toEqual([SECOND, MINUTE]);
  });
});

describe('resolveScale', () => {
  it('defaults to the documented policy', () => {
    expect(resolveScale({})).toBe(1);
    expect(resolveScale({ QUORUM_RATE_LIMIT_SCALE: '' })).toBe(1);
  });

  it('accepts a multiplier and an explicit disable', () => {
    expect(resolveScale({ QUORUM_RATE_LIMIT_SCALE: '4' })).toBe(4);
    expect(resolveScale({ QUORUM_RATE_LIMIT_SCALE: '0' })).toBe(0);
  });

  it('refuses nonsense rather than silently disabling itself', () => {
    expect(() => resolveScale({ QUORUM_RATE_LIMIT_SCALE: 'lots' })).toThrow();
    expect(() => resolveScale({ QUORUM_RATE_LIMIT_SCALE: '-1' })).toThrow();
  });
});

describe('the shipped policies', () => {
  it('leaves room for a full room of devices behind one address', () => {
    // Twenty participants is the hard cap, and they are usually all on the
    // same wifi. Joining and polling an invite must survive that.
    const joinsPerMinute = POLICIES.join.rules.find(
      (rule) => rule.windowMs === MINUTE,
    );
    expect(joinsPerMinute?.limit).toBeGreaterThanOrEqual(20);

    // Twenty join screens polling an invite every three seconds.
    const invitePollsPerMinute = POLICIES.capabilityRead.rules.find(
      (rule) => rule.windowMs === MINUTE,
    );
    expect(invitePollsPerMinute?.limit).toBeGreaterThanOrEqual(20 * 20);
  });

  it('lets one honest client poll a room without being cut off', () => {
    // The lobby and swipe deck poll every two seconds: 30 requests a minute.
    const readsPerMinute = POLICIES.read.rules.find(
      (rule) => rule.windowMs === MINUTE,
    );
    expect(readsPerMinute?.limit).toBeGreaterThan(30);
  });

  it('caps room creation per source per day', () => {
    const daily = POLICIES.createRoom.rules.find(
      (rule) => rule.windowMs === 24 * 60 * MINUTE,
    );
    expect(daily?.limit).toBe(10);
  });
});
