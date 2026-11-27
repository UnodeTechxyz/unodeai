---
name: accessibility-audit
description: Audit pages, flows and whole user journeys against the project's declared WCAG target (WCAG 2.2 is current) for keyboard use, focus, contrast, forms and structure. Use when you need a repeatable accessibility-audit procedure while planning, building, or reviewing work.
---

# Accessibility Audit

Scope: pages, interactive flows and complete user journeys (for example sign-up, checkout, settings). The
semantics, keyboard behaviour and states of a single component belong to the skill whose name contains
`component-a11y`; if you have its findings, cite them here instead of checking the same thing again.

1. **Find the target.** Read the project's declared conformance target (for example "WCAG 2.1 AA") and name its
   version in the report. WCAG 2.2 is the current W3C Recommendation; 2.0 and 2.1 targets are still valid.
   Against an older target, a criterion that is new in 2.2 is a note, not a failure. With no declared target,
   use WCAG 2.2 AA and say that you chose it.
2. **Decide how you observe.** This host has no browser or render tool. If the project has a script that
   renders or tests pages (for example a Playwright, Cypress or axe script in its package scripts or Makefile),
   run it and use its output. Otherwise read the code, and say at the top of the report that the findings were
   read from code, not rendered.
3. **Walk each journey end to end.** Every step can be reached and operated with the keyboard alone, focus order
   follows the visual order, focus stays visible and is not hidden behind sticky content, and nothing traps focus.
4. **Page structure.** Page title, page language, headings and landmarks, and a skip link where navigation
   repeats.
5. **Contrast.** Text 4.5:1 (3:1 for large text); controls, focus indicators and meaningful graphics 3:1. When
   you cannot render, compute it from the colour values or tokens.
6. **Forms and errors.** Every input has a label; errors are announced and say how to fix them; sign-in does not
   depend on a memory or puzzle test alone.
7. **Dynamic content.** Status messages and live updates are announced; moving content can be paused.
8. **Zoom and reflow.** Content works at 200% zoom and at 320 CSS px width. This needs rendering; if you could not
   render, list it as not verified.

For each finding give: the page or step, file:line, the WCAG criterion number and version, `rendered` or
`read from code`, and a concrete fix.
