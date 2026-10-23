---
name: root-cause-analysis
description: Systematically narrow a bug to its root cause using failure trees and evidence. Use when you need a repeatable root-cause-analysis procedure while planning, building, or reviewing work.
---

# Root Cause Analysis

Diagnose a bug or failure systematically:
1. **State the symptom**: what exactly failed, under what conditions, and what was observed? Include logs, stack traces, and reproduction steps.
2. **Form hypotheses**: list the possible causes ranked by likelihood and ease of verification.
3. **Test hypotheses**: design the smallest experiment that can falsify each hypothesis (e.g., isolate a function, mock a dependency).
4. **Identify the root cause**: find the earliest decision or change that allowed the failure to occur, not just the proximate trigger.
5. **Propose fix and prevention**: suggest the smallest correct fix and a test or guardrail that prevents recurrence.

Output: a concise RCA document with evidence, rejected hypotheses, root cause, and action items.
