---
name: clause-playbook-redline
description: Draft a redline against an organisation playbook, tracing every proposed change to the rule that produced it. Use when marking up a counterparty draft. Output is always a draft for human acceptance, never a sent position.
---

# Playbook Redline (draft only)

A redline is a negotiation commitment. An unreviewed redline that reaches a counterparty is an unauthorised
settlement of a term -- the most common documented failure of this category.

1. Read the playbook first and list the rules it actually contains. If no playbook exists, **stop and say
   so**: without one there is no standard to redline against, and inventing one substitutes your judgement
   for the organisation's risk appetite.
2. Compare the draft clause by clause. For each deviation record: the clause, the playbook rule id, the
   proposed change, and the quoted original.
3. **Every proposed change cites the rule that generated it.** A change with no rule behind it is your
   opinion -- mark it `no-rule` and keep it in a separate list rather than mixing it into the redline.
4. Never weaken a limitation of liability, indemnity, IP assignment, or termination right unless a playbook
   rule explicitly authorises that exact move. Flag any such clause you touched, even when a rule allowed it.
5. Never delete language without showing what was removed. Deletions are the changes reviewers miss.
6. List novel clauses with no playbook coverage separately, marked `out-of-playbook -- escalate`.
7. **Deliver a draft, addressed to your own side.** Do not produce counterparty-ready text, do not send, and
   say plainly that a person with signing authority must accept each change before it leaves the
   organisation. See `draft-only-external-actions`.
