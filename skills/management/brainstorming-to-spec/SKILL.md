---
name: brainstorming-to-spec
description: Use when an idea is vague, exploratory, high-impact, or needs product shape before implementation.
---

# Brainstorming to spec

Turn fuzzy intent into a concrete, reviewable spec before building.

Procedure:

1. Restate the goal, user, and success signal in one or two sentences.
2. Ask only the questions that change the design. Prefer assumptions for details that can be safely adjusted.
   Ask on a delegated task, your coordinator, with `send_message` (kind question); if you lead or work alone, the person, in your reply.
3. Offer two or three viable approaches with trade-offs: fastest, safest, and most extensible when those differ.
4. Recommend one approach and say why it fits this project.
5. Draft the spec: scope, non-goals, user-visible behavior, acceptance criteria, risks, and open questions.
6. Get the person's approval before implementation if the choice changes product behavior, cost, security, or
   external integrations. On a delegated task, ask for it through your coordinator with `send_message` (kind
   question).

Do not turn brainstorming into a hidden implementation session. The output is a shared decision.
