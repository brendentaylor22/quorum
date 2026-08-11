# Phase 1 local validation

Date: 2026-08-11  
Host: Docker Desktop, Linux ARM64 container runtime

## Code quality

- Prettier check: passed.
- ESLint strict rules: passed with zero warnings.
- TypeScript workspace typecheck: passed.
- Vitest: 4 tests passed across API health and SQLite operations.
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

After Compose stop/start, `doctor` returned `integrity:["ok"]` with same counts. Online backup returned same integrity and counts. Restore into newly created clean volume returned same integrity and counts; second `doctor` against restored volume confirmed them.

Restore drill initially exposed WAL portability bug when read-only-mounted backup required adjacent writable WAL state. Backup now normalizes completed backup to rollback-journal mode, verifies it through read-only reopen, and restore uses SQLite backup API into new destination. Unit test sets backup file read-only before restore to preserve regression coverage.

## Not yet certified

Local digest is not deployable GHCR identity. Fresh dedicated-VM pull, GHCR release workflow, published SBOM, Cloudflare Tunnel connection, VM firewall policy, and remote scanner evidence require operator credentials/infrastructure. Record those separately before marking Phase 1 exit gate complete.
