# Threat model

Updated: 2026-08-17

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
| T01b | Invite phrase at rest | Database or backup read yields invite phrases and admits the reader to live rooms | Accepted: the phrase is stored in the clear beside its hash so the host screen can re-share a room minted outside a browser; bounded to live lobbies (<=24h) and cleared on expiry; grants no host authority; host and session capabilities remain hash-only | `rooms.invite_token` cleared by `markRoomExpired`; host-only exposure test in `app.test.ts` |
| T02 | Room hijack | Invite recipient obtains host authority | Separate capabilities and endpoints; host secret never in invite/session; explicit host auth | Participant-close denial test; URL/referrer inspection |
| T02a | Host claim takeover | A second holder of the host link claims the room and displaces the first device's host session | Accepted: the host capability, not the claim, is the authority, so a holder reopening the link on another device must not be locked out; each claim retires the previous host session and is audited (`host.claimed`, `host.reclaimed`) | Claim reissue and stale-session tests in `app.test.ts`; audit rows |
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

## Implementation status of the required controls

Recorded here so the table above stays a statement of what is required, and this
stays a statement of what is built.

| ID | Built | Not built |
|---|---|---|
| T01, T01a | Entropy, keyed hashes, uniform failures, rate limits | — |
| T01b | Invite phrase stored in the clear for a live room only, cleared on expiry, shown to the host alone | — |
| T02 | Separate capabilities and endpoints; host secret never in invite or session | — |
| T02a | Host session issued on claim, room-scoped, `HttpOnly`, superseded by a later claim, audited | — |
| T03 | Session-derived identity, ownership checks, unique exposure interaction, transactions | — |
| T04 | Unguessable URLs, uniform responses, no list or search endpoint, request caps | Cloudflare rate control is operator-dependent; Quorum no longer assumes Cloudflare |
| T05 | Body, participant, and room-creation caps; per-source and per-session rate limits; bounded queries | Load test at the declared limit (Phase 5) |
| T06 | No user URL fetch, fixed TMDB origin, serving container on an `internal` network with no egress | Egress proxy or firewall allowlisting is operator infrastructure; not yet proved on a real host |
| T07 | Text rendering, schema and control-character validation, CSP with no inline script or `eval` | — |
| T08 | `SameSite` cookies, exact same-origin check, required request header, JSON content type | — |
| T09 | Non-root, read-only root, dropped capabilities, no socket or shared network, pid/memory/cpu limits | Dedicated-VM boundary and runtime verification on a real host |
| T10 | Pinned actions and base images, least permissions, scans, SBOM, digest deploy | Operator provenance verification on a real deployment |
| T11 | Secret files not variables, capability redaction in logs, secret scan in CI | Browser-bundle and image-history inspection as a standing check |
| T12 | SQLite backup API, integrity and record-count checks, restore refusing an existing volume | Encryption, off-host copy, and a restore drill (Phase 5) |
| T13 | Tokens censored from logs; `Referrer-Policy: no-referrer` as both header and meta tag; proxy access log disabled | — |
| T14 | Canonical server interactions, results hidden until complete, deterministic ranking contract | — |
| T15 | Exposure idempotency, unique constraints, state-checked transactions, monotonic lifecycle | — |
| T16 | Scheduled expiry and purge, operator purge command, no cross-room identity | Restore-reapplies-expiry drill (Phase 5) |

**Turnstile is not implemented**, and T04/T05 no longer assume it. It is a
Cloudflare-coupled control, and Quorum supports deployments with no Cloudflare
in the path; rate limits and the rooms-per-source cap carry that load instead.
An operator fronting Quorum with Cloudflare can enable it at the edge without
the application knowing.

**Source identity is operator configuration.** `QUORUM_TRUST_PROXY` decides
whose `X-Forwarded-For` is believed. Unset behind a proxy, every caller shares
one rate-limit bucket; set without a trusted proxy in front, the limits are
forgeable. The stop condition below therefore has a concrete setting behind it.

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

