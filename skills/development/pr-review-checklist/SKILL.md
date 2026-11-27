---
name: pr-review-checklist
description: Run a standard checklist over a pull request and return a PASS or FAIL verdict with evidence and closing conditions. Use when you need a repeatable pr-review-checklist procedure while planning, building, or reviewing work.
---

# PR Review Checklist

Check the pull request against its stated purpose and acceptance criteria:

1. **Purpose**: does the description state what changed and why? Is it linked to an issue or ticket where the
   project expects one?
2. **Scope**: is the change focused? Are unrelated refactorings split out?
3. **Correctness**: does the code handle errors, edge cases, and concurrency correctly?
4. **Tests**: are new behaviors covered by tests? Would the tests fail if the behavior regressed?
5. **Security**: are inputs validated, secrets kept out of code and logs, and new dependencies free of known
   vulnerabilities?
6. **Style**: does the code follow the project's style and naming conventions?
7. **Documentation**: are README, API docs, or comments updated where behavior changed?
8. **Performance**: are there obvious N+1 queries, large allocations, or blocking calls?

Output:

- What you reviewed: the commit, branch or files.
- The checks you ran and what they returned, or that the verdict rests on reading alone.
- Each finding with: blocking or non-blocking, file:line, the evidence, and the condition that closes it.
- The verdict: **FAIL** while any blocking finding is open, otherwise **PASS**. List non-blocking findings
  separately; they do not change a PASS.
