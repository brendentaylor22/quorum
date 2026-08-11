# Digest rollback runbook

## Preconditions

- Record current image digest, target prior digest, database migration version, and latest verified backup.
- Roll back only when target image declares compatibility with all already-applied forward migrations.
- Do not restore older database merely to run incompatible code until backup verification and explicit incident decision.

## Procedure

1. Run `scripts/quorumctl backup pre-rollback-YYYYMMDDTHHMMSSZ.db`.
2. Run `scripts/quorumctl doctor`; stop if integrity fails.
3. Run `scripts/quorumctl rollback ghcr.io/brendentaylor22/quorum@sha256:FULL_DIGEST`.
4. Confirm health, static shell, running image digest, logs, and `foundation_records` count.
5. Persist verified digest as `QUORUM_IMAGE` in `deploy/.env`.

If target fails health, repeat with previously running digest. Escalate instead of deleting volume or reversing migrations.
