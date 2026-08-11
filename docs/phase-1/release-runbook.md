# Release runbook

## Create release

Merge approved pull request into `main`. Push to `main` runs `Release image` workflow automatically; no manual tag or separate GitHub Release creation is needed. Workflow:

1. Runs format, lint, typecheck, tests, audit, and license checks.
2. Builds image and blocks fixed critical/high findings.
3. Assigns immutable release identity `main-<12-character-commit-SHA>`.
4. Publishes release, commit, and moving `main` tags to GHCR.
5. Generates SPDX SBOM from immutable published digest.
6. Packages pull-only deployment bundle with digest-pinned `deploy/.env`.
7. Generates SHA256 checksums.
8. Creates matching commit-named GitHub Release and attaches `quorum-deploy.tar.gz`, SBOM, and checksums.

Read workflow summary for immutable `ghcr.io/...@sha256:...` identity. Deployment bundle already contains same identity; compare `RELEASE` and `deploy/.env` before use.

## Failure handling

- Failed checks/scan stop before publish.
- If publish succeeds but release packaging fails, re-run failed workflow. Same commit identity is reused and assets are replaced safely.
- Never move or reuse generated `main-<commit>` tag for another commit.
- GitHub Release asset is operator delivery mechanism; VM never clones repository or builds image.

Follow [operator runbook](operator-runbook.md) for checksum verification, pull, startup, persistence proof, and restore drill.
