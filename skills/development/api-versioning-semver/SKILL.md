---
name: api-versioning-semver
description: Classify API changes and map them to the correct semantic version bump. Use when you need a repeatable api-versioning-semver procedure while planning, building, or reviewing work.
---

# API Versioning (SemVer)

Based on semver.org 2.0.0:
1. Classify each change as breaking, additive, or fix.
2. Map to a version bump: breaking→MAJOR, additive→MINOR, fix→PATCH.
3. Verify the URL/header version matches the release notes.
4. Ensure breaking changes include a migration guide and deprecation window.
5. Confirm additive changes use optional fields without altering existing semantics.

Return: recommended bump, changelog snippet, and semver violations.
