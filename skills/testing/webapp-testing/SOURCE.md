# Source and changes: webapp-testing

| | |
| --- | --- |
| Upstream repository | https://github.com/anthropics/skills |
| Upstream commit | `e4bb5d960d87126ff3b3a8af1a104b7db67560ba` (committed 2026-11-16) |
| Upstream path | `skills/webapp-testing/` |
| License | Apache License 2.0; `LICENSE.txt` is the upstream file, unchanged |
| NOTICE | The upstream skill folder has no NOTICE file. The repository's root `THIRD_PARTY_NOTICES.md` covers imageio, imageio-ffmpeg and FFmpeg, none of which is part of this skill. |

## Upstream files

SHA-256 of each file as committed upstream (LF line endings).

| Upstream file | SHA-256 | Shipped as |
| --- | --- | --- |
| `SKILL.md` | `51b7349e77ec63b7744a6f63647e7566a0b4d2e301121cc10e8c2113af6556a2` | `SKILL.md`, adapted |
| `scripts/with_server.py` | `b0dcf4918935b795f4eda9821579b9902119235ff4447f687a30286e7d0925fd` | `references/with-server-helper.md`: code in a fenced block, adapted |
| `examples/element_discovery.py` | `d63c89604a22f8845d724e95dda45db49b1bf57c25ce0a83afbb7b8da3d402f0` | `references/examples.md`, first block, adapted |
| `examples/static_html_automation.py` | `9d533aafb875ee3ab8b8ebf8f5b9003ac8d999da3d09b285cce252e623140064` | `references/examples.md`, second block, adapted |
| `examples/console_logging.py` | `ea46877289acb82da7e7ce59d0bc37c8977cd57e2a006d0c88d7a1c625bf95da` | `references/examples.md`, third block, adapted |
| `LICENSE.txt` | `bc6b3af2f331cbc7fb0da1344efb2cbe5877a31498b4d70dbc7000f3405a1362` | `LICENSE.txt`, unchanged |

## Script conversion

Skill folders carry no scripts. Each upstream script is reference text with its code in a fenced block; the agent
writes it into the workspace when it wants it and runs it with its normal command permission.

| Upstream script | Reference text | Code changes |
| --- | --- | --- |
| `scripts/with_server.py` | `references/with-server-helper.md` | Server output goes to a log file per server (`--log-dir`, default `.skill-helpers/logs`) instead of an unread pipe that can fill and stall the server. Each server starts in its own process group, and cleanup stops the whole process tree (`taskkill /T` on Windows, the process group elsewhere): with `shell=True`, the upstream `terminate()` stopped only the shell, and on Windows the dev server kept running and held the port. Waiting for a port stops as soon as the server process has exited, and the error names the log file. |
| `examples/element_discovery.py` | `references/examples.md` | The screenshot goes to `.skill-helpers/output/` instead of `/tmp`. |
| `examples/static_html_automation.py` | `references/examples.md` | The file URL is built with `Path.as_uri()`, which is correct for Windows paths; upstream's `f'file://{path}'` is not. Output goes to `.skill-helpers/output/` instead of `/mnt/user-data/outputs`. The fixed 500 ms pause after submitting became a wait for the result element. |
| `examples/console_logging.py` | `references/examples.md` | The fixed 1 s pause became a wait for an element. The log is written as UTF-8 to `.skill-helpers/output/console.log` instead of `/mnt/user-data/outputs`. |

## What was adapted, and why

- **Frontmatter.** Only `name` and `description` are kept; the description says when to use the skill.
- **The granted Playwright integration first.** Upstream always wrote Python Playwright scripts. Here the agent first
  uses the managed Playwright MCP integration when it is granted (catalog id `playwright`), then the project's own
  Playwright setup, and writes a script into the workspace only when neither can do the step. When the integration is
  missing, the agent mentions once that it can be granted in the Agent Builder and continues.
- **Scripts are not black boxes.** Upstream said to run the bundled scripts with `--help` and not to read them.
  There are no bundled scripts here; the agent reads the reference text to write the helper.
- **Missing tools in three steps.** Use what is there; install inside the project when the task needs it (pinned
  version, project virtual environment or dev dependency); ask once before a machine-wide install or the browser
  download (exact command, location, approximate size or "unknown"), and on a decline report the command and continue
  with the checks that need no browser.
- **No fixed waits as the rule.** Waiting is for a condition; `networkidle` is the fallback for apps without a
  clearer ready signal.
- **Output paths and clean-up.** Screenshots and logs go into the project; the browser is closed and every started
  server stopped.
- **Honest report.** A check is called visual only when a screenshot or snapshot was looked at; a step that could not
  run is reported as not run.
- **Scope.** The skill says it covers web pages and web apps, not the editor's own interface.
- The adapted reference files start with a one-line notice that they were adapted.
