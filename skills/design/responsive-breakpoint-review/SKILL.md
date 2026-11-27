---
name: responsive-breakpoint-review
description: Verify a layout across the breakpoints the project actually declares, including the states that appear at only one size. Use when reviewing responsive web work.
---

# Responsive Breakpoint Review

This host has no browser or render tool. If the project has a script that renders pages at given widths (for
example a Playwright or Storybook screenshot script, or visual tests), run it at each breakpoint. Otherwise review
the CSS and markup, say at the top of the report that nothing was rendered, and mark every finding `rendered` or
`read from code`.

1. Read the breakpoints from the project's own configuration. Reviewing against remembered device widths
   tests a layout nobody ships.
2. At each declared breakpoint check: no horizontal page scroll, no clipped or overlapping text, tap targets
   large enough, and images that scale rather than overflow.
3. Check the boundaries, not just the middles. Defects cluster one pixel either side of a breakpoint.
4. Check content extremes at every size: the longest realistic string, the empty state, and a list long
   enough to scroll. Fixed-height containers fail on real content, not on placeholder text.
5. Verify that a wide-only control has a reachable equivalent when it collapses. A control that simply
   disappears below a width is a removed feature, not a responsive design.
6. Check zoom to 200% and a narrow window separately -- they are different failures, and only one of them is
   a device width. Both need rendering; if you could not render, list them as not verified.
7. Report each finding with the width at which it appears, so it can be reproduced, and whether it was
   `rendered` or `read from code`.
