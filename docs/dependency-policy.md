# Dependency and vulnerability policy

How updates land and how findings are handled. Enforced by CI, not by habit.

## Updates

- Dependabot opens monthly npm and GitHub Actions updates, maximum five open PRs per ecosystem.
- Every dependency PR must pass format, lint, typecheck, tests, production audit, license policy, secret scan, Compose validation, container build, and image scan.
- Review lockfile and transitive changes. Merge one update at a time. Major versions require migration notes and focused tests.
- Runtime base image and all Actions use immutable digest/SHA pins. Refresh pins through reviewed PRs; never switch production to floating tags.

## Vulnerability response

1. Confirm affected package/image, reachable code path, fixed version, and scanner evidence.
2. Critical or high reachable finding blocks release. Patch immediately, rebuild, scan, publish new digest, then follow deployment runbook.
3. If no fix exists, disable affected surface or stop pilot. Risk acceptance requires owner, rationale, compensating control, review date, and expiry no longer than 30 days.
4. Moderate/low findings enter tracked backlog with severity and exposure review.
5. Suspected credential exposure requires revocation and rotation; deleting secret from latest commit is insufficient.

No release ships while a critical or high image finding lacks either a resolved scan or an unexpired written acceptance.
