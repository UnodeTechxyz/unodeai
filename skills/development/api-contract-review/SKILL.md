---
name: api-contract-review
description: Review API changes for backward compatibility, versioning, and schema violations. Use when you need a repeatable api-contract-review procedure while planning, building, or reviewing work.
---

# API Contract Review

When reviewing an API change:
1. Compare the new schema against the previous version — flag any breaking changes (removed fields, changed types, renamed endpoints).
2. Verify versioning policy: is this a major, minor, or patch change per semver? Does the version header/URL path match?
3. Check that every endpoint documents its request body, response shape, error codes, and auth requirements.
4. Confirm backward-compatible additions (new optional fields, new endpoints) don't break existing clients.
5. Validate the OpenAPI/GraphQL schema against the spec (swagger-parser / graphql-inspector).

Return: a change classification (breaking/non-breaking) and a list of violations with file:line references.
