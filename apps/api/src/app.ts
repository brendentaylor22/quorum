import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import type { ErrorResponse } from '@quorum/contracts';
import {
  integrityCheck,
  migrate,
  migrationsDirectory,
  openDatabase,
  type QuorumDatabase,
} from '@quorum/database';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveTokenSecret } from './capabilities.js';
import { loggerOptions } from './logging.js';
import { RateLimiter, resolveScale } from './rate-limit.js';
import { startRetentionSweep } from './retention.js';
import { registerRoomRoutes } from './routes.js';
import { registerSecurityHeaders } from './security-headers.js';
import { RoomService } from './rooms/service.js';

export interface BuildAppOptions {
  databasePath?: string;
  staticDirectory?: string;
  logger?: boolean;
  /** Test seam: where log lines go, so redaction can be asserted end to end. */
  logDestination?: NodeJS.WritableStream;
  now?: () => Date;
  /** Test seam: a limiter with an injected clock, or a disabled one. */
  rateLimiter?: RateLimiter;
  /** Test seam: how often the retention sweep runs. */
  retentionSweepMs?: number;
}

/**
 * Whether to believe `X-Forwarded-For`, and from whom.
 *
 * This is the one piece of configuration that can silently break rate limiting
 * in either direction. Left off behind a reverse proxy, every request looks
 * like it came from the proxy, so one bucket serves everybody and the first
 * busy room locks out the rest. Turned on without a trusted proxy in front, a
 * caller sets the header themselves and every limit becomes decorative.
 *
 * So it is explicit, and defaults to off: `QUORUM_TRUST_PROXY` takes `true`,
 * a hop count, or a comma-separated list of trusted proxy addresses or CIDRs,
 * which is the form an operator should prefer. Threat model T05 and the
 * "source identity cannot be trusted" stop condition.
 */
export function resolveTrustProxy(
  environment: NodeJS.ProcessEnv = process.env,
): boolean | number | string[] {
  const raw = environment.QUORUM_TRUST_PROXY?.trim();
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  const hops = Number(raw);
  if (Number.isInteger(hops) && hops > 0) return hops;
  return raw.split(',').map((entry) => entry.trim());
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const database: QuorumDatabase = openDatabase(options.databasePath);
  migrate(database, migrationsDirectory);
  const service = new RoomService({
    database,
    secret: resolveTokenSecret(options.databasePath),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  service.seedFixtureCatalog();

  const app = Fastify({
    // Logging is never plain `true`: capability tokens live in URL paths, so the
    // default access log would record host authority verbatim. See `logging.ts`.
    logger:
      options.logger === true
        ? {
            ...loggerOptions,
            ...(options.logDestination === undefined
              ? {}
              : { stream: options.logDestination }),
          }
        : false,
    bodyLimit: 16 * 1024,
    trustProxy: resolveTrustProxy(),
  });

  // Resolved once at boot rather than per request: it comes from the catalog
  // snapshot, which only a refresh changes, and the policy names the documented
  // TMDB CDN as well, so a refresh that moves the host cannot blank posters
  // before the next restart.
  registerSecurityHeaders(app, {
    imageBaseUrl: service.catalogImageBaseUrl(),
  });

  // Lazy expiry on request still applies, so a capability presented one second
  // after expiry is refused without waiting for a sweep. This is what makes the
  // retention promise hold on an instance nobody is using.
  const retention = startRetentionSweep({
    service,
    log: app.log,
    ...(options.retentionSweepMs === undefined
      ? {}
      : { intervalMs: options.retentionSweepMs }),
  });

  app.addHook('onClose', () => {
    retention.stop();
    database.close();
  });
  await app.register(fastifyCookie);

  // Host actions carry their capability in a header and have no payload; an
  // empty JSON body is a valid request, not a parse failure.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      const raw = typeof body === 'string' ? body.trim() : '';
      if (raw.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(raw));
      } catch {
        done(new Error('Invalid JSON body'), undefined);
      }
    },
  );

  /*
   * Fastify's default 404 handler logs `Route GET:/join/<token> not found` as a
   * message string. A serializer cannot redact that — it only sees `req.url` —
   * so the capability survives into the log line that `logging.ts` exists to
   * prevent. Any mistyped path carrying a token leaks it: `/api/invites/<token>/x`.
   *
   * Replacing the handler removes the log entirely, and returns the same
   * uniform body every other unauthorized, unknown, or expired capability gets.
   */
  app.setNotFoundHandler((_request, reply) => {
    const body: ErrorResponse = { error: 'not_found', message: 'Not found' };
    return reply.code(404).send(body);
  });

  app.get('/health/live', () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    const result = integrityCheck(database);
    if (result.length !== 1 || result[0] !== 'ok') {
      return reply.code(503).send({ status: 'unready' });
    }
    return { status: 'ready' };
  });

  registerRoomRoutes(app, service, {
    rateLimiter:
      options.rateLimiter ?? new RateLimiter({ scale: resolveScale() }),
  });

  const staticDirectory = options.staticDirectory ?? resolve('apps/web/dist');
  if (existsSync(staticDirectory)) {
    await app.register(fastifyStatic, {
      root: staticDirectory,
      wildcard: false,
    });
    app.get('/*', async (request, reply) => {
      // Capability paths are client routes; unknown API paths stay 404.
      if (request.url.startsWith('/api/')) {
        reply.callNotFound();
        return reply;
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
