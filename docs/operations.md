# Operations

[Self-hosting](self-hosting.md) is the guide for getting Quorum running: three
commands, three ingress shapes, every configuration variable. **Start there.**

This document is the stricter procedure underneath it, for an instance other
people depend on. It takes the release bundle rather than a clone, requires a
digest pin rather than allowing a tag, and uses `scripts/quorumctl` throughout
rather than raw Compose. None of that is required to run Quorum. It is what
makes each step — what you downloaded, what image you are running, that a
backup restores — verifiable rather than assumed.

Every `quorumctl` command below is a wrapper over `docker compose`; the
plain-Compose equivalents are in [self-hosting](self-hosting.md#6-operate-it).

## A dedicated host

No Node.js toolchain, compiler, or source tree belongs on the host, and this
procedure keeps the repository off it too. GitHub builds Quorum; the release
workflow attaches a checksum-protected deployment bundle containing the Compose
file, the operator script, the runbooks, and a `.env` already pinned to the
published GHCR digest. A clone works — the general install uses one — but the
bundle is what makes the checksum and the pin verifiable steps rather than
manual ones.

1. Install a patched Docker Engine with the Compose plugin. Create a
   low-privilege deployment account; do not add unrelated mounts, networks, or
   Docker socket access.

2. Download `quorum-deploy.tar.gz` and `SHA256SUMS` from the latest release:

   ```sh
   mkdir -p "$HOME/quorum-download"
   cd "$HOME/quorum-download"
   curl --fail --location --remote-name \
     "https://github.com/brendentaylor22/quorum/releases/latest/download/quorum-deploy.tar.gz"
   curl --fail --location --remote-name \
     "https://github.com/brendentaylor22/quorum/releases/latest/download/SHA256SUMS"
   ```

   Verify and extract:

   ```sh
   grep 'quorum-deploy.tar.gz' SHA256SUMS | sha256sum --check -
   install -d -m 0700 "$HOME/quorum"
   tar --extract --gzip \
     --file quorum-deploy.tar.gz \
     --strip-components 1 \
     --directory "$HOME/quorum"
   cd "$HOME/quorum"
   ```

3. Inspect `RELEASE` and `deploy/.env`. `QUORUM_IMAGE` must be an exact
   `ghcr.io/brendentaylor22/quorum@sha256:...` identity, never a floating tag.
   The bundle generates it pinned; `deploy/.env.example` in the repository ships
   the `:latest` tag instead, which is not acceptable here.

4. Choose an ingress shape. `--proxy` runs Caddy inside the Compose project and
   needs `QUORUM_PUBLIC_HOSTNAME` and `QUORUM_ACME_EMAIL` in `deploy/.env` plus
   ports 80 and 443 reaching the host. `--existing-ingress` starts the app
   alone, for a proxy you already run that joins `quorum-edge`. `--tunnel` runs
   a Cloudflare tunnel and opens no inbound port at all.

   Whichever shape, set `QUORUM_TRUST_PROXY` in `deploy/.env`: without it every
   caller shares one rate-limit bucket, because every request appears to come
   from the ingress container.

   For the tunnel, create it and route the hostname from a workstation with
   `cloudflared` logged in — `cloudflared tunnel create quorum`, then
   `cloudflared tunnel route dns quorum <hostname>`, which writes the proxied
   `CNAME` to `<uuid>.cfargotunnel.com` in the Cloudflare zone. Copy
   `deploy/cloudflared/config.example.yml` to `deploy/cloudflared/config.yml`
   and set the tunnel UUID and hostname. Place the tunnel credential JSON at
   `deploy/secrets/tunnel-credentials.json`. Ensure the numeric group `65532`
   exists, then set the credential's owner to the deployment account, its group
   to `65532`, and its mode to `0440`; non-root `cloudflared` runs with that
   GID.

   ```sh
   getent group 65532 >/dev/null || sudo groupadd --gid 65532 cloudflared-runtime
   sudo chown "$(id -un):65532" deploy/secrets/tunnel-credentials.json
   chmod 0440 deploy/secrets/tunnel-credentials.json
   ```

5. Give the backup directory to the runtime UID. The application runs as
   unprivileged `10001:10001` and writes backups through the `deploy/backups`
   bind mount; a freshly extracted bundle leaves that directory owned by the
   deployment account, so backups would fail.

   ```sh
   mkdir -p deploy/backups
   sudo chown 10001:10001 deploy/backups
   chmod 0750 deploy/backups
   ```

   `scripts/quorumctl backup` verifies this before running and refuses with the
   same remediation if ownership is wrong.

6. Create the runtime token secret. Every stored invite, host, and
   participant-session hash is keyed with it, so it must exist before first
   start and must not be rotated casually: rotation invalidates every live room
   and session.

   ```sh
   openssl rand -hex 32 > deploy/secrets/token-secret
   chmod 0400 deploy/secrets/token-secret
   ```

   `scripts/quorumctl start` refuses to run without it. Back it up with the same
   care as the database; a lost secret makes existing rooms unreachable.

7. If the GHCR package is private, authenticate Docker with a read-only package
   credential. Do not store the token in the repository or the bundle.

   ```sh
   read -r -s -p 'GHCR read token: ' GHCR_READ_TOKEN
   printf '\n'
   printf '%s' "$GHCR_READ_TOKEN" | docker login ghcr.io --username YOUR_GITHUB_USERNAME --password-stdin
   unset GHCR_READ_TOKEN
   ```

8. Run `scripts/quorumctl start --tunnel` (or `--proxy`, `--existing-ingress`).
   Compose pulls the exact image digest from GHCR; no local build occurs.

9. Run `scripts/quorumctl doctor`. Confirm Compose publishes no host ports and
   that the application has only the `quorum-edge` network.

The host firewall should deny inbound public and LAN traffic except from an
explicit administration source. Outbound policy needs only DNS, NTP, GHCR, and —
for the tunnel shape — Cloudflare. The serving container makes no external
requests of its own; only the short-lived catalog-refresh container does.

## Persistence check

```sh
scripts/quorumctl stop
scripts/quorumctl start --tunnel
scripts/quorumctl doctor
```

`catalog_items` and any room, exposure, and interaction counts must be unchanged
across the restart.

## Backup and clean-volume restore

```sh
scripts/quorumctl backup quorum-YYYYMMDDTHHMMSSZ.db
scripts/quorumctl restore quorum-YYYYMMDDTHHMMSSZ.db quorum-restore-YYYYMMDD
```

Backup uses the SQLite online backup API while the app stays live, then checks
`PRAGMA integrity_check` and every table's record count. Restore refuses an
existing destination volume, requires the volume name typed back, restores into
the new volume, and runs `doctor`.

To verify a restored volume, set `QUORUM_DATA_VOLUME` in `deploy/.env` to it,
start the app, run `doctor`, and inspect the counts. Keep the original volume
untouched until that passes.

Backups are unencrypted. Encrypt the backup directory at rest and copy verified
backups off the host. Never publish one: it holds bulk provider metadata as well
as room data.

## Routine operations

- `scripts/quorumctl start [--tunnel|--proxy|--existing-ingress]` — start with
  the chosen ingress. With no flag the app runs with no route in at all, which
  is useful for migrate and catalog work and serves nobody.
- `scripts/quorumctl stop` — stop containers; never removes the volume.
- `scripts/quorumctl status` — container and health state.
- `scripts/quorumctl doctor` — migrate forward, then verify SQLite integrity and
  counts.
- `scripts/quorumctl migrate` — apply pending forward-only migrations and report
  the applied names.
- `scripts/quorumctl logs` — follow the last 200 lines.
- `scripts/quorumctl purge [--room ROOM_ID]` — apply retention now, or delete
  one room outright for a deletion request. The single-room form requires the
  room id typed back.
- `scripts/quorumctl backup NAME.db` — verified online backup.
- `scripts/quorumctl restore NAME.db NEW_VOLUME` — verified clean-volume
  restore.

Never run `docker compose down --volumes` for a routine stop. Never raw-copy
live SQLite or WAL files.

Each of these is a `docker compose` call with a precondition attached — the
wrapper is what refuses a start without a token secret, a backup into a
directory the runtime UID cannot write, a rollback to a floating tag, and a
`purge --room` or `restore` without the name typed back.

## Upgrade

1. Download and verify the new release bundle into a temporary directory.
2. Run `scripts/quorumctl backup pre-upgrade-YYYYMMDDTHHMMSSZ.db` and
   `scripts/quorumctl doctor`.
3. Extract the new archive over `$HOME/quorum` with `--strip-components 1`. It
   updates Compose, the operator script, the runbooks, release metadata, and the
   digest-pinned `.env`; it carries no tunnel credential and deletes no existing
   backup or secret.
4. Run `scripts/quorumctl start --tunnel`, then `scripts/quorumctl doctor`.
5. Confirm the running image by digest, and keep the prior digest for rollback.

## Rollback

Preconditions:

- Record the current image digest, the target prior digest, the database
  migration version, and the latest verified backup.
- Roll back only when the target image is compatible with every migration
  already applied. Migrations are forward-only.
- Do not restore an older database merely to run incompatible code until the
  backup is verified and the decision is explicit.

Procedure:

1. `scripts/quorumctl backup pre-rollback-YYYYMMDDTHHMMSSZ.db`
2. `scripts/quorumctl doctor` — stop if integrity fails.
3. `scripts/quorumctl rollback ghcr.io/brendentaylor22/quorum@sha256:FULL_DIGEST`
4. Confirm health, the static shell, the running image digest, the logs, and the
   `rooms` and `interactions` counts.
5. Persist the verified digest as `QUORUM_IMAGE` in `deploy/.env`.

If the target fails health, repeat with the previously running digest. Escalate
rather than deleting the volume or reversing migrations.
