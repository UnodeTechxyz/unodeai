---
name: owasp-top10-review
description: Screen code changes for the OWASP Top 10 web application security risks. Use when you need a repeatable owasp-top10-review procedure while planning, building, or reviewing work.
---

# OWASP Top 10 Review

Screen changes for the current OWASP Top 10:
1. **Broken Access Control**: verify every endpoint checks authentication and authorization; flag missing ownership checks on resource IDs.
2. **Cryptographic Failures**: ensure sensitive data is encrypted at rest and in transit; no hardcoded keys or weak algorithms (MD5, SHA1).
3. **Injection**: inspect SQL, NoSQL, command, and LDAP queries for unsanitized input. Verify parameterized queries or ORM use.
4. **Insecure Design**: flag features that lack rate limiting, input validation, or fail-secure defaults.
5. **Security Misconfiguration**: check for default credentials, verbose error messages, and unnecessary enabled features.
6. **Vulnerable Components**: cross-reference changed dependencies with known CVEs.
7. **Identification and Authentication Failures**: verify password policies, MFA, session handling, and token expiry.
8. **Software and Data Integrity Failures**: ensure CI/CD pipelines verify signatures and dependencies are pinned.
9. **Security Logging and Monitoring Failures**: confirm security events are logged with enough context for incident response.
10. **Server-Side Request Forgery (SSRF)**: validate and restrict URLs fetched by the server; no user-controlled raw URLs.

Output: a finding list with OWASP category, severity, file:line, and remediation.
