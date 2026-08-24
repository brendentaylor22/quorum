# Releasing

What a push to `main` produces, and what to do when it fails. Relevant to
maintainers and to anyone running a fork that publishes its own images.

## Cutting a release

Merge the pull request into `main`. The `Release image` workflow runs
automatically; no manual tag or separate GitHub Release is needed. It:

1. Runs format, lint, typecheck, tests, audit, and license checks.
2. Builds image and blocks fixed critical/high findings.
3. Assigns immutable release identity `main-<12-character-commit-SHA>`.
4. Publishes release, commit, and moving `main` tags to GHCR.
5. Generates SPDX SBOM from immutable published digest.
6. Packages deployment bundle with digest-pinned `deploy/.env`.
7. Generates SHA256 checksums.
8. Creates matching commit-named GitHub Release and attaches `quorum-deploy.tar.gz`, SBOM, and checksums.

Read the workflow summary for the immutable `ghcr.io/...@sha256:...` identity. The deployment bundle already contains that identity; compare `RELEASE` and `deploy/.env` before use.

The digest is the release's output that matters. An installer following [self-hosting](self-hosting.md) copies `deploy/.env.example` from the repository and pins that digest by hand; the bundle exists so a host can skip that step and verify a checksum instead. Both run the same image.

## Failure handling

- Failed checks or scans stop the run before anything is published.
- If publishing succeeds but packaging fails, re-run the failed workflow. The same commit identity is reused and the assets are replaced safely.
- Never move or reuse a generated `main-<commit>` tag for another commit.
- The release asset is the delivery mechanism for the strict procedure in [operations](operations.md): that host never clones the repository and never builds an image. An ordinary self-hosting install may clone, but still never builds.

For checksum verification, the pull, startup, the persistence check, and the restore drill, follow [operations](operations.md).
