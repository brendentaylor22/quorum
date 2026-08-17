# Phase 1 evidence index

Status: implementation complete; local evidence recorded, fresh-VM/release evidence pending operator run.

| Deliverable                                         | Evidence                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| TypeScript monorepo and commands                    | Root `package.json`, strict TypeScript/ESLint/Prettier configs   |
| Fastify health/readiness and React shell            | `apps/api`, `apps/web`, health integration tests                 |
| SQLite migration, durability, backup/restore/doctor | `packages/database`, operation tests, operator runbook           |
| Hardened image and Compose topology                 | `Dockerfile`, `deploy/compose.yaml`                              |
| PR and release automation                           | `.github/workflows/checks.yml`, `.github/workflows/release.yml`  |
| Pull-only VM deployment bundle                      | GitHub Release archive, checksum, generated digest-pinned `.env` |
| Tunnel and secret examples                          | `deploy/cloudflared`, `deploy/secrets`, `.env.example`           |
| Operations and rollback                             | Operator and rollback runbooks, `scripts/quorumctl`              |
| Operator command behavior                           | `tests/operator/quorumctl.test.ts`                               |
| Release creation                                    | Automatic `main` release runbook and commit identity policy      |
| Update/vulnerability response                       | Dependency security policy, Dependabot config                    |

Local implementation evidence: [local-validation.md](local-validation.md).

## Remaining external evidence

Phase 1 exit gate is not fully certified by repository-local tests alone. Operator must publish trusted release, download verified deployment bundle without cloning repository, deploy exact digest on fresh dedicated VM, and record persistence plus clean-volume restore results.
