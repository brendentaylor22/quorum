# Phase 1 operator runbook

## Fresh dedicated VM

1. Install patched Docker Engine with Compose plugin. Create low-privilege deployment administrator; do not add unrelated mounts, networks, or Docker socket access.
2. Clone repository, check out approved release, then copy `deploy/.env.example` to `deploy/.env`. Set `QUORUM_IMAGE` to exact GHCR `@sha256:` digest and `QUORUM_VCS_REF` to matching commit.
3. Create `deploy/cloudflared/config.yml` from example. Place tunnel credential JSON at `deploy/secrets/tunnel-credentials.json`; set secret file mode `0400` and deployment directory mode `0700`.
4. Authenticate Docker to GHCR using read-only package credential, then run `scripts/quorumctl start --tunnel`.
5. Run `scripts/quorumctl doctor`. Confirm Compose exposes no host ports and application has only `quorum-edge` network.

Host firewall must deny inbound public/LAN traffic except explicit administration source. Outbound policy must allow only documented DNS/NTP, GHCR, and Cloudflare Tunnel destinations. Phase 1 code makes no external application requests.

## Persistence proof

```sh
docker compose --file deploy/compose.yaml --env-file deploy/.env exec --no-TTY app node apps/api/dist/cli.js seed-foundation
scripts/quorumctl stop
scripts/quorumctl start
scripts/quorumctl doctor
```

`foundation_records` count must remain `1` after restart.

## Backup and clean-volume restore

```sh
scripts/quorumctl backup quorum-YYYYMMDDTHHMMSSZ.db
scripts/quorumctl restore quorum-YYYYMMDDTHHMMSSZ.db quorum-restore-YYYYMMDD
```

Backup uses SQLite online backup API while app remains live. Command checks `PRAGMA integrity_check` and every table record count. Restore refuses existing destination volume, requires typed volume confirmation, restores into new volume, then runs `doctor`. Keep backup directory encrypted at rest and copy verified backups off VM; Phase 4 adds automated encryption/retention.

To test restored volume, set `QUORUM_DATA_VOLUME` in `deploy/.env` to new volume, start app, run `doctor`, and inspect seeded count. Keep original volume unchanged until verification passes.

## Routine operations

- `scripts/quorumctl start [--tunnel]`: start app, optionally tunnel.
- `scripts/quorumctl stop`: stop containers; never removes volume.
- `scripts/quorumctl status`: show container and health state.
- `scripts/quorumctl doctor`: migrate forward, then verify SQLite integrity and counts.
- `scripts/quorumctl logs`: follow last 200 lines.
- `scripts/quorumctl backup NAME.db`: make verified online backup.
- `scripts/quorumctl restore NAME.db NEW_VOLUME`: verified clean-volume restore.

Never run `docker compose down --volumes` for routine stop. Never raw-copy live SQLite/WAL files.
