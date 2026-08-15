export type Sleep = (milliseconds: number) => Promise<void>;

export const realSleep: Sleep = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

export interface RateLimiterOptions {
  /** Sustained request rate. TMDB tolerates far more; stay well under it. */
  requestsPerSecond: number;
  /** Requests allowed to fire back to back before the rate applies. */
  burst?: number;
  now?: () => number;
  sleep?: Sleep;
}

/**
 * Token bucket shared by every request from one client.
 *
 * Serialising through `pending` keeps concurrent callers in FIFO order and
 * stops them all reading the same refilled bucket and bursting past the rate.
 */
export class RateLimiter {
  private readonly capacity: number;
  private readonly ratePerMs: number;
  private readonly now: () => number;
  private readonly sleep: Sleep;
  private tokens: number;
  private lastRefill: number;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions) {
    if (options.requestsPerSecond <= 0) {
      throw new Error('Rate limiter requires a positive request rate');
    }
    this.capacity = Math.max(1, options.burst ?? 1);
    this.ratePerMs = options.requestsPerSecond / 1000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
    this.tokens = this.capacity;
    this.lastRefill = this.now();
  }

  /** Resolve once this caller may issue a request. */
  acquire(): Promise<void> {
    const next = this.pending.then(() => this.take());
    // Failures must not poison the queue for later callers.
    this.pending = next.catch(() => undefined);
    return next;
  }

  private async take(): Promise<void> {
    this.refill();
    if (this.tokens < 1) {
      const deficit = 1 - this.tokens;
      await this.sleep(Math.ceil(deficit / this.ratePerMs));
      this.refill();
    }
    this.tokens -= 1;
  }

  private refill(): void {
    const timestamp = this.now();
    const elapsed = Math.max(0, timestamp - this.lastRefill);
    this.lastRefill = timestamp;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + elapsed * this.ratePerMs,
    );
  }
}
