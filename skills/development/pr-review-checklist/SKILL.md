---
name: pr-review-checklist
description: Run a standardized checklist over a pull request before approval. Use when you need a repeatable pr-review-checklist procedure while planning, building, or reviewing work.
---

# PR Review Checklist

Run this checklist on every pull request:
1. **Purpose**: does the PR description clearly state what changed and why? Is it linked to an issue or ticket?
2. **Scope**: is the change focused? Are unrelated refactorings split out?
3. **Correctness**: does the code handle errors, edge cases, and concurrency correctly?
4. **Tests**: are new behaviors covered by tests? Do tests fail if the behavior regresses?
5. **Security**: are inputs validated, secrets not exposed, and dependencies free of known CVEs?
6. **Style**: does the code follow the project style and naming conventions?
7. **Documentation**: are README, API docs, or comments updated if behavior changed?
8. **Performance**: are there obvious N+1 queries, large allocations, or blocking calls?

Output: a checklist result with blockers, nits, and an approval recommendation.
