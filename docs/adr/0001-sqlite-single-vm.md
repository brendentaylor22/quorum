# ADR-0001: SQLite for single-VM MVP

Status: Accepted  
Date: 2026-08-11

## Decision

Use SQLite in WAL mode for one application replica on one VM. Use forward-only migrations, narrow repositories, foreign keys, busy timeout, durable transaction confirmation, SQLite backup API, integrity checks, and clean-volume restore drills.

## Consequences

One stateful container and small operational surface suit MVP. WAL files forbid raw file-copy backups while live. Horizontal replicas and sustained write scale are unsupported. Move to PostgreSQL before either need; migration is explicit project work, not transparent scaling.

