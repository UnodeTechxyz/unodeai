---
name: frontend-design
description: Use when building a new web interface or reshaping an existing one and the visual direction, typography, layout or interface copy needs deliberate design choices rather than templated defaults. Works inside the project's existing brand, component system and theme first.
---

# Frontend Design

## Start from what the project already has

Before any new visual direction, look at what the project already decides: its brand, its design tokens, its
component library, and, for an editor extension's webview, the editor's theme tokens. Where they exist, they win.
Your distinctive choices then happen inside them: in hierarchy, composition, copy and the one memorable moment,
not in a new palette that fights the product. Do not overturn an existing product style unless the brief asks for
a new direction. Where the brief or the project pins down a visual direction, follow it exactly.

When the brief leaves the visual direction open, approach it as the design lead at a studio known for giving every
client a distinct visual identity that is not mistaken for anyone else's: make deliberate, opinionated choices about
palette, typography and layout that are specific to this brief, and take aesthetic risk where it is justified.

## Ground your designs in the subject matter

If the brief does not identify what the product or subject matter is, identify it yourself before designing: one
concrete subject, the design's audience and the design's primary job. Write them at the top of your design plan as
the assumptions you designed for. Ask only when the brief is too ambiguous to design anything sensible; an
aesthetic choice does not need the person's confirmation before you build. If project files, team rules or earlier
messages say something about the client's preferences or what they are building, use that as a hint. The subject's
industry, subject matter, materials and vernacular are where distinctive visual choices come from: a design for a
toy for girls aged 8 to 11 will be very aesthetically different from a dashboard for financial analysts. Build with
the brief's real content and subject matter throughout.

## Design principles

For web designs, the hero is the first thing viewers will see. Open with the most characteristic thing in the
subject's world, in the form that is most appropriate: a headline, an image, an animation, a live demo, an
interactive moment, or other treatments. Be deliberate with your choice: a big number with a small label, supporting
stats, and a gradient accent is the default treatment, so only use it if that's truly the best option.

Typography carries the personality of the page. You don't need a different typeface for display or headline text
and body content: use one family or two, and if two, make them clearly distinct.

