import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
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
import { registerRoomRoutes } from './routes.js';
import { RoomService } from './rooms/service.js';

export interface BuildAppOptions {
  databasePath?: string;
  staticDirectory?: string;
  logger?: boolean;
  now?: () => Date;
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
    logger: options.logger ?? false,
    bodyLimit: 16 * 1024,
    trustProxy: false,
  });

  app.addHook('onClose', () => {
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

  app.get('/health/live', () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    const result = integrityCheck(database);
    if (result.length !== 1 || result[0] !== 'ok') {
      return reply.code(503).send({ status: 'unready' });
    }
    return { status: 'ready' };
  });

  registerRoomRoutes(app, service);

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
