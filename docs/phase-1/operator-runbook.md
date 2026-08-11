# Phase 1 operator runbook

## Fresh dedicated VM

No repository clone, Node.js toolchain, compiler, or source tree belongs on VM. GitHub builds Quorum. Release workflow attaches pull-only deployment bundle containing Compose file, operator script, runbooks, and `.env` already pinned to published GHCR digest.

1. Install patched Docker Engine with Compose plugin. Create low-privilege deployment administrator; do not add unrelated mounts, networks, or Docker socket access.
2. Download `quorum-deploy-VERSION.tar.gz` and `SHA256SUMS` from matching GitHub Release. For public repository:

   ```sh
   QUORUM_VERSION=v0.1.2
   mkdir -p "$HOME/quorum-download"
   cd "$HOME/quorum-download"
   curl --fail --location --remote-name \
     "https://github.com/brendentaylor22/quorum/releases/download/${QUORUM_VERSION}/quorum-deploy-${QUORUM_VERSION}.tar.gz"
   curl --fail --location --remote-name \
     "https://github.com/brendentaylor22/quorum/releases/download/${QUORUM_VERSION}/SHA256SUMS"
   grep "quorum-deploy-${QUORUM_VERSION}.tar.gz" SHA256SUMS | sha256sum --check -
   install -d -m 0700 "$HOME/quorum"
   tar --extract --gzip \
     --file "quorum-deploy-${QUORUM_VERSION}.tar.gz" \
     --strip-components 1 \
     --directory "$HOME/quorum"
   cd "$HOME/quorum"
   ```

   For private repository, download same two assets through authenticated GitHub CLI or browser; no clone required:

   ```sh
   QUORUM_VERSION=v0.1.2
   mkdir -p "$HOME/quorum-download"
   gh release download "$QUORUM_VERSION" \
     --repo brendentaylor22/quorum \
     --pattern "quorum-deploy-${QUORUM_VERSION}.tar.gz" \
     --pattern SHA256SUMS \
     --dir "$HOME/quorum-download"
   cd "$HOME/quorum-download"
   grep "quorum-deploy-${QUORUM_VERSION}.tar.gz" SHA256SUMS | sha256sum --check -
   ```

3. Inspect `RELEASE` and `deploy/.env`. `QUORUM_IMAGE` must contain exact `ghcr.io/brendentaylor22/quorum@sha256:...` identity, never floating tag.
4. Copy `deploy/cloudflared/config.example.yml` to `deploy/cloudflared/config.yml` and set tunnel UUID/hostname. Place tunnel credential JSON at `deploy/secrets/tunnel-credentials.json`. Ensure numeric group `65532` exists, then set credential owner to deployment administrator, group to `65532`, and mode to `0440`; non-root `cloudflared` runs with that GID.

   ```sh
   getent group 65532 >/dev/null || sudo groupadd --gid 65532 cloudflared-runtime
   sudo chown "$(id -un):65532" deploy/secrets/tunnel-credentials.json
   chmod 0440 deploy/secrets/tunnel-credentials.json
   ```

5. If GHCR package is private, authenticate Docker using read-only package credential. Do not store token in repository or deployment bundle.

   ```sh
   read -r -s -p 'GHCR read token: ' GHCR_READ_TOKEN
   printf '\n'
   printf '%s' "$GHCR_READ_TOKEN" | docker login ghcr.io --username YOUR_GITHUB_USERNAME --password-stdin
   unset GHCR_READ_TOKEN
   ```

6. Run `scripts/quorumctl start --tunnel`. Compose pulls exact image digest from GHCR; no local build occurs.
7. Run `scripts/quorumctl doctor`. Confirm Compose exposes no host ports and application has only `quorum-edge` network.

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

## Upgrade without repository clone

1. Download and verify new release bundle into temporary download directory.
2. Run current `scripts/quorumctl backup pre-upgrade-YYYYMMDDTHHMMSSZ.db` and `scripts/quorumctl doctor`.
3. Extract new archive into existing `$HOME/quorum` with `--strip-components 1`. Archive updates Compose, operator files, runbooks, release metadata, and digest-pinned `.env`; it contains no tunnel credential and does not delete existing backup/secret files.
4. Run `scripts/quorumctl start --tunnel`, then `scripts/quorumctl doctor`.
5. Confirm running image by digest and retain prior digest for rollback.
