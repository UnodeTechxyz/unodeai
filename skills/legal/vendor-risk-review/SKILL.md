---
name: vendor-risk-review
description: Assess a third-party vendor package -- security questionnaire, certifications, sub-processors, and contract terms -- into a findings list with evidence. Use for third-party due diligence, not for package dependency triage.
---

# Vendor Risk Review

This is third-party due diligence. For package and dependency CVE or licence triage use
`dependency-risk-triage` instead; conflating the two produces a review that covers neither.

1. Inventory what the vendor actually supplied: questionnaire responses, certifications (SOC 2, ISO 27001),
   pen-test summaries, sub-processor list, DPA, and status-page history. **List what is missing first** -- an
   absent artefact is the finding most often lost in a long review.
2. For every certification record the scope statement and the report period, not just the badge. A current
   badge over an expired or narrowly scoped report is the standard failure here.
3. Map questionnaire answers to evidence. An answer with no supporting artefact is `asserted, unevidenced` --
   a distinct category from `evidenced` and from `not answered`.
4. Record where the data will live, which sub-processors touch it, and what the vendor commits to on
   notice-of-change. Quote the commitment or mark it absent.
5. Note contractual security terms that contradict the questionnaire. Contradictions between what a vendor
   says and what it signs are findings in their own right.
6. Rate findings by their impact **on the data being shared**, and state the data classification you assumed.
7. **Stop at the boundary.** Produce findings and open questions. Accepting a risk is a decision for the
   owner of the data and the budget, not for the reviewer.
