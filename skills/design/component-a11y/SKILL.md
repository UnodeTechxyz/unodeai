---
name: component-a11y
description: Verify a frontend component is keyboard, screen-reader, and focus friendly. Use when you need a repeatable component-a11y procedure while planning, building, or reviewing work.
---

# Component Accessibility

Verify a frontend component meets accessibility expectations:
1. **Semantic HTML**: use the correct element (`<button>` for actions, `<a>` for navigation, `<label>` for inputs).
2. **Keyboard**: all interactive parts are reachable via Tab, have visible focus, and support Enter/Space activation.
3. **Screen reader**: the component has a meaningful accessible name, role, and state (e.g., `aria-expanded` for toggles).
4. **Focus management**: focus moves sensibly when the component opens/closes; focus traps are avoided or documented.
5. **Color independence**: information is not conveyed by color alone; icons have labels or are hidden from assistive tech when decorative.

Output: an accessibility report with file:line references and fix suggestions.
