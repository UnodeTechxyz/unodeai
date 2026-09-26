---
name: diff-risk-triage
description: Rate each changed file by risk to focus review effort and catch dangerous changes early. Use when you need a repeatable diff-risk-triage procedure while planning, building, or reviewing work.
---

# Diff Risk Triage

Based on Google code-review heuristics:
1. Categorize changed files by layer: data, API, logic, UI, infra, test.
2. Flag auth, payments, security headers, secrets, and schema migrations as high risk.
3. Measure blast radius: count call sites and consumers of changed public interfaces.
4. Check for removed or renamed public symbols without deprecation.
5. Verify new dependencies are pinned, justified, and licensed compatibly.

Return: risk rating per file with reviewer recommendations and blockers.
