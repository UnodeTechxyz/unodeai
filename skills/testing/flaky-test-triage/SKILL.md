---
name: flaky-test-triage
description: Identify root causes of unstable tests and recommend a fix or quarantine plan. Use when you need a repeatable flaky-test-triage procedure while planning, building, or reviewing work.
---

# Flaky Test Triage

Based on public test-engineering practice:
1. Collect recent CI failures and reruns for the same test name.
2. Inspect for non-deterministic inputs: time, random seeds, unordered collections, or concurrency.
3. Check for unreset external dependencies: network, database, or shared state.
4. Verify async assertions wait for conditions instead of assuming immediate results.
5. Recommend isolation, mocks, retries as last resort, or quarantine.

Return: root cause, suspect file:line, and remediation plan.
