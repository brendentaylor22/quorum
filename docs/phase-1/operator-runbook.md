# Phase 1 operator runbook

This runbook is written for the author's own dedicated-VM deployment behind a
Cloudflare tunnel. **If you are installing Quorum yourself, start with
[self-hosting](../self-hosting.md)** — it covers all three ingress shapes and
every configuration variable, and its quickstart is three commands. This
document is the stricter procedure underneath it: it takes the release bundle
rather than a clone, requires a digest pin rather than allowing a tag, and uses
`scripts/quorumctl` throughout rather than raw Compose.

None of that strictness is required to run Quorum. It is required to produce
Phase 1 exit evidence, which is what this document exists for. Every
`quorumctl` command below is a wrapper over `docker compose`; the plain-Compose
equivalents are in [self-hosting](../self-hosting.md#6-operate-it).

## Fresh dedicated VM

No Node.js toolchain, compiler, or source tree belongs on the VM, and this
procedure keeps the repository off it too. GitHub builds Quorum; the release
workflow attaches a checksum-protected deployment bundle containing the Compose
file, the operator script, the runbooks, and a `.env` already pinned to the
published GHCR digest. A clone would work — the general install uses one — but
the bundle is what makes the checksum and the pin verifiable steps rather than
manual ones.

1. Install patched Docker Engine with Compose plugin. Create low-privilege deployment administrator; do not add unrelated mounts, networks, or Docker socket access.
2. Download `quorum-deploy.tar.gz` and `SHA256SUMS` from latest GitHub Release. For public repository:

   ```sh
   mkdir -p "$HOME/quorum-download"
   cd "$HOME/quorum-download"
   curl --fail --location --remote-name \
     "https://github.com/brendentaylor22/quorum/releases/latest/download/quorum-deploy.tar.gz"
   curl --fail --location --remote-name \
     "https://github.com/brendentaylor22/quorum/releases/latest/download/SHA256SUMS"
   ```

   For private repository, download same two assets through authenticated GitHub CLI or browser; no clone required:

   ```sh
   mkdir -p "$HOME/quorum-download"
   gh release download --repo brendentaylor22/quorum \
     --pattern quorum-deploy.tar.gz \
     --pattern SHA256SUMS \
     --dir "$HOME/quorum-download"
   ```

   Verify and extract downloaded bundle:

   ```sh
   cd "$HOME/quorum-download"
   grep 'quorum-deploy.tar.gz' SHA256SUMS | sha256sum --check -
   install -d -m 0700 "$HOME/quorum"
   tar --extract --gzip \
     --file quorum-deploy.tar.gz \
     --strip-components 1 \
     --directory "$HOME/quorum"
   cd "$HOME/quorum"
   ```

3. Inspect `RELEASE` and `deploy/.env`. `QUORUM_IMAGE` must contain exact `ghcr.io/brendentaylor22/quorum@sha256:...` identity, never floating tag. The bundle generates it pinned; `deploy/.env.example` in the repository ships the `:latest` tag instead, which is not acceptable here.
4. Choose an ingress shape. This runbook uses the Cloudflare tunnel. `--proxy`
   runs Caddy inside the Compose project instead, and needs
   `QUORUM_PUBLIC_HOSTNAME` and `QUORUM_ACME_EMAIL` in `deploy/.env` plus ports
   80 and 443 reaching the host. `--existing-ingress` starts the app alone, for
   a proxy you already run that joins `quorum-edge`. Whichever shape, set
   `QUORUM_TRUST_PROXY` in `deploy/.env`: without it every caller shares one
   rate-limit bucket, because every request appears to come from the ingress
   container.

   For the tunnel, create it and route the hostname to it from a workstation with `cloudflared` logged in — `cloudflared tunnel create quorum`, then `cloudflared tunnel route dns quorum <hostname>`, which writes the proxied `CNAME` to `<uuid>.cfargotunnel.com` in the Cloudflare zone. Copy `deploy/cloudflared/config.example.yml` to `deploy/cloudflared/config.yml` and set tunnel UUID/hostname. Place tunnel credential JSON at `deploy/secrets/tunnel-credentials.json`. Ensure numeric group `65532` exists, then set credential owner to deployment administrator, group to `65532`, and mode to `0440`; non-root `cloudflared` runs with that GID.

   ```sh
   getent group 65532 >/dev/null || sudo groupadd --gid 65532 cloudflared-runtime
   sudo chown "$(id -un):65532" deploy/secrets/tunnel-credentials.json
   chmod 0440 deploy/secrets/tunnel-credentials.json
   ```

5. Give the backup directory to the runtime UID. Application runs as unprivileged `10001:10001` and writes backups through the `deploy/backups` bind mount; a freshly extracted bundle leaves that directory owned by deployment administrator, so backups would fail.

   ```sh
   mkdir -p deploy/backups
   sudo chown 10001:10001 deploy/backups
   chmod 0750 deploy/backups
   ```

   `scripts/quorumctl backup` verifies this before running and refuses with the same remediation if ownership is wrong.

6. Create the runtime token secret. Every stored invite, host, and participant-session hash is keyed with it, so it must exist before first start and must not be rotated casually: rotation invalidates every live room and session.

   ```sh
   openssl rand -hex 32 > deploy/secrets/token-secret
   chmod 0400 deploy/secrets/token-secret
   ```

   `scripts/quorumctl start` refuses to run without it. Back it up with the same care as the database; a lost secret makes existing rooms unreachable.

7. If GHCR package is private, authenticate Docker using read-only package credential. Do not store token in repository or deployment bundle.

   ```sh
   read -r -s -p 'GHCR read token: ' GHCR_READ_TOKEN
   printf '\n'
   printf '%s' "$GHCR_READ_TOKEN" | docker login ghcr.io --username YOUR_GITHUB_USERNAME --password-stdin
   unset GHCR_READ_TOKEN
   ```

8. Run `scripts/quorumctl start --tunnel`. Compose pulls exact image digest from GHCR; no local build occurs.
9. Run `scripts/quorumctl doctor`. Confirm Compose exposes no host ports and application has only `quorum-edge` network.

Host firewall must deny inbound public/LAN traffic except explicit administration source. Outbound policy must allow only documented DNS/NTP, GHCR, and Cloudflare Tunnel destinations. Phase 1 code makes no external application requests.

## Persistence proof

```sh
docker compose --file deploy/compose.yaml --env-file deploy/.env exec --no-TTY app node apps/api/dist/cli.js import-catalog
scripts/quorumctl stop
scripts/quorumctl start
scripts/quorumctl doctor
```

`catalog_items` count must remain `20` after restart, and any room, exposure, and interaction counts must be unchanged.

## Backup and clean-volume restore

```sh
scripts/quorumctl backup quorum-YYYYMMDDTHHMMSSZ.db
scripts/quorumctl restore quorum-YYYYMMDDTHHMMSSZ.db quorum-restore-YYYYMMDD
```

Backup uses SQLite online backup API while app remains live. Command checks `PRAGMA integrity_check` and every table record count. Restore refuses existing destination volume, requires typed volume confirmation, restores into new volume, then runs `doctor`. Keep backup directory encrypted at rest and copy verified backups off VM; Phase 4 adds automated encryption/retention.

To test restored volume, set `QUORUM_DATA_VOLUME` in `deploy/.env` to new volume, start app, run `doctor`, and inspect seeded count. Keep original volume unchanged until verification passes.

## Routine operations

- `scripts/quorumctl start [--tunnel|--proxy|--existing-ingress]`: start app with the chosen ingress. With no flag the app runs with no route in at all, which is useful for migrate and catalog work and serves nobody.
- `scripts/quorumctl stop`: stop containers; never removes volume.
- `scripts/quorumctl status`: show container and health state.
- `scripts/quorumctl doctor`: migrate forward, then verify SQLite integrity and counts.
- `scripts/quorumctl migrate`: apply pending forward-only migrations and report applied names.
- `scripts/quorumctl logs`: follow last 200 lines.
- `scripts/quorumctl purge [--room ROOM_ID]`: apply retention now, or delete one room outright for a deletion request. The single-room form requires typing the room id back.
- `scripts/quorumctl backup NAME.db`: make verified online backup.
- `scripts/quorumctl restore NAME.db NEW_VOLUME`: verified clean-volume restore.

Never run `docker compose down --volumes` for routine stop. Never raw-copy live SQLite/WAL files.

Each of these is a `docker compose` call with a precondition attached — the wrapper is what refuses a start without a token secret, a backup into a directory the runtime UID cannot write, a rollback to a floating tag, and a `purge --room` or `restore` without the name typed back. Use it here; the raw equivalents are in [self-hosting](../self-hosting.md#6-operate-it).

## Upgrade without repository clone

1. Download and verify new release bundle into temporary download directory.
2. Run current `scripts/quorumctl backup pre-upgrade-YYYYMMDDTHHMMSSZ.db` and `scripts/quorumctl doctor`.
3. Extract new archive into existing `$HOME/quorum` with `--strip-components 1`. Archive updates Compose, operator files, runbooks, release metadata, and digest-pinned `.env`; it contains no tunnel credential and does not delete existing backup/secret files.
4. Run `scripts/quorumctl start --tunnel`, then `scripts/quorumctl doctor`.
5. Confirm running image by digest and retain prior digest for rollback.
