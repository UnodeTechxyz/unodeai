---
name: internal-comms
description: Use when asked to write an internal communication such as a status report, leadership update, 3P update (progress, plans, problems), project update, newsletter, FAQ or incident report. Organizes the material for its readers, keeps facts apart from inference, and produces a draft that a person sends.
---

# Internal communications

## When to use this skill

To write internal communications, use this skill for:
- 3P updates (Progress, Plans, Problems)
- Status reports and project updates
- Leadership updates
- Company or team newsletters
- FAQ responses
- Incident reports
- Anything else written for readers inside an organization

## Ground rules

- **The user's own format comes first.** If the user, the project or the team already has a template, a house style
  or earlier issues of the same update, follow them. The guideline files below are defaults for when nothing like
  that exists.
- **Write in the user's language** and in the register their organization uses. The guideline files are written in
  English; their structure carries over, their English idioms do not have to.
- **Only what the sources support.** Use the material you actually have in this session: what the user gave you,
  files in the workspace, and integrations this agent has been granted. Never invent progress, numbers, names, dates
  or quotes. Keep what a source states apart from what you infer, and mark inference as such.
- **Missing facts are marked, not filled.** When a fact the piece needs is missing, write a visible placeholder (for
  example `[team name]` or `[metric: source needed]`) and list the gaps at the end of the draft. Ask the user only
  for a fact that changes the result and that no source you have can supply; otherwise deliver the draft with the
  gaps marked.
- **You produce a draft.** Do not send, post or publish it. If the user asks you to send it as well, that is a
  separate outward action and goes through the normal confirmation of that exact action.

## How to use this skill

1. **Identify the communication type** from the request.
2. **Read the matching guideline file** in this skill's `examples/` folder (with `read_skill_file` where that tool is
   offered, otherwise from this skill's folder):
   - `examples/3p-updates.md` - For Progress/Plans/Problems team updates
   - `examples/company-newsletter.md` - For company-wide or team newsletters
   - `examples/faq-answers.md` - For answering frequently asked questions
   - `examples/general-comms.md` - For anything else that doesn't explicitly match one of the above
3. **Follow the guideline file** for structure, tone and content gathering, within the ground rules above.
4. **Hand over** the draft, the sources each statement rests on, and the list of gaps and assumptions.

If the communication type matches none of the guidelines, use `examples/general-comms.md`, state the audience,
purpose and tone you assumed, and deliver the draft.

## Keywords

3P updates, status report, leadership update, company newsletter, company comms, weekly update, FAQs, common
questions, project updates, incident report, internal comms

---
Adapted from the Apache-2.0 `internal-comms` skill in github.com/anthropics/skills. What changed and why is listed in
`SOURCE.md`; the license is in `LICENSE.txt`.
