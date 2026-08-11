# Quorum

Quorum helps one person or a group privately choose a movie from a shared slate.

Current status: Phase 1 secure foundation implemented. Product room/voting flows begin in Phase 2.

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

Run locally with a writable database path:

```sh
QUORUM_DATABASE_PATH=.local/quorum.db npm start
```

Container and operator instructions: [Phase 1 evidence](docs/phase-1/README.md) and [operator runbook](docs/phase-1/operator-runbook.md).

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
