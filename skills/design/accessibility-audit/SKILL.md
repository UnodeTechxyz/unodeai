---
name: accessibility-audit
description: Evaluate UI components against WCAG 2.1 AA — contrast, labels, keyboard nav, ARIA. Use when you need a repeatable accessibility-audit procedure while planning, building, or reviewing work.
---

# Accessibility Audit

Audit a UI component against WCAG 2.1 AA:
1. **Color contrast**: all text meets 4.5:1 (normal) / 3:1 (large) ratio. Run a contrast checker on the color tokens.
2. **Keyboard navigation**: every interactive element is reachable via Tab, has a visible focus indicator, and doesn't trap focus.
3. **Labels and names**: every input, button, and link has an accessible name (aria-label, aria-labelledby, or visible text).
4. **ARIA roles**: landmarks (banner, main, navigation) are used correctly; no aria-* attributes violate the spec.
5. **Screen-reader flow**: the reading order matches the visual order; dynamic content announces via aria-live regions.

For each violation, provide the file:line, the WCAG criterion number, and a concrete fix.
