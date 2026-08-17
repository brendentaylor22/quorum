import { execFile } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const source = resolve(import.meta.dirname, '../../scripts/quorumctl');

interface Invocation {
  status: number;
  stdout: string;
  stderr: string;
  dockerCalls: string[];
}

interface Sandbox {
  root: string;
  script: string;
  binDirectory: string;
  dockerLog: string;
  backupsDirectory: string;
  envFile: string;
}

/**
 * quorumctl resolves its project directory from its own location and shells out
 * to `docker`. Each test gets a throwaway deployment tree plus a recording
 * `docker` stub earlier on PATH, so operator argument handling is exercised
 * without touching the repository or needing a running daemon.
 */
function createSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'quorumctl-'));
  const binDirectory = join(root, 'bin');
  const backupsDirectory = join(root, 'deploy/backups');
  mkdirSync(binDirectory);
  mkdirSync(backupsDirectory, { recursive: true });
  mkdirSync(join(root, 'scripts'));

  const script = join(root, 'scripts/quorumctl');
  copyFileSync(source, script);
  chmodSync(script, 0o755);
  copyFileSync(
    resolve(import.meta.dirname, '../../deploy/compose.yaml'),
    join(root, 'deploy/compose.yaml'),
  );

  const dockerLog = join(root, 'docker-calls.log');
  // `volume inspect` must report absence so restore proceeds past its
  // existing-volume guard; every other call succeeds.
  writeFileSync(
    join(binDirectory, 'docker'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${dockerLog}'\ncase "$*" in 'volume inspect'*) exit 1 ;; esac\nexit 0\n`,
  );
  chmodSync(join(binDirectory, 'docker'), 0o755);

  return {
    root,
    script,
    binDirectory,
    dockerLog,
    backupsDirectory,
    envFile: join(root, 'deploy/.env'),
  };
}

let sandbox: Sandbox;

beforeEach(() => {
  sandbox = createSandbox();
});

afterEach(() => {
  rmSync(sandbox.root, { recursive: true, force: true });
});

const pinnedEnv = 'QUORUM_IMAGE=ghcr.io/example/quorum@sha256:abc\n';

/** `execFile` rejects with a plain Error carrying `code`, `stdout`, `stderr`. */
function asFailure(error: unknown): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const failure = error as { code?: number; stdout?: string; stderr?: string };
  return {
    status: failure.code ?? 1,
    stdout: failure.stdout ?? '',
    stderr: failure.stderr ?? '',
  };
}

