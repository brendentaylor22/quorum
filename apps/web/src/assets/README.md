# Third-party brand assets

## `tmdb-primary-short.svg`

The "Primary short (blue)" TMDB logo, taken unmodified from TMDB's own
[Logos & Attribution](https://www.themoviedb.org/about/logos-attribution) page.

|           |                                                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Source    | `https://www.themoviedb.org/assets/2/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg` |
| Retrieved | 2026-08-18                                                                                                                        |
| SHA-256   | `8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c`                                                                |

TMDB serves these assets under a digest-named URL, so the hash above is
verifiable against the source rather than being a claim this repository makes
about itself:

```sh
shasum -a 256 apps/web/src/assets/tmdb-primary-short.svg
```

The digest in the filename upstream is that same hash. If they ever disagree,
the file here has been altered and must be replaced from source.

### Terms this file is used under

TMDB's terms of use require attribution wherever their data or images appear,
and require the logo be shown unmodified and less prominently than the branding
of the application using it. Concretely, in Quorum:

- **Do not recolour, rotate, crop, stretch, or add effects to it.** Any styling
  beyond a proportional size constraint is a modification.
- **It stays smaller than the Quorum wordmark** and lives in the credits
  section of the privacy page, never in the app header.
- **It is only rendered when a TMDB catalogue is actually installed.** A
  fixture-only instance shows no TMDB branding, because it uses no TMDB data.

This asset is TMDB's property and is not covered by Quorum's AGPL licence.
See [docs/phase-0/tmdb-use-review.md](../../../../docs/phase-0/tmdb-use-review.md).
