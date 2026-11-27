---
name: recent-activity-scan
description: Use when the task itself depends on recent history, such as continuing interrupted work, taking over a handed-off task, or answering what changed recently. Not a step to run before every task.
---

# Recent activity scan

Use this only when the next step depends on recent history: continuing interrupted or handed-off work, resuming
after a break, or a question about what changed recently. Do not run it before every task, and a lead does not run
it before dispatching: a lead dispatches first, and the teammate reads what its task needs.

Procedure:

1. Start with what you already have: the conversation, the task you were given and any results it names. Stop
   here if that answers the question.
2. If more is needed, read only the sources the task points to: the nearest task card, design note or review
   result, and, in a Git project, the current status and the recent commits that touch the files in scope.
3. Separate intentional work from obvious temporary output in the files changed in scope.
4. Summarize only the facts that change your next step: current branch, dirty files in scope, known blockers,
   and the next requested action.
5. If history conflicts, prefer the latest explicit user instruction and say what you are assuming.

This is a context-recovery habit, not an excuse to wander the repo. Stop scanning once you know enough to act.
