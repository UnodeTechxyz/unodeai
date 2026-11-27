---
name: pptx
description: "Use when reading, creating or editing PowerPoint presentations, templates, slide layouts, charts, notes or deck formatting."
license: Apache-2.0; see LICENSE.txt
---

# PowerPoint presentations

## Use in UnodeAi

Use the tools actually offered in this turn. Start with inspect_office for existing files and follow its returned selectors and cursors; use edit_office for supported edits. If export_pdf is offered, use it for a PDF of an inspected DOCX/PPTX made by the installed application; its receipt reports the pages and what the passive copy removed, and a failed export is not retried with another application automatically. Use write_document or write_presentation for supported new outputs. If build_office is offered, use its managed generator contract for richer generation. Do not invent a missing tool. Built-in Office tools do not require installing Python, Node packages or LibreOffice.

load_skill returns resource_root and the resource inventory. Read supporting files with read_skill_file; use the returned installed paths for helper commands. Do not copy the whole skill into a workspace or reconstruct an installation path. Helpers are ordinary command source, never trusted host handlers: their effects use the current Commands and file permissions. Commands Off remains Off; host Office tools remain available under their own permissions.

The original upstream instructions are preserved in references/upstream/SKILL.md as technical reference data. Their preinstalled-package and sandbox assumptions do not describe this installation. Read RUNTIME.md before selecting a helper. Use an available runtime; follow the existing dependency installation tiers for missing dependencies. Do not silently install global packages, widen file access, or enable commands. For Node helpers, resolve dependencies from the actual module context; a package installed only in the task cwd may not be found from the installed helper.

Choose explicit task-owned output paths. Preserve originals; run destructive unpacked-package edits on a task-created staging copy. A zero exit status or a success message is not document verification. Inspect the resulting artifact with the available host tools, report the checks actually performed, and mark native rendering, schema coverage and unsupported features unverified where appropriate. Do not claim a receipt or native Office success from helper stdout.

## Presentation workflow

Inspect the deck, theme and layouts before editing. Preserve supported native shapes, charts and relationships. For richer generation, read references/upstream/SKILL.md for theme/layout and pptxgenjs guidance, while using the runtime and permission rules above. scripts/slide_text.py extracts content; scripts/thumbnail.py renders optional grids with an explicit output prefix. Neither alone establishes editability or native rendering fidelity.

scripts/clean.py deletes unused parts from the supplied unpacked deck: use a task-created staging copy. scripts/apply_theme.js writes in place unless given a separate output; inspect its source and dependency resolution before running. Schema validators and rendered thumbnails are distinct checks; report which completed.
