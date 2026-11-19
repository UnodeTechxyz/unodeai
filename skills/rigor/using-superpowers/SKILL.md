---
name: using-superpowers
description: Use when starting any task to choose and load the most relevant authorized skills before acting.
---

# Using Superpowers

Before acting on a task:

1. Find your authorized skills.
   - OpenAI-compatible and Claude backends: they are listed under **Authorized Agent Skills** in your system
     prompt.
   - Codex backend: your skills are Codex native skills with renamed names of the form
     `unode-<hash>-<name>-<hash>`, and your system prompt has no list of them. Find a skill by the name it
     contains (for example a name containing `systematic-debugging`).
2. If one or more skills are relevant, load the best match before you answer, plan, edit, delegate,
   or run tools.
   - OpenAI-compatible backend: call `load_skill` with the skill name.
   - Claude backend: invoke the extension-managed plugin command shown next to the skill.
   - Codex backend: use the native skill whose name contains the skill name.
3. Follow the loaded skill's procedure as your operating checklist.
4. If no listed skill applies, proceed normally and do not pretend that you used one.
5. For multi-domain work, load the most relevant skill first; load another only when it materially
   changes the next step.

Two exceptions to "load a skill first":

- The person explicitly asks you to run a specific command or step first. Do that first, then load a skill if
  it still helps.
- You are a coordinator whose instructions say to dispatch first. Dispatch first; the teammates who do the work
  load the skills it needs.

The point is not ceremony. The point is to pause long enough to use the specialized procedure that
the user already authorized for this agent.
