---
name: diff-risk-triage
description: Rate each changed file by risk to focus review effort, and return a PASS or FAIL verdict on the dangerous changes found. Use when you need a repeatable diff-risk-triage procedure while planning, building, or reviewing work.
---

# Diff Risk Triage

Based on Google code-review heuristics:

1. Categorize changed files by layer: data, API, logic, UI, infra, test.
2. Flag auth, payments, security headers, secrets, and schema migrations as high risk.
3. Measure blast radius: count call sites and consumers of changed public interfaces.
4. Check for removed or renamed public symbols without deprecation.
5. Verify new dependencies are pinned, justified, and licensed compatibly.

Output:

- What you reviewed: the commit, branch or files.
- A risk rating per file with the reason, to focus further review.
- Each finding with: blocking or non-blocking, file:line, the evidence, and the condition that closes it.
- The verdict: **FAIL** while any blocking finding is open, otherwise **PASS**. List non-blocking findings
  separately; they do not change a PASS.
