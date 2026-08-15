import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limit.js';

/** Virtual clock: sleeping advances time instead of waiting for it. */
function harness(requestsPerSecond: number, burst: number) {
  let clock = 0;
  const sleeps: number[] = [];
  const limiter = new RateLimiter({
    requestsPerSecond,
    burst,
    now: () => clock,
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
      return Promise.resolve();
    },
  });
  return { limiter, sleeps, advance: (ms: number) => (clock += ms) };
}

describe('RateLimiter', () => {
  it('rejects a non-positive rate', () => {
    expect(() => new RateLimiter({ requestsPerSecond: 0 })).toThrow(
      /positive request rate/u,
    );
  });

  it('lets the burst through without waiting', async () => {
    const { limiter, sleeps } = harness(10, 3);
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(sleeps).toEqual([]);
  });

  it('throttles once the burst is spent', async () => {
    const { limiter, sleeps } = harness(10, 2);
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    // 10/s means one token per 100ms.
    expect(sleeps).toEqual([100]);
  });

  it('refills over elapsed time', async () => {
    const { limiter, sleeps, advance } = harness(10, 1);
    await limiter.acquire();
    advance(500);
    await limiter.acquire();
    expect(sleeps).toEqual([]);
  });

  it('never accumulates beyond the burst capacity', async () => {
    const { limiter, sleeps, advance } = harness(10, 2);
    advance(10_000);
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(sleeps).toEqual([100]);
  });

  it('serialises concurrent callers so they cannot share one token', async () => {
    const { limiter, sleeps } = harness(10, 1);
    await Promise.all([
      limiter.acquire(),
      limiter.acquire(),
      limiter.acquire(),
    ]);
    expect(sleeps).toEqual([100, 100]);
  });
});
