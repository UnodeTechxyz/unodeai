# Source and changes: mcp-builder

| | |
| --- | --- |
| Upstream repository | https://github.com/anthropics/skills |
| Upstream commit | `e4bb5d960d87126ff3b3a8af1a104b7db67560ba` (committed 2026-11-16) |
| Upstream path | `skills/mcp-builder/` |
| License | Apache License 2.0; `LICENSE.txt` is the upstream file, unchanged |
| NOTICE | The upstream skill folder has no NOTICE file. The repository's root `THIRD_PARTY_NOTICES.md` covers imageio, imageio-ffmpeg and FFmpeg, none of which is part of this skill. |

## Upstream files

SHA-256 of each file as committed upstream (LF line endings).

| Upstream file | SHA-256 | Shipped as |
| --- | --- | --- |
| `SKILL.md` | `b483b56d6673134497e45489c317f26ae0f1429c194db0297e43073e17e6748c` | `SKILL.md`, adapted |
| `reference/mcp_best_practices.md` | `80fb4369a349447cf18ecdd7494fe7938b6065377e9f08c077cec411093a3007` | `reference/mcp_best_practices.md`, unchanged |
| `reference/node_mcp_server.md` | `ee3c95d812e450f6168b734390d0c9ef6f8ebeef041d73a122c972dfbd4d476a` | `reference/node_mcp_server.md`, unchanged |
| `reference/node_mcp_server_v2.md` | `49b2fe48f33910b743ae3a56353fffa5d5f252f531053f24f2da4e5914c0d3aa` | `reference/node_mcp_server_v2.md`, two passages adapted |
| `reference/python_mcp_server.md` | `2da52f77e675191014ca2e146a4b95aa04d0ca7dd7e2b100322df15ade685e80` | `reference/python_mcp_server.md`, unchanged |
| `reference/evaluation.md` | `8c99479f8a2d22a636c38e274537aac3610879e26f34e0709825077c4576f427` | `reference/evaluation.md`; question-writing part unchanged, "Running Evaluations" rewritten |
| `scripts/connections.py` | `9403668a2041568772082a8b334122c1f88daf0541fb393af4522d0094a47a6e` | `reference/connection-helper.md`: code unchanged in a fenced block, with a command line added |
| `scripts/evaluation.py` | `49ed1d17cdce5da101b210197740713f49b935c29d4f339542a14b132658e6f7` | not shipped as code; its report layout is kept in `reference/evaluation.md` |
| `scripts/example_evaluation.xml` | `9272b348ddcc4b06ba562367ccd0770e018158c0068ac5116d5e34aaeff8777a` | `reference/example-evaluation.md`: the XML unchanged in a fenced block |
| `scripts/requirements.txt` | `d5d7558b2368ecea9dfeed7d1fbc71ee9e0750bebd1282faa527d528a344c3c7` | not shipped; the `mcp` requirement is described in `reference/connection-helper.md`, the model SDK requirement is dropped with the runner |
| `LICENSE.txt` | `bc6b3af2f331cbc7fb0da1344efb2cbe5877a31498b4d70dbc7000f3405a1362` | `LICENSE.txt`, unchanged |

## Script conversion

Skill folders carry no scripts. The agent writes a helper into the workspace when it wants it and runs it with its
normal command permission.

| Upstream file | Reference text | What changed |
| --- | --- | --- |
| `scripts/connections.py` | `reference/connection-helper.md` | The connection classes are unchanged. A command line was added (`list`, and `call <tool> <json>`, with the stdio server command after `--`) so the current agent can initialize a server, list its tools and call one tool per command. It calls no model and reads no key. |
| `scripts/evaluation.py` | removed; replaced by "Running Evaluations" in `reference/evaluation.md` | Intentionally not converted. Upstream installed a model vendor's SDK, read an API key from the environment and sent each question to a model through its own paid API calls. Here the current agent answers each question with the model, budget and tools it already has, through the server's tools (granted, or through the connection helper), compares answers by exact string, and records the report in the upstream runner's layout. No API client, no key from the environment or a credentials file, no pasted key, no background pipeline. This is not a drop-in replacement for the runner: the agent that wrote the answers also runs them, and the report says so. |
| `scripts/example_evaluation.xml` | `reference/example-evaluation.md` | Unchanged XML in a fenced block, with a note that it shows the format only. |
| `scripts/requirements.txt` | none | `anthropic>=0.39.0` is dropped with the runner; `mcp` is installed into a project virtual environment with a pinned version when the connection helper needs it. |

## What was adapted, and why

- **Frontmatter.** Only `name` and `description` are kept; the description says when to use the skill.
- **No separate paid evaluation runner.** See the conversion table above.
- **No automatic migration or registration.** Upstream told the agent to migrate v1 projects with
  `npx @modelcontextprotocol/codemod@latest` when asked and pointed at the latest codemod. Here the agent tells the
  user once that v2 exists, continues with the project's SDK, and migrates only when asked, with a pinned codemod
  version and one ask before the `npx` download. The built server is never added to the user's integrations or CLI
  configuration by the skill.
- **Missing tools in three steps.** Use what the project declares; install the SDK, test client or `mcp` package
  inside the project with pinned versions when the task needs them; ask once before `npx` of an undeclared package
  (such as the Inspector) or a global install, and on a decline report the command and continue.
- **Local test.** Phase 3 names the four things a local server must prove (initialize, list tools, valid call,
  readable error) and the two ways to prove them without a model: the v2 self-check script and the connection helper.
- **Tool names.** Upstream named one assistant's web-fetch tool; the text now says "your web-fetch tool".
- **Stack.** The recommended stack yields to the project's existing language; emoji link labels became plain paths.
- `reference/node_mcp_server_v2.md`: the Inspector bullet says how to get the Inspector without an unasked download,
  and the migration section says to migrate only when asked, with a pinned codemod version and one ask first.
- The adapted reference files start with a one-line notice that they were adapted.
