#!/usr/bin/env node
// Local development: Fastify API plus the Vite client, one command, one
// SQLite file under .data. Nothing here runs in production images.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const apiPort = process.env.QUORUM_API_PORT ?? '3000';
const webPort = process.env.QUORUM_WEB_PORT ?? '5173';
const databasePath = resolve(
  process.env.QUORUM_DATABASE_PATH ?? '.data/quorum.db',
);
mkdirSync(dirname(databasePath), { recursive: true });

const environment = {
  ...process.env,
  QUORUM_DATABASE_PATH: databasePath,
  QUORUM_API_PORT: apiPort,
  QUORUM_WEB_PORT: webPort,
  PORT: apiPort,
  HOST: '127.0.0.1',
  // Plain-HTTP localhost only; production builds always set Secure cookies.
  QUORUM_ALLOW_INSECURE_COOKIES: '1',
};

const children = [
  spawn('npm', ['run', 'dev', '--workspace', '@quorum/api'], {
    stdio: 'inherit',
    env: environment,
  }),
  spawn('npm', ['run', 'dev', '--workspace', '@quorum/web'], {
    stdio: 'inherit',
    env: environment,
  }),
];

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}

for (const child of children) {
  child.on('exit', (code) => {
    stop(code ?? 0);
  });
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stop(0);
  });
}

console.log(`Quorum development server: http://localhost:${webPort}`);
