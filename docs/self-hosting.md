# Self-hosting Quorum

Updated: 2026-08-17

Quorum is one container, one SQLite file, and no external service at request
time. This is what it takes to run your own.

You need: a Linux host with Docker and Compose, a hostname you control, and
somewhere for TLS to be terminated. You do **not** need a Cloudflare account, a
GitHub account, or a TMDB key to get started — Quorum ships with a 60-movie
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

## Quickstart

```sh
git clone https://github.com/brendentaylor22/quorum.git
cd quorum/deploy

cp .env.example .env                            # works as shipped; read it
openssl rand -hex 32 > secrets/token-secret     # see step 2 — do not skip
chmod 0400 secrets/token-secret

docker compose up -d
docker compose logs -f app
```

That is the whole install. Compose pulls the published image; nothing is built
locally, and the repository is only there for the Compose file. Read on for the
part the quickstart cannot do for you: **nothing can reach the instance yet**,
because the app publishes no port by design. Step 3 is how traffic gets in.

Two shortcuts if the shape of your host is already decided: adding Quorum as one
service to a Compose file you already run is
[here](#adding-quorum-to-a-compose-file-you-already-have), and closing room
creation to everyone but yourself is [step 4](#4-decide-who-may-start-a-room).

## 1. Get the files

You need two files on the host — `deploy/compose.yaml` and a `deploy/.env` —
plus the `deploy/secrets/` and `deploy/backups/` directories beside them. The
clone above is the simplest way to get all of that. Downloading the two files
straight out of the repository works equally well if you would rather not clone.

Only `.env` is yours to edit. Every setting has a default that works, and the
file documents each one where you will be editing it; the
[configuration reference](#configuration-reference) below repeats them in table
form.

### Pinning the image

`.env.example` ships `QUORUM_IMAGE=ghcr.io/brendentaylor22/quorum:latest`, which
follows every push to `main`. That is the right default for trying it out and
the wrong one for something you depend on: `latest` means the container you
restart tonight need not be the one you scanned this morning.

Every push to `main` also cuts a GitHub Release recording the exact image digest
it was built from, after the full checks, the browser suite, and an image smoke
test have passed. The digest is in the release's `quorum-deploy.tar.gz`, in a
`RELEASE` file at the root and already set in the `deploy/.env` beside it — not
in the release page's asset list, whose digests belong to the assets themselves.
Take it from there and pin it:

```sh
QUORUM_IMAGE=ghcr.io/brendentaylor22/quorum@sha256:<digest>
```

Compose then pulls that exact image, so what you run is what was scanned.

### The release bundle

Each release also attaches `quorum-deploy.tar.gz` and a `SHA256SUMS`. The bundle
is the same Compose file and scripts as the repository, plus a `deploy/.env`
already pinned to that release's digest, so it takes the copy-and-pin steps
above off your hands and lets you verify what you downloaded:

```sh
gh release download --repo brendentaylor22/quorum \
  --pattern quorum-deploy.tar.gz --pattern SHA256SUMS
grep quorum-deploy.tar.gz SHA256SUMS | sha256sum --check -
tar -xzf quorum-deploy.tar.gz && cd quorum-deploy
cat RELEASE     # the commit and digest this bundle deploys
cd deploy       # `.env` is already here, already pinned
```

Use it if you want the checksum and the pin without doing them by hand. It is
not required, and it contains nothing the repository does not.

### If the image will not pull

An anonymous `docker compose up` only works while the GHCR package is public. If
you get `401 Unauthorized`, authenticate with a token carrying `read:packages` —
note that a token which can read the repository cannot necessarily read its
packages:

```sh
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <username> --password-stdin
docker pull ghcr.io/brendentaylor22/quorum:latest
```

### Building your own image

```sh
docker build -t quorum:local .        # from the repository root
```

Then set `QUORUM_IMAGE=quorum:local`. You lose the digest guarantee and the
release scan; that is your call to make.

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
and it means something in front of it has to bridge the gap. Three shapes are
supported, and all three keep that property.

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
docker compose --profile proxy up -d
docker compose exec app node apps/api/dist/cli.js doctor
```

`QUORUM_PUBLIC_HOSTNAME` must resolve to this host, and ports 80 and 443 must
reach it, or the certificate cannot be issued.

Already running a proxy? Use Option B instead — this profile publishes 80 and
443 and will collide with it.

### Option B — an ingress you already run

The common case, and the one to reach for if this host already serves something
else on a domain. Quorum starts with no ingress of its own; your existing
reverse proxy or tunnel joins Quorum's network and forwards to it. This is what
plain `docker compose up -d` gives you — no profile, no published port:

```sh
docker compose up -d
```

**Attach the proxy to `quorum-edge` — never Quorum to the proxy's network.**
That direction matters more than it looks. A container attached to both an
internal network and an ordinary bridge takes its default route from the
bridge, so putting Quorum on your proxy's network hands the serving container
exactly the Internet access `internal: true` exists to deny. Joining the proxy
to `quorum-edge` costs the proxy nothing — it keeps its own networks — and
Quorum stays sealed.

In the proxy's own Compose file:

```yaml
services:
  your-proxy:
    networks:
      - your-existing-network # keep whatever it already had
      - quorum-edge

networks:
  quorum-edge:
    external: true
```

Then forward the hostname to **`http://quorum:3000`**. `quorum` is a stable
network alias, so it does not change when your Compose project name does.

**Resolve the upstream at request time, not at startup.** nginx — and therefore
Nginx Proxy Manager — resolves upstream names once when it loads its config, and
_refuses to start at all_ if the name is missing:

```text
[emerg] host not found in upstream "quorum"
```

If Quorum is stopped when the proxy restarts, that takes down every other site
the proxy serves. In Nginx Proxy Manager, put this in the host's **Advanced**
tab:

```nginx
resolver 127.0.0.11 valid=10s ipv6=off;
set $quorum_upstream http://quorum:3000;
location / {
  proxy_pass $quorum_upstream;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto https;
}
```

With that, stopping Quorum yields a 502 for Quorum's hostname alone, and
everything else keeps serving. Verified: proxy restarted with Quorum down stays
healthy, and recovers on its own when Quorum comes back.

#### Adding Quorum to a Compose file you already have

Everything above assumes Quorum keeps its own Compose project, which is what
`deploy/compose.yaml` gives you and what the runbooks and `quorumctl` expect. If
you would rather add one service to the stack already on the host, this is the
block — no clone, no build, and nothing to copy but this:

```yaml
services:
  quorum:
    image: ghcr.io/brendentaylor22/quorum:latest # pin a digest for real use
    restart: unless-stopped
    init: true
    user: '10001:10001'
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    tmpfs:
      - /tmp:size=32m,mode=1777,noexec,nosuid,nodev
    environment:
      QUORUM_TOKEN_SECRET_FILE: /run/secrets/quorum_token_secret
      QUORUM_TRUST_PROXY: ${QUORUM_TRUST_PROXY:-172.16.0.0/12}
      QUORUM_ROOM_CREATION: ${QUORUM_ROOM_CREATION:-public}
      QUORUM_PUBLIC_URL: ${QUORUM_PUBLIC_URL:-}
    secrets:
      - quorum_token_secret
    volumes:
      - quorum-data:/data
    networks:
      quorum-edge:
        aliases: [quorum]

  your-proxy:
    networks:
      - default # or whatever it already had
      - quorum-edge

secrets:
  quorum_token_secret:
    file: ./secrets/token-secret

volumes:
  quorum-data:

networks:
  # Same reason as the shipped file: no default route out of this network, so a
  # compromised container has no way to phone home. Your proxy joins it; Quorum
  # never joins your proxy's.
  quorum-edge:
    internal: true
```

Then, beside that file:

```sh
mkdir -p secrets
openssl rand -hex 32 > secrets/token-secret
chmod 0400 secrets/token-secret
docker compose up -d quorum
```

The image defaults supply the rest — port 3000, `/data/quorum.db`, and the
fixture catalog, so it is playable immediately. Point your proxy at
`http://quorum:3000`.

What you give up by not using the shipped project, so you can decide rather than
discover:

- **`scripts/quorumctl` does not apply.** It drives `deploy/compose.yaml`. Use
  `docker compose exec quorum node apps/api/dist/cli.js <command>` instead — the
  same commands, listed under [Operate it](#6-operate-it).
- **No `./backups` bind mount.** Add one, or write backups into the data volume
  and copy them out. Backups are still the operator's job either way.
- **No `catalog-refresh` service.** Copy that service out of
  `deploy/compose.yaml` when you want a real catalog; keep it on its own
  network, never on `quorum-edge`.
- **Quorum shares a Docker daemon with your other services**, which is a weaker
  boundary than [ADR 0004](adr/0004-dedicated-vm.md) assumes. See
  [Running alongside other services](#running-alongside-other-services).

Set `QUORUM_TRUST_PROXY` to the Docker network range so rate limits key on the
real client rather than on the proxy:

```sh
QUORUM_TRUST_PROXY=172.16.0.0/12
```

### Option C — Cloudflare Tunnel (no open inbound port)

The host opens no inbound port at all; `cloudflared` makes an outbound
connection and Cloudflare routes to it. This is the shape
[ADR 0003](adr/0003-cloudflare-tunnel.md) chose, and it is the better option
behind a home router.

Unlike a DNS record pointing at your address, the hostname resolves to
Cloudflare and the route lives in the tunnel, so nothing about your address —
static, dynamic, or behind CGNAT — matters.

On a machine with `cloudflared` installed and logged in (`cloudflared tunnel
login`), create the tunnel and route the hostname to it. Both are one-time:

```sh
cloudflared tunnel create quorum
cloudflared tunnel route dns quorum quorum.example.org
```

`create` prints a tunnel UUID and writes a credentials JSON file. `route dns`
creates the proxied `CNAME` to `<uuid>.cfargotunnel.com` in your Cloudflare
zone; it cannot be turned off (grey-clouded), which is the point.

Move both onto the deployment host:

```sh
cp deploy/cloudflared/config.example.yml deploy/cloudflared/config.yml
# Set `tunnel:` to the UUID and `hostname:` to the name you just routed.

cp ~/.cloudflared/<uuid>.json deploy/secrets/tunnel-credentials.json
sudo chgrp 65532 deploy/secrets/tunnel-credentials.json
chmod 0440 deploy/secrets/tunnel-credentials.json
```

The credential is a bearer token for the tunnel: anyone holding it can serve
traffic on that hostname. Group `65532` is the unprivileged user `cloudflared`
runs as, and `0440` is the least that lets it read. `config.yml` is ignored by
Git, so your real hostname and UUID stay out of the repository.

Set `QUORUM_TRUST_PROXY=true` in `.env` — every request arrives from the
tunnel, so without it the whole household shares one rate-limit bucket. Then:

```sh
scripts/quorumctl start --tunnel
scripts/quorumctl doctor
```

`quorumctl` refuses to start until the configuration and credential are both
in place, because a missing bind-mount source becomes an empty directory and
`cloudflared` fails on a path you never typed. The equivalent without it:

```sh
docker compose --profile tunnel up -d
docker compose exec app node apps/api/dist/cli.js doctor
```

`scripts/quorumctl session --tunnel` reads the hostname straight out of
`config.yml`, so it prints whole links without `QUORUM_PUBLIC_URL` being set.

Only `cloudflared` joins the outbound network; the application still publishes
no port and still has no route to the Internet.

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

## 4. Decide who may start a room

By default anyone who loads the page can create a room: `POST /api/rooms` is
unauthenticated, holding only a same-origin check and a rate limit. On a private
address that is the right trade — no account, no friction. On a public hostname
it means strangers and crawlers can mint rooms, which costs you database rows
and a landing page that works for people you never invited.

`QUORUM_ROOM_CREATION=operator` closes that endpoint. The landing page then says
the instance is invitation-only instead of showing a button that fails, and
rooms come from the shell:

```sh
scripts/quorumctl session --existing-ingress
```

That starts the stack, waits for the health check, mints one room, and prints:

```text
room     rAnFPyrjGKLeWlp-9J7Jsg
host     https://quorum.example.org/host/D-JdJAWwyioaHauYV7isz4TXOKKD…
invite   https://quorum.example.org/join/imagines-catalyze-moocher-fol…
phrase   imagines-catalyze-moocher-follow-scallion-deport
expires  2026-08-18T14:49:31.280Z
```

Set `QUORUM_PUBLIC_URL` in `.env` for whole links; without it you get paths, and
you supply the origin yourself. Without `quorumctl` — including in the
[single-service setup](#adding-quorum-to-a-compose-file-you-already-have) — the
same thing, one layer down:

```sh
docker compose exec quorum node apps/api/dist/cli.js create-room https://quorum.example.org
```

`scripts/quorumctl stop` ends it. Nothing has to stay running between evenings:
the data volume survives a stop, so a room started tonight is still there
tomorrow if it has not expired.

### What this actually protects

- **The host link is the host credential.** Whoever opens it first becomes the
  host; a second attempt is refused with a conflict rather than quietly making
  someone a second host. So open it yourself before sharing anything.
- **The invite phrase is what friends get.** Six words, ~77.5 bits, good for one
  room that expires within 24 hours and holds at most 20 people. It grants entry
  and no host authority.
- **A stranger at the front door gets nothing to press.** No room to create, and
  joining needs a phrase they do not have.
- **It is not authentication.** Anyone holding a link can use it, which is the
  point — no accounts, no passwords. Treat both links as secrets, and remember
  the host token is printed once: only its hash is stored, so a lost host link
  means minting a new room, not recovering that one.

Two alternatives, and why they are not the default:

- **A shared passphrase on room creation** keeps the button but hands every
  friend a long-lived secret to leak, for less protection than closing the
  endpoint outright.
- **Authentication at the ingress** (basic auth, Cloudflare Access) is a
  stronger wall and costs the property worth keeping: friends would need
  credentials before they could tap a link.

## Running alongside other services

Quorum's documents describe a dedicated VM with no other workloads
([ADR 0004](adr/0004-dedicated-vm.md)). Running it beside a media server or
anything else on one Docker host is a weaker boundary, and worth being clear
about rather than discovering later: containers on one host share a kernel and a
daemon, so a container escape reaches the neighbours.

It is a reasonable trade for a household, and the plan anticipates it. What it
is not is the isolation the threat model claims under T09. If you take it:

- Keep Quorum in its own Compose project and its own networks, as shipped.
- Do not add the Docker socket, host networking, or bind mounts from other
  services. Nothing in Quorum's topology needs them.
- Remember the serving container has no Internet route only because of
  `internal: true`. Attaching it to a shared network removes that.

## 5. Import a real catalog (optional)

Without this you get 60 fixture movies, which is enough to play but not enough
to be interesting.

Register at [TMDB](https://www.themoviedb.org/settings/api) for a **v4 read
access token**, then:

```sh
printf '%s' 'eyJhbGciOi...' > deploy/secrets/tmdb-read-access-token.secret
chmod 0400 deploy/secrets/tmdb-read-access-token.secret

docker compose --profile refresh run --rm catalog-refresh
docker compose exec app node apps/api/dist/cli.js doctor
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

## 6. Operate it

Ordinary Compose, from the `deploy/` directory:

```sh
docker compose ps
docker compose logs -f app
docker compose stop            # keeps the data volume; rooms and votes survive
docker compose up -d           # back again
```

Quorum's own commands run inside the container. `doctor` is the one worth
knowing — it checks database integrity and catalog age, and exits non-zero on
either:

```sh
docker compose exec app node apps/api/dist/cli.js doctor
docker compose exec app node apps/api/dist/cli.js catalog-status
docker compose exec app node apps/api/dist/cli.js backup /backups/daily.db
docker compose exec app node apps/api/dist/cli.js purge          # retention now
```

### `scripts/quorumctl`

A POSIX shell wrapper around exactly those commands, for when you would rather
not type them. Nothing depends on it, and nothing it does is unavailable
without it. What it adds is the guardrails:

```sh
scripts/quorumctl start --existing-ingress   # or --proxy, --tunnel
scripts/quorumctl session --existing-ingress # start, then mint one room
scripts/quorumctl status
scripts/quorumctl doctor
scripts/quorumctl logs
scripts/quorumctl backup daily.db
scripts/quorumctl purge --room <roomId>      # types the room id back
scripts/quorumctl restore <backup>.db <new-volume>
scripts/quorumctl rollback ghcr.io/...@sha256:<digest>
scripts/quorumctl stop
```

It refuses to start without a token secret, checks the backups directory is
writable by the runtime UID before a backup fails obscurely inside the
container, refuses a rollback to anything but a digest, and makes both
destructive operations — `purge --room` and `restore` — type the name back.
Run it from the repository root; it finds `deploy/` itself.

`session` is `start` plus a room: it waits for the container to report healthy
before minting one, so the link it prints is a link that already works rather
than one that 502s for the next few seconds. See
[who may start a room](#4-decide-who-may-start-a-room).

**Back up.** Backups use the SQLite backup API, so they are safe on a running
instance, and they verify integrity and record counts. `deploy/backups/` is a
bind mount, so anything written to `/backups` inside the container lands there.
Copy the result off the host, and never publish one — a backup contains bulk
provider metadata as well as room data. Restore is deliberately awkward: it
requires an explicit new volume name and typing that name back, which is
`quorumctl restore`'s reason to exist.

The bind mount is owned by whoever created it, and the container runs as UID
10001, so give it the directory or the first backup fails with an opaque error:

```sh
sudo chown 10001:10001 deploy/backups && chmod 0750 deploy/backups
```

**Retention runs itself.** Rooms expire (24 hours in lobby, 24 more once voting
starts, 7 days after completion), and expired rooms are deleted 24 hours later
along with every participant, exposure, and interaction. `quorumctl purge
--room <roomId>` deletes one room immediately, for a deletion request.

**Update.** With a floating tag, `docker compose pull && docker compose up -d`.
With a pinned digest — the better habit — set the new `QUORUM_IMAGE` in `.env`
and `docker compose up -d` again. Take a backup first, and keep the previous
digest: `scripts/quorumctl rollback <image@sha256:...>` goes back to it, or set
it in `.env` by hand. Migrations are forward-only, so a rollback across one is
not safe — check what changed before rolling back over a migration.

## Configuration reference

Everything Quorum reads from the environment. Only the token secret is mandatory
in production, by either `QUORUM_TOKEN_SECRET_FILE` or `QUORUM_TOKEN_SECRET`.

### Application

| Variable                         | Default            | What it does                                                                                                                                                                   |
| -------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `QUORUM_TOKEN_SECRET_FILE`       | —                  | File holding the key for every capability hash. Mandatory in production; preferred over the variable below because a file stays out of the process table and `docker inspect`. |
| `QUORUM_TOKEN_SECRET`            | —                  | The key itself, at least 32 characters. Works in production, but prefer the file above: an environment variable is visible in the process table and in `docker inspect`.       |
| `QUORUM_DATABASE_PATH`           | `/data/quorum.db`  | SQLite file.                                                                                                                                                                   |
| `QUORUM_ROOM_CREATION`           | `public`           | `operator` closes `POST /api/rooms`, leaving `create-room` on the CLI as the only way to start one. Any unrecognised value reads as `operator`, so a typo cannot fail open.    |
| `QUORUM_PUBLIC_URL`              | —                  | Origin used only to print whole links from `create-room`. Never used to build a link at request time.                                                                          |
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

| Variable                 | Default       | What it does                                                                                                            |
| ------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `QUORUM_IMAGE`           | —             | Image to run. `.env.example` ships the `:latest` tag; prefer an immutable `@sha256:` digest for anything you depend on. |
| `QUORUM_DATA_VOLUME`     | `quorum-data` | Named volume holding the database.                                                                                      |
| `QUORUM_PUBLIC_HOSTNAME` | —             | Hostname the proxy profile serves.                                                                                      |
| `QUORUM_ACME_EMAIL`      | —             | Contact address for certificate problems.                                                                               |

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

**The landing page says "by invitation only" and I did not mean it to.**
`QUORUM_ROOM_CREATION` is set to something other than `public` — including a
misspelling, which is read as `operator` on purpose. Unset it, or set it to
exactly `public`.

**The host link says the room already has a host.** Host links are claimed once,
first come first served. Somebody opened it before you, or you opened it in a
browser that has since lost its session cookie. Mint a new room; the old one
expires on its own.

**The invite link points at the wrong address.** Invite links are built from the
address the host used to create the room. Use the public hostname, not the
container or LAN address.

**A room disappeared.** Rooms expire: 24 hours in lobby, 24 more once voting
starts, 7 days after completion. Expired rooms are deleted 24 hours after that,
and no, they cannot be recovered except from a backup.
