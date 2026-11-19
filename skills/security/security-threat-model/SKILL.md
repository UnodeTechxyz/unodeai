---
name: security-threat-model
description: Use when the user asks to threat model a codebase or a path in it, to enumerate threats or abuse paths, or to do AppSec threat modeling. Builds a repository-grounded model of trust boundaries, assets, attacker capabilities, abuse paths and mitigations, and writes a concise Markdown threat model. Not for general architecture summaries, code review or non-security design work.
---

# Threat Model Source Code Repo

Deliver an actionable AppSec-grade threat model that is specific to the repository or a project path, not a generic
checklist. Anchor every architectural claim to evidence in the repo and keep assumptions explicit. Prioritize
realistic attacker goals and concrete impacts over generic checklists.

Reference files in this skill are read with `read_skill_file` where that tool is offered, otherwise from this
skill's folder.

## Quick start

1) Collect (or infer) inputs:
- Repo root path and any in-scope paths.
- Intended usage, deployment model, internet exposure, and auth expectations (if known).
- Any existing repository summary or architecture spec.
- Use the prompts in `references/prompt-template.md` to generate a repository summary.
- Follow the output contract in `references/prompt-template.md`. Use it verbatim when possible.

## Workflow

### 1) Scope and extract the system model
- Identify primary components, data stores, and external integrations from the repo summary.
- Identify how the system runs (server, CLI, library, worker) and its entrypoints.
- Separate runtime behavior from CI/build/dev tooling and from tests/examples.
- Map the in-scope locations to those components and exclude out-of-scope items explicitly.
- Do not claim components, flows, or controls without evidence.

### 2) Derive boundaries, assets, and entry points
- Enumerate trust boundaries as concrete edges between components, noting protocol, auth, encryption, validation,
  and rate limiting.
- List assets that drive risk (data, credentials, models, config, compute resources, audit logs).
- Identify entry points (endpoints, upload surfaces, parsers/decoders, job triggers, admin tooling, logging/error
  sinks).

### 3) Calibrate assets and attacker capabilities
- List the assets that drive risk (credentials, PII, integrity-critical state, availability-critical components,
  build artifacts).
- Describe realistic attacker capabilities based on exposure and intended usage.
- Explicitly note non-capabilities to avoid inflated severity.

### 4) Enumerate threats as abuse paths
- Prefer attacker goals that map to assets and boundaries (exfiltration, privilege escalation, integrity compromise,
  denial of service).
- Classify each threat and tie it to impacted assets.
- Keep the number of threats small but high quality.

### 5) Prioritize with explicit likelihood and impact reasoning
- Use qualitative likelihood and impact (low/medium/high) with short justifications.
- Set overall priority (critical/high/medium/low) using likelihood x impact, adjusted for existing controls.
- State which assumptions most influence the ranking.

### 6) Settle service context and assumptions
- First look for the context in the repository, the request and earlier messages: deployment files, docs,
  configuration, the README.
- Summarize the key assumptions that materially affect threat ranking or scope, and put them in the report's
  "Scope and assumptions" section.
- Ask the user only when a missing fact would change the scope or the ranking materially and nothing you can read
  answers it. Ask at most 1–3 targeted questions (service owner and environment, scale/users, deployment model,
  authn/authz, internet exposure, data sensitivity, multi-tenancy) and continue with the work that does not depend
  on the answer.
- Without an answer, finish the report with the assumptions stated, and mark the conclusions that depend on them as
  conditional.

### 7) Recommend mitigations and focus paths
- Distinguish existing mitigations (with evidence) from recommended mitigations.
- Tie mitigations to concrete locations (component, boundary, or entry point) and control types (authZ checks, input
  validation, schema enforcement, sandboxing, rate limits, secrets isolation, audit logging).
- Prefer specific implementation hints over generic advice (e.g., "enforce schema at gateway for upload payloads"
  vs "validate inputs").
- Base recommendations on the context you established; where assumptions remain unresolved, mark recommendations as
  conditional.

### 8) Run a quality check before finalizing
- Confirm all discovered entrypoints are covered.
- Confirm each trust boundary is represented in threats.
- Confirm runtime vs CI/dev separation.
- Confirm user clarifications (or the assumptions that stand in for them) are reflected.
- Confirm assumptions and open questions are explicit.
- Confirm that the format of the report matches closely the required output format defined in the prompt template:
  `references/prompt-template.md`.
- Where you can write files and the task names no other location, write the final Markdown to a file named
  `<repo-or-dir-name>-threat-model.md` (use the basename of the repo root, or the in-scope directory if you were
  asked to model a subpath). Otherwise hand the report over in your reply.

## Risk prioritization guidance (illustrative, not exhaustive)
- High: pre-auth RCE, auth bypass, cross-tenant access, sensitive data exfiltration, key or token theft, model or
  config integrity compromise, sandbox escape.
- Medium: targeted DoS of critical components, partial data exposure, rate-limit bypass with measurable impact,
  log/metrics poisoning that affects detection.
- Low: low-sensitivity info leaks, noisy DoS with easy mitigation, issues requiring unlikely preconditions.

## Security hygiene
- Never print a secret you come across. Redact it and describe only its presence and location.

## References

- Output contract and full prompt template: `references/prompt-template.md`
- Optional controls/asset list: `references/security-controls-and-assets.md`

Only load the reference files you need. Keep the final result concise, grounded, and reviewable.

---
Adapted from the Apache-2.0 `security-threat-model` skill in github.com/openai/skills. What changed and why is listed
in `SOURCE.md`; the license is in `LICENSE.txt`.
