# Third-Party Notices

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
