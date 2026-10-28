---
name: api-error-handling
description: Check API error responses conform to RFC 7807 Problem Details and don't leak internals. Use when you need a repeatable api-error-handling procedure while planning, building, or reviewing work.
---

# API Error Handling

Based on RFC 7807 Problem Details:
1. Confirm all error responses use `application/problem+json`.
2. Verify each error includes type, title, status, and detail; instance is recommended.
3. Ensure 4xx/5xx status codes match the failure class.
4. Check that messages do not leak stack traces, secrets, or internals.
5. Document expected errors in the OpenAPI schema with example payloads.

Return: error-handling gaps with file:line and required Problem Details fields to add.
