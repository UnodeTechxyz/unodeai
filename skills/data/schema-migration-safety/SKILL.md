---
name: schema-migration-safety
description: Validate database schema changes for backward compatibility and safe rollout. Use when you need a repeatable schema-migration-safety procedure while planning, building, or reviewing work.
---

# Schema Migration Safety

Review a database schema change for safe rollout:
1. **Additive first**: new columns/tables should be nullable or have sensible defaults; never drop a column in the same deploy that stops writing it.
2. **Backward compatibility**: the old application version must still run against the new schema until all instances are rolled out.
3. **Index strategy**: new indexes are created `CONCURRENTLY` in Postgres to avoid table locks; verify index usage with `EXPLAIN`.
4. **Data migration**: if data must be backfilled, do it in batches with a resumable script and idempotency checks.
5. **Rollback**: ensure the migration can be reversed or that a compensating migration is ready before deploy.

Output: a migration risk assessment with safe/unsafe steps and suggested ordering.
