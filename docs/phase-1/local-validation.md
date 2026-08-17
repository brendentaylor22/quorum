# Phase 1 local validation

Date: 2026-08-11  
Host: Docker Desktop, Linux ARM64 container runtime

## Code quality

- Prettier check: passed.
- ESLint strict rules: passed with zero warnings.
- TypeScript workspace typecheck: passed.
- Vitest: 15 tests passed across API health, SQLite operations, and `quorumctl` operator behavior.
- Coverage: 90.9% lines, 90.38% statements, 91.66% functions, 77.77% branches; all configured thresholds passed.
- Production npm audit: zero vulnerabilities.
- Full dependency license allowlist: passed.
- Compose configuration and operator shell syntax: passed.

## Image and topology

Final local image identity: `quorum:phase1`, local manifest digest `sha256:ab7ce1225523ffa4635992fe26afe34a7ce12fc6f27553ba708495e7d76c5133`.

Runtime inspection:

```text
user=10001:10001
readonly=true
privileged=false
ports={"3000/tcp":null}
security=["no-new-privileges:true"]
capdrop=["ALL"]
networks=quorum-edge only
```

Application checks from inside internal network returned readiness HTTP 200 and static shell HTTP 200. No host port was published.

Production `deploy/compose.yaml` is pull-only and requires immutable `QUORUM_IMAGE`; it has no build context. Repository-local builds use explicit `deploy/compose.local.yaml` override and cannot silently become VM fallback builds.

Pinned local Trivy scan against final image returned:

```json
{ "high_or_critical_count": 0 }
```

First scan found seven fixed high/critical vulnerabilities only in global npm CLI bundled by Node base image. Runtime never invokes npm, so final stage removes npm/npx and was rebuilt/re-scanned. Application production packages and Debian runtime then reported zero high/critical findings.

## Durability and recovery

Dedicated validation volume was migrated and seeded:

```json
{ "foundation_records": 1, "schema_migrations": 1 }
```

That count is the Phase 1 record. Migration `0002_room_model.sql` replaced `foundation_records` with the room schema, so the equivalent Phase 2 persistence proof uses `catalog_items` plus room, exposure, and interaction counts.

After Compose stop/start, `doctor` returned `integrity:["ok"]` with same counts. Online backup returned same integrity and counts. Restore into newly created clean volume returned same integrity and counts; second `doctor` against restored volume confirmed them.

Restore drill initially exposed WAL portability bug when read-only-mounted backup required adjacent writable WAL state. Backup now normalizes completed backup to rollback-journal mode, verifies it through read-only reopen, and restore uses SQLite backup API into new destination. Unit test sets backup file read-only before restore to preserve regression coverage.

## Defects found and fixed after first validation pass

Re-audit of the Phase 1 deliverables against the plan found five issues. All are fixed; `tests/operator/quorumctl.test.ts` covers the operator-script changes with a recording `docker` stub, so no daemon is required.

1. **Backups bind mount was unwritable on a real VM.** Application runs as UID `10001` and writes backups through `deploy/backups`, but a freshly extracted bundle leaves that directory owned by the deployment administrator. Docker Desktop's permissive bind-mount mapping hid this locally; a Linux VM would have failed the backup exit gate with an opaque error. `quorumctl backup` now probes writability as the runtime UID first and prints the exact `chown` remediation, and the operator runbook sets ownership during first-run setup.
2. **`quorumctl migrate` was missing.** Plan section 8 lists `migrate` in the operator interface and the CLI implemented it, but the wrapper never exposed it.
3. **Release scan did not gate the published artifact.** Trivy blocked findings in a separately built, locally loaded image, then a second build was pushed. The release now re-scans the published GHCR digest and fails if that exact deployed artifact has critical or high findings.
4. **Release permissions were workflow-scoped.** `contents: write` and `packages: write` applied to the whole workflow. Workflow default is now `{}` with the grant narrowed to the publishing job.
5. **Restore resolved its image from `compose config --images`.** Output membership and order change when a tunnel profile is active, so restore could have run the `cloudflared` image. It now reads the pinned `QUORUM_IMAGE` digest from `deploy/.env` and fails loudly when absent.

## Not yet certified

Local digest is not deployable GHCR identity. Fresh dedicated-VM pull, GHCR release workflow, published SBOM, Cloudflare Tunnel connection, VM firewall policy, and remote scanner evidence require operator credentials/infrastructure. Record those separately before marking Phase 1 exit gate complete.
