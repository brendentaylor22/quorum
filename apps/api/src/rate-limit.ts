/**
 * Application rate limiting.
 *
 * The limits themselves are policy, written down in
 * `docs/retention-and-abuse.md`; this file enforces them. Every
 * operation carries two rules — a sustained one and a burst one — because a
 * single window cannot express both "five rooms an hour" and "not five rooms in
 * five seconds".
 *
 * Counters are in-process fixed windows. That is the honest fit for Quorum:
 * one SQLite file, one application container, no Redis (ADR 0001). It has two
 * consequences worth stating rather than discovering. A restart forgets every
 * counter, so a determined attacker who can also restart the process is not
 * limited — but an attacker who can restart the process has already won. And a
 * fixed window lets a caller spend a full window's budget at the end of one
 * window and again at the start of the next; the burst rule is what keeps that
 * bounded to twice the burst, not twice the hour.
 */

/** One window: at most `limit` requests per `windowMs`. */
export interface RateLimitRule {
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimitPolicy {
  /** Namespaces the counter, so two policies never share a bucket. */
  readonly name: string;
  readonly rules: readonly RateLimitRule[];
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Seconds until the caller could succeed. Always >= 1 when blocked. */
  readonly retryAfterSeconds: number;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The limits from `docs/retention-and-abuse.md`. Changing a number here
 * changes the policy, so change the document in the same commit.
 */
export const POLICIES = {
  /**
   * Room creation is the only unauthenticated write, so it is the cheapest
   * thing to abuse and the most expensive to absorb: every room is rows on
   * disk. The third rule is the "active rooms per source per 24 hours" cap.
   * It counts created rooms rather than live ones, which is stricter than the
   * policy text and much simpler — a source that creates ten rooms and expires
   * them all still waits, and no honest user creates ten rooms a day.
   */
  createRoom: {
    name: 'create-room',
    rules: [
      { limit: 2, windowMs: MINUTE },
      { limit: 5, windowMs: HOUR },
      { limit: 10, windowMs: DAY },
    ],
  },
  /**
   * Keyed by source, and sized for the case Quorum is actually built for:
   * everyone in the room is on the same wifi, so twenty joins can legitimately
   * arrive from one address inside a minute. The documented 10/minute would
   * have made a full room impossible to fill from a single household.
   */
  join: {
    name: 'join',
    rules: [
      { limit: 30, windowMs: MINUTE },
      { limit: 120, windowMs: HOUR },
    ],
  },
  /**
   * Twenty cards is the whole game, so a human never approaches this. It exists
   * so a script cannot turn a valid session into a write loop.
   */
  swipe: {
    name: 'swipe',
    rules: [
      { limit: 20, windowMs: SECOND },
      { limit: 120, windowMs: MINUTE },
    ],
  },
  /**
   * Room reads, keyed by participant session — the finest capability available,
   * and one a caller cannot mint freely because joining is itself limited. The
   * lobby and the swipe deck poll every two seconds, so 30/minute is the floor
   * for one honest tab; 60 leaves room for a second tab and a manual refresh.
   */
  read: {
    name: 'read',
    rules: [
      { limit: 10, windowMs: SECOND },
      { limit: 60, windowMs: MINUTE },
    ],
  },
  /**
   * Reads of a capability path by a caller with no session yet: the join screen
   * polling an invite, and the host page polling its own link. These can only
   * be keyed by source, so the limit has to absorb a full room of devices
   * behind one NAT — twenty phones polling an invite every three seconds is
   * 400 legitimate requests a minute. This is a denial-of-service bound, not an
   * anti-guessing control; guessing is answered by 77.5 bits of invite entropy
   * and 256 bits of host entropy (threat model T01, T01a).
   */
  capabilityRead: {
    name: 'capability-read',
    rules: [
      { limit: 30, windowMs: SECOND },
      { limit: 600, windowMs: MINUTE },
    ],
  },
  hostMutation: {
    name: 'host-mutation',
    rules: [
      { limit: 5, windowMs: MINUTE },
      { limit: 20, windowMs: HOUR },
    ],
  },
} as const satisfies Record<string, RateLimitPolicy>;

/**
 * A single operator knob, because the shape of a self-hosted deployment is not
 * knowable from here. A shared office address, a school, or a CGNAT carrier can
 * put far more honest people behind one source than a household; an instance on
 * a private network may want none of this at all.
 *
 * `QUORUM_RATE_LIMIT_SCALE` multiplies every limit. `1` is the default and the
 * documented policy. `0` disables rate limiting entirely, which is only
 * defensible on a network where every caller is already trusted — an instance
 * reachable from the Internet with limits off has no answer to T05.
 */
export function resolveScale(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const raw = environment.QUORUM_RATE_LIMIT_SCALE;
  if (raw === undefined || raw.trim() === '') return 1;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      'QUORUM_RATE_LIMIT_SCALE must be a non-negative number (1 = documented policy, 0 = disabled)',
    );
  }
  return value;
}

/** Apply the operator scale, keeping every limit at least 1 unless disabled. */
export function scalePolicy(
  policy: RateLimitPolicy,
  scale: number,
): RateLimitPolicy {
  if (scale === 1) return policy;
  return {
    name: policy.name,
    rules: policy.rules.map((rule) => ({
      limit: Math.max(1, Math.round(rule.limit * scale)),
      windowMs: rule.windowMs,
    })),
  };
}

interface Window {
  count: number;
  /** Epoch milliseconds at which this window's count resets. */
  resetAt: number;
}

/** Swept whenever the map grows past this, so an attacker cannot grow it. */
const SWEEP_THRESHOLD = 10_000;

export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly now: () => number;
  private readonly scale: number;

  constructor(options: { now?: () => number; scale?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.scale = options.scale ?? 1;
  }

  /**
   * Check every rule and consume a slot from each, or consume nothing.
   *
   * Consuming nothing on rejection matters: a blocked caller hammering the
   * endpoint must not push their own reset further out, because that turns a
   * rate limit into an unbounded lockout for anyone sharing their key — and
   * behind a reverse proxy, keys are shared far more often than operators
   * expect.
   */
  check(key: string, requested: RateLimitPolicy): RateLimitDecision {
    if (this.scale === 0) return { allowed: true, retryAfterSeconds: 0 };
    const policy = scalePolicy(requested, this.scale);
    const now = this.now();
    if (this.windows.size > SWEEP_THRESHOLD) this.sweep(now);

    let blockedUntil = 0;
    for (const rule of policy.rules) {
      const window = this.window(policy, key, rule, now);
      if (window.count >= rule.limit) {
        blockedUntil = Math.max(blockedUntil, window.resetAt);
      }
    }

    if (blockedUntil > 0) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((blockedUntil - now) / SECOND),
        ),
      };
    }

    for (const rule of policy.rules) {
      this.window(policy, key, rule, now).count += 1;
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Test and operator seam: how many counters are being held. */
  size(): number {
    return this.windows.size;
  }

  private window(
    policy: RateLimitPolicy,
    key: string,
    rule: RateLimitRule,
    now: number,
  ): Window {
    const id = `${policy.name}:${rule.windowMs.toString()}:${key}`;
    const existing = this.windows.get(id);
    if (existing !== undefined && existing.resetAt > now) return existing;
    const fresh: Window = { count: 0, resetAt: now + rule.windowMs };
    this.windows.set(id, fresh);
    return fresh;
  }

  private sweep(now: number): void {
    for (const [id, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(id);
    }
  }
}
