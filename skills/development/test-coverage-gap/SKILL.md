---
name: test-coverage-gap
description: Find untested code paths, missing edge cases, and low-coverage modules. Use when you need a repeatable test-coverage-gap procedure while planning, building, or reviewing work.
---

# Test Coverage Gap Analysis

Identifying coverage gaps:
1. Run the project's coverage tool (`npm test -- --coverage`) and parse the output.
2. Flag files below the project's coverage threshold (default 80% line coverage).
3. For each low-coverage file, identify the largest uncovered function/branch — that's the highest-priority gap.
4. Scan source for `TODO`, `FIXME`, error-handling branches, and edge-case comments — these often signal untested paths.
5. For API endpoints, check that every status code in the spec has at least one test.

Output: a ranked gap list (file, uncovered lines, risk level) with a one-sentence test suggestion per gap.
