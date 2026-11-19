---
name: component-a11y
description: Verify a frontend component's semantics, keyboard behaviour, focus handling and states for accessibility. Use when you need a repeatable component-a11y procedure while planning, building, or reviewing work.
---

# Component Accessibility

Scope: one component and its variants: semantics, keyboard behaviour, focus and states. Page structure and whole
user journeys belong to the skill whose name contains `accessibility-audit`, which can cite this report.

1. **Target.** Use the project's declared WCAG target and name its version in the report. WCAG 2.2 is current;
   2.0 and 2.1 targets are still valid. With no declared target, use WCAG 2.2 AA and say so.
2. **Semantic HTML.** The right native element (`<button>` for actions, `<a>` for navigation, `<label>` for
   inputs). A custom widget follows the matching ARIA pattern and role.
3. **Name, role and state.** A meaningful accessible name; states exposed and kept current (for example
   `aria-expanded`, `aria-selected`, `aria-invalid`, disabled).
4. **Keyboard.** Every interactive part is reachable with Tab; Enter or Space activates; arrow keys work where
   the pattern expects them; Escape closes an overlay.
5. **Focus.** A visible focus indicator; focus moves sensibly when the component opens or closes and returns to
   the control that opened it; no focus trap, except a modal that releases focus when it closes.
6. **Every state.** Default, hover, focus, active, disabled, loading, error and empty.
7. **Colour independence.** Information is not conveyed by colour alone; icon-only controls have a name;
   decorative icons are hidden from assistive technology.
8. **Observation.** This host has no browser or render tool. If the project has a component test or story
   runner with an accessibility check (for example jest-axe, a Storybook accessibility add-on, Playwright), run
   it. Otherwise say that the findings were read from code.

Output: each finding with file:line, the WCAG criterion and version, `rendered` or `read from code`, and a fix.
