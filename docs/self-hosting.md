# Self-hosting Quorum

Updated: 2026-08-17

Quorum is one container, one SQLite file, and no external service at request
time. This is what it takes to run your own.

You need: a Linux host with Docker and Compose, a hostname you control, and
somewhere for TLS to be terminated. You do **not** need a Cloudflare account, a
GitHub account, or a TMDB key to get started — Quorum ships with a 20-movie
fixture catalog so a fresh install is playable immediately.

## What you are agreeing to run

- **Quorum's code is AGPL-3.0-or-later.** If you modify it and let other people
  use your instance over a network, you have to offer them your changes. Running
  it unmodified for your friends carries no obligation beyond keeping the source
  offer in the footer intact.
- **Movie data is not Quorum's to give you.** If you import a real catalog you
  register your own TMDB account and accept TMDB's terms directly, including
  their non-commercial restriction and their six-month cache limit. See
  [TMDB use review](phase-0/tmdb-use-review.md).
- **You are the operator.** Quorum ships hardened defaults, but the token
  secret, the backups, TLS, and the update cadence are yours. See
  [SECURITY.md](../SECURITY.md).

## 1. Get the bundle

Every push to `main` publishes an image to GHCR and cuts a GitHub Release
containing a checksum-protected deployment bundle: the Compose file, the
`quorumctl` script, the proxy and tunnel configuration, and a `deploy/.env`
pinning the exact image digest that release was built from.

```sh
# From the latest release page
tar -xzf quorum-deploy-<release>.tar.gz
cd quorum-deploy-<release>
sha256sum --check SHA256SUMS
```

The host never clones this repository and never builds an image. Compose pulls
the pinned `ghcr.io/...@sha256:...` digest, so what you run is what was scanned.

To build your own image instead, clone the repository and
`docker build -t quorum:local .`, then set `QUORUM_IMAGE=quorum:local` in
`deploy/.env`. You lose the digest guarantee and the release scan; that is your
call to make.

## 2. Create the token secret

Every invite, host link, and session hash is keyed with this. It must exist
before the first start, and it must not change casually: rotating it invalidates
every live room and session in one go, which is also the emergency lever if you
think it leaked.

```sh
openssl rand -hex 32 > deploy/secrets/token-secret
chmod 0400 deploy/secrets/token-secret
```

Back it up with the same care as the database. A database restored without its
matching token secret has rooms nobody can open.

## 3. Choose how traffic reaches it

The application container **publishes no port and has no route to the
Internet** — it sits on an `internal: true` Docker network. That is deliberate,
and it means something in front of it has to bridge the gap. Two shapes are
supported, and both keep that property.

### Option A — your own reverse proxy (no third-party account)

Caddy runs inside the Compose project, joins the internal network to reach the
application, and gets its own separate network to reach the certificate
authority. It obtains and renews TLS certificates automatically.

In `deploy/.env`:

```sh
QUORUM_PUBLIC_HOSTNAME=quorum.example.org
QUORUM_ACME_EMAIL=you@example.org
# Believe X-Forwarded-For from the proxy container only. See "Trusting the
# proxy" below — getting this wrong breaks rate limiting in one direction or
# the other.
QUORUM_TRUST_PROXY=172.16.0.0/12
```

Then:

```sh
scripts/quorumctl start --proxy
scripts/quorumctl doctor
```

`QUORUM_PUBLIC_HOSTNAME` must resolve to this host, and ports 80 and 443 must
reach it, or the certificate cannot be issued.

Already running nginx, Traefik, or HAProxy elsewhere? Point it at the app by
attaching your proxy to the `quorum-edge` network rather than publishing a port
from the app. Forward `X-Forwarded-For` and `X-Forwarded-Proto`, and set
`QUORUM_TRUST_PROXY` to your proxy's address.

### Option B — Cloudflare Tunnel (no open inbound port)

The host opens no inbound port at all; `cloudflared` makes an outbound
connection and Cloudflare routes to it. This is the shape
[ADR 0003](adr/0003-cloudflare-tunnel.md) chose, and it is the better option
behind a home router.

