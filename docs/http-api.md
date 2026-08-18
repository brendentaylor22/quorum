# HTTP surface

Every route the server answers, and what has to be presented to reach it. The
normative request and response schemas are
[`packages/contracts`](../packages/contracts/src/index.ts), which the client
imports directly; this table is the map, not the contract.

## Rooms

| Method | Path                             | Caller                                  |
| ------ | -------------------------------- | --------------------------------------- |
| POST   | `/api/rooms`                     | anyone (unless room creation is closed) |
| GET    | `/api/invites/:inviteToken`      | invite capability                       |
| POST   | `/api/invites/:inviteToken/join` | invite capability                       |
| GET    | `/api/host/:hostToken`           | host capability                         |
| POST   | `/api/host/:hostToken/join`      | host capability                         |
| GET    | `/api/rooms/:roomId`             | participant session or host capability  |
| POST   | `/api/rooms/:roomId/start`       | host capability                         |
| POST   | `/api/rooms/:roomId/close`       | host capability                         |
| POST   | `/api/rooms/:roomId/expire`      | host capability                         |
| POST   | `/api/rooms/:roomId/swipe`       | participant session                     |
| POST   | `/api/rooms/:roomId/continue`    | host capability                         |
| GET    | `/api/rooms/:roomId/results`     | participant session or host capability  |

`POST /api/rooms` answers `403` when `QUORUM_ROOM_CREATION` is not `public`;
rooms are then minted with the `create-room` CLI command instead.
`/continue` opens the next round from a completed room.

## Unauthenticated

| Method | Path            | Purpose                                              |
| ------ | --------------- | ---------------------------------------------------- |
| GET    | `/api/catalog`  | Catalog source and attribution, for the footer.      |
| GET    | `/api/instance` | Licence and source URL, for the AGPL source offer.   |
| GET    | `/health/live`  | Process is up.                                       |
| GET    | `/health/ready` | Database reachable and migrated. Never rate limited. |

Health checks are never rate limited, so a limit can never look like an outage.

## How authorization works

Invite and host capabilities carry 256 bits of entropy — the invite phrase is
six diceware words, ~77.5 bits, and the reasoning for that reduction is in the
[threat model](threat-model.md) as T01a. All of them are stored only as
HMAC-SHA-256 hashes, so a database read yields no working link.

Participant sessions are separate room-scoped capabilities delivered in an
`HttpOnly`, `SameSite=Lax` cookie named per room. Host control travels in a
header, not a cookie.

Every failure of a capability check — unknown, modified, expired, wrong room —
answers the same `404 {"error":"not_found"}`. Unauthorized, unknown, and expired
are indistinguishable from outside, including by timing.

Beyond authorization, every mutation validates room state, membership, payload
schema, and same-origin intent before touching data. Swipe confirmation is
idempotent per exposure: a retry with the same choice succeeds, a retry with the
opposite choice conflicts, because confirmed votes are immutable. Display names
are schema-validated at 1–40 characters with control and bidi overrides
rejected.

Rate limits, and which key each one is charged to, are in
[retention and abuse](retention-and-abuse.md).
