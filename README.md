# Quorum

Quorum helps one person or a group privately choose a movie.

Everyone in a room swipes through the same 20 films on their own device. Nobody
sees anyone else's answers while voting. When the last person finishes, the
server reveals one ranked list built from all of the votes. If nothing appeals,
the host opens another round of 20 chosen from what the group has already said.

No accounts, no email, no profiles. A room is a pair of unguessable links that
expire.

Current status: playable end to end, and installable. Rooms, private voting,
ranked results, multi-round recommendations, a real TMDB catalog, rate limits,
and scheduled retention all run locally and in the container. Not yet proved on
real infrastructure — see [where the build is](#project-status).

Self-hosting it: [docs/self-hosting.md](docs/self-hosting.md).

---

## How it works

### The room lifecycle

```text
                host starts
   LOBBY ------------------------> VOTING
     |                               |
     | host expires                  | all finish, or host closes
     v                               v
  EXPIRED <---------------------- COMPLETE
             retention expires
```

There is no reverse transition. An invalid transition returns a uniform
conflict that leaks nothing about room state to an unauthorized caller.

1. **Create.** The server mints two independent capabilities and returns both:
   an invite link (`/join/<token>`) to share, and a host link (`/host/<token>`)
   to keep. Rooms live 24 hours in lobby, another 24 once voting starts.
2. **Join.** A participant opens the invite, picks a temporary display name,
   and gets a room-scoped session cookie. Up to 20 people per room. The host
   can play too.
3. **Start.** In one transaction the server freezes membership, the eligible
   count, the catalog version, the slate seed, and the exact 20-item slate.
   After that the denominators cannot move.
4. **Vote.** Each frozen participant gets one _exposure_ per slate item and
   confirms one `LEFT` or `RIGHT` per exposure. The server hands back the next
   card. Results stay hidden.
5. **Complete.** When every participant has confirmed all 20 — or the host
   closes early — the room reveals canonical results.
6. **Keep voting.** From results, the host can open round 2: 20 more films,
   chosen from the group's own swipes, with membership refrozen.

Refresh, tab close, and phone death are all survivable: the session cookie
returns the first unconfirmed exposure in persisted slate order. A repeated
swipe with the same choice succeeds idempotently; the opposite choice
conflicts, because confirmed votes are immutable.

### Ranking

Per movie `m` in a round:

```text
eligible(m)     = frozen participant count for that round
yes(m)          = confirmed RIGHT interactions
responses(m)    = confirmed LEFT + RIGHT interactions
approval_pct(m) = 100 * yes(m) / eligible(m)
coverage_pct(m) = 100 * responses(m) / eligible(m)
match(m)        = yes(m) == eligible(m)
```

Sort by approval descending, then coverage descending. Ties share a competition
rank (`1, 2, 2, 4`) and present in slate position order.

The load-bearing detail: **non-responses stay in the denominator.** Closing a
room early cannot turn one person's single yes into "100% group approval". The
exact fraction (`3/4`) always displays beside the percentage, so a rounded
integer never has to be trusted on its own.

[`packages/ranking`](packages/ranking/src/index.ts) is a pure function with no
I/O, checked against normative examples in
[`tests/contracts/ranking.examples.json`](tests/contracts/ranking.examples.json).
If prose and examples ever disagree, the examples win.

### Where the 20 films come from

**Round 1** — 20 drawn, seeded-random, from a shortlist of the local catalog.
No personalisation, because there is nothing yet to personalise from.

The shortlist is not simply the best-rated films. Ranking on rating alone
answers "best film of all time", and the honest answer to that is a wall of
restored classics and subtitled festival winners — a defensible list, and a bad
first slate for a group deciding what to watch tonight. Three normalised
signals decide the shortlist instead:

| Signal         | Weight | Source                                     |
| -------------- | -----: | ------------------------------------------ |
| **Quality**    |   0.60 | Bayesian weighted rating, normalised       |
| **Mainstream** |   0.22 | Vote count, saturating at 2 500 votes      |
| **Recency**    |   0.18 | Release year, normalised over catalog span |

Quality still dominates, so nothing bad gets in; reach and recency decide which
of the many good films surface first. Every term reads stored columns and the
pool's own bounds, and ties break on id, so the shortlist is deterministic for
a catalog version — which is what makes a persisted slate seed reproducible.

**Round 2+** — content-based scoring over the group's own swipes:

- **Per-person profile.** Accumulate likes and dislikes per tag (genre,
  keyword, decade, runtime band, language):
  `affinity = (likes − β·dislikes) / (likes + β·dislikes + prior)`. A dislike
  counts less than a like (β = 0.6), because "not tonight" is weaker evidence
  than "yes". A prior (2) keeps one swipe on a rare tag from reading as
  certainty.
- **Prediction.** Mean affinity over a candidate's tags, mapped to [0, 1]. No
  matching evidence scores **0.5, not 0** — unknown is not unwanted.
- **Group aggregation.** `score = w·mean(predictions) + (1 − w)·min(predictions)`,
  w = 0.7. Pure averaging cheerfully includes a film one person clearly rejects;
  pure least-misery picks nobody's favourite. The blend keeps a floor under the
  unhappiest member.
- **Diversity.** No more than half a slate shares a genre.
- **Exploration.** 5 of 20 slots are random, labelled "Something different"
  rather than given an invented rationale. Twenty swipes is not enough evidence
  to justify a filter bubble.
- **Determinism.** Every random choice comes from the round's persisted seed,
  never `Math.random`, so a slate can be replayed and explained.

Collaborative filtering is deliberately **not** attempted: the matrix is 20
items wide and one room deep, everyone rated the same 20 items, and history is
room-scoped by design. There is nothing to generalise from.

Nothing a room has judged can reappear in a later round — enforced by
`UNIQUE (room_id, catalog_item_id)`, not merely by the query.

Full write-up: [group recommendations](docs/recommendations.md).

### Where the catalog comes from

Movie metadata is a **local snapshot**, imported by an operator-triggered job,
never fetched during a request. A fresh checkout falls back to a 60-movie
fixture so it is playable with no credentials.

The importer sweeps TMDB `/discover/movie` one release year at a time (an
unsliced sweep silently truncates at TMDB's 500-page cap), fetches details per
movie, applies a quality bar, and scores each with a Bayesian weighted rating:

```text
score = (v/(v+m)) * R + (m/(v+m)) * C
```

so a 9.5 from twelve votes does not outrank a classic. The whole network phase
holds no database lock; rows commit in one transaction, so a reader sees the old
catalog until it sees the new one, never a mixture. A movie that drops out of a
later import is marked inactive, never deleted — deleting it would break an
in-flight room and rewrite historical results.

This is why serving never touches the Internet: slate selection is a local set
scan, replay needs a frozen candidate pool, and a TMDB outage must not stop a
room. Details, obligations, and configuration:
[catalog ingestion](docs/catalog-ingestion.md).

### Security model

- **Capability links, not accounts.** Host and session tokens carry 256 bits of
  entropy. The database stores only HMAC keyed hashes, so a database read does
  not yield working links.
- **The invite is six words.** `/join/copper-harbor-vivid-lantern-quiet-ember`,
  drawn uniformly from the 7772-word EFF diceware list: ~77.5 bits. That is
  deliberately below the 128-bit floor the other capabilities hold to, because
  the invite is the one link that gets read aloud or retyped across a room. The
  reduction is bounded to it — an invite confers no host authority, expires
  with a lobby inside 24 hours, and admits at most 20 people. At ~10²³ expected
  guesses no amount of unthrottled HTTP closes that gap within a room's life.
  Recorded as T01a in the [threat model](docs/threat-model.md).
- **Split capabilities.** Host control (start, close, expire) travels in a
  header, not a cookie. A stolen participant cookie grants that participant's
  remaining actions in that one room — never host control, never another
  participant's state, never another room.
- **Server-authoritative voting.** Client state is never scoring authority. The
  server advances only after the transaction commits.
- **Uniform not-found.** Unauthorized, unknown, and expired all look the same
  from outside.
- **No egress from the serving container.** It joins an `internal: true`
  network. Only the short-lived refresh container has a route out, on its own
  network, and it never joins the edge network.
- **Hardened runtime.** Read-only rootfs, all capabilities dropped,
  `no-new-privileges`, non-root user, pid/memory/cpu limits, pinned image
  digests.
- **Secrets from files**, not environment variables, so credentials stay out of
  the process table, `docker inspect`, and log lines.
- **No capability in a log line.** Tokens live in URL paths, so the request
  serializer censors the token segment before anything is written, and the
  host header, session cookie, and `Set-Cookie` are redacted too.
- **Rate limits sized for a household.** Room reads and swipes are charged to
  the participant session rather than the address, because everyone in a room is
  usually on the same wifi. Room creation is capped at ten per source per day.
- **A content security policy** with no inline script and no `eval`, plus
  `no-referrer`, `frame-ancestors 'none'`, and no device permissions at all.
- **Retention that runs itself.** A scheduled sweep expires rooms and then
  deletes them — participants, exposures, interactions, and all — 24 hours
  later, whether or not anyone visits.

Threat model: [docs/threat-model.md](docs/threat-model.md).
Retention and abuse: [docs/retention-and-abuse.md](docs/retention-and-abuse.md).

### Accessibility

Swiping is never the only way to vote. Every card has visible `No` and `Yes`
buttons; `ArrowLeft`/`ArrowRight` do the same thing with identical confirmation
semantics. Focus order, labels, status announcements, contrast, and
reduced-motion behavior do not depend on gesture support. Destructive host
actions require explicit confirmation and stay separate from participant
controls.

---

## Architecture

npm workspaces monorepo, TypeScript throughout, Node 24.

```text
apps/
  api/        Fastify server: routes, room service, catalog import, quorumctl CLI
  web/        React + Vite client: create, join, swipe deck, results, host controls
packages/
  contracts/  Zod schemas and constants shared by server and client
  ranking/    Pure ranking function (no I/O)
  recommend/  Pure group recommender (no I/O, no provider concepts)
  catalog/    Seeded slate selection over a candidate pool
  database/   SQLite (better-sqlite3), migrations, backup/restore
  tmdb/       TMDB client: rate limiting, schemas, mapping, attribution
deploy/       Compose topology, Cloudflare tunnel config, secrets layout
docs/         Self-hosting, operations, contracts, threat model, ADRs
fixtures/     60-movie fallback catalog
```

Two rules keep the shape honest:

1. **`ranking` and `recommend` are pure.** No I/O, no provider, no persistence.
   Items reach the recommender as opaque namespaced tags like `genre:28`; it
   does not know what a genre is. Everything deciding _what a movie looks like_
   lives in one file,
   [`apps/api/src/catalog/features.ts`](apps/api/src/catalog/features.ts).
2. **`contracts` is the only shared vocabulary.** The client imports schemas,
   not server internals.

**Storage** is a single SQLite file on one VM
([ADR 0001](docs/adr/0001-sqlite-single-vm.md)) — the whole product is a handful
of rooms of ≤20 people making 20 decisions each. Rounds, slates, exposures, and
interactions are separate tables so a vote is an append, not an update, and a
round's frozen denominator is stored rather than recomputed.

**Ingress** is pluggable, and the serving container publishes no port under any
of the shapes. A Cloudflare tunnel ([ADR 0003](docs/adr/0003-cloudflare-tunnel.md))
is the default recommendation, because it opens no inbound port at all.

---

## Running it

### In Docker

Docker with the Compose plugin. Nothing is built locally — Compose pulls the
published image.

```sh
git clone https://github.com/brendentaylor22/quorum.git
cd quorum/deploy

cp .env.example .env                            # works as shipped
openssl rand -hex 32 > secrets/token-secret     # keys every capability hash
chmod 0400 secrets/token-secret

docker compose up -d
```

`.env.example` documents every setting where you will be editing it; the
defaults are all workable, and the 60-movie fixture catalog means it is playable
with no TMDB credential.

One thing the quickstart deliberately cannot do for you: **nothing can reach the
instance yet.** The app publishes no port and sits on an `internal: true`
network, so an ingress has to bridge the gap. Three shapes are supported — your
own existing reverse proxy, the bundled Caddy (`--profile proxy`), or a
Cloudflare tunnel (`--profile tunnel`) — and all three keep that property.
[docs/self-hosting.md](docs/self-hosting.md) covers each in full, along with
`QUORUM_TRUST_PROXY`, backups, and the configuration reference.

### From source

Requires Node.js 24.

```sh
npm ci
npm run dev
```

Open <http://localhost:5173>, create a room, and open the invite link in a
second window to play both sides. `npm run dev` starts Fastify on :3000 and Vite
on :5173 against `.data/quorum.db`, and sets `QUORUM_ALLOW_INSECURE_COOKIES=1`
so cookies work over plain-HTTP localhost — a flag that is ignored when
`NODE_ENV=production`. The dev token secret is generated once and stored beside
the database with mode `0600`, so rooms survive a restart.

To play from phones on the same network, open the `http://<lan-ip>:5173` address
printed at startup instead of `localhost`; invite links are built from whatever
address the host used, so they point at the same machine. Vite listens on every
interface — set `QUORUM_WEB_HOST=127.0.0.1` to keep it on loopback. Fastify stays
on loopback either way and is reached through Vite's `/api` proxy.

Full check suite, same as CI:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test              # vitest with coverage
npm run test:browser  # Playwright, builds first
npm run build
```

Run the built server alone:

```sh
QUORUM_DATABASE_PATH=.local/quorum.db npm start
```

### Importing a real catalog

Needs a TMDB v4 read access token in a file. Locally:

```sh
TMDB_READ_ACCESS_TOKEN_FILE=.local/tmdb-token \
  node apps/api/dist/cli.js catalog-refresh
node apps/api/dist/cli.js catalog-status
```

In the deployed topology, the refresh is its own container on its own egress
network:

```sh
docker compose --profile refresh run --rm catalog-refresh
docker compose run --rm app node apps/api/dist/cli.js catalog-status
```

A first import of ~13,000 movies takes 10–15 minutes at a deliberately polite
~20 req/s. Tuning variables are in
[catalog ingestion](docs/catalog-ingestion.md#configuration).

### Operational commands

The server image carries a CLI: `migrate`, `import-catalog`, `catalog-refresh`,
`catalog-status`, `doctor`, `purge`, `backup`, `restore`. `doctor` and
`catalog-status` exit non-zero on an empty or stale catalog, so staleness fails
loudly rather than quietly breaching the provider's six-month cache limit.

```sh
docker compose exec app node apps/api/dist/cli.js doctor
```

[`scripts/quorumctl`](scripts/quorumctl) wraps those in a shell script with the
guardrails — it refuses to start without a token secret, refuses a rollback to
anything but a digest, and makes `purge --room` and `restore` type the name
back. Convenience only; nothing depends on it.

---

## Release and deployment

Every push to `main` runs the release workflow: test, scan, publish a GHCR
image, generate an SBOM, and cut a commit-named GitHub Release. No manual tag
needed.

Deploying is ordinary Compose — copy `deploy/.env.example`, create a token
secret, `docker compose up -d`. See [running it in Docker](#in-docker) above,
and [docs/self-hosting.md](docs/self-hosting.md) for the whole thing.

Two things are worth doing beyond the quickstart, and both are optional:

- **Pin the digest.** `.env.example` ships the `:latest` tag. Every release
  records the exact `ghcr.io/...@sha256:...` it was built from, after the checks
  and the image smoke test have passed; setting that as `QUORUM_IMAGE` is what
  makes tonight's restart provably the image you scanned this morning.
- **Use the release bundle.** Each release attaches `quorum-deploy.tar.gz` and a
  `SHA256SUMS`: the same Compose file and scripts, plus a `deploy/.env` already
  pinned to that release's digest. It saves the copy-and-pin by hand and lets
  you verify the download. It contains nothing this repository does not, so a
  host that would rather clone can clone.

Procedures: [releasing](docs/releasing.md) · [operations](docs/operations.md),
which covers the strict deployment, backup and restore, upgrade, and rollback.

---

## Project status

Playable end to end and installable. Rooms, private voting, ranked results,
multi-round recommendations, a real TMDB catalog, rate limits, security headers,
log redaction, and scheduled retention are all built, tested, and running in the
container.

Known gaps, stated plainly:

- **Nothing here has been proved on real infrastructure yet.** Everything is
  tested locally and in CI. A pilot on real phones over a real hostname — and
  the fresh-host, GHCR, and ingress checks that go with it — has not happened.
- No load test has been run, so the "20 participants, 20 concurrent rooms"
  support target is a design intent rather than a measurement.
- Backups are unencrypted and local; no restore drill has been performed on a
  real deployment.
- No accessibility audit or mobile-browser matrix has been run against the
  shipped build.
- The recommender's blend is a reasoned default, not a measured winner — offline
  replay evaluation is not built.
- Nothing tracks fairness across rounds; the same member could be outvoted
  repeatedly.
- Movies only. No series.
- Whether tag-counting over TMDB genres and keywords falls inside TMDB's
  ML/AI restriction is an open question with a documented fallback. See
  [the open question](docs/recommendations.md#open-question-tmdbs-mlai-restriction).
  This repository records engineering interpretation, not legal advice.

---

## Documentation map

**Run it**

- [Self-hosting](docs/self-hosting.md) — the install, all three ingress shapes, and every configuration variable
- [Operations](docs/operations.md) — strict deployment, backup and restore, upgrade, rollback
- [Releasing](docs/releasing.md) — what a push to `main` produces
- [Dependency policy](docs/dependency-policy.md) — updates and vulnerability response

**How it is built**

- [HTTP surface](docs/http-api.md) — every route and what it takes to reach it
- [Catalog ingestion](docs/catalog-ingestion.md) — the TMDB importer and its obligations
- [Group recommendations](docs/recommendations.md) — how round 2 chooses
- [Architecture decisions](docs/adr/)

**Product and security contracts**

- [Product contract](docs/product-contract.md) — normative invariants
- [Threat model](docs/threat-model.md)
- [Retention and abuse policy](docs/retention-and-abuse.md)
- [TMDB use review](docs/tmdb-use-review.md)
- [Wireframes](docs/wireframes.md) — the original design sketches

**Executable specification**

- [Ranking examples](tests/contracts/ranking.examples.json)
- [User-journey acceptance tests](tests/acceptance/user-journeys.feature)

---

## Licence

Quorum is free software under [AGPL-3.0-or-later](LICENSE). Run it, change it,
share it. If you run a modified copy as a service for other people, you owe them
your changes — set `QUORUM_SOURCE_URL` so the footer points at your source.

Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Security reports:
[SECURITY.md](SECURITY.md) — privately, never in a public issue.

Movie data and images from [TMDB](https://www.themoviedb.org/). This product
uses the TMDB API but is not endorsed or certified by TMDB. The licence above
covers Quorum's code and says nothing about movie metadata: if you import a real
catalog you register your own TMDB credential and accept their terms directly,
including their non-commercial restriction. Never publish a database backup — it
contains bulk provider metadata.
