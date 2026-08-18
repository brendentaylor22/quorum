# Phase 3 — Abuse resistance, web hardening, and open-source release

Updated: 2026-08-17

Goal: make the working MVP safe to expose and safe for a stranger to install,
without changing its data model or route contracts.

This phase carries the Phase 3 deliverables from the implementation plan plus
the open-source release work the plan never had, because the plan predates the
decision to ship Quorum as a self-installable image rather than a service the
author operates alone.

## Status

| #   | Item                                                       | State       |
| --- | ---------------------------------------------------------- | ----------- |
| 1   | Licence and open-source hygiene                            | Complete    |
| 2   | Capability redaction in logs                               | Complete    |
| 3   | Rate limits and rooms-per-source cap                       | Complete    |
| 4   | Security headers and CSP                                   | Complete    |
| 5   | Scheduled expiry and operator purge                        | Complete    |
| 6   | Self-hosting path, reverse-proxy overlay, config reference | Complete    |
| 7   | Privacy notice and source offer in the UI                  | Complete    |
| 8   | Plan and evidence docs reconciled with reality             | Outstanding |

Turnstile is **not** being built. It is a Cloudflare-coupled control, and Quorum
now supports deployments with no Cloudflare in the path at all. Rate limits plus
the rooms-per-source cap cover the abuse case for a self-hosted instance;
operators fronting Quorum with Cloudflare can enable Turnstile at the edge
without the application knowing. Recorded here rather than left as a silent gap
in the threat model's T04/T05 controls.

## 1 — Licence and open-source hygiene — complete

Quorum is **AGPL-3.0-or-later** ([LICENSE](../../LICENSE)). Copyleft that reaches
network use: anyone running a modified Quorum as a service publishes their
changes. That matches what Quorum is — a thing people run for other people —
where a permissive licence would let a hosted fork close it.

The licence covers Quorum's code. It says nothing about movie metadata: TMDB's
terms bind the operator who supplies their own TMDB credential, and a
self-installer inherits them directly. See
[TMDB use review](../phase-0/tmdb-use-review.md).

Added:

- [LICENSE](../../LICENSE) — canonical AGPL-3.0 text, `license` and `repository`
  in `package.json`, `org.opencontainers.image.licenses` on the image, and the
  licence file copied into the image so it travels with every distributed copy.
- [SECURITY.md](../../SECURITY.md) — private disclosure through GitHub advisories,
  scope, and the accepted residual risks a reporter should not re-report (T01a
  invite entropy in particular).
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — the check suite, and the invariants
  review actually enforces: pure ranking and recommendation, `contracts` as the
  only shared vocabulary, server authority, forward-only migrations, no new
  egress from the serving path.
- [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md).
- Issue templates and a config that routes security reports away from public
  issues.

**The published image did not run.** `packages/recommend` was missing from both
stages of the `Dockerfile`. The build stage copied `packages` wholesale, so the
image built green and every scan passed; nothing in CI ever started the built
container, so nothing noticed that `apps/api` imports `@quorum/recommend`
statically and the runtime stage never copied it. Verified against an image
built from the previous `Dockerfile`:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@quorum/recommend'
    imported from /app/apps/api/dist/rooms/service.js
