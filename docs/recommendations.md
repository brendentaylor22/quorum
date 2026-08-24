# Group recommendations

How a room's second and later rounds are chosen.

## The loop

1. **Round 1** — 20 drawn at random from the best-rated slice of the catalog. No personalisation; see [catalog ingestion](catalog-ingestion.md).
2. **Results** — ranked exactly as before, per round.
3. **Keep voting** — the host may open another round. 20 more, chosen from what the group has already said.

Each round refreezes membership and gets its own `eligible_count`, so its percentages have their own honest denominator. Progress resets. Nothing the room has already judged can reappear — enforced by `UNIQUE (room_id, catalog_item_id)`, not merely by the query.

## What the data actually supports

A room yields roughly **twenty binary swipes per person**, and anonymous history is room-scoped by design, so there is no cross-room signal.

**Collaborative filtering is not viable and is not attempted.** The user–item matrix is twenty items wide and one room deep, and every member rated the _same_ twenty items. There is nothing to generalise from. That changes only if accounts and consented history arrive.

What twenty swipes _do_ support is a coarse, interpretable preference over tags. That is what this does.

## The method

**Per-participant profile.** For each tag — genre, keyword, decade, runtime band, language — accumulate likes and dislikes across the items that person judged:

```text
affinity(tag) = (likes − β·dislikes) / (likes + β·dislikes + prior)
```

`β` (0.6) counts a LEFT for less than a RIGHT, because "not tonight" is weaker evidence than "yes". `prior` (2) pulls thin evidence toward neutral, so one swipe on a rare tag does not read as certainty.

**Prediction.** A candidate's score for one person is the mean affinity over its tags, mapped onto [0, 1]. An item with no matching evidence scores **0.5, not 0** — unknown is not the same as unwanted.

**Group aggregation.** The interesting decision:

```text
score = w · mean(predictions) + (1 − w) · min(predictions)
```

`w` defaults to 0.7. Pure averaging (`w = 1`) happily includes a film one person clearly does not want. Pure least-misery (`w = 0`) picks nobody's favourite. The blend keeps a floor under the unhappiest member without flattening the slate.

**Diversity.** No more than half the slate may share a genre. Without it, a group that liked two action films gets twenty. If the cap starves the scored pass, it relaxes rather than returning a short slate.

**Exploration.** Five of the twenty slots are filled at random from the remaining candidates. This guards against overfitting twenty swipes and stops repeated rounds collapsing into a filter bubble. Exploration picks are labelled "Something different" rather than given an invented rationale.

**Determinism.** Every random choice — tie-breaks and exploration alike — comes from the round's persisted seed, never `Math.random`. The same inputs reproduce the same slate, which is what makes `algorithm_version` and replay meaningful.

## Why it is shaped this way

`@quorum/recommend` is pure: no I/O, no provider, no persistence. Items arrive described only by opaque namespaced tags such as `genre:28`. It does not know what a genre is.

Everything that decides _what a movie looks like_ lives in one file, [`apps/api/src/catalog/features.ts`](../apps/api/src/catalog/features.ts). That is deliberate, and it matters for the open question below: narrowing or replacing the feature set is a change to that file alone.

## Open question: TMDB's ML/AI restriction

[`docs/tmdb-use-review.md`](tmdb-use-review.md) records that TMDB's terms **prohibit ML/AI use of their content**.

Genres and keywords in the current feature set are TMDB-derived. Whether tag-counting of this kind falls inside that prohibition is a real question and needs an answer from the current terms, not from inference. It has not been resolved.

What is already true regardless:

- The **judgements** are the group's own swipes, not provider content.
- The scoring package holds no provider data and no provider concepts.
- Decade, runtime band, and language are factual attributes of a film rather than TMDB's editorial work; genre and keyword are the ones genuinely in question.

If the answer turns out to be no, the fallback is to drop `genre:` and `keyword:` tags from `catalogFeatures` — scoring then runs on decade, runtime, and language alone — and to source similarity from TMDB's own `/recommendations` endpoint, which is their inference rather than ours. Neither change touches `@quorum/recommend`.

Resolve this before the pilot goes anywhere near real use.

This repository records engineering interpretation, not legal advice.

## Tuning

Defaults live in `SelectOptions` and are all overridable per call:

| Option                | Default        | Effect                                                                     |
| --------------------- | -------------- | -------------------------------------------------------------------------- |
| `consensusWeight`     | `0.7`          | Toward 1 favours average utility; toward 0 favours the least happy member. |
| `explorationSlots`    | `5`            | Slots filled at random rather than by score.                               |
| `maxPerFacet`         | half the slate | Cap on items sharing a genre.                                              |
| `dislikeWeight`       | `0.6`          | How much a LEFT counts against a tag.                                      |
| `priorStrength`       | `2`            | Pull toward neutral for thin evidence.                                     |
| `enthusiasmThreshold` | `0.55`         | Prediction above which a member counts as a supporter.                     |

`RECOMMENDER_VERSION` is persisted on every recommended round as `rounds.algorithm_version`, so a change in any of this is visible in the data rather than silent.

## Not built

- **Offline evaluation.** The plan calls for comparing average utility, least-misery, and fairness-aware blends through replay before committing to one. The blend here is a reasoned default, not a measured winner. Real rooms would need to be replayed to choose properly.
- **Fairness across rounds.** Nothing yet tracks whether the same member is repeatedly outvoted over several rounds; a rotating priority would address it.
- **Series.** Movies only, as elsewhere.
