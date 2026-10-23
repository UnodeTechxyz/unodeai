---
name: dependency-risk-triage
description: Audit third-party dependencies for vulnerabilities, staleness, license issues, and bloat. Use when you need a repeatable dependency-risk-triage procedure while planning, building, or reviewing work.
---

# Dependency Risk Triage

Triage dependencies with `npm audit` and manual review:
1. Run `npm audit --json` and parse the output. Flag every critical/high vulnerability with its CVE, affected package, and fix version.
2. Check staleness: any dependency more than 12 months behind its latest major? Flag it with the lag and a migration feasibility note.
3. Scan licenses via `license-checker` — flag any GPL/AGPL in a proprietary project, or any unlicensed package.
4. Check for bloat: dependencies with < 10% usage (e.g. importing 1 function from a 500 KB package). Suggest tree-shakeable alternatives.
5. Review transitive dependency depth — flag chains deeper than 5 levels (high maintenance risk).

Output: a risk-ranked dependency report with clear action items.
