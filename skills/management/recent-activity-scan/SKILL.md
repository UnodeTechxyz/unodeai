---
name: recent-activity-scan
description: Use when joining an existing project or taking over a task where recent local activity may matter.
---

# Recent activity scan

Before asking the user to repeat context, inspect the project breadcrumbs that are already available.

Procedure:

1. Check the current git status and the most recent relevant docs/task cards when available.
2. Identify files changed in the active worktree and separate intentional work from obvious temporary output.
3. Read the nearest task card, design note, or review result before acting on a handed-off request.
4. Summarize only the facts that change your next step: current branch, dirty files in scope, known blockers,
   and the next requested action.
5. If history conflicts, prefer the latest explicit user instruction and say what you are assuming.

This is a context-recovery habit, not an excuse to wander the repo. Stop scanning once you know enough to act.
