# Source and changes: frontend-design

| | |
| --- | --- |
| Upstream repository | https://github.com/anthropics/skills |
| Upstream commit | `e4bb5d960d87126ff3b3a8af1a104b7db67560ba` (committed 2026-11-16) |
| Upstream path | `skills/frontend-design/` |
| License | Apache License 2.0; `LICENSE.txt` is the upstream file, unchanged |
| NOTICE | The upstream skill folder has no NOTICE file. The repository's root `THIRD_PARTY_NOTICES.md` covers imageio, imageio-ffmpeg and FFmpeg, none of which is part of this skill. |

## Upstream files

SHA-256 of each file as committed upstream (LF line endings).

| Upstream file | SHA-256 | Shipped as |
| --- | --- | --- |
| `SKILL.md` | `d91970639e9f5c37682ac7ab60094d35f1c7c1f38d731bd56396563aee10c1d3` | `SKILL.md`, adapted |
| `LICENSE.txt` | `0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594` | `LICENSE.txt`, unchanged |

The upstream skill has no scripts.

## What was adapted, and why

- **Frontmatter.** Only `name` and `description` are kept, as this product's skill format allows. The upstream
  `license` field is recorded here instead. The description now says when to use the skill.
- **Existing product style first.** A new opening section makes the project's brand, design tokens, component system
  and an editor webview's theme tokens take precedence, so the skill does not overturn an existing product style by
  default. The upstream "design studio" stance applies when the brief leaves the direction open.
- **No required confirmation.** Upstream asked to "confirm with the client" the subject the agent inferred. Here the
  agent writes its assumptions into the design plan and asks only when the brief is too ambiguous to design anything;
  the plan review is the agent's own check, not a stop for approval.
- **Context source.** "Information in your memory" became project files, team rules and earlier messages.
- **Visual checks are named honestly.** The self-critique step says to render the page the project's way or with a
  granted browser integration, to check a wide and a narrow width and keyboard focus, and to call a review visual
  only when a render or screenshot was actually looked at.
- **Brand reference.** The calibration list kept its traits; the remark naming one vendor's own interface accent
  became a neutral description.
- **Hand-over.** A short closing section names what to hand over.
- Line wrapping changed; the remaining guidance is the upstream text.
