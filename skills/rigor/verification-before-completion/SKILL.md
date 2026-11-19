---
name: verification-before-completion
description: Use before claiming a task is done, shipping a release, or handing work back to the user.
---

# Verification before completion

Do not call work done until the evidence matches the claim.

Checklist:

1. Compare the final state against the user's request and acceptance criteria.
2. Run the relevant checks using the project's own scripts.
3. Inspect changed files for accidental scope creep, debug leftovers, generated junk, and stale docs.
4. Confirm safety-sensitive behavior with targeted tests or direct probes.
5. If a check was skipped, say why and what risk remains.
6. Final response must include what changed and how it was verified.

"Looks good" is not evidence. Use commands, tests, diffs, and observed behavior.
