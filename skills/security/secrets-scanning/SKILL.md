---
name: secrets-scanning
description: Detect exposed API keys, tokens, passwords, and private certificates in source and config. Use when you need a repeatable secrets-scanning procedure while planning, building, or reviewing work.
---

# Secrets Scanning

Hunt for exposed secrets in code, config, and history:
1. Search for high-entropy strings matching common patterns: `AWS_ACCESS_KEY_ID`, `ghp_`, `sk-`, `PRIVATE KEY`, `-----BEGIN`.
2. Check `.env`, `.env.local`, `config.json`, and YAML files for plaintext credentials.
3. Review recent commits for accidentally committed secrets (use `git log -p` or a secret scanner).
4. Verify that secrets are loaded from environment variables or a vault, never hardcoded.
5. Confirm that `.gitignore` excludes secrets and that pre-commit hooks block new leaks.

Output: a list of leaks with file:line, secret type, and a rotation/remediation plan.
