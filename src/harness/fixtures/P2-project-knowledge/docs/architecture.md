# Fixture architecture

The fixture represents a small TypeScript service with a source directory and one local verification command.

## Boundaries

The evaluation runner owns temporary workspaces and captures only bounded evidence fields.

## Detailed operating notes

The source tree is intentionally small so a task can demonstrate an edit, a verification command, and an
evidence record without depending on an external service. The task file defines the requested change; source
files define the current state; the runner observes the result from outside the agent process. A model should
read the exact source it needs instead of treating an index as the source of truth. The fixture does not grant
network, publishing, credential, or filesystem access beyond its own temporary workspace. These notes exist
to make the whole-document control materially larger than the progressive index while preserving the same
documents, order, and authority in both A/B arms.
