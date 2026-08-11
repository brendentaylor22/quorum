# Quorum implementation plan

Status: proposed  
Updated: 2026-08-11

## 1. Product goal

Quorum helps one person or a group choose something to watch. Each participant privately swipes left or right on the same 20 movies. Once voting finishes, Quorum ranks the slate by group approval and highlights unanimous choices.

First release must be easy to demonstrate, safe to stop and restart, deployable from a GitHub-built container image, reachable through a personal-domain HTTPS URL, and isolated from unrelated home-server services.

### MVP success story

1. Host creates a room and receives an invite link plus a separate host-control link.
2. Two or more people open invite link and choose temporary display names. No account required.
3. Host starts room. Membership and a 20-movie slate become fixed.
4. Each participant swipes privately through all 20 movies.
5. Results unlock when everyone finishes, or when host explicitly closes voting.
6. Results show ranked movies, approval percentage, vote count, response coverage, and a prominent `Match` badge for unanimous approval.
7. Restarting containers preserves active rooms and completed results.

Solo rooms use same flow. Right-swiped movies appear first; percentage is necessarily either 0% or 100%, so solo MVP value is a shortlist rather than meaningful group ranking.

## 2. MVP scope

### Included

- Movies only.
- Anonymous, temporary participants.
- Host-created rooms and unguessable invite links.
- One fixed slate of 20 movies per room.
- Poster, title, year, short synopsis, runtime, and content rating when available.
- Left/right swipe plus accessible Yes/No buttons.
- Reconnect and continue from last confirmed swipe.
- Ranked results and unanimous-match detection.
- Host can close or expire a room.
- Mobile-first web UI.
- One application image published to GHCR by GitHub Actions.
- Docker Compose deployment with persistent data, health checks, backup, restore, and rollback instructions.
- HTTPS ingress through Cloudflare Tunnel without router port forwarding or published application ports.

### Explicitly deferred

- Installable Progressive Web App (PWA), offline mode, series, genre selection, streaming-provider filters, Google sign-in, permanent profiles, social graphs, comments, chat, native apps, machine-learned recommendations, and horizontal scaling.
- Live synchronization animations. MVP can use short polling; WebSockets add operational complexity without changing core demo.
- Automatic deployment from GitHub into production. VM operator pulls and starts approved image digest.
- Claiming that a Docker container sharing media-server kernel and daemon is a hard security boundary.

## 3. Ranking contract

Binary input cannot produce fine-grained ranking when groups are small. MVP therefore uses transparent approval ranking and displays ties honestly.

For movie `m`:

```text
eligible(m)      = participant count frozen when room starts
yes(m)           = confirmed right swipes
responses(m)     = confirmed left + right swipes
approval_pct(m)  = 100 * yes(m) / eligible(m)
coverage_pct(m)  = 100 * responses(m) / eligible(m)
match(m)         = yes(m) == eligible(m)
```

Sort order:

1. Approval percentage, descending.
2. Response coverage, descending if host closed voting early.
3. Shared rank for equal scores; no hidden popularity-based tie-breaker.

| Rank | Movie | Yes | Coverage | Match |
|---:|---|---:|---:|:---:|
| 1 | Movie A | 100% (4/4) | 100% | Yes |
| 2 | Movie B | 75% (3/4) | 100% | No |
| 2 | Movie C | 75% (3/4) | 100% | No |
| 4 | Movie D | 50% (2/4) | 100% | No |

Non-responses remain in denominator after early close. This prevents one positive response appearing as 100% group approval. Results stay hidden until voting ends, preventing early scores influencing later swipes.

Potential post-MVP tie breaker: quick runoff ranking of tied top movies. Do not infer preference intensity from swipe speed or card order.

## 4. Data model designed for later recommendations

Record exposure and context, not only mutable movie preference. Right swipe in group session means “I would watch this now with this group,” not “this is one of my favourite movies.”

Core records:

- `catalog_items`: provider ID, media type, metadata snapshot, image reference, source timestamp.
- `rooms`: state, host-secret hash, invite-token hash, creation/expiry times, catalog version.
- `participants`: room-scoped ID, display name, signed-session hash, joined/last-seen times.
- `room_items`: room ID, catalog item ID, fixed slate position.
- `exposures`: participant, room item, `WATCH_NOW` context, shown time, slate/model version.
- `interactions`: exposure ID, `LEFT` or `RIGHT`, confirmed time; unique per exposure.
- `audit_events`: security and room-lifecycle events without secrets or unnecessary personal data.

