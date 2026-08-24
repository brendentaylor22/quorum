# TMDB accepted-use and attribution review

What TMDB's terms require of anyone importing a real catalog, and what Quorum
does about it. This repository records engineering interpretation, not legal
advice; the terms themselves are the authority, and they change.

## Decision

Quorum may use TMDB developer API only while project remains personal and non-commercial, registration is approved, then-current terms are accepted by authorized operator, and required attribution ships. Any revenue, paid access, advertising, business use, or ML/AI use of TMDB content stops import until written commercial permission is obtained.

Runtime catalog records may cache only fields needed by Quorum and must carry source/fetch timestamps. Refresh or delete TMDB content before six months. API credentials remain server-side. Test suite uses synthetic fixtures and never republishes a TMDB-derived dataset.

## Required UI attribution

About/Credits view must:

- show approved, unmodified TMDB logo less prominently than Quorum branding;
- link `TMDB` to `https://www.themoviedb.org`;
- prominently state: `This product uses the TMDB API but is not endorsed or certified by TMDB.`

Compare the exact notice against the then-current API terms before each release; the terms page currently uses slightly different wording from developer FAQ. Use wording satisfying current registration agreement.

## Reviewed official sources

- [TMDB getting started](https://developer.themoviedb.org/docs/getting-started): account API settings registration and agreement to terms before key issuance.
- [TMDB developer FAQ](https://developer.themoviedb.org/docs/faq): non-commercial developer use, logo and About/Credits attribution, required notice.
- [TMDB API terms](https://www.themoviedb.org/api-terms-of-use): non-commercial restriction without written agreement, attribution, six-month cache maximum, termination/purge duties, and prohibition on ML/AI use.

This repository records engineering interpretation, not legal advice.

## What an operator must do

Quorum ships no TMDB credential and cannot inherit one. If you import a real
catalog, the obligations are yours directly:

1. **Register.** Create a TMDB account, request API access, declare an accurate
   purpose, and accept the then-current terms. Quorum uses a **v4 read access
   token** as a bearer token.
2. **Stay inside non-commercial use.** No revenue, paid access, advertising, or
   business use of TMDB content without a written commercial agreement with
   them.
3. **Keep the credential server-side and in a file.** Compose mounts it at
   `/run/secrets/tmdb_read_access_token` and passes
   `TMDB_READ_ACCESS_TOKEN_FILE`, so it stays out of the process table,
   `docker inspect`, and log lines. No token belongs in a repository, issue,
   screenshot, CI log, image, fixture, or database export.
4. **Refresh before six months.** `doctor` and `catalog-status` exit non-zero
   once the catalog passes that limit, so staleness fails loudly rather than
   quietly breaching the cache limit.
5. **Ship the attribution above**, and never republish a TMDB-derived dataset —
   which includes publishing a database backup.

Keep your own record of when you accepted the terms and under what declared
purpose, without the credential value in it.
