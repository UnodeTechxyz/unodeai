---
name: systematic-debugging
description: Use when diagnosing a bug, regression, failed test, crash, flaky behavior, or unexplained output.
---

# Systematic debugging

Find the root cause before changing code.

Procedure:

1. Capture the exact symptom: command, input, output, stack trace, expected behavior, and observed behavior.
2. Reproduce it in the smallest reliable way. If reproduction is impossible, state what signal is missing.
3. List plausible causes, then test them one at a time with the smallest falsifying check.
4. Isolate the boundary where good state becomes bad: input parsing, routing, state update, IO, rendering, or
   integration.
5. Fix the root cause, not the most convenient symptom.
6. Add or update a regression test that would have failed before the fix.
7. Re-run the relevant checks and report exact results.

Do not guess a cause from vibes. Evidence first; patch second.
