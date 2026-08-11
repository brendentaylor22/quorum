# ADR-0003: Cloudflare Tunnel ingress

Status: Accepted  
Date: 2026-08-11

## Decision

Expose Quorum through outbound-only Cloudflare Tunnel. Application joins internal `quorum-edge` network with no host-published port. `cloudflared` alone joins tunnel egress and application edge network. Trust Cloudflare client headers only after request traverses configured tunnel path.

## Consequences

No router port-forward or public origin listener. Cloudflare becomes ingress dependency and privacy subprocessor. Tunnel outage blocks new access but existing data remains intact. Origin firewall and network isolation still required; tunnel is not workload isolation.

