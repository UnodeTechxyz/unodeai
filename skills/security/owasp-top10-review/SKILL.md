---
name: owasp-top10-review
description: Screen code changes for the OWASP Top 10 web application security risks, using the 2025 edition as the current baseline. Use when you need a repeatable owasp-top10-review procedure while planning, building, or reviewing work.
---

# OWASP Top 10 Review

Baseline: the OWASP Top 10 2025 (https://top10.owasp.org/2025/). If the project has adopted another edition (for
example 2021) in its policy or earlier reports, also map each finding to that edition and name both in the
report. The Top 10 is an awareness list of common risk categories, not a complete security review. Say so in the
report, and report a real issue even when it fits no category.

Screen the change for:

1. **A01 Broken Access Control**: every endpoint checks authentication and authorization; ownership checks on
   resource IDs; server-side request forgery (SSRF): URLs the server fetches from user input are validated and
   restricted.
2. **A02 Security Misconfiguration**: default credentials, verbose errors, debug features, permissive CORS or
   headers, features enabled that are not needed.
3. **A03 Software Supply Chain Failures**: new or changed dependencies, build and CI steps and where they come
   from; known vulnerabilities; pinned versions and lock files; who can change the pipeline.
4. **A04 Cryptographic Failures**: sensitive data encrypted in transit and at rest; no hard-coded keys; no weak
   algorithms for security uses (for example MD5, SHA-1).
5. **A05 Injection**: SQL, NoSQL, OS command, LDAP, template and HTML/script output; parameterized queries and
   output encoding.
6. **A06 Insecure Design**: missing rate limits, missing business-rule checks, unsafe defaults.
7. **A07 Authentication Failures**: credential storage, multi-factor authentication where required, session
   handling, token expiry and revocation.
8. **A08 Software or Data Integrity Failures**: unsigned updates, unsafe deserialization, untrusted data used as
   code or configuration.
9. **A09 Security Logging and Alerting Failures**: security events logged with enough context and alerted on;
   no secrets in logs.
10. **A10 Mishandling of Exceptional Conditions**: errors fail closed, are handled at the right level, do not leak
    details, and do not leave state half-changed.

Output: the edition or editions you used; each finding with category, severity, file:line, evidence and
remediation; then any findings outside the Top 10.
