# Phase 2 — Local browser-testable MVP

Updated: 2026-08-14

Status: step 2a complete and playable in a browser. Step 2b is partially done;
outstanding items are listed at the end.

## Run it

```sh
npm ci
npm run build
npm run dev
```

`npm run dev` starts Fastify on port 3000 and Vite on port 5173 against a local
SQLite file at `.data/quorum.db`. Open <http://localhost:5173>, create a room,
then open the invite link in a second browser window or private window.

The development script sets `QUORUM_ALLOW_INSECURE_COOKIES=1` so session cookies
work over plain-HTTP localhost. That flag is ignored when `NODE_ENV=production`,
and `QUORUM_TOKEN_SECRET` is mandatory in production. In development the key is
generated once and stored beside the database as `dev-token-secret` with mode
`0600`, so rooms and sessions survive a restart.

## What exists

| Piece                                      | Where                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------- |
| Room schema (section 4 of the plan)        | `packages/database/migrations/0002_room_model.sql`                    |
| Ranking contract                           | `packages/ranking`, driven by `tests/contracts/ranking.examples.json` |
| Shared request/response schemas            | `packages/contracts`                                                  |
| Fixture catalog and seeded slate selection | `packages/catalog`                                                    |
| Capabilities, sessions, room rules         | `apps/api/src/capabilities.ts`, `apps/api/src/rooms/`                 |
| HTTP surface                               | `apps/api/src/routes.ts`                                              |
| Screens                                    | `apps/web/src/screens/`                                               |

## HTTP surface

| Method | Path                             | Caller                                 |
| ------ | -------------------------------- | -------------------------------------- |
| POST   | `/api/rooms`                     | anyone                                 |
| GET    | `/api/invites/:inviteToken`      | invite capability                      |
| POST   | `/api/invites/:inviteToken/join` | invite capability                      |
| GET    | `/api/host/:hostToken`           | host capability                        |
| POST   | `/api/host/:hostToken/join`      | host capability                        |
| GET    | `/api/rooms/:roomId`             | participant session or host capability |
| POST   | `/api/rooms/:roomId/start`       | host capability                        |
| POST   | `/api/rooms/:roomId/close`       | host capability                        |
| POST   | `/api/rooms/:roomId/expire`      | host capability                        |
| POST   | `/api/rooms/:roomId/swipe`       | participant session                    |
| GET    | `/api/rooms/:roomId/results`     | participant session or host capability |

Invite and host capabilities carry 256 bits of entropy and are stored only as
HMAC-SHA-256 hashes. Participant sessions are separate room-scoped capabilities
delivered in an `HttpOnly`, `SameSite=Lax` cookie named per room. Every failure
of a capability check — unknown, modified, expired, wrong room — answers the
same `404 {"error":"not_found"}` body.

## Structural security built now

- Separate invite and host capabilities, stored as keyed hashes only.
- Room-scoped anonymous sessions; a stolen cookie grants only that participant's
  remaining actions in that one room.
- Server-authoritative voting: results come from stored interactions, never from
  client totals, and stay hidden until the room is `COMPLETE`.
- Every mutation validates room state, membership, authorization, payload schema,
  and same-origin intent before touching data.
- Swipe confirmation is idempotent per exposure; a retry with the opposite choice
  conflicts instead of overwriting a confirmed vote.
- Display names are schema-validated: 1–40 characters, control and bidi
  overrides rejected.

Deferred to Phase 3 as planned: rate limits, Turnstile, CSP and security headers,
structured redacted logs, and caps beyond participants-per-room and body size.

## Evidence

`npm test` runs the unit and API-integration suites; `npm run test:browser` runs
the Playwright suite against the built server. Together they cover:

- The normative ranking examples and ranking properties (range, unanimity,
  non-response inflation, deterministic ties, coverage ordering).
- Two participants through a full 20-card room over HTTP, with matching results
  for both callers.
- Solo shortlist, early close arithmetic (25%, not 100%), hidden interim results.
- Idempotent retry, conflicting flip, reconnect resuming at the first
  unconfirmed card, and restart preserving confirmed votes.
- Uniform not-found for unknown, tampered, and expired capabilities; cross-room
  and cross-participant denial; participant attempting host actions.

Browser evidence (`tests/browser/room.spec.ts`, Chromium, 2026-08-14):

- Four participants in four isolated browser contexts plus a separate host page
  complete all 20 cards; every window shows the same top-ranked title, the same
  `100% (4/4)` arithmetic, and the `Match` badge, and no results appear while one
  participant is still voting.
- A refreshed participant resumes on the same unconfirmed card.
- Arrow keys vote identically to the Yes/No buttons.
- Host early close shows `25% (1/4)` with `25% answered` and no match.
- An invalid invite reveals nothing about room existence.

## Deployment note

The image now carries the fixture catalog and the new workspace packages, and
Compose passes a keyed secret through `QUORUM_TOKEN_SECRET_FILE`
(`deploy/secrets/token-secret`). `scripts/quorumctl start` refuses to run without
it. Rotating that secret invalidates every live invite, host link, and session.

## Not done yet

- Wireframe-faithful progress view and visual polish pass.
- Scheduled expiry job; today expiry is applied lazily on API requests.
- Everything explicitly deferred to Phase 3: rate limits, Turnstile, CSP and
  security headers, structured redacted logs, and the remaining hard caps.
