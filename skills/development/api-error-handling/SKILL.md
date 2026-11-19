---
name: api-error-handling
description: Check API error responses against Problem Details (RFC 9457, which replaced RFC 7807) or the project's chosen format, and check they do not leak internals. Use when you need a repeatable api-error-handling procedure while planning, building, or reviewing work.
---

# API Error Handling

The current standard for HTTP API error bodies is RFC 9457 (Problem Details). It replaced RFC 7807 and keeps
the same core members, so a response written for 7807 is usually valid under 9457 too.

1. Find the format the project has chosen: its API guidelines, the error schemas in its API description, or the
   existing error code. Name the format and version you checked against in the report.
   - If the project explicitly uses RFC 7807, check against 7807. Mention 9457 as an optional note; do not
     report the older reference as a defect or ask for a migration.
   - If the project uses another error format on purpose, check that the format is used consistently.
   - With no stated choice, check against RFC 9457 and say that you chose it.
2. For Problem Details responses: the media type is `application/problem+json`; `type`, `title`, `status`,
   `detail` and `instance` are used as the RFC defines them (`type` defaults to `about:blank`); `status`
   matches the HTTP status code; extension members are documented.
3. Status codes match the failure class: 4xx for a client error, 5xx for a server error.
4. Messages do not leak stack traces, secrets, queries, file paths or internal host names.
5. Expected errors are documented in the API description (for example OpenAPI) with example payloads.

Return: the format and version you checked against, then each gap with file:line and the fix.
