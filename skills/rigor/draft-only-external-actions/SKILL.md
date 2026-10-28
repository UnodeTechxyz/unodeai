---
name: draft-only-external-actions
description: Use when a task might send, publish, deploy, purchase, or change something outside this machine. Reads, installs, provider calls and local drafts are not such actions.
---

# Outward actions: confirm the exact action, not the preparation

Only an action that changes what other people or other systems see needs the person's go-ahead. The work that
prepares it does not.

Procedure:

1. Go ahead without asking for: reading public web pages and APIs, calling the model provider or an integration
   the person set up, installing packages, `git fetch` and `git pull`, running local commands and tests, and
   writing local files, including the finished draft of a message, post or document.
2. These are outward actions: `git push`, a deployment, publishing a package, page or release, sending a message,
   email or post to other people, a purchase or payment, a change or deletion in a production system or a
   third-party account, and a change to credentials or security settings.
3. Prepare an outward action completely. Show the recipient or system, the payload, command, URL or configuration
   change in plain language, and say what will change, what data leaves the machine, and how reversible it is.
4. Do it only when the person approved that exact action (for example "push it" or "send it to Alice"). A general
   goal such as "finish the release" is not approval for a push or a send.
5. If approval is missing, finish everything up to the outward step, then say in one sentence what is ready and
   what will happen when they approve.

Do not hide outbound work behind generic words like "sync", "publish", "notify", or "clean up". Say exactly
what would happen.
