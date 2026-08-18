## What changed and why

<!-- The diff shows how. Say what moved and what problem it solves. -->

## Invariants touched

<!-- Delete the lines that do not apply. -->

- [ ] Ranking or recommendation stayed pure — no I/O, no provider concepts
- [ ] `packages/contracts` is still the only shared vocabulary
- [ ] The server remains the authority; no client-reported state became a score
- [ ] Migrations are forward-only; no applied migration was edited
- [ ] No new egress was added to the serving path
- [ ] A documented invariant changed, and the document changed with it

## Evidence

<!-- Paste what you ran. CI runs the same list. -->

```sh
npm run format:check && npm run lint && npm run typecheck && npm test
```

- [ ] Behaviour change comes with a test
- [ ] Ranking change goes through `tests/contracts/ranking.examples.json`

By opening this pull request you agree your contribution is licensed under
AGPL-3.0-or-later. There is no CLA.