Choose your typefaces deliberately, not the default families you would reach for on any other project, and set a
clear type scale following the default guidance of The Elements of Typographic Style with intentional weights,
widths, and spacing. When type is used as a headline or visual element, use the type treatment itself as an active
part of the design, not a neutral delivery vehicle for the content. Where the project already sets its typefaces
(or an editor webview inherits the editor's font), keep them and work with scale, weight and spacing instead.

Default to line lengths of less than 80 characters. Serif typefaces can have slightly longer line lengths; give
serif body text slightly more line-height than a sans-serif.

Avoid these default typographic treatments; they are the commonest tells of a generated page:
- Accenting just a single word or phrase in a headline, like putting one word in italic/bold or a different color.
- Using all caps for labels.
- Adding unnecessary typographic labels above content.

Visual structure is information. Structural devices like outlines, borders, numbering, eyebrows, dividers, labels,
etc., encode useful information about the content rather than decorate it. Many generic designs use numbered markers
(01 / 02 / 03), but that's only appropriate if the content actually is a sequence, like a stepped process or a
timeline. Before adding numbered markers, check the content really is a sequence.

Use non-user-triggered motion sparingly and deliberately, only to draw attention. A single orchestrated moment (one
page-load sequence or one reveal) lands better than scattered effects; fade-and-slide-up entrances on each section
and hover transitions on every card are the generic default and read as generated. Motion that answers a person's
action (opening, expanding, confirming) is welcome when it shows what changed.

Consider written content carefully. Often a design brief may not contain real content, and it's up to you to come
up with copy and placeholder content. Copy can make a design feel as templated as the design itself. See the section
on writing below for more guidance.

## Process: plan, review against the brief, build, critique

For calibration, generated design right now clusters around some traits:
1. a warm cream background (near #F4F1EA) with a high-contrast serif display and a terracotta or warm-clay accent
   (often near #D97757, the accent of a well-known AI assistant's own interface, so on a user's brief it reads as a
   tell);
2. a near-black background with a single bright acid-green or vermilion accent;
3. a broadsheet-style layout with hairline rules, zero border-radius, and dense newspaper-like columns;
4. the SaaS-card kit: content chopped into identical rounded cards, one border-radius on everything regardless of
   hierarchy, the same soft grey shadow (rgba(0,0,0,.1)) under each, and gradient washes as decoration;
5. template chrome that appears whatever the subject: a tracked-out ALL-CAPS eyebrow label above every heading; meta
   strings joined with middle dots ('A · B · C'); labels built as 'WORD — fragment' with a spaced em dash; tinted
   near-black (#0B0B0B, #111) standing in for black; a monospace face for small data labels; a '→' appended to link
   and button text.

All traits are legitimate for some briefs, but they are defaults rather than choices, and they appear regardless of
subject. Where the brief pins down a visual direction, follow it exactly: the brief's own words always win, including
when it asks for one of these looks. Where it leaves an axis free, don't spend that freedom on one of these defaults.
As with a hired human designer, there's often a careful balance between doing what you're good at and taking each
project as a chance to experiment and learn.

Work in two passes. First, brainstorm a short design plan based on the client's design brief: create a compact token
system with color, type, layout, and principles. Where the project already has tokens, the plan names which existing
tokens you use and what, if anything, you add.
- Color: describe the core base palette as 4–6 named hex values (or the existing token names).
- Type: the typefaces and their roles.
- Layout: a layout concept, using one-sentence prose descriptions and ASCII wireframes to ideate and compare. Include
  alignment guidance; should the content be left aligned, center aligned, justified?
- Principles: the high-level guidance for what makes this page unique.

Then review that plan against the brief before building: if any part of it reads like the generic default you would
produce for any similar page (work through a similar prompt to see if you arrive somewhere similar) rather than a
choice made for this specific brief, revise that part, and say what you changed and why. Only after you've confirmed
the relative uniqueness of your design plan should you start to write the code, following the revised plan. This
review is your own; it is not a step where you stop and wait for approval.

When writing the code, be careful of structuring your CSS selector specificities. It's easy to generate CSS classes
that cancel each other out (especially with a type-based selector like .section and an element-based selector like
.cta). This can happen often with padding/margin between sections.

## Restraint and self-critique

Spend your boldness in one place. Let one element be the memorable thing, keep everything around it quiet and
disciplined, and cut any decoration that does not serve the brief. Build to a quality floor without announcing it:
responsive down to mobile, visible keyboard focus, every control reachable and usable from the keyboard, reduced
motion respected, visually accessible (contrast, labels), harmonious color palettes. Consider Chanel's advice: before
leaving the house, take a look in the mirror and remove one accessory.

Critique your own work as you build by looking at it. Render the page the project's own way (its dev server, a
script, a screenshot test) or with a browser integration you have been granted, take screenshots at a wide and a
narrow width, and check keyboard focus. A picture is worth a thousand tokens. Call your review visual only when you
actually looked at a rendered page or a screenshot; when you could not render it, say that what you report is read
from the code, not seen, and say what would be needed to look at it.

Human creatives have memory and always try to do something new, so if you have a space to quickly jot down notes
about what you've tried, it can help you in future passes.

## More on writing in design

Words appear in a design for one reason: to make it easier to understand and use. They are design content, not
decoration. Bring the same intentionality and minimalism to copywriting that you would bring to spacing and color.
Before writing anything, ask what the design needs to say, and how it can best be said to help the person navigate
the experience. Write in the language of the brief and the product.

Write from the end user's perspective. Name things by what users will understand in simple language, not by how the
system is built. A user manages notifications, not webhook config. Describe what something is or does in plain terms
rather than selling it. Being specific and legible to new users is always better than being clever.

Use active voice as default. A CTA says exactly what happens when it is used: "Save changes," not "Submit." An action
keeps the same name through the whole flow, so the button that says "Publish" produces a toast that says "Published."
The vocabulary of an interface is the signposting for someone navigating the product. Cohesion and consistency are
how people learn their way around. Where the product already names an action, keep its name.

Treat failure and emptiness as moments for direction, not mood. Explain what went wrong and how to fix it, in the
interface's voice rather than a person's. Errors don't apologize, and they are never vague about what happened. An
empty screen is an invitation to act.

Keep the tone conversational: plain verbs, sentence case, no filler, with tone matched to the brand and the audience.
Let each written element do exactly one job.

## Hand-over

Hand over the working page or component, the design plan you built from (with the assumptions you made), what you
checked (widths, keyboard, contrast) and how: seen in a render or screenshot, or read from the code.

---
Adapted from the Apache-2.0 `frontend-design` skill in github.com/anthropics/skills. What changed and why is listed in
`SOURCE.md`; the license is in `LICENSE.txt`.
