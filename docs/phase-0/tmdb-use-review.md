# TMDB accepted-use and attribution review

Review date: 2026-08-11

Status: policy reviewed; developer registration approved and terms accepted.

## Decision

Quorum may use TMDB developer API only while project remains personal and non-commercial, registration is approved, then-current terms are accepted by authorized operator, and required attribution ships. Any revenue, paid access, advertising, business use, or ML/AI use of TMDB content stops import until written commercial permission is obtained.

Runtime catalog records may cache only fields needed by Quorum and must carry source/fetch timestamps. Refresh or delete TMDB content before six months. API credentials remain server-side. Test suite uses synthetic fixtures and never republishes a TMDB-derived dataset.

## Required UI attribution

About/Credits view must:

- show approved, unmodified TMDB logo less prominently than Quorum branding;
- link `TMDB` to `https://www.themoviedb.org`;
- prominently state: `This product uses the TMDB API but is not endorsed or certified by TMDB.`

Before Phase 3, compare exact notice against then-current API terms; terms page currently uses slightly different wording from developer FAQ. Use wording satisfying current registration agreement.

## Reviewed official sources

- [TMDB getting started](https://developer.themoviedb.org/docs/getting-started): account API settings registration and agreement to terms before key issuance.
- [TMDB developer FAQ](https://developer.themoviedb.org/docs/faq): non-commercial developer use, logo and About/Credits attribution, required notice.
- [TMDB API terms](https://www.themoviedb.org/api-terms-of-use): non-commercial restriction without written agreement, attribution, six-month cache maximum, termination/purge duties, and prohibition on ML/AI use.

This repository records engineering interpretation, not legal advice.

## Operator registration evidence

Recorded without credential values:

```text
TMDB account owner: brenden.taylor22
Application name: Quorum
Application URL: https://github.com/brendentaylor22/quorum
Purpose declared: personal, non-commercial group movie voting
Terms accepted on: 2026-08-11
Registration approved on: 2026-08-11
Credential type: TMDB API Read Access Token used as a Bearer token
Local secret location: ignored .env as TMDB_READ_ACCESS_TOKEN
Production secret location: dedicated VM Docker secret mounted at /run/secrets/tmdb_read_access_token
Reviewer: brenden.taylor22
```

Local `.env` use is development-only. Production must mount a read-only secret
file instead of placing token in container environment, where inspection can
expose it. No API token belongs in repository, issue, screenshot, CI log,
image, fixture, or database export.
