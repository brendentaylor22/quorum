# Contributing

Quorum is a personal project released as open source so other people can run
it. Contributions are welcome; a slow response is likely.

Do not report security problems here. See [SECURITY.md](SECURITY.md).

## Before writing code

Open an issue first for anything beyond a bug fix or a typo. Quorum has a
written product contract and threat model, and the fastest way to waste an
afternoon is to build something the contract already rules out:

- [Product contract](docs/product-contract.md) — normative invariants
- [Threat model](docs/threat-model.md)
- [Retention and abuse policy](docs/retention-and-abuse.md)

Deferred rather than forgotten: accounts, series, streaming-provider filters,
WebSockets, PWA, and collaborative filtering. The last of those is argued out in
[group recommendations](docs/recommendations.md); the rest are scope, not
principle, and an issue is the place to make the case.

## Local setup

Node.js 24.

```sh
npm ci
npm run dev
```

Open <http://localhost:5173>. A fresh checkout falls back to a 60-movie fixture
catalog, so no TMDB credential is needed to work on anything except the
importer.

## The checks

CI runs exactly this. Run it before opening a pull request:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test              # vitest with coverage
npm run test:browser  # Playwright, builds first
npm run build
```

## What review looks for

- **Ranking and recommendation stay pure.** `packages/ranking` and
  `packages/recommend` have no I/O, no persistence, and no provider concepts.
  Anything that knows what a TMDB genre is belongs in
  `apps/api/src/catalog/features.ts`.
- **`packages/contracts` is the only shared vocabulary.** The client imports
  schemas, never server internals.
- **The server is the authority.** Client-reported state is input, never a
  score. Results derive from stored interactions.
- **Behaviour changes come with a test.** Ranking changes must go through
  `tests/contracts/ranking.examples.json`; if prose and examples disagree, the
  examples win.
- **Migrations are forward-only.** Never edit an applied migration; add a new
  one. A movie leaving the catalog is marked inactive, not deleted, because
  deleting it would rewrite historical results.
- **No new egress from the serving path.** Only the operator-triggered catalog
  refresh reaches the Internet, and it runs as its own container on its own
  network.

## Commits and pull requests

Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`), imperative subject.
Say what changed and why; the diff already shows how.

Keep pull requests to one concern. If a change alters a documented invariant,
update the document in the same pull request — the contracts in `docs/` are
normative, not decoration.

## Licence

Quorum is AGPL-3.0-or-later. By contributing you agree your contribution is
licensed under those terms. There is no CLA.
