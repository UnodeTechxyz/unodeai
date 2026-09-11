---
name: quality-gate-95
description: Use when reviewing, completing, releasing, or signing off work that must meet a high quality bar.
---

# Quality gate 95

Before calling work complete, score it against the user's actual acceptance bar. The target is not perfection;
it is "would a careful reviewer confidently ship this?"

Checklist:

1. Requirements fit: every requested behavior is present, and no large unrequested behavior was added.
2. Correctness: the implementation handles normal, empty, error, and boundary cases.
3. Safety: destructive, external, security-sensitive, or irreversible actions are gated or documented.
4. Integration: touched files agree on names, types, contracts, configuration, and runtime assumptions.
5. Verification: relevant tests/checks were run, or the blocker is stated with exact commands and output.
6. User experience: labels, error messages, and defaults are honest and actionable.
7. Maintainability: the solution is smaller than the problem, with no needless framework or cleverness.

If the work scores below 95/100, do not pretend it is done. State the top gaps and either fix them or ask the
user whether to accept the known trade-off.
