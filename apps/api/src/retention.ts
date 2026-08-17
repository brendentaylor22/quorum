import type { FastifyBaseLogger } from 'fastify';
import type { RoomService } from './rooms/service.js';

/**
 * The scheduled half of retention.
 *
 * Expiry used to happen only on an API request, which meant a quiet instance
 * kept expired rooms — and their participants, exposures, and interactions —
 * on disk indefinitely. The retention policy in
 * `docs/phase-0/retention-and-abuse.md` promises otherwise, and a promise that
 * only holds while someone is using the service is not one worth printing.
 *
 * Lazy expiry stays as well: it is what guarantees a capability presented one
 * second after expiry is refused, without waiting for the next sweep.
 */
const DEFAULT_INTERVAL_MINUTES = 15;

export function resolveSweepIntervalMs(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const raw = environment.QUORUM_RETENTION_SWEEP_MINUTES?.trim();
  if (raw === undefined || raw === '') {
    return DEFAULT_INTERVAL_MINUTES * 60 * 1000;
  }
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(
      'QUORUM_RETENTION_SWEEP_MINUTES must be a positive number of minutes',
    );
  }
  return minutes * 60 * 1000;
}

export interface RetentionSweep {
  /** Run one sweep now. Exposed so an operator command shares this path. */
  runOnce: () => { expired: number; purged: number };
  stop: () => void;
}

export function startRetentionSweep(options: {
  service: RoomService;
  log?: FastifyBaseLogger;
  intervalMs?: number;
}): RetentionSweep {
  const intervalMs = options.intervalMs ?? resolveSweepIntervalMs();

  const runOnce = (): { expired: number; purged: number } => {
    const result = options.service.applyRetention();
    if (result.expired > 0 || result.purged > 0) {
      // Counts only. Which rooms were purged is exactly the thing the purge
      // was for, so it does not go in a log line that outlives them.
      options.log?.info(
        { expired: result.expired, purged: result.purged },
        'retention sweep',
      );
    }
    return result;
  };

  runOnce();
  const timer = setInterval(() => {
    try {
      runOnce();
    } catch (error) {
      // A failed sweep must never take the server down: rooms still work, and
      // the next sweep gets another go.
      options.log?.error(error, 'retention sweep failed');
    }
  }, intervalMs);
  // Never hold the process open for a sweep.
  timer.unref();

  return {
    runOnce,
    stop: () => {
      clearInterval(timer);
    },
  };
}
