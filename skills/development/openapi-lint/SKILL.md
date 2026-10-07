---
name: openapi-lint
description: Validate an OpenAPI document for spec compliance, consistency, and completeness. Use when you need a repeatable openapi-lint procedure while planning, building, or reviewing work.
---

# OpenAPI Lint

Based on OpenAPI 3.1 and Spectral rules:
1. Validate the document parses and matches the declared openapi version.
2. Ensure every operation has a unique operationId, summary, description, and tag.
3. Check paths use consistent casing and plural nouns for collections.
4. Verify every response has a schema and 4xx/5xx errors share a common structure.
5. Confirm security schemes are declared globally and referenced per operation.

Return: lint report with file:line, rule, and fix suggestion.
