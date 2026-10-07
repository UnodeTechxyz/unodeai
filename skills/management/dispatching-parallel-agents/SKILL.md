---
name: dispatching-parallel-agents
description: Use when coordinating multiple agents on independent work that can safely run in parallel.
---

# Dispatching parallel agents

Parallelism is useful only when ownership is explicit.

Procedure:

1. Split the work by independent vertical slices, not by vague effort.
2. Assign each agent a non-overlapping file or module ownership set.
3. Give every agent the same public contracts, acceptance criteria, and verification expectations.
4. Use blocking delegation for dependent tasks; use async delegation only for independent slices.
5. Collect results, then run the project-level verification that catches cross-slice breakage.
6. Route failures to the owner of the broken contract or file. Do not let implementers review their own work.

If you cannot define non-overlapping ownership, do not parallelize.
