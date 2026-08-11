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

export interface BuildAppOptions {
  databasePath?: string;
  staticDirectory?: string;
  logger?: boolean;
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const database: QuorumDatabase = openDatabase(options.databasePath);
  migrate(database, migrationsDirectory);
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 16 * 1024,
    trustProxy: false,
  });

  app.addHook('onClose', () => {
    database.close();
  });
  app.get('/health/live', () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    const result = integrityCheck(database);
    if (result.length !== 1 || result[0] !== 'ok') {
      return reply.code(503).send({ status: 'unready' });
    }
    return { status: 'ready' };
  });

  const staticDirectory = options.staticDirectory ?? resolve('apps/web/dist');
  if (existsSync(staticDirectory)) {
    await app.register(fastifyStatic, {
      root: staticDirectory,
      wildcard: false,
    });
    app.get('/*', async (_request, reply) => reply.sendFile('index.html'));
  }

  return app;
}
