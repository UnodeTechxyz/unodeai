# Source and changes: security-threat-model

| | |
| --- | --- |
| Upstream repository | https://github.com/openai/skills |
| Upstream commit | `49f948faa9258a0c61caceaf225e179651397431` (committed 2026-06-23) |
| Upstream path | `skills/.curated/security-threat-model/` |
| License | Apache License 2.0; `LICENSE.txt` is the upstream file, unchanged |
| NOTICE | Neither the upstream skill folder nor the repository root has a NOTICE file. |

The upstream repository's README marks it as deprecated in favour of github.com/openai/plugins. This skill was taken
from the commit above; it does not follow either repository automatically.

## Upstream files

SHA-256 of each file as committed upstream (LF line endings).

| Upstream file | SHA-256 | Shipped as |
| --- | --- | --- |
| `SKILL.md` | `1283c0dd62a8104d9edda4583569b5d8510b4ddaa45120687c999250fd96bad2` | `SKILL.md`, adapted |
| `references/prompt-template.md` | `81a59aa3fb3ac3a739d6a26ab38e4015965f215581ee54becef21a2b121ec29b` | `references/prompt-template.md`, adapted |
| `references/security-controls-and-assets.md` | `d536cfa9acad2523dc39134bcf33b9566c29dd9a57b407cbc9901637230c6b98` | `references/security-controls-and-assets.md`, unchanged |
| `agents/openai.yaml` | `3319b59736312abceca614e341c0e59cae47263e3b58a22b2b5ddf1e5fc8c227` | not shipped: display metadata for one host's skill picker |
| `LICENSE.txt` | `4dd13869245e356246a5b770723247bbb80a8f07a181d1d3d873a1734297cdb9` | `LICENSE.txt`, unchanged |

The upstream skill has no scripts.

## What was adapted, and why

- **Frontmatter.** Only `name` and `description` are kept, unquoted. The description keeps the upstream trigger rule
  (only when the user asks for threat modeling) and says when to use the skill.
- **No required pause.** Upstream made the agent stop before the final report, ask the user to confirm its
  assumptions and wait. Here the agent first looks for the service context in the repository and the request, writes
  its key assumptions into the report, and asks 1–3 questions only when a missing fact would change the scope or the
  ranking materially and nothing readable answers it; it continues with the work that does not depend on the answer
  and marks dependent conclusions as conditional. This applies in both `SKILL.md` (step 6) and the prompt template
  (step 7 and the output contract).
- **Report file.** The report is written to `<repo-or-dir-name>-threat-model.md` where the agent can write files and
  the task names no other location; otherwise it is handed over in the reply.
- **Secret hygiene.** The prompt template's rule never to print secrets is repeated in `SKILL.md`.
- **Reading references.** `SKILL.md` says how to read its reference files on every route.
- `agents/openai.yaml` is not shipped; it holds only a display name, a short description and a default prompt for
  another host's picker.
- Line wrapping changed; the remaining guidance is the upstream text. The adapted reference file starts with a
  one-line notice that it was adapted.
