# ADR-0004: Dedicated VM isolation

Status: Accepted  
Date: 2026-08-11

## Decision

Run production pilot on dedicated VM with separate guest kernel/disk, administrator identity, firewall, secrets, Compose project, and backups. Mount no media-server data; expose no Docker socket; join no unrelated network. Deny LAN and Internet egress except documented administration, Cloudflare, DNS/NTP, GHCR pulls, and controlled catalog refresh paths.

## Consequences

VM provides stronger workload boundary than containers sharing media-server kernel and daemon. Cost is separate patching, backup, monitoring, and resource allocation. Same-host container deployment may be temporary development fallback only and must never be described as equivalent isolation.