```

That is boot failure, not a degraded feature. Both stages now copy the package,
and the rebuilt image starts and serves. The gap that hid it — CI builds and
scans the image but never runs it — is worth closing in Phase 5 with a
container smoke test.

## 2 — Capability redaction in logs — complete

Capability tokens travel in URL paths, because an invite has to be a link a
person can open. Fastify's default logger records the request line, so the
serving process was writing `/api/host/<256 bits of host authority>` on every
host poll. Log files outlive rooms, get shipped to aggregators, and get pasted
into bug reports. Threat model T11 and T13 both land here.

[`apps/api/src/logging.ts`](../../apps/api/src/logging.ts) replaces Fastify's
request serializer so the token segment of every capability route is censored
before a line is written, keeping method, route shape, and query string —
which is what a log is for. Pino `redact` paths additionally censor the
host-capability header, the session cookie, and the `Set-Cookie` that issues
one, so anything logging a whole request or reply cannot leak either.

`buildApp` no longer accepts a plain `logger: true` into Fastify; logging is
either off or the redacting configuration.

Evidence:

- `apps/api/src/logging.test.ts` — every capability route redacted, route shape
  and query string preserved, non-capability paths untouched.
- `apps/api/src/app.test.ts` (`request logging`) — a live app logging to a
  captured stream, driven through room creation, invite read, host read, join,
  a host-header request, and the client capability route. The captured log
  contains neither the invite nor the host token, and still contains
  `/api/host/[redacted]`.

## 3 — Rate limits and rooms-per-source cap — complete

[`apps/api/src/rate-limit.ts`](../../apps/api/src/rate-limit.ts) enforces the
policy table in [retention and abuse](../phase-0/retention-and-abuse.md), which
was updated in the same change because implementing it revealed two of its
numbers were wrong.

Before this, `POST /api/rooms` was an unauthenticated write with nothing but a
16 KiB body limit in front of it: anyone could spam rooms until the disk filled.
That is now 2/minute, 5/hour, and 10/day per source, the last of which is the
"active rooms per source per 24 hours" cap the policy always claimed.

The design problem worth recording: **everyone in a Quorum room is usually on
the same wifi.** A limit keyed on source address treats a household as one
caller. Room reads and swipes are therefore charged to the participant session —
the finest capability available, and not free to mint because joining is itself
limited — while join and capability-read limits are keyed by source and sized
for twenty devices behind one address. Joining moved from the documented
10/minute to 30/minute for exactly this reason: a full room could not have been
filled from one household at the original figure.

Two pieces of operator configuration come with it:

- `QUORUM_TRUST_PROXY` — whether to believe `X-Forwarded-For`, and from whom.
  Off by default. Off behind a proxy means one bucket for everybody; on without
  a trusted proxy means limits a caller can forge past. Neither is guessable
  from inside the process, so it is explicit.
- `QUORUM_RATE_LIMIT_SCALE` — one multiplier over every limit, for unusually
  large shared sources. `0` disables limiting for trusted private networks.

Counters are in-process fixed windows, which suits one SQLite file and one
container (ADR 0001). A blocked caller retrying does not extend their own
lockout, because behind a shared address that would turn a rate limit into a
denial of service against honest people.

Evidence:

- `apps/api/src/rate-limit.test.ts` — burst and sustained rules, window
  recovery, key and policy isolation, no lockout extension under hammering,
  bounded memory as keys churn, scaling, and configuration parsing. Three tests
  assert the shipped policies still fit a full room.
- `apps/api/src/routes.rate-limit.test.ts` — a room-creation flood refused with
  `429`, `rate_limited`, and a `Retry-After`; the daily cap holding at ten
  however long the attacker waits; four sessions polling one room from one
  address without starving each other; one session refused when it polls far
  beyond a real client; host mutations limited separately from participant
  joins; twenty people joining one room from one address; a full lobby polling
  an invite for a minute; health checks never limited, so a limit cannot look
  like an outage.
- `apps/web/src/hooks.ts` — a rate-limited poll backs off for five ticks and
  keeps the last good view rather than showing an error banner.

## 4 — Security headers and CSP — complete

[`apps/api/src/security-headers.ts`](../../apps/api/src/security-headers.ts)
sets the policy on every response, success or error.

Quorum's XSS exposure is genuinely small: React escapes text, display names
reject control and bidi characters, and there is no user-supplied HTML, URL,
template, or fetch target anywhere in the product. The policy still earns its
place, because the _value_ of an injection here is unusually high — the
capability tokens that are the entire authorization model sit in the URL and in
a cookie, and script on this origin can read one and use the other.

`script-src 'self'`, with no `unsafe-inline` and no `unsafe-eval`: the built
client is one module script and one stylesheet, both first-party, so a strict
script policy costs nothing. `style-src` does carry `'unsafe-inline'`, and only
for style _attributes_ — the swipe card's drag transform and the roster's
progress width, both numbers computed by our own code. CSP cannot distinguish an
attribute from an inline `<style>` block without hashing every value, so that is
the honest price of animating a card.

`img-src` names the poster CDN, because TMDB requires images be served from
their origin rather than mirrored. It lists both the base URL the importer
recorded and the documented default, so a refresh that moves the host cannot
blank every poster until the next restart. The policy is resolved once at boot
rather than per request, since only a catalog refresh can change it.

Also sent: `nosniff`, `referrer-policy: no-referrer` (a referrer is a token leak
to any third-party origin the page touches, starting with the poster CDN),
`X-Frame-Options: DENY` alongside `frame-ancestors 'none'`, both
cross-origin isolation headers, and a `permissions-policy` that turns off every
device capability Quorum does not use. HSTS is asserted only where cookies are
already `Secure`, so plain-HTTP `npm run dev` cannot pin a browser to HTTPS for
a year.

Evidence:

- `apps/api/src/security-headers.test.ts` — script policy with no inline or
  eval, the locked-down directives, the recorded and default image origins, an
  unparseable base URL ignored rather than emitted, headers present on both a
  success and a 404, and HSTS gated on `secure`.
- `npm run test:browser` — the full Playwright suite passes with the policy
  live, which is the check that matters for `style-src`.

## 5 — Scheduled expiry and operator purge — complete

Expiry was applied lazily on API requests. On a quiet instance that meant an
expired room — with its participants, exposures, and interactions — sat on disk
indefinitely, so the retention table in
[retention and abuse](../phase-0/retention-and-abuse.md) described something
nothing enforced.

[`apps/api/src/retention.ts`](../../apps/api/src/retention.ts) runs a sweep at
boot and every `QUORUM_RETENTION_SWEEP_MINUTES` (default 15). Lazy expiry
stays, because it is what guarantees a capability presented one second after
expiry is refused without waiting for a sweep. A failed sweep is logged and the
next one tries again; it never takes the server down, and the timer is
`unref`'d so it cannot hold the process open.

Retention now has two stages, matching the policy:

1. **Expire** — revoke capabilities, mark the room `EXPIRED`, keep the rows.
2. **Purge** — 24 hours later, delete the room outright. Every child table
   cascades from `rooms` and `foreign_keys` is on for every connection, so one
   delete takes participants, rounds, room items, exposures, interactions, and
   the room's audit events with it.

The tombstone between the two is deliberate: an expired link and a link that
never existed must be indistinguishable, including by timing.

`quorumctl purge` applies retention now; `quorumctl purge --room <roomId>`
deletes one room for an operator answering a deletion request, and requires
typing the room id back. It exits non-zero when the named room was not there,
because that is a failed instruction rather than a no-op. The audit row a purge
leaves behind is deliberately detail-free — recording which rooms were deleted
would outlive the deletion it records.

Evidence — `apps/api/src/retention.test.ts`:

- A room expired but not purged, then purged once its own window is up, with
  participants, exposures, and interactions gone with it.
- Retention applied with no request traffic at all, which is the case lazy
  expiry could not reach.
- A live room and its data untouched.
- A purge audit row that does not name the room it deleted.
- Single-room purge deleting one room and leaving the other, and reporting
  false rather than success for a room that was not there.
- The sweep running once immediately, so a restart applies retention at boot.
- Through the API: an expired link and a link that never existed return the
  same status and the same body.

## 6 — Self-hosting path — complete

The deployment shape assumed one operator: the author, on their own VM, behind
their own Cloudflare tunnel. A stranger following the runbook would have found
that `quorumctl start` with no `--tunnel` produces an application nothing can
reach — it publishes no port and sits on an `internal: true` network — and that
Cloudflare was effectively mandatory.

A second ingress shape now exists, built to the same isolation rule as the
first. Caddy runs inside the Compose project under a `proxy` profile, joins
`quorum-edge` to reach the application and a separate `proxy-egress` network to
reach the certificate authority, and terminates TLS with automatic
certificates. The application still publishes no port and still has no route to
the Internet. Its access log is switched off, because capability tokens are in
the URL path and a proxy log would put back exactly what
[`logging.ts`](../../apps/api/src/logging.ts) removes.

`quorumctl start` now takes `--tunnel` or `--proxy` — and, added after this
phase, `--existing-ingress` for a proxy the host already runs, which joins
`quorum-edge` from its own Compose project. It rejects an unrecognised flag
rather than silently starting an unreachable instance, and says plainly when
started with no ingress at all that it is serving nobody.

Publishing the application's port directly is documented as unsupported rather
than left to be discovered: `Secure` cookies are unconditional in production, so
over plain HTTP no session cookie is stored and nobody can vote.

[docs/self-hosting.md](../self-hosting.md) is the guide written for someone who
is not the author: what the AGPL and TMDB's terms actually oblige them to,
getting the files, the token secret, every ingress shape, importing a catalog,
routine operation, a full configuration reference for all 20-odd `QUORUM_*`
variables, and a troubleshooting section built from the failure modes this work
turned up. It has since been restructured to lead with the ordinary
copy-`.env.example`-and-`docker compose up` install, with the release bundle as
the option for a host that wants a checksum and a digest pin without doing them
by hand. `deploy/.env.example` and the bundle carry the same options, and the
bundle ships the licence, `SECURITY.md`, the proxy config, and this guide.

Evidence: `tests/operator/quorumctl.test.ts` covers both ingress flags, the
rejection of an unknown one, the no-ingress warning, and the purge command
including its typed confirmation. `docker compose config` validates with the
proxy profile active.

## 7 — Privacy notice and source offer — complete

Two things every deployment owes the people using it, and neither existed.

**The privacy notice.** `/privacy`, linked from the footer of every screen —
including the join screen, before anyone types a name. Written as plain
sentences rather than a policy, because the honest version is short: what is
stored (display name, votes, a room-scoped session cookie, room events), how
long it lasts, what is never collected, and who else sees anything. It states
the two things a self-hosted product cannot promise on the operator's behalf —
that deleting from the live service is not deleting from their backups, and
that the operator has access to the server — rather than implying otherwise.

**The source offer.** The AGPL asks that people interacting with a modified copy
over a network be offered its source. `GET /api/instance` reports the licence
and a source URL that defaults to upstream and is overridable with
`QUORUM_SOURCE_URL`, because a fork owes its users _its_ code, not this
repository's. When an operator sets it, the notice says so.

Evidence:

- `apps/api/src/instance.test.ts` — upstream default, operator override, an
  empty setting ignored, and the endpoint answering without a capability.
- `tests/browser/room.spec.ts` — the notice and the source link reachable from
  the footer, with the licence named on the page.

## 8 — Documents reconciled with reality — complete

The implementation plan still opened with "Phase 2 active, Phase 3 next" while
Phase 4's recommender was shipped and in the README. Documents that describe a
build two phases behind are worse than no documents, because they get trusted.

- **The plan** now carries an accurate status table, marks phases 2 and 3
  complete, records Phase 4 as code-complete with the pilot outstanding, and
  replaces a "next slice" listing work finished months ago with the six steps
  that actually remain — all of which need a real machine rather than more code.
  Completed phases keep their original text, because the reasoning is why the
  code looks the way it does; where implementation contradicted the plan, the
  contradiction is noted rather than edited away.
- **The README** status table matches, and states plainly that nothing has been
  proved on real infrastructure, no load test has been run, and backups are
  unencrypted with no restore drill performed.
- **Phase 2's document** closes out its two outstanding items: scheduled expiry
  landed here, and the wireframe-faithful progress view was deliberately not
  built — the roster grew progress bars instead.
- **The threat model** gains a table separating what is required from what is
  built, per threat ID, including the controls that are operator infrastructure
  rather than application code.
- **Retention and abuse** carries the real rate-limit numbers and why two of
  them moved.

## Verification

The full CI sequence, plus the container:

- `npm run format:check`, `npm run lint`, `npm run typecheck` — clean.
- `npm test` — 274 tests, 23 files, coverage 93.5% statements / 85.2% branches,
  above thresholds. The vitest timeout moved from the 5s default to 30s: these
  tests build real Fastify apps over real SQLite under v8 coverage, and a loaded
  machine was failing tests that were queued rather than slow. Assertions
  unchanged.
- `npm run test:browser` — 9 Playwright tests pass with the CSP and rate limits
  live.
- `npm run audit:prod`, `npm run licenses` — clean.
- `docker compose config` validates with every profile, and CI now validates
  the profiles too, since ingress services are invisible to the default check.
- The image builds, boots, and serves.

## Outstanding after this phase

Nothing from Phase 3. What remains before a first public release belongs to
Phase 4's pilot and Phase 5, and none of it is application code:

- No instance has run on real infrastructure. The Phase 1 exit gate — fresh host,
  pull by digest, no host port or socket or shared network, stop/start
  persistence, clean-volume restore — is certified locally only.
- The Phase 4 pilot has not happened: real phones, a real hostname, egress
  proved blocked from inside the serving container.
- No load test, so the "20 participants, 20 concurrent rooms" support target is
  an intention rather than a measurement.
- Backups are unencrypted, local, and undrilled.
- No accessibility audit or mobile-browser matrix.
- CI builds and scans the image but never runs it, which is exactly how a
  boot-failing image passed every check. Each lands here with its own evidence section as it completes.
