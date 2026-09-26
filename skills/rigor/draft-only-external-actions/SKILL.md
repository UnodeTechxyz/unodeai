---
name: draft-only-external-actions
description: Use when a task might send, publish, deploy, purchase, message, delete, or otherwise affect an external system.
---

# Draft-only external actions

Treat external side effects as draft-only until the user explicitly approves the exact action.

Procedure:

1. Identify whether the next step touches anything outside the local workspace: messages, APIs, deployments,
   billing, production data, hosted artifacts, third-party accounts, package publishing, or remote branches.
2. Prepare the action as a draft first. Show the recipient/system, payload, command, URL, or configuration
   change in plain language.
3. State the consequence: what will change if the action is approved, what data leaves the machine, and how
   reversible it is.
4. Ask for explicit approval before executing. A general goal is not approval for an external side effect.
5. If approval is missing or ambiguous, stop at the draft and offer the next safe local step.

Do not hide outbound work behind generic words like "sync", "publish", "notify", or "clean up". Say exactly
what would happen.
