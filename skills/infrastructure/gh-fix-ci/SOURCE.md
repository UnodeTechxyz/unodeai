# Source and changes: gh-fix-ci

| | |
| --- | --- |
| Upstream repository | https://github.com/openai/skills |
| Upstream commit | `49f948faa9258a0c61caceaf225e179651397431` (committed 2026-06-23) |
| Upstream path | `skills/.curated/gh-fix-ci/` |
| License | Apache License 2.0; `LICENSE.txt` is the upstream file, unchanged |
| NOTICE | Neither the upstream skill folder nor the repository root has a NOTICE file. |

The upstream repository's README marks it as deprecated in favour of github.com/openai/plugins. This skill was taken
from the commit above; it does not follow either repository automatically.

## Upstream files

SHA-256 of each file as committed upstream (LF line endings).

| Upstream file | SHA-256 | Shipped as |
| --- | --- | --- |
| `SKILL.md` | `7b326b4a2f0f5f85122144628ec02077e48841e0e0e82efce88b3415bcfb7c26` | `SKILL.md`, adapted |
| `scripts/inspect_pr_checks.py` | `9459e5b03f86785d184a83e5cd8d621b832e918ec04158a2962d867785812c6c` | `references/inspect-pr-checks-helper.md`: code in a fenced block, two decoding changes |
| `agents/openai.yaml` | `36f73b9450504983d1647c960689596f59bf9147c14b1b43162912ed7ada9af6` | not shipped: display metadata for one host's skill picker |
| `assets/github-small.svg` | `ee05e92d373d4d84f4612af3c1090ef67698d421bbe30896a4ed5a00cb86a069` | not shipped: picker icon referenced only by `agents/openai.yaml` |
| `assets/github.png` | `d55a9baa41798d8b5108e3058df3a5bda09914ea9fd73b49929cc38a8832424f` | not shipped: picker icon referenced only by `agents/openai.yaml` |
| `LICENSE.txt` | `4dd13869245e356246a5b770723247bbb80a8f07a181d1d3d873a1734297cdb9` | `LICENSE.txt`, unchanged |

## Script conversion

| Upstream script | Reference text | Code changes |
| --- | --- | --- |
| `scripts/inspect_pr_checks.py` | `references/inspect-pr-checks-helper.md` | `run_gh_command` and `find_git_root` decode output as UTF-8 with replacement instead of the console code page, so a log line the code page cannot represent no longer stops the helper on Windows. No other code change. |

Skill folders carry no scripts. The agent writes the helper into the workspace when it wants it and runs it with its
normal command permission; without Python it uses the manual `gh` commands in `SKILL.md`.

## What was adapted, and why

- **Frontmatter.** Only `name` and `description` are kept, unquoted; the description says when to use the skill.
- **The user's task sets the scope.** Upstream always stopped for explicit approval of a fix plan and asked before
  opening a pull request. Here a request to fix the CI is the authorization to fix it, without a separate plan
  approval; a request only to diagnose produces a diagnosis and a plan and no change. The plan-skill reference
  (`create-plan`) was removed.
- **The project's rules, not new gates.** The skill follows the repository's own contribution and agent instruction
  files and team rules and adds no gates of its own.
- **Outward actions, stated as the host handles them.** Pushes and the pull request writes UnodeAi recognises go
  through its normal confirmation. `gh run rerun`, `gh workflow run`, `gh pr edit` and changing `gh api` calls are
  not recognised as outward actions; the skill says so and runs them only when the task asks for exactly that, and it
  never starts a CI run on its own to check a fix.
- **Missing or signed-out gh.** Upstream told the user to run `gh auth login`. Here: use a granted GitHub integration
  or a signed-in `gh` first; installing `gh` is a system install with one ask (exact command, location, size or
  "unknown"), and a decline leaves the rest of the work running; signing in is the user's own `gh auth login
  --hostname <host>` in their terminal, never a token searched for in files or pasted into the chat; installed and
  signed in are reported separately.
- **Locating the cause.** Steps to reproduce the failing step locally, to separate change failures from environment
  failures, and to redact secrets printed into logs were added. `gh run view --log-failed` was added beside
  `--log`.
- **Reporting.** Remote CI is reported as passing only after it has run again, never from local results.
- `agents/openai.yaml` and the two icons are not shipped; they serve only another host's skill picker.
- The adapted reference file starts with a one-line notice that it was adapted.