Rules:

- Server confirms swipe only after durable transaction commit.
- Retry uses stable exposure ID and is idempotent.
- Participant cannot vote on item outside their room or more than once.
- Starting room freezes participant membership and slate.
- Results derive from canonical interactions, never client totals.
- Anonymous history remains room-scoped. It cannot safely become cross-device personal history until account linking is explicitly designed.

Future personal statistics can distinguish `WATCH_NOW`, `GENERAL_TASTE`, `SEEN_AND_LIKED`, `SEEN_AND_DISLIKED`, `NOT_INTERESTED`, and `ALREADY_SEEN`. Exposure-aware values must show numerator, denominator, minimum sample count, and later time decay.

## 5. Proposed MVP architecture

### Application stack

- TypeScript monorepo.
- React + Vite mobile-first client.
- Fastify JSON API serving built client assets.
- SQLite in WAL mode for single-VM MVP, with forward-only migrations and backup through SQLite backup API.
- Zod or TypeBox contracts shared between client and server.
- Vitest for unit/integration tests and Playwright for browser flows.
- One multi-stage, non-root OCI image containing server, static client, migrations, and operator commands.

SQLite keeps MVP to one stateful application container and fits small-room concurrency. Move to PostgreSQL before multiple application replicas or sustained cloud scale; keep repository interfaces and migrations narrow enough to make migration deliberate.

Keep MVP PWA-ready without implementing PWA behavior: responsive standalone-friendly layout, stable HTTPS routes, touch and keyboard controls, theme/icon source assets, versioned static assets, and clean separation between application shell and JSON API. Do not add web app manifest, service worker, install prompt, background sync, push notifications, or offline write queue during MVP. Service-worker caching can otherwise serve stale application code or API responses and complicate swipe confirmation, deployment, and rollback.

### Movie catalog

Use TMDB as initial metadata source, subject to current API terms, attribution rules, image configuration, and rate limits. Store provider IDs plus refreshable metadata; never treat imported metadata as owned product data.

MVP slate generation:

1. Operator runs catalog refresh command using server-side TMDB credential.
2. Import bounded, adult-content-excluded pool of currently suitable movies.
3. Validate required fields and record catalog/version timestamp.
4. On room start, choose 20 without replacement using server-generated seed and persist exact slate.
5. Bias only for basic quality: valid poster, synopsis, supported language, release date, and configurable minimum vote count. Do not call this personalized recommendation.

No API key reaches browser, image, logs, repository, or database export. UI includes required TMDB attribution and source notice. Exact use and image-caching approach must be checked against accepted TMDB terms before public launch.

### Runtime topology

```text
Internet
   |
Cloudflare HTTPS, rate controls, optional Turnstile
   |
cloudflared (outbound tunnel only)
   |
quorum-edge internal Docker network
   |
application:3000 (no host port)
   |
named data volume containing SQLite database
```

`cloudflared` joins tunnel-egress plus `quorum-edge`. Application joins only `quorum-edge` during normal serving and gets no Docker socket, host networking, host PID/IPC namespace, privileged mode, added capabilities, or unrelated mounts/networks.

Catalog import uses separate operator-triggered command/profile. Its egress is only application path needing TMDB. Best isolation uses allowlisting HTTPS proxy plus firewall rules blocking host, RFC1918, link-local, metadata-service, and other LAN destinations.

### Honest isolation boundary

Recommended production target is small dedicated VM on home server:

- Separate guest kernel and virtual disk.
- No mounts from media services.
- No access to host Docker socket or other Compose networks.
- VM firewall denies LAN access except explicit administration source; no inbound public port.
- Outbound allowlist for Cloudflare Tunnel, DNS/NTP, GHCR image pulls, and controlled catalog refresh.
- Separate low-privilege VM administrator credentials and secrets.

Running Quorum beside other services on one Docker host is weaker because containers share kernel and Docker daemon. Temporary fallback: rootless Docker or dedicated daemon/user, separate Compose project, internal network, read-only root filesystem, dropped capabilities, `no-new-privileges`, strict CPU/memory/PID limits, and host firewall egress rules. Risk reduced, but not equal to VM isolation.

