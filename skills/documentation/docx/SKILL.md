---
name: docx
description: "Use when reading, creating or editing Word documents, templates, tracked changes, comments, tables or document formatting."
license: Apache-2.0; see LICENSE.txt
---

# Word documents

## Use in UnodeAi

Use the tools actually offered in this turn. Start with inspect_office for existing files and follow its returned selectors and cursors; use edit_office for supported edits. If export_pdf is offered, use it for a PDF of an inspected DOCX/PPTX made by the installed application; its receipt reports the pages and what the passive copy removed, and a failed export is not retried with another application automatically. To change the body text of a PDF made from a Word document, edit that DOCX with edit_office (tracked by default) and export it again with export_pdf, naming the earlier PDF in regenerates_pdf; for a combined PDF, put the new pages in with edit_pdf replace_pages and repeat the overlays on them. Without the source DOCX, convert_pdf_to_docx (when offered, Windows with Word) turns a PDF that has a text layer into an editable .docx; it runs only after the user has turned off Word's PDF-conversion notice and otherwise returns the steps for them. Word's conversion can change the layout, so compare the old and new PDF pages side by side with view_pdf_pages before delivering. Use write_document or write_presentation for supported new outputs. If build_office is offered, use its managed generator contract for richer generation. Do not invent a missing tool. Built-in Office tools do not require installing Python, Node packages or LibreOffice.

For Excel workbooks that a document reports on or produces, use read_workbook, then edit_workbook for an existing .xlsx or write_workbook for a new one. When the user states a relationship (for example A = B+C+D, a total or a share), write a formula, not a number you computed; write fixed numbers only when the user asks for fixed values. These tools save formulas without recalculating them: say so, and never quote a formula result you did not read from a recalculated file.

load_skill returns resource_root and the resource inventory. Read supporting files with read_skill_file; use the returned installed paths for helper commands. Do not copy the whole skill into a workspace or reconstruct an installation path. Helpers are ordinary command source, never trusted host handlers: their effects use the current Commands and file permissions. Commands Off remains Off; host Office tools remain available under their own permissions.

The original upstream instructions are preserved in references/upstream/SKILL.md as technical reference data. Their preinstalled-package and sandbox assumptions do not describe this installation. Read RUNTIME.md before selecting a helper. Use an available runtime; follow the existing dependency installation tiers for missing dependencies. Do not silently install global packages, widen file access, or enable commands. For Node helpers, resolve dependencies from the actual module context; a package installed only in the task cwd may not be found from the installed helper.

Choose explicit task-owned output paths. Preserve originals; run destructive unpacked-package edits on a task-created staging copy. A zero exit status or a success message is not document verification. Inspect the resulting artifact with the available host tools, report the checks actually performed, and mark native rendering, schema coverage and unsupported features unverified where appropriate. Do not claim a receipt or native Office success from helper stdout.

## Word workflow

Inspect the document and supported selectors before editing. Preserve styles, sections, bookmarks, fields and relationships outside the requested change. Read the original technical reference for OOXML details and the relevant helper source before using it. scripts/office/validate.py provides optional source validators, not a complete native Word rendering check.

scripts/accept_changes.py has a fixed /tmp/libreoffice_docx_profile macro location and may report success after a LibreOffice timeout without checking revisions. Do not use its stdout as proof that tracked changes were accepted. Prefer an available verified host/native workflow; if using the helper under existing authority, inspect the resulting document and explicitly verify the revision postcondition or report it unverified.
