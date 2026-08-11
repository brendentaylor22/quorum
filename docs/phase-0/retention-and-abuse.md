# Data retention and abuse limits

Updated: 2026-08-11

## Retention

| Data | Active retention | Expiry action | Backup treatment |
|---|---|---|---|
| Lobby room | 24 hours from creation | Revoke tokens, mark expired, purge room data | Removed as backups age out |
| Completed/closed room | 7 days from completion | Revoke tokens, purge participants, exposures, interactions, room audit | Encrypted; maximum 30 days |
| Expired room tombstone | 24 hours | Delete | Not restored into service |
| Security logs | 14 days | Delete/rotate | Included only when needed for recovery; maximum 30 days |
| Catalog snapshot | 6 months maximum after TMDB fetch | Refresh or delete | Same maximum applies |

Display names and room actions are temporary operational data, not permanent profiles. No analytics SDK, ads, contact data, precise location, or cross-room identity in MVP. IP addresses may appear only in minimized security logs; application records truncated/pseudonymized source identifier when possible.

Purge deletes keyed token hashes, participants, room items, exposures, interactions, and room-specific audit events. Backup retention means UI must say deletion from live service does not immediately erase already-created backups. Restore process reapplies expiry before serving traffic.

## Hard abuse limits

| Control | MVP limit |
|---|---:|
| Participants per room | 20 |
| Slate items | Exactly 20 |
| Active rooms per source per 24 hours | 10 |
| Concurrent active rooms declared support target | 20 |
| Display name | 1–40 Unicode characters after trim; control/bidi override characters rejected |
| JSON request body | 16 KiB |
| Invite/host/session token entropy | At least 128 bits |
| Lobby lifetime | 24 hours |
| Completed room lifetime | 7 days |

Initial application rate limits, enforced per trusted client source plus room/capability where available:

| Operation | Limit | Burst |
|---|---:|---:|
| Create room | 5/hour | 2/minute |
| Join attempts | 30/hour | 10/minute |
| Swipe confirmations | 120/minute | 20/second |
| Read progress/results | 60/minute | 10/second |
| Host mutations | 20/hour | 5/minute |

Invalid and expired capabilities use same status, response shape, and comparable work. Repeated create/join abuse escalates to Turnstile at ingress. Limits are configuration with secure maximums; loosening production values needs recorded load/abuse evidence.

