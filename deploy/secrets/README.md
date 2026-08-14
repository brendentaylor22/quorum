# Runtime secrets

Create `token-secret` here before the first start:

```sh
openssl rand -hex 32 > deploy/secrets/token-secret
chmod 0400 deploy/secrets/token-secret
```

The application keys every stored invite, host, and session hash with it. Rotating it invalidates every live room and session, so treat it as long-lived and back it up with the same care as the database.

Create `tunnel-credentials.json` here with mode `0440`, owned by deployment administrator and numeric group `65532` so non-root `cloudflared` can read it. Keep deployment directory accessible only to administrator. Directory and JSON files are ignored by Git. Never place TMDB credentials here until Phase 3 catalog import exists.
