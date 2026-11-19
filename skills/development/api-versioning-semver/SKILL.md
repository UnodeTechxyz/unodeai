---
name: api-versioning-semver
description: Classify the compatibility of interface changes and advise on the version number under the project's versioning policy. Use when you need a repeatable api-versioning-semver procedure while planning, building, or reviewing work.
---

# API Versioning (SemVer)

Scope: the compatibility class of each change and advice on the version number. Describing the changes belongs
to the skill whose name contains `api-contract-review`; if you have its change list, start from it. Without it,
first list each interface change against the previous version.

1. Find the project's versioning policy: SemVer 2.0.0, calendar versions, URL or header versions, or none.
   Follow it. Under SemVer, a 0.x version may make breaking changes in a minor release.
2. Classify each change as breaking, additive or fix, with the reason.
3. Advise the version change the policy implies (under SemVer: breaking to MAJOR, additive to MINOR, fix to
   PATCH). This is advice: the project decides, and it may batch changes or release on a schedule. Report a
   missing bump as a problem only when the project's policy requires one for this release.
4. Check that the version a client sees (URL, header, package version, release notes) matches the project's
   decision.
5. For a breaking change, check for a migration note and the deprecation period the project promises.

Return: the policy you applied, the class of each change with evidence, the advised version change, and a
changelog snippet.
