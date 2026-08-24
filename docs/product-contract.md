# Product contract

## Actors and capabilities

- Host creates room. Server returns separate invite and host-control URLs.
- Participant joins through invite URL, chooses temporary display name, and receives room-scoped session cookie.
- Host-control capability can start, close, or expire room. Participant capability cannot.
- URLs and session tokens contain at least 128 bits of server-generated entropy. Database stores keyed hashes only.

## Invariants

- Room has exactly 20 persisted slate items before voting begins.
- `LOBBY -> VOTING` freezes participant membership, eligible count, catalog version, slate order, and seed.
- Each frozen participant receives one exposure per slate item and may confirm one `LEFT` or `RIGHT` interaction per exposure.
- Retry with same exposure and same choice succeeds idempotently. Retry with opposite choice conflicts; confirmed votes are immutable in MVP.
- Server advances only after transaction commits. Client state is never scoring authority.
- Results stay hidden during voting.
- Voting completes when every frozen participant confirms all 20 interactions, or host closes early.
- Solo room follows identical rules.

## Room lifecycle

```text
                host starts
   LOBBY ------------------------> VOTING
     |                               |
     | host expires                  | all complete or host closes
     v                               v
  EXPIRED <---------------------- COMPLETE
             retention expires
```

Allowed transitions:

| From     | Event                   | To       | Required effect                                    |
| -------- | ----------------------- | -------- | -------------------------------------------------- |
| LOBBY    | host starts             | VOTING   | Freeze members and exact 20-item slate atomically  |
| LOBBY    | host expires            | EXPIRED  | Revoke capabilities; schedule purge                |
| VOTING   | all participants finish | COMPLETE | Set completion timestamp; reveal canonical results |
| VOTING   | host closes             | COMPLETE | Preserve non-responses; reveal canonical results   |
| COMPLETE | retention expires       | EXPIRED  | Revoke capabilities; purge on schedule             |

No reverse transition exists. Invalid transition returns uniform conflict response without leaking room state to unauthorized callers.

## Ranking contract

For each movie `m`:

```text
eligible(m)      = frozen participant count
yes(m)           = confirmed RIGHT interactions
responses(m)     = confirmed LEFT + RIGHT interactions
approval_pct(m)  = 100 * yes(m) / eligible(m)
coverage_pct(m)  = 100 * responses(m) / eligible(m)
match(m)         = eligible(m) > 0 AND yes(m) == eligible(m)
```

Precondition: room cannot start with zero participants, so `eligible(m) >= 1`.

Sort by approval percentage descending, then response coverage descending. Equal values receive shared competition rank (`1, 2, 2, 4`). Stable presentation order for equal scores uses persisted slate position but does not change rank.

Percentages display as whole numbers in MVP. Exact numerator and denominator always display beside percentage, avoiding rounding ambiguity. Non-response remains denominator after early close.

[Machine-readable examples](../tests/contracts/ranking.examples.json) are normative. If prose and examples conflict, one change must update both.

## Completion and reconnect

- Swipe response includes durable confirmation plus next exposure ID.
- Refresh uses session cookie to return first unconfirmed exposure in persisted slate order.
- Twentieth confirmed swipe makes participant complete.
- Last required interaction makes room complete in same database transaction or through idempotent post-commit reconciliation.
- Stolen participant cookie grants only that participant's remaining room actions; it never grants host control, other participant state, or cross-room access.

## Accessibility contract

- Every swipe action has visible `No` and `Yes` buttons.
- Keyboard: `ArrowLeft` selects No, `ArrowRight` selects Yes; confirmation semantics match buttons.
- Focus order, labels, status announcements, contrast, and reduced-motion behavior do not depend on gesture support.
- Destructive host actions require explicit confirmation and remain separate from participant controls.
