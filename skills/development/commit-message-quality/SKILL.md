---
name: commit-message-quality
description: Enforce Conventional Commits format and meaningful body content in commit messages. Use when you need a repeatable commit-message-quality procedure while planning, building, or reviewing work.
---

# Commit Message Quality

Review commit messages against these rules:
1. **Format**: `type(scope): description` per Conventional Commits. Types: feat, fix, docs, style, refactor, perf, test, chore, ci.
2. **Description**: imperative mood, ≤ 72 characters, starts lowercase, no period at end.
3. **Body** (if present): wrapped at 72 chars, explains WHY and WHAT (not how). References issues with `Fixes #123` or `Refs #456`.
4. **Breaking changes**: flagged with `!` after type/scope AND a `BREAKING CHANGE:` footer.
5. **Single concern**: one logical change per commit; no mixed refactoring + features.

Flag violations with the commit hash and the specific rule broken.
