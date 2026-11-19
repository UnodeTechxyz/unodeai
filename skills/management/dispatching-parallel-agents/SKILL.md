---
name: dispatching-parallel-agents
description: Use when coordinating multiple agents on independent work that can safely run in parallel.
---

# Dispatching parallel agents

Parallelism is useful only when ownership is explicit.

Procedure:

1. Split the work by independent vertical slices, not by vague effort.
2. Give each task a non-overlapping file or module write scope.
3. Give every task the same public contracts, acceptance criteria, and verification expectations.
4. Dispatch the independent tasks together with `dispatch_task`, then end your turn. There is no blocking wait:
   when a teammate's result arrives, the host wakes you with it. For dependent work, dispatch the first stage,
   end your turn, and dispatch the next stage when its result wakes you.
5. When a teammate asks a question about its running task, answer it with `reply_to_task`, using the handle and
   exchange_id that the wake shows.
6. When a result arrives, check its evidence against the acceptance criteria: what changed, what was run and what
   it returned. Then record your decision with `record_task_disposition`: `accepted`, or `needs-rework` with the
   concrete reason, or another disposition with its reason.
7. Run `run_checks` only when the team has a configured check. Run it after the slices are in, to catch
   cross-slice breakage, and route a failure to the owner of the failing file. Without a configured check, rely
   on the evidence each result carries and say so.
8. Have the work reviewed by a teammate who did not implement it. Do not let implementers review their own work.

If you cannot define non-overlapping ownership, do not parallelize.