Cloud migration later reuses image and Compose concepts on dedicated VM. Cloud-provider firewall, managed secrets, disk snapshots, and Terraform replace home-specific operator setup.

## 6. Security and privacy baseline

### Authentication and authorization

- Public room participation needs no account.
- Invite URL contains at least 128 bits of random entropy; never use short code as sole authorization.
- Separate host-control secret grants room administration. Store only keyed hashes of invite, host, and participant session tokens.
- Cookies: `Secure`, `HttpOnly`, `SameSite=Lax`, narrow path/domain, rotation on join, bounded expiry.
- Every mutation validates room state, participant membership, CSRF/origin, payload schema, and authorization server-side.
- Display names are escaped text with strict length and character limits.

### Abuse resistance

- Per-IP and per-room rate limits for create, join, swipe, and result endpoints.
- Cloudflare Turnstile on suspicious or repeated room creation/join, not necessarily every normal swipe.
- Uniform not-found responses for invalid/expired private links.
- Hard caps: participants per room, 20 slate items, request body size, rooms per source, and room lifetime.
- No user-supplied URLs, file uploads, HTML, templates, shell commands, or server-side fetch targets.
- Derive client IP only from trusted Cloudflare headers when request arrived through configured tunnel path.

### Container and supply chain

- Minimal pinned runtime base image; run as fixed non-root UID/GID.
- Read-only root filesystem, temporary `tmpfs`, dropped Linux capabilities, `no-new-privileges`, seccomp default, resource/PID limits.
- No secrets baked into image or GitHub build arguments. Runtime secrets live on VM with restrictive permissions.
- Pin GitHub Actions by commit SHA. Grant job-level least privilege.
- Pull deploy image by immutable digest, never floating `latest`.
- CI: format, lint, typecheck, unit/integration/browser tests, production dependency audit, secret scan, license check, Docker build, Compose validation, vulnerability scan, SBOM generation, and GHCR publish on trusted release refs.
- GitHub artifact attestations are useful when plan/repository visibility supports them. Current GitHub documentation says attestations for private repositories require GitHub Enterprise Cloud; do not make them a private-repo MVP gate without confirming plan support.
- No self-hosted GitHub runner on production VM. GitHub builds; VM operator verifies and deploys.

### Privacy and retention

- Collect only temporary display name, room actions, timestamps, and coarse security logs.
- No analytics SDK, advertising tracker, contact list, or precise location in MVP.
- Default room expiry: 7 days after completion; configurable shorter value.
- Operator purge command and scheduled expiry remove room tokens, participants, exposures, interactions, and room-specific audit data.
- Backups define separate retention, encryption, and expiry; UI deletion cannot claim immediate erasure from retained backups.
- Document TMDB as external metadata/image provider and Cloudflare as ingress provider.

## 7. Phased build plan

Each phase ends with evidence, not only code. Feature loop: contract and migration, server logic, UI, unit/integration tests, browser test, security/fault test, deployment evidence.

### Phase 0 — Product contract and threat model

Goal: remove ambiguous rules before implementation.

Deliverables:

- Wireframes for create, lobby, swipe, progress, and results views.
- Ranking contract from section 3 encoded as examples and acceptance tests.
- Room lifecycle: `LOBBY -> VOTING -> COMPLETE -> EXPIRED`.
- Data-retention policy and abuse limits.
- TMDB developer registration, accepted-use review, attribution decision, and fixture dataset for tests.
- Architecture decision records for SQLite, anonymous links, Cloudflare Tunnel, and dedicated VM.
- Threat model covering token discovery, room hijack, vote forgery, scraping, denial of service, SSRF, XSS, CSRF, compromised container, malicious image, secret leakage, and backup loss.

Exit gate:

- Ten written user journeys pass unambiguously: solo, tie, unanimous match, reconnect, early close, expired room, duplicate swipe, stolen participant cookie, invalid invite, and 20th-swipe completion.

### Phase 1 — Secure foundation and CI image

Goal: boot harmless vertical skeleton using final deployment shape.

Deliverables:

- Repository structure, strict TypeScript, lint/format/typecheck/test commands.
- Fastify health/readiness endpoints and static React shell.
- Migration runner, SQLite durability settings, backup/restore/doctor commands.
- Hardened multi-stage Dockerfile and Compose topology.
- GitHub Actions PR checks; release workflow builds/scans/SBOMs and publishes version plus commit-digest image to GHCR.
- Cloudflare Tunnel example config, secret templates, operator runbook, rollback runbook.
- Dependency update and vulnerability-response policy.

