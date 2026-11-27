---
name: root-cause-analysis
description: Explain why a failure happened as an evidenced causal chain and decide what prevents it from recurring. Use when you need a repeatable root-cause-analysis procedure for an incident, a repeated failure, or a postmortem.
---

# Root Cause Analysis

Scope: the causal chain behind a failure and how to stop it recurring. Reproducing the failure, testing
hypotheses and locating the defect belong to the skill whose name contains `systematic-debugging`; if you have
its result, start from it instead of repeating it. If the failure is not yet located and you do not have that
skill, first capture the exact symptom, reproduce it, and test one hypothesis at a time with the smallest check
that could prove it wrong.

1. **Start from evidence**: the located defect, the reproduction, and the logs or traces that show it. Name
   anything still unverified.
2. **Build the causal chain** backward from the symptom: the trigger, the defect, the change or decision that
   introduced it, and why existing tests, reviews or checks did not catch it. Each link cites evidence; mark a
   link without evidence as inference.
3. **Stop at causes you can act on.** "Human error" is not a root cause; ask what made the mistake easy to make
   and hard to notice.
4. **Look for siblings**: the same pattern elsewhere in the code or the process.
5. **Propose prevention**: the smallest correct fix, a test or check that would have failed, and any guard or
   process change that stops the whole class of failure. Say what each one prevents.

Output: a concise RCA with the symptom, the causal chain and its evidence, rejected hypotheses, the root cause,
sibling cases, and action items.