Put the tunnel credential at `deploy/secrets/tunnel-credentials.json` (mode
`0440`, group `65532`), set the hostname in `deploy/cloudflared/config.yml`,
then:

```sh
QUORUM_TRUST_PROXY=true scripts/quorumctl start --tunnel
scripts/quorumctl doctor
```

### What is not supported

**Publishing the app's port directly.** Quorum sets `Secure` cookies whenever
`NODE_ENV=production`, and refuses to relax that. Over plain HTTP the session
cookie is never stored and nobody can vote. This is not a setting to hunt for;
terminate TLS somewhere.

For a LAN-only instance, run the proxy with an internal certificate authority
or a self-signed certificate your devices trust. `npm run dev` is the only
plain-HTTP path, and it is for development, not for a household.

### Trusting the proxy

`QUORUM_TRUST_PROXY` is the one setting that can silently break rate limiting in
either direction:

- **Left off behind a proxy**, every request appears to come from the proxy, so
  one rate-limit bucket serves everybody and the first busy room locks out the
  rest.
- **Turned on with no trusted proxy in front**, a caller sets `X-Forwarded-For`
  themselves and every limit becomes decorative.

So it defaults to off, and you set it deliberately. It accepts `true`, a hop
count, or — best — a comma-separated list of addresses or CIDRs you actually
trust.

## 4. Import a real catalog (optional)

Without this you get 20 fixture movies, which is enough to play but not enough
to be interesting.

