---
name: commit-message-quality
description: Check commit messages against the repository's own convention and for a body that explains the change. Use when you need a repeatable commit-message-quality procedure while planning, building, or reviewing work.
---

# Commit Message Quality

1. Find the repository's convention: CONTRIBUTING, a commitlint or similar configuration, a commit template, or
   the pattern in recent `git log`. Name the convention you used in the report.
2. Check each message against that convention. Apply Conventional Commits (`type(scope): description`, with `!`
   and a `BREAKING CHANGE:` footer for breaking changes) only when the repository uses it. A message is not wrong
   for missing a convention the repository does not use.
3. With no visible convention, use general rules: a short summary line that says what changed, a blank line, and
   a body that says why when the reason is not obvious.
4. The message matches the diff: it claims neither more nor less than the commit changes.
5. One logical change per commit, where the repository expects that.
6. Issue and ticket references use the repository's own form.

Flag each problem with the commit hash, the rule broken, and where the rule comes from (the repository's
convention or the general rules above).
