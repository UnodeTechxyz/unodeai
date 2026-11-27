---
name: secrets-scanning
description: Detect exposed API keys, tokens, passwords, and private certificates in source and config, and report their location and type without ever repeating the value. Use when you need a repeatable secrets-scanning procedure while planning, building, or reviewing work.
---

# Secrets Scanning

**Never repeat a secret value**, not in full and not in part (no prefix, suffix or partly masked form), in a
report, log, message, commit, file you write, or export. Report only where it is and what type it looks like.

Hunt for exposed secrets in code, config, and history:

1. Search for strings matching common secret patterns and high-entropy values: cloud access keys, `ghp_` and
   similar tokens, `sk-` style API keys, `PRIVATE KEY` blocks, connection strings with passwords.
2. Check `.env`, `.env.local`, `config.json`, YAML and similar files for plaintext credentials.
3. Check history for secrets that were committed and later removed. Prefer a secret scanner with its redaction
   option on (for example `gitleaks` with `--redact`). Raw `git log -p` or scanner output prints the values: do
   not paste it into your reply or a report.
4. Verify that secrets are loaded from environment variables or a vault, never hard-coded.
5. Confirm that `.gitignore` excludes secret files and that a pre-commit hook or CI check blocks new leaks.

Output: one entry per leak with its location (file:line, or commit and path), the secret type, whether it reached
history or a shared place, and a rotation and remediation plan. Treat any secret that reached a commit or a
shared place as exposed.
