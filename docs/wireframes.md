# Mobile-first wireframes

Wireframes define information and action hierarchy, not visual style. They are
the original sketches, kept because they record what each screen owes the
person reading it; where the built product diverged, the code is the decision.
The one divergence worth naming is Progress below: rather than a screen of its
own to navigate to, per-participant progress became bars on the roster, inside
the screen people are already looking at.

## Create

```text
┌──────────────────────────┐
│ QUORUM                    │
│ Pick tonight's movie     │
│                          │
│ Your display name        │
│ [ Brenden____________ ]  │
│                          │
│ [ Create room ]          │
│                          │
│ Private links. No account│
└──────────────────────────┘
```

Success replaces form with copy/share invite URL and separate copy host-control URL. Host-control URL gets stronger warning: never share it.

## Lobby

```text
┌──────────────────────────┐
│ Room ready          Host │
│ 3 people joined          │
│                          │
│ ● Brenden (you)          │
│ ● Sam                    │
│ ● Jo                     │
│                          │
│ [ Share invite ]         │
│ [ Start with 3 people ]  │
│                          │
│ Starting locks members   │
│ and chooses 20 movies.   │
└──────────────────────────┘
```

Participant sees joined list and `Waiting for host`; no host actions.

## Swipe

```text
┌──────────────────────────┐
│ 7 of 20            Quorum│
│ ┌──────────────────────┐ │
│ │       poster         │ │
│ └──────────────────────┘ │
│ Fixture Movie 07 · 2020 │
│ PG-13 · 108 min         │
│ Short synopsis…         │
│                          │
│ [ No ]          [ Yes ] │
│ ← / swipe       → / swipe│
└──────────────────────────┘
```

Control disables while confirmation is in flight. Failure leaves same card visible and offers retry. Optimistic motion never claims confirmation.

## Progress

```text
┌──────────────────────────┐
│ Votes submitted          │
│ You're done: 20 of 20 ✓  │
│                          │
│ Group progress           │
│ Ali           20 / 20 ✓  │
│ Sam           20 / 20 ✓  │
│ Jo            16 / 20    │
│                          │
│ Results unlock when all  │
│ finish. Choices stay     │
│ private.                 │
│                          │
│ Host: [ Close early ]    │
└──────────────────────────┘
```

Progress exposes counts, never per-movie choices or interim scores.

## Results

```text
┌──────────────────────────┐
│ Tonight's results        │
│ Voting complete · 3/3    │
│                          │
│ #1 Fixture Movie 04      │
│ MATCH · 100% (3/3)       │
│ Coverage 100%            │
│                          │
│ #2 Fixture Movie 12      │
│ 67% (2/3) · Coverage 100%│
│                          │
│ #2 Fixture Movie 19      │
│ 67% (2/3) · Coverage 100%│
└──────────────────────────┘
```

Early-close banner states incomplete voting. Shared ties show same rank. Solo banner explains result is personal shortlist.