Exit gate:

- Fresh VM can pull image by digest and pass `doctor`.
- No application host port, privileged container, Docker socket, shared network, or unrelated mount exists.
- Stop/start preserves seeded database.
- Backup restores into clean volume and passes integrity plus record-count checks.
- Critical/high image findings are resolved or explicitly risk-accepted with expiry.

### Phase 2 — Local end-to-end MVP

Goal: demo complete selection loop locally with deterministic fixtures.

Deliverables:

- Create room, join, lobby, freeze membership, generate fixed slate, swipe, reconnect, complete, and results flows.
- Ranking engine with exact ties and incomplete-coverage behavior.
- Signed anonymous sessions and hashed capabilities.
- Fixture catalog supporting repeatable offline tests.
- Mobile gestures plus keyboard/button accessibility.
- Host early-close and room-expiry behavior.

Exit gate:

- Playwright passes host plus three isolated browser contexts through all 20 swipes.
- Unit tests cover ranking properties: range 0–100, unanimous detection, no non-response inflation, deterministic ties, duplicate-retry idempotency.
- Database restart during swipe produces either one confirmed vote or retryable failure, never two votes.
- Browser refresh resumes correct card and cannot view another participant's state.

### Phase 3 — Movie data and private pilot

Goal: replace fixtures in runtime with controlled real catalog and test with real users.

Deliverables:

- TMDB importer with bounded pagination, retries, rate handling, schema validation, attribution, and catalog-version audit.
- Adult exclusion and basic metadata-quality filters.
- Operator-triggered refresh; application works from last good catalog if TMDB is unavailable.
- Private-domain deployment through Cloudflare Tunnel.
- Rate controls, Turnstile escalation, security headers, CSP, structured redacted logs, and alertable health failures.

Exit gate:

- Two phones plus host complete real 20-movie room over public hostname.
- Invalid, expired, or modified tokens fail; participant cannot host-close room or submit for another participant.
- Origin has no public/LAN listener and survives tunnel restart.
- Application cannot reach host, media services, Docker API, cloud metadata endpoint, or arbitrary Internet targets in controlled test.
- TMDB outage does not break existing-room voting or results.

This phase is first genuinely demoable MVP.

### Phase 4 — MVP release hardening

Goal: make repeated demos and routine operation boring.

Deliverables:

- Load test at declared support limit, initially 20 participants per room and 20 concurrent active rooms.
- Automated expiry, encrypted backups, off-VM backup copy, restore drill, disk-full behavior, and database integrity checks.
- Upgrade and rollback by digest; forward-only migration compatibility rules.
- Operational view for room counts, error rates, latency, disk, catalog age, backup age, and tunnel health without personal data.
- Accessibility pass, mobile-browser matrix, privacy notice, security contact, admin incident runbook.

Exit gate:

- Declared load passes latency/error budget.
- Abrupt container kill and VM restart preserve confirmed votes.
- Restore drill recovers room/results from backup.
- Previous compatible image digest rollback succeeds.
- Demo checklist passes from fresh room creation through ranked result.

### Phase 5 — Installable PWA

Goal: make Quorum installable while preserving server-authoritative voting and safe upgrades.

- Add web app manifest, complete icon set, theme/background colours, display mode, scope, and stable start URL.
- Add deliberately scoped service worker for versioned static application assets. Never cache authenticated mutations or treat cached API data as authoritative.
- Show install guidance only when browser/platform supports it; normal URL experience remains complete.
- Define upgrade behavior so new release activates predictably and old cached shell cannot submit incompatible payloads.
- Add offline read-only shell and clear connectivity state first. Defer offline swipe queue until idempotency, conflict handling, expiry, logout, and shared-device privacy have dedicated tests.
- Test install, launch, update, uninstall/reinstall, cleared storage, expired room, and offline/online transitions on supported Android, iOS/iPadOS, and desktop browsers.

Exit gate:

- Supported browsers can install and launch Quorum from home screen or application list.
- Installed and browser modes complete same room flow.
- Offline state never displays unconfirmed swipe as confirmed.
- Deployment and rollback cannot leave clients permanently pinned to stale shell.

### Phase 6 — Genres and better candidate generation

