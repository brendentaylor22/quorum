# Runtime secrets

Create `tunnel-credentials.json` here with mode `0440`, owned by deployment administrator and numeric group `65532` so non-root `cloudflared` can read it. Keep deployment directory accessible only to administrator. Directory and JSON files are ignored by Git. Never place TMDB credentials here until Phase 3 catalog import exists.
