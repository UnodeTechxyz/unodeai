# Third-Party Notices

## Office editorial advice references

`OfficeDocumentAdvice.ts` is original MIT-licensed repository code. It contains no copied W3C text, rule tables,
zhlint or write-good code. Its `clreq-mixed-text` source id references the W3C Chinese Layout Requirements,
[Group Note Draft, 4 November 2026](https://www.w3.org/TR/2026/DNOTE-clreq-20261104/), Copyright © 2015–2026
World Wide Web Consortium. The `wcag-text-alternatives` id references the informative
[WCAG 2.2 Understanding Non-text Content](https://www.w3.org/WAI/WCAG22/Understanding/non-text-content).
These reference documents use the [W3C document license](https://www.w3.org/copyright/document-license-2023/).
The local implementation is a limited suggestion system, not a copy, translation, modification of those documents,
grammar checker, accessibility conformance test or rendered layout check. Decorative-image, quoted-text and
style exceptions remain for the author to assess. Other rules use source id `local-editorial-v1` and original MIT
heuristics. It never rewrites content or refuses a save because of these suggestions.

## Bundled runtime libraries

The production VSIX bundles a small set of JavaScript runtime libraries into `out/extension.js`. The build
derives this set from esbuild's actual input graph and includes each package's complete license text under
`third_party_licenses/` in the VSIX. This prevents license notices from being lost when dependencies are
compiled into a single file.

The runtime set includes the Model Context Protocol SDK, AJV and its schema helpers, UUID, Zod and its JSON
Schema adapter, EventSource parsing, PKCE support, cross-platform process-spawn helpers, and Mozilla PDF.js.
The separate DOCX generation worker bundles yazl 3.3.1 and buffer-crc32 (MIT); their complete licenses are
collected from that worker's build graph by the same runtime-license packaging step. It does not bundle a font,
canvas or native add-on.
Workbook and Office generation workers use SheetJS SSF 0.11.2 and frac 1.1.2 (Apache-2.0) for stored spreadsheet
number/date format display. Their package licenses are included by the same graph-driven packaging step. Exact
workbook arithmetic remains repository code; these libraries do not evaluate formulas or access the network.
The same generation worker uses pdf-lib 1.17.1 and fontkit 2.0.4 for PDF output. Its graph also includes
fontkit's pure-JavaScript brotli dictionary, Unicode lookup packages, and @swc/helpers (Apache-2.0).
Their complete package licenses are included by the same graph-driven packaging step. System fonts are
read locally only for a render job; only permitted glyph subsets enter that user's PDF, never the extension.
The Unicode lookup data in fontkit is used for shaping, not to replace the pinned admission table below.
The published fontkit 2.0.4, dfa 1.2.0 and brotli 1.3.3 archives declare MIT in their README but omit a
standalone license file. Their generated notices retain the package author credit and versioned source,
and supply the standard MIT permission/warranty text without inventing a copyright year. The brotli
notice additionally retains its decoder/dictionary source copyright notices (Google, 2013) and the complete
Apache-2.0 license. These reviewed supplements are pinned to those exact versions and published README
digests; they are not a generic inference that any package with a missing license is MIT.
The Office edit, render-copy, chart and data-check paths read and write Office packages with JSZip 3.10.1,
used under the MIT option of its MIT-or-GPL-3.0 dual license, together with its pako, lie, immediate,
setimmediate and readable-stream dependencies and their helpers. Their complete package licenses are included
by the same graph-driven packaging step.
PDF.js is bundled only in the local PDF worker used for temporary native-text extraction; its Apache-2.0
license text is included with the other generated runtime-license files in the VSIX. That worker also
bundles `@napi-rs/canvas`'s pure-JavaScript geometry polyfill for `DOMMatrix`; no platform-specific native
canvas binary is shipped. All runtime libraries are used locally by the extension; none is a remotely
downloaded plugin or executable.

## Unicode character data

The document layout admission table is derived from the pinned Unicode Character Database 17.0.0.
Source URLs, exact hashes, and generator revision are recorded in the document testdata manifest.
The following notice applies to that data and its generated table:

```text
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.
```

## Agent Skills adapted from third-party sources

Six bundled Agent Skills are adapted from Apache License 2.0 skills published by others. They ship as instruction
and reference text only: each upstream script became Markdown reference text, and no upstream code is executed or
bundled as a program. Each skill folder under `skills/` carries the upstream `LICENSE.txt` unchanged and a
`skills/<category>/<skill>/SOURCE.md` that records the upstream commit, the SHA-256 of every upstream file, and what was changed and why.
Neither upstream skill folder has a NOTICE file.

| Skill | Upstream source | Upstream commit | License |
| --- | --- | --- | --- |
| `skills/design/frontend-design` | https://github.com/anthropics/skills, `skills/frontend-design` | `e4bb5d960d87126ff3b3a8af1a104b7db67560ba` | Apache-2.0 |
| `skills/documentation/internal-comms` | https://github.com/anthropics/skills, `skills/internal-comms` | `e4bb5d960d87126ff3b3a8af1a104b7db67560ba` | Apache-2.0 |
| `skills/testing/webapp-testing` | https://github.com/anthropics/skills, `skills/webapp-testing` | `e4bb5d960d87126ff3b3a8af1a104b7db67560ba` | Apache-2.0 |
| `skills/development/mcp-builder` | https://github.com/anthropics/skills, `skills/mcp-builder` | `e4bb5d960d87126ff3b3a8af1a104b7db67560ba` | Apache-2.0 |
| `skills/security/security-threat-model` | https://github.com/openai/skills, `skills/.curated/security-threat-model` | `49f948faa9258a0c61caceaf225e179651397431` | Apache-2.0 |
| `skills/infrastructure/gh-fix-ci` | https://github.com/openai/skills, `skills/.curated/gh-fix-ci` | `49f948faa9258a0c61caceaf225e179651397431` | Apache-2.0 |

The license files of `internal-comms`, `webapp-testing` and `mcp-builder` state "Copyright 2026 Anthropic, PBC.".
The license files of `frontend-design`, `security-threat-model` and `gh-fix-ci` contain the Apache License 2.0 text
without a filled-in copyright line. The modified files carry a notice that they were changed.

## Catalog references

UnodeAi's bundled Marketplace catalog (`marketplace/*.json`) references third-party Model Context
Protocol (MCP) servers and external agent runtimes. UnodeAi does **not** bundle or redistribute
their code — the catalog only contains metadata (name, package/command, and the user-approved
install configuration). Each referenced project is the property of its respective authors and is
governed by its own license.

## Model Context Protocol servers

The MCP server entries (filesystem, git, github, fetch, memory, sqlite, puppeteer, brave-search,
time, sequential-thinking, slack, gitlab, google-maps, everything) reference packages from the
**Model Context Protocol servers** project, licensed under the MIT License.

- Source: https://github.com/modelcontextprotocol/servers (and the archived
  https://github.com/modelcontextprotocol/servers-archived)
- License: MIT — Copyright (c) Anthropic, PBC and the MCP servers contributors.

These packages are fetched and run on the user's machine via `npx`/`uvx` only after the user
explicitly installs and approves them through UnodeAi's MCP approval gate.

## Hermes

The "Hermes Bridge" / "Hermes Operator" entries integrate with **Hermes**, an open-source autonomous
agent by Nous Research, via a user-provided MCP endpoint. UnodeAi does not bundle the Hermes
runtime; the user runs and points UnodeAi at their own Hermes bridge.

- Project: https://github.com/NousResearch (Hermes)

---

If you are a maintainer of a referenced project and would like an entry amended or removed, please
open an issue on the UnodeAi repository.

### docx and pptx source resources (v0.9.107)

The managed Office runner additionally uses docx 9.7.1 (MIT; Copyright (c) 2016 Dolan), pinned published revision 4934d310c724520ad9d3e7e6d5d47430664ea9f7. Its prebundled components have separate retained notices: `scripts/license-texts/docx-9.7.1-embedded.json` records exact upstream lock paths, versions, archive integrities and original license hashes; the accompanying text is included in the generated docx runtime notice. This covers 53 package/version records including nested readable-stream versions and JSZip's internal dependencies. JSZip uses its MIT license option. The local build preserves original installed bytes and patches two embedded nanoid loop conditions to the upstream 5.1.16 non-secure fix, with exact original bundle-hash checks. It does not claim the upstream docx package itself was republished or all internal components upgraded.

Source: anthropics/skills at e4bb5d960d87126ff3b3a8af1a104b7db67560ba, skills/docx and skills/pptx. License: Apache-2.0. Original LICENSE.txt is retained in each bundled skill. The 61 docx and 58 pptx original files are preserved byte-for-byte, with original SKILL.md relocated to references/upstream/SKILL.md. UnodeAi adapts the active instructions and adds SOURCE.md, RUNTIME.md and upstream-files.json. Per-file mapping and SHA-256 records accompany both skills. Upstream archive SHA-256: 28cc73b0b22d9129002f027bc2420d2a0faef0313e8806d4624adb80f0c2ea08. These sources do not imply upstream endorsement or installed optional dependencies.
