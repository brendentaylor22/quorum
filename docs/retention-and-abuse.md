# Data retention and abuse limits

## Retention

| Data                   | Active retention                  | Expiry action                                                          | Backup treatment                                        |
| ---------------------- | --------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| Lobby room             | 24 hours from creation            | Revoke tokens, mark expired, purge room data                           | Removed as backups age out                              |
| Completed/closed room  | 7 days from completion            | Revoke tokens, purge participants, exposures, interactions, room audit | Encrypted; maximum 30 days                              |
| Expired room tombstone | 24 hours                          | Delete                                                                 | Not restored into service                               |
| Security logs          | 14 days                           | Delete/rotate                                                          | Included only when needed for recovery; maximum 30 days |
| Catalog snapshot       | 6 months maximum after TMDB fetch | Refresh or delete                                                      | Same maximum applies                                    |

Display names and room actions are temporary operational data, not permanent profiles. No analytics SDK, ads, contact data, precise location, or cross-room identity in MVP. IP addresses may appear only in minimized security logs; application records truncated/pseudonymized source identifier when possible.

Purge deletes keyed token hashes, participants, room items, exposures, interactions, and room-specific audit events. Backup retention means the UI must say deletion from the live service does not immediately erase already-created backups. Restore reapplies expiry before serving traffic.

The backup column above is what the policy requires of an operator, not what Quorum automates: backups are written unencrypted and the encryption, off-host copy, and age-out are the operator's to arrange. See [operations](operations.md#backup-and-clean-volume-restore).

## Hard abuse limits

| Control                                         |                                                                                                                                 MVP limit |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------: |
| Participants per room                           |                                                                                                                                        20 |
| Slate items                                     |                                                                                                                                Exactly 20 |
| Active rooms per source per 24 hours            |                                                                                                                                        10 |
| Concurrent active rooms declared support target |                                                                                                                                        20 |
| Display name                                    |                                                             1–40 Unicode characters after trim; control/bidi override characters rejected |
| JSON request body                               |                                                                                                                                    16 KiB |
| Host/session token entropy                      |                                                                                                         At least 128 bits (issued at 256) |
| Invite phrase entropy                           | At least 77 bits — six words from a 7772-word list. Traded down from 128 so the link can be read aloud and retyped; see threat model T01a |
| Lobby lifetime                                  |                                                                                                                                  24 hours |
| Completed room lifetime                         |                                                                                                                                    7 days |

Application rate limits, enforced in `apps/api/src/rate-limit.ts`. Every operation carries a sustained rule and a burst rule, because one window cannot express both "five rooms an hour" and "not five rooms in five seconds".

| Operation                  |           Sustained |     Burst | Keyed by            |
| -------------------------- | ------------------: | --------: | ------------------- |
| Create room                | 5/hour, 10/24 hours |  2/minute | Source              |
| Join attempts              |            120/hour | 30/minute | Source              |
| Read invite or host link   |          600/minute | 30/second | Source              |
| Read room progress/results |           60/minute | 10/second | Participant session |
| Swipe confirmations        |          120/minute | 20/second | Participant session |
| Host mutations             |             20/hour |  5/minute | Host capability     |

The "10 active rooms per source per 24 hours" cap is enforced as ten _created_ rooms — stricter than the wording, and much simpler, since a source that creates ten rooms and expires them still waits.

### Why the keys differ, and why two of these numbers moved

Everyone in a Quorum room is usually on the same wifi. A limit keyed only on source address treats a household, a shared office, or a CGNAT carrier as one caller, so the limits that matter for a room have to be keyed more finely, or sized for twenty devices behind one address:

- **Room reads and swipes are charged to the participant session**, the finest capability available. Four phones polling the same room are four honest callers. A session is not free to mint, because joining is itself limited.
- **Joining is keyed by source**, so it was raised from 10/minute to 30/minute: filling a 20-person room from one household was impossible at the original figure.
- **Invite and host reads are keyed by source**, because the caller has no session yet, and sized for twenty join screens polling every three seconds — 400 honest requests a minute. This is a denial-of-service bound, not an anti-guessing control; guessing is answered by entropy (T01, T01a), not by rate limiting.

`QUORUM_TRUST_PROXY` decides whose address is believed. Left off behind a reverse proxy, every request appears to come from the proxy and one bucket serves everybody; turned on without a trusted proxy in front, a caller sets `X-Forwarded-For` themselves and every limit becomes decorative. It defaults to off and is an operator obligation. See [self-hosting](self-hosting.md).

`QUORUM_RATE_LIMIT_SCALE` multiplies every limit for deployments behind an unusually large shared source. `1` is this table. `0` disables limiting entirely and is only defensible where every caller is already trusted.

Counters are in-process fixed windows: one SQLite file, one container, no Redis (ADR 0001). A restart forgets them, which is acceptable because an attacker who can restart the process has already won.

Invalid and expired capabilities use the same status, response shape, and comparable work. Turnstile is **not** implemented: it is a Cloudflare-coupled control, and Quorum supports deployments with no Cloudflare in the path. Operators who do front Quorum with Cloudflare can enable it at the edge without the application knowing.
