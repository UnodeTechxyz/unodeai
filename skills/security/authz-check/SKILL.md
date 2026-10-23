---
name: authz-check
description: Verify that access-control decisions enforce ownership, least privilege, and deny-by-default. Use when you need a repeatable authz-check procedure while planning, building, or reviewing work.
---

# Authorization Check

Based on OWASP Broken Access Control:
1. List every changed route/handler/method that touches a resource; record file:line.
2. Confirm authentication is checked before authorization on every endpoint.
3. Verify the subject can only access resources they own or are explicitly granted.
4. Ensure role/permission enforcement is at the service layer, not just the UI.
5. Check for deny-by-default fallthrough on every branch.

Return: authorization gaps with file:line and concrete fixes.
