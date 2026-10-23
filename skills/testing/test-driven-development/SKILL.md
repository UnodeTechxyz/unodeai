---
name: test-driven-development
description: Use when designing or strengthening tests for behavior, bug fixes, regressions, or edge cases.
---

# Test-driven development

Use tests as executable requirements.

Procedure:

1. Name the behavior and the failure mode.
2. Write the smallest test that proves the behavior or reproduces the regression.
3. Confirm it fails before the fix when practical.
4. Make the implementation pass without weakening the assertion.
5. Add edge cases for empty, invalid, boundary, and permission/error paths.
6. Run the focused test, then the relevant suite.
7. Report exactly what passed and what remains untested.

Tests should fail loudly when the behavior regresses.
