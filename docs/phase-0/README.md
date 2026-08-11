# Phase 0 evidence index

Updated: 2026-08-11

Phase 0 removes ambiguous product and security rules before implementation.

| Deliverable | Evidence | Status |
|---|---|---|
| Create, lobby, swipe, progress, results wireframes | [wireframes.md](wireframes.md) | Complete |
| Ranking contract and examples | [product-contract.md](product-contract.md), [ranking.examples.json](../../tests/contracts/ranking.examples.json) | Complete |
| Room lifecycle | [product-contract.md](product-contract.md) | Complete |
| Retention policy and abuse limits | [retention-and-abuse.md](retention-and-abuse.md) | Complete |
| TMDB registration and accepted-use review | [tmdb-use-review.md](tmdb-use-review.md) | Blocked on operator registration; policy decision complete |
| Test fixture dataset | [movies.json](../../fixtures/catalog/movies.json) | Complete; synthetic, no TMDB content |
| Four architecture decisions | [ADR index](../adr/README.md) | Complete |
| Threat model | [threat-model.md](threat-model.md) | Complete |
| Ten unambiguous user journeys | [phase-0.feature](../../tests/acceptance/phase-0.feature) | Complete as executable specifications; implementation pending |

## Exit decision

Phase 0 is `CONDITIONALLY READY`. Product, architecture, privacy, abuse, and threat contracts are fixed. Phase 1 may begin using synthetic fixtures. TMDB-backed Phase 3 work remains blocked until operator records API registration and acceptance of then-current terms in [tmdb-use-review.md](tmdb-use-review.md).

Acceptance scenarios are specifications in Phase 0. They become automated browser/integration tests as matching endpoints and UI arrive in Phase 2.

