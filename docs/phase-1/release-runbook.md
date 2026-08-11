# Release runbook

## Create release

Release tag must point to commit contained in `main`. Workflow rejects tag from feature or unmerged branch.

```sh
git checkout main
git pull --ff-only origin main
git tag -a v0.1.2 -m "Quorum v0.1.2"
git push origin v0.1.2
```

Tag push runs `Release image` workflow. No separate GitHub Release creation is needed. Workflow:

1. Verifies tagged commit belongs to `main`.
2. Runs format, lint, typecheck, tests, audit, and license checks.
3. Builds image and blocks fixed critical/high findings.
4. Publishes semantic-version and commit tags to GHCR.
5. Generates SPDX SBOM from immutable published digest.
6. Packages pull-only deployment bundle with digest-pinned `deploy/.env`.
7. Generates SHA256 checksums.
8. Creates GitHub Release and attaches bundle, SBOM, and checksums.

Read workflow summary for immutable `ghcr.io/...@sha256:...` identity. Deployment bundle already contains same identity; compare `RELEASE` and `deploy/.env` before use.

## Failure handling

- Failed checks/scan stop before publish.
- If publish succeeds but release packaging fails, do not move tag. Re-run failed workflow after fixing transient cause.
- Never delete/reuse version tag for different commit. Create next patch version when code changes.
- GitHub Release asset is operator delivery mechanism; VM never clones repository or builds image.

Follow [operator runbook](operator-runbook.md) for checksum verification, pull, startup, persistence proof, and restore drill.
