---
name: artifact-hash-verification
description: Use before publishing or installing a release artifact when its bytes must be checked against independent hash references.
---

# Artifact hash verification

Follow the project's own release rules first: its release runbook, CONTRIBUTING or RELEASING file, or release
workflow. They decide which artifact is canonical, where its hashes are published and who may publish it. The
steps below are a general check; fit them to that process.

1. Identify the canonical artifact as the project defines it (for example the file its CI built from the release
   tag). Do not rebuild or repackage it to compare: a rebuild is a different artifact unless the project proves
   reproducible builds.
2. Collect the independent hash references the project provides, for example a checksum or evidence file shipped
   with the artifact, a hash in the build log or release notes, or a signature or attestation. Then compute the
   hash over the downloaded bytes yourself.
3. Use SHA-256 or stronger, and compare full values, not prefixes.
4. Require every reference to match. A mismatch means stop and investigate; it is a new candidate, not a retry.
5. If the project signs its artifacts, verify the signature with the project's published key as well.
6. Do not change the file between verification and use. Publishing is an outward action: do it only with the
   explicit approval the project requires.

Record the artifact name and source, each reference and where it came from, the matched hash, and anything you
could not verify.
