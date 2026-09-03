---
name: artifact-hash-verification
description: Use before publishing a release artifact when its canonical bytes must be independently verified.
---

# Three-way artifact hash verification

Treat a release artifact as untrusted until three independent references name the same SHA-256:

1. Download the canonical CI artifact from the tag run; do not rebuild or repackage it locally.
2. Read the SHA-256 in the evidence file bundled with that download.
3. Compute SHA-256 over the downloaded artifact bytes locally.
4. Read the canonical run's server-side log/summary hash. This is the independent reference a substituted
   download cannot forge.
5. Require all three values to be identical before invoking the credential-free frozen-publish dry run on
   that exact downloaded file. A mismatch means stop and investigate; it is a new candidate, not a retry.
6. After explicit owner authorization, pass the same file and matched hash to frozen publish. Do not package,
   rebuild, or change the artifact between verification and upload.

Record the run ID, artifact name, all three sources, matched hash, dry-run result, and publish authorization
in the release evidence. Registry visibility checks happen only after upload and must defeat cached 404s.
