---
name: writing-implementation-plans
description: Use when an approved design must become an ordered implementation plan for one or more agents.
---

# Writing implementation plans

Create plans that are executable by another agent without extra context.

Plan shape:

1. Objective and non-goals.
2. Preconditions and assumptions.
3. Ordered tasks, each with exact files or modules to inspect/change.
4. Acceptance criteria per task.
5. Verification commands and expected signals.
6. Rollback or cleanup notes for risky changes.
7. Review focus: what the reviewer should attack first.

Keep steps small and sequenced. If tasks can run in parallel, state the non-overlapping file ownership. If two
tasks need the same file, sequence them rather than creating a merge fight.
