---
name: design-system-consistency
description: Check that a screen or component reuses the design system rather than re-inventing it: tokens, spacing, type scale, states and variants. Use when reviewing UI work against an existing system.
---

# Design System Consistency

1. Locate the system first: token file, component library, or the closest existing implementation. If none
   exists, say so -- a consistency review against nothing is a style opinion.
2. List every colour, spacing, radius, shadow and font size the work introduces as a **literal value**, and
   name the token it should have used. Literals are how a system erodes.
3. Check the state set of every interactive element: default, hover, focus-visible, active, disabled,
   loading, error, empty. A missing focus-visible is both a consistency and an accessibility failure -- see
   `accessibility-audit`.
4. Check that a new component is genuinely new. A variant of an existing component that was rebuilt instead
   of extended is the most expensive kind of inconsistency to unwind.
5. Verify the type scale and spacing rhythm against the system rather than against how it looks.
6. Report each finding as `file:line`, the literal used, and the token that exists. A finding without a
   named replacement is not actionable.
