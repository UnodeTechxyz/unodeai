---
name: using-superpowers
description: Use when starting any task to choose and load the most relevant authorized skills before acting.
---

# Using Superpowers

Before acting on a task:

1. Check the **Authorized Agent Skills** listed in your system prompt.
2. If one or more skills are relevant, load the best match before you answer, plan, edit, delegate,
   or run tools.
   - OpenAI-compatible backend: call `load_skill` with the skill name.
   - Claude backend: invoke the extension-managed plugin command shown next to the skill.
3. Follow the loaded skill's procedure as your operating checklist.
4. If no listed skill applies, proceed normally and do not pretend that you used one.
5. For multi-domain work, load the most relevant skill first; load another only when it materially
   changes the next step.

The point is not ceremony. The point is to pause long enough to use the specialized procedure that
the user already authorized for this agent.
