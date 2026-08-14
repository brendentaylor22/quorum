# Quorum

Quorum helps one person or a group privately choose a movie from a shared slate.

Current status: Phase 2 step 2a complete. Rooms, invite and host capabilities, private swiping, and ranked results run locally in a browser against fixture movies.

## Development

Requires Node.js 24 and Docker with Compose.

```sh
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Run the local product loop (API plus client, SQLite file under `.data`):

```sh
npm run dev
```

Open <http://localhost:5173>, create a room, and open the invite link in a
second window to play both sides. Run the built server alone with:

```sh
QUORUM_DATABASE_PATH=.local/quorum.db npm start
```

Container and operator instructions: [Phase 1 evidence](docs/phase-1/README.md) and [operator runbook](docs/phase-1/operator-runbook.md).

## Release and deployment

Every push to `main`, including a merged pull request, runs release workflow. It tests, scans, publishes GHCR image, generates SBOM, and creates commit-named GitHub Release containing checksum-protected pull-only deployment bundle.

No manual release tag is required. Exact procedure: [release runbook](docs/phase-1/release-runbook.md).

Production VM does not clone this repository or build image. Operator downloads release bundle, verifies checksum, supplies Cloudflare credential, then runs:

```sh
scripts/quorumctl start --tunnel
scripts/quorumctl doctor
```

Compose pulls exact `ghcr.io/...@sha256:...` image recorded in bundle-generated `deploy/.env`.

## Phase 2 evidence

- [Phase 2 index](docs/phase-2/README.md)

## Phase 0 evidence

- [Phase 0 index](docs/phase-0/README.md)
- [Product contract](docs/phase-0/product-contract.md)
- [Wireframes](docs/phase-0/wireframes.md)
- [Retention and abuse policy](docs/phase-0/retention-and-abuse.md)
- [TMDB use review](docs/phase-0/tmdb-use-review.md)
- [Threat model](docs/phase-0/threat-model.md)
- [Architecture decisions](docs/adr/)
- [Ranking examples](tests/contracts/ranking.examples.json)
- [User-journey acceptance tests](tests/acceptance/phase-0.feature)
- [Synthetic 20-movie fixture](fixtures/catalog/movies.json)

See [implementation plan](QUORUM_IMPLEMENTATION_PLAN.md) for later phases.
