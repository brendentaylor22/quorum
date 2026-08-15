# Runtime secrets

Create `token-secret` here before the first start:

```sh
openssl rand -hex 32 > deploy/secrets/token-secret
chmod 0400 deploy/secrets/token-secret
```

The application keys every stored invite, host, and session hash with it. Rotating it invalidates every live room and session, so treat it as long-lived and back it up with the same care as the database.

Create `tunnel-credentials.json` here with mode `0440`, owned by deployment administrator and numeric group `65532` so non-root `cloudflared` can read it. Keep deployment directory accessible only to administrator. Directory and JSON files are ignored by Git.

## TMDB credential

Create `tmdb-read-access-token` holding the TMDB **v4 read access token** on a single line:

```sh
printf '%s' 'eyJhbGciOi...' > deploy/secrets/tmdb-read-access-token
chmod 0400 deploy/secrets/tmdb-read-access-token
```

Only the `catalog-refresh` service reads it, and only from the file — never from a command argument or a plain environment variable, so it stays out of the process table and out of `docker inspect`. The serving application never receives it and has no route to TMDB.

The token is a credential like any other: do not commit it, do not paste it into a log or issue, and rotate it in the TMDB dashboard if it is ever exposed. Everything in this directory except this README is ignored by Git.