Register at [TMDB](https://www.themoviedb.org/settings/api) for a **v4 read
access token**, then:

```sh
printf '%s' 'eyJhbGciOi...' > deploy/secrets/tmdb-read-access-token.secret
chmod 0400 deploy/secrets/tmdb-read-access-token.secret

docker compose --profile refresh run --rm catalog-refresh
scripts/quorumctl doctor
```

A first import of ~13,000 movies takes 10–15 minutes at a deliberately polite
request rate. The importer runs as its own short-lived container on its own
network — it is the only part of Quorum that reaches the Internet, and the
serving application never does. If TMDB is down, existing rooms and results are
unaffected.

Re-run it every few months. `doctor` and `catalog-status` exit non-zero once the
catalog passes TMDB's six-month cache limit, so staleness fails loudly rather
than quietly breaching the provider's terms. Tuning:
[catalog ingestion](phase-4/catalog-ingestion.md#configuration).

## 5. Operate it

```sh
scripts/quorumctl status
scripts/quorumctl doctor          # integrity + catalog age; non-zero on trouble
scripts/quorumctl logs
scripts/quorumctl backup daily.db
scripts/quorumctl purge           # apply retention now
scripts/quorumctl stop            # keeps the data volume
```

**Back up.** `quorumctl backup` uses the SQLite backup API, so it is safe on a
running instance. Copy the result off the host, and never publish one — a backup
contains bulk provider metadata as well as room data. Restore is deliberately
awkward: it requires an explicit new volume name and typing that name back.

**Retention runs itself.** Rooms expire (24 hours in lobby, 24 more once voting
starts, 7 days after completion), and expired rooms are deleted 24 hours later
along with every participant, exposure, and interaction. `quorumctl purge
--room <roomId>` deletes one room immediately, for a deletion request.

**Update by digest.** Set the new `QUORUM_IMAGE` in `deploy/.env` and
`scripts/quorumctl start` again; `scripts/quorumctl rollback <image@sha256:...>`
goes back. Migrations are forward-only.

## Configuration reference

Everything Quorum reads from the environment. Only `QUORUM_TOKEN_SECRET_FILE`
is mandatory in production.

### Application

| Variable                         | Default            | What it does                                                                                                                                                                   |
| -------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `QUORUM_TOKEN_SECRET_FILE`       | —                  | File holding the key for every capability hash. Mandatory in production; preferred over the variable below because a file stays out of the process table and `docker inspect`. |
| `QUORUM_TOKEN_SECRET`            | —                  | The key itself. Development and testing only.                                                                                                                                  |
| `QUORUM_DATABASE_PATH`           | `/data/quorum.db`  | SQLite file.                                                                                                                                                                   |
| `QUORUM_TRUST_PROXY`             | off                | Whose `X-Forwarded-For` to believe: `true`, a hop count, or a list of addresses/CIDRs. See "Trusting the proxy".                                                               |
| `QUORUM_RATE_LIMIT_SCALE`        | `1`                | Multiplies every rate limit. Raise behind a large shared address; `0` disables limiting entirely and is only defensible on a trusted private network.                          |
| `QUORUM_RETENTION_SWEEP_MINUTES` | `15`               | How often expiry and purge run.                                                                                                                                                |
| `QUORUM_ALLOW_INSECURE_COOKIES`  | off                | Drops `Secure` from cookies for plain-HTTP localhost. Ignored when `NODE_ENV=production`.                                                                                      |
| `PORT` / `HOST`                  | `3000` / `0.0.0.0` | Listener. Inside the container this needs no changing.                                                                                                                         |

### Catalog import

Read only by the `catalog-refresh` container.

| Variable                                          | Default          | What it does                                      |
| ------------------------------------------------- | ---------------- | ------------------------------------------------- |
| `TMDB_READ_ACCESS_TOKEN_FILE`                     | —                | File holding the TMDB v4 read access token.       |
| `QUORUM_CATALOG_MIN_VOTES`                        | `600`            | Vote floor for inclusion.                         |
| `QUORUM_CATALOG_FIRST_YEAR` / `_LAST_YEAR`        | `1930` / current | Release-year sweep bounds.                        |
| `QUORUM_CATALOG_MAX_ITEMS`                        | `30000`          | Ceiling on imported movies.                       |
| `QUORUM_CATALOG_RATING_PRIOR`                     | `3000`           | Confidence prior in the Bayesian weighted rating. |
| `QUORUM_CATALOG_CONCURRENCY`                      | `12`             | Parallel detail fetches.                          |
| `QUORUM_CATALOG_REGIONS`                          | `GB,US`          | Release regions for certification lookup.         |
| `QUORUM_CATALOG_LANGUAGES` / `_ORIGINAL_LANGUAGE` | —                | Language filters.                                 |
| `QUORUM_CATALOG_FIXTURE_PATH`                     | bundled          | Override the fallback fixture catalog.            |

### Deployment

Read by Compose, not by the application.

| Variable                 | Default       | What it does                                      |
| ------------------------ | ------------- | ------------------------------------------------- |
| `QUORUM_IMAGE`           | —             | Image to run. Use an immutable `@sha256:` digest. |
| `QUORUM_DATA_VOLUME`     | `quorum-data` | Named volume holding the database.                |
| `QUORUM_PUBLIC_HOSTNAME` | —             | Hostname the proxy profile serves.                |
| `QUORUM_ACME_EMAIL`      | —             | Contact address for certificate problems.         |

### Development only

| Variable                              | Default         | What it does                                 |
| ------------------------------------- | --------------- | -------------------------------------------- |
| `QUORUM_API_PORT` / `QUORUM_WEB_PORT` | `3000` / `5173` | Ports for `npm run dev`.                     |
| `QUORUM_WEB_HOST`                     | all interfaces  | Set to `127.0.0.1` to keep Vite off the LAN. |

## Troubleshooting

**Nobody can join, or everyone is logged out immediately.** Cookies are
`Secure`, so the browser is dropping them over plain HTTP. Terminate TLS.

**Everyone in the house gets "Too many requests".** `QUORUM_TRUST_PROXY` is not
set, so every device shares the proxy's rate-limit bucket. Set it to your
proxy's address.

**`doctor` exits non-zero with an empty or stale catalog.** That is the intended
behaviour. Run a catalog refresh.

**The invite link points at the wrong address.** Invite links are built from the
address the host used to create the room. Use the public hostname, not the
container or LAN address.

**A room disappeared.** Rooms expire: 24 hours in lobby, 24 more once voting
starts, 7 days after completion. Expired rooms are deleted 24 hours after that,
and no, they cannot be recovered except from a backup.
