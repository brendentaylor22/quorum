# Quorum

Quorum helps one person or a group privately choose a movie.

Everyone in a room swipes through the same 20 films on their own device. Nobody
sees anyone else's answers while voting. When the last person finishes, the
server reveals one ranked list built from all of the votes. If nothing appeals,
the host opens another round of 20 chosen from what the group has already said.

No accounts, no email, no profiles. A room is a pair of unguessable links that
expire.

Current status: playable end to end. Rooms, private voting, ranked results,
multi-round recommendations, and a real TMDB catalog all run locally and in the
deployed container. See [where the build is](#project-status).

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

**Round 1** — 20 drawn, seeded-random, from the best-rated slice of the local
catalog. No personalisation, because there is nothing yet to personalise from.

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

Full write-up: [group recommendations](docs/phase-4/recommendations.md).

### Where the catalog comes from

Movie metadata is a **local snapshot**, imported by an operator-triggered job,
never fetched during a request. A fresh checkout falls back to a 20-movie
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
[catalog ingestion](docs/phase-4/catalog-ingestion.md).

### Security model

- **Capability links, not accounts.** Invite, host, and session tokens each
  carry 256 bits of entropy. The database stores only HMAC keyed hashes, so a
  database read does not yield working links.
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

Threat model: [docs/phase-0/threat-model.md](docs/phase-0/threat-model.md).
Retention and abuse: [docs/phase-0/retention-and-abuse.md](docs/phase-0/retention-and-abuse.md).

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
docs/         Product contract, threat model, ADRs, phase evidence
fixtures/     20-movie fallback catalog
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

**Ingress** is a Cloudflare tunnel ([ADR 0003](docs/adr/0003-cloudflare-tunnel.md)),
so the VM opens no inbound port.

---

## Running it

Requires Node.js 24 (and Docker with Compose for the container path).

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
[catalog ingestion](docs/phase-4/catalog-ingestion.md#configuration).

### `quorumctl`

`migrate`, `import-catalog`, `catalog-refresh`, `catalog-status`, `doctor`,
`backup`, `restore`. `doctor` and `catalog-status` exit non-zero on an empty or
stale catalog, so staleness fails loudly rather than quietly breaching the
provider's six-month cache limit.

---

## Release and deployment

Every push to `main` runs the release workflow: test, scan, publish a GHCR
image, generate an SBOM, and cut a commit-named GitHub Release containing a
checksum-protected, pull-only deployment bundle. No manual tag needed.

The production VM never clones this repository and never builds an image. The
operator downloads the bundle, verifies the checksum, supplies the Cloudflare
credential, then:

```sh
scripts/quorumctl start --tunnel
scripts/quorumctl doctor
```

Compose pulls the exact `ghcr.io/...@sha256:...` digest recorded in the
bundle-generated `deploy/.env`.

Procedures: [release runbook](docs/phase-1/release-runbook.md),
[operator runbook](docs/phase-1/operator-runbook.md),
[rollback runbook](docs/phase-1/rollback-runbook.md).

---

## Project status

| Phase                                  | State                                                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 0 — Product contract and threat model  | Complete                                                                                              |
| 1 — Secure foundation and CI image     | Code and local evidence complete; fresh-VM, GHCR, and tunnel evidence pending operator infrastructure |
| 2 — Local browser-testable MVP         | Step 2a complete, step 2b substantially complete                                                      |
| 3 — Abuse resistance and web hardening | Not started (rate limits, Turnstile, CSP, security headers)                                           |
| 4 — Movie data and private pilot       | Catalog ingestion and recommendations built                                                           |

Known gaps, stated plainly:

- The recommender's blend is a reasoned default, not a measured winner — offline
  replay evaluation is not built.
- Nothing tracks fairness across rounds; the same member could be outvoted
  repeatedly.
- Movies only. No series.
- Whether tag-counting over TMDB genres and keywords falls inside TMDB's
  ML/AI restriction is an open question with a documented fallback. See
  [the open question](docs/phase-4/recommendations.md#open-question-tmdbs-mlai-restriction).
  This repository records engineering interpretation, not legal advice.

---

## Documentation map

**Product and design**

- [Product contract](docs/phase-0/product-contract.md) — normative invariants
- [Wireframes](docs/phase-0/wireframes.md)
- [Threat model](docs/phase-0/threat-model.md)
- [Retention and abuse policy](docs/phase-0/retention-and-abuse.md)
- [TMDB use review](docs/phase-0/tmdb-use-review.md)
- [Architecture decisions](docs/adr/)

**Build and operate**

- [Phase 1 evidence](docs/phase-1/README.md) · [operator](docs/phase-1/operator-runbook.md) · [release](docs/phase-1/release-runbook.md) · [rollback](docs/phase-1/rollback-runbook.md)
- [Dependency security policy](docs/phase-1/dependency-security-policy.md)
- [Phase 2 evidence](docs/phase-2/README.md)
- [Catalog ingestion](docs/phase-4/catalog-ingestion.md) · [group recommendations](docs/phase-4/recommendations.md)

**Executable specification**

- [Ranking examples](tests/contracts/ranking.examples.json)
- [User-journey acceptance tests](tests/acceptance/phase-0.feature)
- [Implementation plan](QUORUM_IMPLEMENTATION_PLAN.md)

---

Movie data and images from [TMDB](https://www.themoviedb.org/). This product
uses the TMDB API but is not endorsed or certified by TMDB. Non-commercial use
only. Never publish a database backup — it contains bulk provider metadata.
