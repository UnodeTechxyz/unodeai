---
name: api-contract-review
description: Describe API and interface changes, classify each as breaking or non-breaking, and check the contract is documented and valid. Use when you need a repeatable api-contract-review procedure while planning, building, or reviewing work.
---

# API Contract Review

Scope: what changed in an interface, whether existing clients keep working, and whether the contract is
documented. Advice on the version number belongs to the skill whose name contains `api-versioning-semver`; give
it this change list. Without that skill, leave the version decision to the project's own versioning policy.

1. Compare the new contract with the previous one (OpenAPI, GraphQL schema, protobuf, exported types, CLI flags).
   List every change: added, removed, renamed, type or constraint changed, default changed, behaviour changed.
2. For each change, say whether existing clients keep working: breaking or non-breaking, with the reason (for
   example "removes field `x`, which clients read").
3. Check that additions are really compatible: new fields are optional, existing clients tolerate new enum
   values, and existing fields keep their meaning.
4. Check that every changed endpoint or operation documents its request, response, error responses and auth
   requirements.
5. Validate the schema with the project's own tool or script if it has one; otherwise say it was not validated.

Return: the change list with breaking or non-breaking and evidence (file:line), then documentation gaps.
