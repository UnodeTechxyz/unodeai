---
name: documentation-lint
description: Check markdown docs for broken links, stale content, readability, and style consistency. Use when you need a repeatable documentation-lint procedure while planning, building, or reviewing work.
---

# Documentation Lint

Lint markdown documentation:
1. **Broken links**: check every relative and absolute link; flag any that return 404 or point to missing files.
2. **Stale content**: compare documented commands/flags against the actual CLI `--help` output or code. Flag mismatches.
3. **Readability**: run a Flesch-Kincaid check — target grade 8–10 for developer docs. Flag sentences over 25 words.
4. **Style consistency**: check that code blocks have language tags, headings use sentence case, and terminology matches the project glossary.
5. **Coverage**: ensure every public API function/endpoint and every CLI command has a corresponding doc section.

Output: a violation list (file:line, rule, fix suggestion) suitable for a CI doc-lint gate.
