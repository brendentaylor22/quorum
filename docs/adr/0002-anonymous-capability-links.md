# ADR-0002: Anonymous capability links

Status: Accepted  
Date: 2026-08-11

## Decision

Use separate high-entropy invite and host-control URLs plus room-scoped participant sessions. Generate at least 128 random bits, reveal raw secrets only to clients, and store keyed hashes. Rotate participant session on join. Apply `Secure`, `HttpOnly`, `SameSite=Lax`, bounded-expiry cookies and origin/CSRF checks.

## Consequences

No account friction. Possession grants scoped authority, so link leakage is security-sensitive and cannot be recovered like account password. Host secret never appears in participant URL. Logs, analytics, referrers, and error reports must redact capabilities. Later account linking needs separate consent design.

