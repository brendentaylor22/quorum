# Threat model

Updated: 2026-08-11

## Scope and trust boundaries

Protected assets: capability secrets, participant sessions, private votes, room integrity, availability, catalog credential, SQLite data, backups, release provenance, and unrelated home services.

```text
untrusted browser
    -> Cloudflare controls / tunnel
    -> application container
    -> SQLite volume

operator -> dedicated VM -> image by digest / secrets / backup store
catalog job -> restricted egress -> TMDB
GitHub Actions -> GHCR (build only; no VM access)
```

Trust ends at every arrow. Browser state, forwarded headers, container image, external metadata, backup media, and CI output require validation or verification. Dedicated VM boundary protects unrelated services; container boundary alone does not.

## Threats and required controls

| ID | Threat | Attack and impact | Required prevention/detection | Verification evidence |
|---|---|---|---|---|
| T01 | Token discovery | Guess invite/host/session capability; enter or control room | Host/session >=128 random bits; invite >=77 bits (see T01a); keyed hashes; uniform failures; rate limits | Entropy unit test; invalid/modified-token integration tests; log redaction test |
| T01a | Invite phrase guessing | Guess a six-word invite phrase; enter one room as an extra participant | Accepted reduction to ~77.5 bits so the invite can be spoken and retyped; bounded to the invite alone, which grants no host authority, expires with a <=24h lobby, and admits at most 20 people; host/session capabilities unchanged at 256 bits | Word-list size and phrase entropy unit tests; uniform-draw test; `capabilities.ts` records the trade |
| T02 | Room hijack | Invite recipient obtains host authority | Separate capabilities and endpoints; host secret never in invite/session; explicit host auth | Participant-close denial test; URL/referrer inspection |
| T03 | Vote forgery | Submit for another participant, room, item, or twice | Server derives identity from session; relational ownership checks; unique exposure interaction; transaction | Cross-room/cross-participant tests; concurrent duplicate test |
| T04 | Scraping | Enumerate rooms or bulk-copy catalog/posters | Unguessable URLs; uniform responses; request caps; no list/search endpoint; Cloudflare rate control | Enumeration test; route inventory; rate-limit evidence |
| T05 | Denial of service | Room creation, join, swipe, expensive reads exhaust CPU/disk | Body/participant/room limits; bounded queries; timeouts; rate controls; resource/PID/disk monitoring | Load test at declared limit; abuse test; disk-full drill |
| T06 | SSRF | User input or catalog data causes server fetch to LAN/metadata | No user URL fetch; fixed TMDB origin; egress proxy/firewall blocks RFC1918, link-local, metadata, LAN | Controlled blocked-destination tests from app/catalog contexts |
| T07 | XSS | Display name or catalog text executes script and steals visible data | Text rendering; schema/length/control-char validation; CSP; no unsafe HTML | Stored/reflected payload browser tests; CSP inspection |
| T08 | CSRF | Attacker site uses participant/host cookie for mutation | SameSite cookie; exact trusted Origin validation; CSRF token where cookie endpoint needs it; JSON content type | Missing/wrong Origin and token tests |
| T09 | Compromised container | App exploit reaches host or other services | Dedicated VM; non-root; read-only root; drop capabilities; no socket/mount/shared network; seccomp; egress deny | Compose inspection; runtime identity/mount/network/egress tests |
| T10 | Malicious image | Dependency/base/action compromise ships payload | Pinned actions/base; least permissions; scans; SBOM; trusted refs; digest deploy; operator verifies provenance | Workflow review; scan/SBOM artifact; running digest check |
| T11 | Secret leakage | Credentials enter Git, image, logs, browser, backups | Runtime secret files/manager; no build args; redaction; secret scan; browser-bundle scan; restrictive permissions | Secret-scan result; image-history and bundle inspection; log tests |
| T12 | Backup loss | Corrupt/missing/unreadable backup destroys rooms/results | SQLite backup API; encryption; off-VM copy; integrity and record counts; retention; restore drills | Scheduled backup age alert; clean-volume restore record |
| T13 | Link leakage | Capability appears in referrer, history sync, screenshot, logs | Tokens in path consumed then replaced where feasible; Referrer-Policy no-referrer; redact logs; warning | Header/browser-history/log inspection |
| T14 | Result manipulation | Client totals or early scores bias/alter outcome | Canonical server interactions only; results hidden until complete; deterministic ranking contract | Ranking examples; pre-completion authorization test |
| T15 | Replay/race | Concurrent swipe/start/close causes double or invalid state | Idempotency by exposure; unique constraints; state-checked transactions; monotonic lifecycle | Concurrency integration and fault tests |
| T16 | Privacy over-retention | Temporary identity/actions persist or reappear after restore | Scheduled purge; bounded backups; restore reapplies expiry; no cross-room identity | Purge test; expired-backup restore test |

## Abuse cases and stop conditions

- If source identity cannot be trusted through tunnel, do not use it for rate-limit or audit claims; fail deployment check.
- If application can reach host, LAN, metadata service, Docker API, or arbitrary Internet during serving, private pilot stops.
- If secret scan, image scan, backup integrity, or migration check fails, release/deploy stops.
- If uniform invalid-capability behavior cannot be demonstrated, public ingress remains disabled.
- If backup has not passed clean-volume restore, no disruptive migration proceeds.

## Residual risks accepted for MVP

- Authorized invite recipient may share invite; MVP host cannot identify real people.
- Stolen participant cookie can cast remaining votes as that participant until expiry; scope and short retention limit impact. Host-control remains separate.
- Cloudflare and TMDB observe network requests permitted by their roles; privacy notice must disclose them.
- Traffic spike beyond declared support limit may reduce availability. Integrity must fail closed.
- VM administrator can access application data and secrets. Low-privilege access, encrypted backups, and operational controls reduce but do not remove risk.

