# Source and changes: internal-comms

| | |
| --- | --- |
| Upstream repository | https://github.com/anthropics/skills |
| Upstream commit | `e4bb5d960d87126ff3b3a8af1a104b7db67560ba` (committed 2026-11-16) |
| Upstream path | `skills/internal-comms/` |
| License | Apache License 2.0; `LICENSE.txt` is the upstream file, unchanged |
| NOTICE | The upstream skill folder has no NOTICE file. The repository's root `THIRD_PARTY_NOTICES.md` covers imageio, imageio-ffmpeg and FFmpeg, none of which is part of this skill. |

## Upstream files

SHA-256 of each file as committed upstream (LF line endings).

| Upstream file | SHA-256 | Shipped as |
| --- | --- | --- |
| `SKILL.md` | `067b7587a344a928fc6534ef66b1bcd591fc7c26d207ea7ca3334aeb678d6475` | `SKILL.md`, adapted |
| `examples/3p-updates.md` | `087e4363c0f3513728a7e695eeb9ead5c3ecd12a4681b59340691180e65b68fc` | `examples/3p-updates.md`, adapted |
| `examples/company-newsletter.md` | `30f81cfbdb03858a006169c72169024089c7c5d3d32611d337782da4f38c86b5` | `examples/company-newsletter.md`, adapted |
| `examples/faq-answers.md` | `5ecd3356cd6666937f2ebefa753253edfdbdca15e368d07baf398bfcced72484` | `examples/faq-answers.md`, adapted |
| `examples/general-comms.md` | `4d3a4bb198a77626bcf018e96b2b45a2dbabed172d4ade0fcd70d23ae8a47a47` | `examples/general-comms.md`, adapted |
| `LICENSE.txt` | `bc6b3af2f331cbc7fb0da1344efb2cbe5877a31498b4d70dbc7000f3405a1362` | `LICENSE.txt`, unchanged |

The upstream skill has no scripts.

## What was adapted, and why

- **Frontmatter.** Only `name` and `description` are kept. The upstream description spoke as one company ("the
  formats that my company likes") and named one assistant; it now says what the skill does and when to use it. The
  upstream `license` field is recorded here.
- **The user's format and language first.** The guideline files are defaults for when the user, project or team has
  no template or house style of its own, and the draft is written in the user's language.
- **Evidence only.** Each file now says to use the sources the session actually has (the user's material, workspace
  files, granted integrations), never to invent progress, numbers, names or quotes, and to keep facts apart from
  inference. The named tools (Slack, Google Drive, email, calendar) remain as examples of good sources, not as
  assumed connections.
- **Fewer questions.** Upstream asked the user for the team name, audience, purpose, tone and format before writing.
  The agent now takes them from the request and the sources, asks only for a missing fact that changes the result,
  and otherwise marks the gap (for example `[team name]`) and lists it with the draft.
- **Draft only.** The skill produces a draft. Sending or posting it is a separate outward action that goes through
  the normal confirmation.
- **Newsletter size.** The "1000+ people" company size and the "~20-25 bullet points" length are scaled to the
  organization. A typo ("perhgaps") was corrected.
- **3P format.** The fixed 3P format applies unless the user's own template differs; metrics only where a source
  gives them.
- Every adapted file starts with a one-line notice that it was adapted.