async function invoke(args: string[]): Promise<Invocation> {
  const result = await execFileAsync('sh', [sandbox.script, ...args], {
    env: {
      ...process.env,
      PATH: `${sandbox.binDirectory}:${process.env.PATH ?? ''}`,
    },
  }).then(
    (value) => ({ stdout: value.stdout, stderr: value.stderr, status: 0 }),
    asFailure,
  );

  return {
    ...result,
    dockerCalls: existsSync(sandbox.dockerLog)
      ? readFileSync(sandbox.dockerLog, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
      : [],
  };
}

describe('quorumctl', () => {
  it('rejects unknown commands with usage listing every operator command', async () => {
    const result = await invoke(['bogus']);
    expect(result.status).toBe(2);
    for (const command of [
      'start',
      'stop',
      'status',
      'doctor',
      'migrate',
      'purge',
      'backup',
      'restore',
      'logs',
      'rollback',
    ]) {
      expect(result.stderr).toContain(command);
    }
  });

  it('refuses to act without deploy/.env', async () => {
    const result = await invoke(['status']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('deploy/.env.example');
    expect(result.dockerCalls).toHaveLength(0);
  });

  it('refuses to start without the runtime token secret', async () => {
    writeFileSync(sandbox.envFile, pinnedEnv);
    const result = await invoke(['start']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('deploy/secrets/token-secret');
    expect(result.stderr).toContain('openssl rand -hex 32');
    expect(result.dockerCalls).toHaveLength(0);
  });

  it('starts the app once the token secret exists', async () => {
    writeFileSync(sandbox.envFile, pinnedEnv);
    mkdirSync(join(sandbox.root, 'deploy/secrets'), { recursive: true });
    writeFileSync(
      join(sandbox.root, 'deploy/secrets/token-secret'),
      'a'.repeat(64),
    );
    const result = await invoke(['start']);
    expect(result.status).toBe(0);
    expect(result.dockerCalls.join('\n')).toContain('up --detach app');
  });

  it('starts each supported ingress shape, and refuses an unknown one', async () => {
    writeFileSync(sandbox.envFile, pinnedEnv);
    mkdirSync(join(sandbox.root, 'deploy/secrets'), { recursive: true });
    writeFileSync(
      join(sandbox.root, 'deploy/secrets/token-secret'),
      'a'.repeat(64),
    );

    const tunnel = await invoke(['start', '--tunnel']);
    expect(tunnel.status).toBe(0);
    expect(tunnel.dockerCalls.join('\n')).toContain('--profile tunnel');

    // The proxy cannot get a certificate without a hostname, and Compose
    // cannot enforce that without making the topology unvalidatable.
    const unconfigured = await invoke(['start', '--proxy']);
    expect(unconfigured.status).toBe(1);
    expect(unconfigured.stderr).toContain('QUORUM_PUBLIC_HOSTNAME');
    expect(unconfigured.stderr).toContain('QUORUM_ACME_EMAIL');

    writeFileSync(
      sandbox.envFile,
      `${pinnedEnv}QUORUM_PUBLIC_HOSTNAME=quorum.example.org\nQUORUM_ACME_EMAIL=you@example.org\n`,
    );
    const proxy = await invoke(['start', '--proxy']);
    expect(proxy.status).toBe(0);
    expect(proxy.dockerCalls.join('\n')).toContain('--profile proxy');

    // A typo must not silently start an instance nobody can reach.
    const wrong = await invoke(['start', '--tunnnel']);
    expect(wrong.status).toBe(2);
  });

  it('says plainly that a start with no ingress serves nobody', async () => {
    writeFileSync(sandbox.envFile, pinnedEnv);
    mkdirSync(join(sandbox.root, 'deploy/secrets'), { recursive: true });
    writeFileSync(
      join(sandbox.root, 'deploy/secrets/token-secret'),
      'a'.repeat(64),
    );

    const result = await invoke(['start']);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Nothing can reach this instance');
  });

  it('runs retention on demand, and requires confirmation to purge one room', async () => {
    writeFileSync(sandbox.envFile, pinnedEnv);

    const sweep = await invoke(['purge']);
    expect(sweep.status).toBe(0);
    expect(sweep.dockerCalls.join('\n')).toContain('cli.js purge');

    // Deleting a named room is destructive, so it must not proceed unless the
    // operator types the room id back.
    const wrongConfirmation = await execFileAsync(
      'sh',
      ['-c', `printf 'yes\\n' | '${sandbox.script}' purge --room abc123`],
      {
        env: {
          ...process.env,
          PATH: `${sandbox.binDirectory}:${process.env.PATH ?? ''}`,
        },
      },
    ).catch(asFailure);
    expect(wrongConfirmation.stderr).toContain('Purge cancelled');

    const confirmed = await execFileAsync(
      'sh',
      ['-c', `printf 'abc123\\n' | '${sandbox.script}' purge --room abc123`],
      {
        env: {
          ...process.env,
          PATH: `${sandbox.binDirectory}:${process.env.PATH ?? ''}`,
        },
      },
    ).catch(asFailure);
    expect(confirmed.stderr).not.toContain('Purge cancelled');
  });

  it('runs migrate inside the app container', async () => {
    writeFileSync(sandbox.envFile, pinnedEnv);
    const result = await invoke(['migrate']);
    expect(result.status).toBe(0);
    expect(result.dockerCalls.join('\n')).toContain(
      'exec --no-TTY app node apps/api/dist/cli.js migrate',
    );
  });

  it('stops containers without removing the data volume', async () => {
    writeFileSync(sandbox.envFile, pinnedEnv);
    const result = await invoke(['stop']);
    expect(result.status).toBe(0);
    const calls = result.dockerCalls.join('\n');
    expect(calls).toContain('stop');
    expect(calls).not.toContain('down');
    expect(calls).not.toContain('--volumes');
  });

  it('rejects backup names that escape the backup directory', async () => {
    writeFileSync(sandbox.envFile, pinnedEnv);
    const result = await invoke(['backup', '../escape.db']);
    expect(result.status).toBe(2);
    expect(result.dockerCalls).toHaveLength(0);
  });

  it('preflights backup directory writability before backing up', async () => {
    writeFileSync(sandbox.envFile, pinnedEnv);
    const result = await invoke(['backup', 'quorum-test.db']);
    expect(result.status).toBe(0);
    const calls = result.dockerCalls.join('\n');
    expect(calls).toContain('--user 10001:10001');
    expect(calls).toContain(
      'exec --no-TTY app node apps/api/dist/cli.js backup /backups/quorum-test.db',
    );
  });

  it('reports the remediation when backups are not writable by the runtime UID', async () => {
    writeFileSync(sandbox.envFile, pinnedEnv);
    // Make only the writability probe fail, leaving other docker calls working.
    writeFileSync(
      join(sandbox.binDirectory, 'docker'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${sandbox.dockerLog}'\ncase "$*" in *W_OK*) exit 1 ;; 'volume inspect'*) exit 1 ;; esac\nexit 0\n`,
    );
    chmodSync(join(sandbox.binDirectory, 'docker'), 0o755);

    const result = await invoke(['backup', 'quorum-test.db']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not writable by runtime UID 10001');
    expect(result.stderr).toContain('chown 10001:10001');
    expect(result.dockerCalls.join('\n')).not.toContain('cli.js backup');
  });

  it('rejects rollback targets without an immutable digest', async () => {
    writeFileSync(sandbox.envFile, pinnedEnv);
    const result = await invoke(['rollback', 'ghcr.io/example/quorum:main']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('@sha256');
    expect(result.dockerCalls).toHaveLength(0);
  });

  it('refuses restore when the named backup is missing', async () => {
    writeFileSync(sandbox.envFile, pinnedEnv);
    const result = await invoke(['restore', 'absent.db', 'quorum-restore']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Backup not found');
  });

  it('resolves the restore image from the pinned digest in deploy/.env', async () => {
    writeFileSync(
      sandbox.envFile,
      'QUORUM_DATA_VOLUME=quorum-data\nQUORUM_IMAGE=ghcr.io/example/quorum@sha256:abc\n',
    );
    writeFileSync(join(sandbox.backupsDirectory, 'backup.db'), 'stub');
    // Existing-volume guard and typed confirmation both read from stdin/docker;
    // the stub reports the volume as absent, so supply the confirmation.
    const result = await execFileAsync(
      'sh',
      [
        '-c',
        `printf 'quorum-restore\\n' | '${sandbox.script}' restore backup.db quorum-restore`,
      ],
      {
        env: {
          ...process.env,
          PATH: `${sandbox.binDirectory}:${process.env.PATH ?? ''}`,
        },
      },
    ).catch(asFailure);

    expect(result).toBeDefined();
    const calls = readFileSync(sandbox.dockerLog, 'utf8');
    expect(calls).toContain('ghcr.io/example/quorum@sha256:abc');
    expect(calls).not.toContain('cloudflare/cloudflared');
  });

  it('fails when deploy/.env has no QUORUM_IMAGE to restore from', async () => {
    writeFileSync(sandbox.envFile, 'QUORUM_DATA_VOLUME=quorum-data\n');
    writeFileSync(join(sandbox.backupsDirectory, 'backup.db'), 'stub');
    const result = await execFileAsync(
      'sh',
      [
        '-c',
        `printf 'quorum-restore\\n' | '${sandbox.script}' restore backup.db quorum-restore`,
      ],
      {
        env: {
          ...process.env,
          PATH: `${sandbox.binDirectory}:${process.env.PATH ?? ''}`,
        },
      },
    ).then(() => ({ status: 0, stderr: '' }), asFailure);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('QUORUM_IMAGE is not set');
  });
});
