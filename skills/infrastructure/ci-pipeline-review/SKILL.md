---
name: ci-pipeline-review
description: Review CI/CD workflows for speed, security, reliability, and maintainability. Use when you need a repeatable ci-pipeline-review procedure while planning, building, or reviewing work.
---

# CI Pipeline Review

Review a CI/CD pipeline definition (GitHub Actions, GitLab CI, etc.):
1. **Triggers**: confirm jobs run on the right events (push, PR, release) and avoid unnecessary runs on every file change.
2. **Speed**: check for parallel jobs, caching of dependencies and build output, and minimal redundant steps.
3. **Security**: pin third-party actions to a commit SHA, never use `pull_request_target` with untrusted checks, and inject secrets only via environment variables.
4. **Reliability**: ensure jobs have timeouts, idempotent steps, and clear failure notifications.
5. **Maintainability**: prefer reusable workflows or composite actions over copy-pasted YAML; document non-obvious steps.

Output: a pipeline review with risk items and concrete YAML improvements.
