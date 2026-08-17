# Catalog ingestion

How real movies get into Quorum, and the obligations that come with them.

Scope: this covers the **first 20** — the round-one slate drawn at random from the best-rated slice of the catalog. Recommendation-driven later rounds are not built yet; see [Open questions](#open-questions-for-the-recommender) for a constraint that affects them.

## Why a local snapshot, not live polling

The application container joins only `quorum-edge`, which is `internal: true`. It has **no route to the Internet at all**, and the Phase 4 exit gate tests exactly that. A live TMDB call from the request path would dismantle it.

Three further reasons:

- **Slate selection is a set scan.** Picking 20 from the top 500 is `ORDER BY weighted_rating DESC LIMIT` over a local table — milliseconds. It is not expressible as an API call.
- **Determinism.** A room persists `slate_seed` and `catalog_version`; replay only works if the candidate pool is frozen. TMDB ratings drift daily.
- **Availability.** A TMDB outage must not stop a room. It cannot, because serving never touches TMDB.

## Topology

```text
docker compose --profile refresh run --rm catalog-refresh
   |
   +-- joins quorum-catalog-egress (Internet) — never quorum-edge
   +-- mounts quorum-data volume
   +-- reads /run/secrets/tmdb_read_access_token
```

The refresh container is short-lived and stopped in normal operation. The serving app keeps zero egress in both states.

## The pipeline

1. `/discover/movie`, sliced **one release year at a time**, descending from the present. TMDB refuses to page past 500 pages (10,000 results), so an unsliced sweep silently truncates. Slicing keeps each query well inside the cap; anything still over is reported via `truncatedYears` in the report rather than vanishing.
2. `/movie/{id}?append_to_response=keywords,credits,release_dates` — one call per movie, carrying genres, keywords, cast/crew, and certification. Genres and keywords are stored now even though only the recommender will use them, because backfilling them later means a second full sweep.
3. Quality bar: released, non-adult, non-video, has poster, synopsis, language, plausible release year, runtime, and at least `QUORUM_CATALOG_MIN_VOTES` votes. Rejections are counted by reason in the report.
4. **Bayesian weighted rating** across the accepted pool:

   ```text
   score = (v/(v+m)) * R + (m/(v+m)) * C
   ```

   A raw average lets a 9.5 from twelve votes outrank a classic. This pulls thin records toward the pool mean until they have earned their score.

   `m` is **not** the inclusion threshold — they answer different questions. Inclusion asks "is this film rated at all?"; ranking asks "do I trust this average against an all-time list?". Measured against the real 7,088-film catalog, a low `m` put three 2026 releases in the all-time top twelve, one of them on 2,098 votes. At `m = 3000` that inflation disappears and the head of the list is Shawshank, The Godfather, The Dark Knight. At `m = 8000` older classics start being over-penalised. Tunable via `QUORUM_CATALOG_RATING_PRIOR`.

5. One transaction: upsert every row, relink taxonomy, flip `catalog_versions.is_current`, and set `active = (catalog_version = new)`.

The entire network phase — the slow part — holds **no database lock**. Rows are only written once the whole catalog is known good, so a reader sees the old catalog right up until it sees the new one, never a mixture. A failure at any point before the commit leaves the previous catalog serving untouched.

## Retiring, not deleting

`room_items.catalog_item_id` is a foreign key. A movie that drops out of a later import is marked `active = 0`, never deleted — deleting it would break an in-flight room and rewrite historical results.

Retired rows are collected later by the cache-limit purge (below), and only when no room references them.

## Running it

First import, then check:

```sh
docker compose --profile refresh run --rm catalog-refresh
docker compose run --rm app node apps/api/dist/cli.js catalog-status
```

A full first import of ~13,000 movies takes roughly 10–15 minutes, dominated by one detail call per movie at a deliberately polite ~20 req/s.

### Configuration

| Variable                      | Default      | Meaning                                                                                                                          |
| ----------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `TMDB_READ_ACCESS_TOKEN_FILE` | —            | Path to the v4 read access token. Required.                                                                                      |
| `QUORUM_CATALOG_MIN_VOTES`    | `600`        | Vote floor. Below a few hundred, a rating is mostly noise.                                                                       |
| `QUORUM_CATALOG_FIRST_YEAR`   | `1930`       | Oldest release year swept.                                                                                                       |
| `QUORUM_CATALOG_LAST_YEAR`    | current year | Newest release year swept.                                                                                                       |
| `QUORUM_CATALOG_MAX_ITEMS`    | `30000`      | Ceiling on accepted items. Discovery is newest-first, so hitting it drops the oldest films; the report flags `cappedAtMaxItems`. |
| `QUORUM_CATALOG_CONCURRENCY`  | `12`         | Parallel detail fetches.                                                                                                         |
| `QUORUM_CATALOG_LANGUAGES`    | any          | Comma-separated allowed original languages.                                                                                      |
| `QUORUM_CATALOG_REGIONS`      | `GB,US`      | Certification regions, in preference order.                                                                                      |
| `TMDB_BASE_URL`               | TMDB         | Test-only override for pointing at a local stub.                                                                                 |

## Do not refresh on startup

Tempting, and wrong:

- The app container has no egress, so it structurally cannot.
- A TMDB outage would delay or block startup, exactly when you want to pick a film.
- It buys nothing. A movie needs `vote_count >= 300` to enter the pool, which takes weeks to months after release. A "top movies of all time" set is close to static.

Instead the refresh is deliberate, and staleness is made visible: `catalog-status` and `doctor` both report `ageDays`, and both exit non-zero when the catalog is empty or past the cache limit.

## TMDB obligations

Reviewed in [`docs/phase-0/tmdb-use-review.md`](../phase-0/tmdb-use-review.md). What the code enforces:

- **Credential handling.** Read from a file into a bearer header. It never reaches a URL, so it cannot leak through a log line, proxy record, or error message. `redactUrl` masks secret-shaped query parameters defensively. Tests assert the token appears in neither the request URL nor the retry callback.
- **Attribution.** `GET /api/catalog` returns the provider actually installed and the notice it requires; the client renders that rather than a hard-coded string, so a fixture build never claims to be showing TMDB data. The footer carries the notice and links to themoviedb.org.
- **Images from the TMDB CDN.** Only `poster_path` is stored, never the image itself. The importer records `secure_base_url` and a bounded poster size from `/configuration` onto the catalog version, because the serving application has no egress and cannot ask. The server then hands the client a finished URL, so posters always come from TMDB and the client holds no provider URL scheme. If `/configuration` is unavailable the import still succeeds and the UI falls back to a placeholder tile.
- **Rate limits.** Token bucket at ~20 req/s with `Retry-After` honoured and full-jitter backoff.
- **Six-month cache maximum.** `purgeRetiredCatalogItems` deletes retired provider content older than `TMDB_CACHE_MAX_DAYS` (180) that no room references, and it runs at the end of every refresh. `catalog-status` exits non-zero once the current catalog passes the limit, so a stale install fails loudly instead of quietly breaching the terms.
- **Non-commercial only.** Any revenue, advertising, or business use stops import until written permission exists.
- **Never publish a database backup.** Backups contain bulk TMDB metadata; distributing one crosses into redistribution. `backups/` and `*.db` are gitignored — keep it that way.

### Outstanding

- The TMDB **logo** is not yet shipped in an About/Credits view. The review requires the approved, unmodified logo shown less prominently than Quorum branding. The text notice and link are in place; the logo asset is not.
- The review notes TMDB's terms page and developer FAQ word the required notice slightly differently. The wording used here matches the FAQ. Confirm against the current registration agreement before the pilot.

## Open questions for the recommender

The review records that TMDB's terms **prohibit ML/AI use of their content**. Content-based recommendation over TMDB genres and keywords may fall inside that prohibition depending on how it is read. This needs an explicit answer — from the current terms, not from inference — before recommendation-driven rounds are built, since the whole design assumed those fields as its feature source. If the answer is no, the fallback is group aggregation over the room's own swipe data plus TMDB's own `/recommendations` endpoint, which is their inference rather than ours.

This repository records engineering interpretation, not legal advice.