Goal: improve slate relevance without personal accounts.

- Host selects one or more genres before room start.
- Optional release-year, runtime, language, certification, and region/provider filters.
- Candidate generator balances relevance, popularity confidence, novelty, and diversity; persist algorithm version and candidate reasons.
- Avoid 20 near-duplicates from one franchise/year/genre cluster.
- Evaluate with fixtures and non-personal aggregate measures such as completion rate, approval spread, and match frequency.

### Phase 7 — Accounts and personal history

Goal: add optional identity without harming anonymous use.

- Google OpenID Connect authorization-code flow with PKCE, strict issuer/audience/nonce/state checks, exact redirect URIs, and no Google access-token storage unless later feature needs it.
- Anonymous participation remains available; account linking requires explicit consent.
- Personal history separates “watch now” group context from general taste and watched status.
- User can inspect, export, delete history, and disconnect Google identity.
- Exposure-aware stats show sample size: `8 right swipes from 10 completed exposures`, not misleading “80% liked” without context.

### Phase 8 — Recommendations, series, and cloud portability

Goal: rank candidates intelligently while preserving group fairness.

- Add series as separate media type; do not overload movie-specific runtime/release rules.
- Start recommender with interpretable content features and Bayesian-smoothed user preferences; add collaborative signals only after enough consented data exists.
- Group candidate score combines predicted willingness while penalizing strong dislike by one member. Compare average utility, least-misery floor, and fairness-aware blends through offline replay before choosing.
- Keep exploration quota so repeated sessions do not become filter bubbles.
- Record model/version and recommendation reason; support deterministic replay and rollback.
- Move SQLite to PostgreSQL before replicas; add Redis only for disposable cache/rate coordination if measurements justify it.
- Add Terraform for cloud VM, network/firewall, disk, secret manager, registry access, monitoring, and backups.

## 8. Operator interface

Use thin `quorumctl` commands: `start`, `stop`, `status`, `doctor`, `backup`, `restore`, `catalog-refresh`, `migrate`, `logs`, and `rollback`. `stop` stops containers without deleting volume. Destructive purge and restore commands require explicit target and confirmation.

Suggested repository areas: `apps/api`, `apps/web`, shared `contracts`, `ranking`, `database`, and `catalog` packages, `deploy`, `docs`, operator scripts, and GitHub workflows.

## 9. MVP acceptance checklist

Product:

- Four people can join with no account and privately swipe same 20 movies.
- Everyone sees same final ranking and exact vote arithmetic.
- Unanimous choice visibly marked; ties not hidden.
- Refresh/reconnect loses no confirmed vote.
- Solo flow produces usable shortlist.

Security:

- Invite and host-control capabilities are separate and unguessable.
- Cross-room and cross-participant mutations fail.
- No secrets appear in repository, image history, logs, browser bundle, or exported backup metadata.
- Origin has no public or LAN listener; only tunnel reaches application network.
- Container has no path to unrelated services, mounts, or Docker API; dedicated VM provides hard workload boundary.
- Rate limits and resource caps resist cheap room/join/swipe abuse.

Operations:

- GitHub release produces scanned GHCR image and SBOM.
- Operator deploys exact digest and can identify running commit.
- `stop` then `start` preserves state.
- Backup, integrity verification, clean-volume restore, upgrade, and rollback are demonstrated.
- Cloudflare/TMDB loss has documented degraded behavior.

## 10. Recommended first implementation slice

Build Phases 0 and 1, then one thin Phase 2 path:

1. Fixture catalog with exactly 20 movies.
2. Create room and one unguessable invite.
3. Join two participants.
4. Persist one swipe per participant/movie idempotently.
5. Complete room and show approval-ranked results.
6. Exercise flow in Playwright with two browser contexts.
7. Package same path in hardened image and prove stop/start persistence.

Avoid TMDB, Cloudflare, Google, recommendations, WebSockets, and elaborate animation until this slice works. It validates product loop, scoring contract, schema, persistence, and deployable image before external integration work.

## 11. Current external references

- TMDB API getting started and terms entry point: https://developer.themoviedb.org/docs/getting-started
- Cloudflare Tunnel outbound-only model: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/
- GitHub container publishing: https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images
- GitHub artifact-attestation availability and verification: https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations

Re-check provider terms, plan eligibility, action versions, and deployment docs during implementation; these are external and can change.
