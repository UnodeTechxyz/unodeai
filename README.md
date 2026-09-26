<p align="center">
  <img src="images/unode.png" alt="UnodeAi" width="128" height="128">
</p>

# UnodeAi

### Turn AI agents into an organized workforce.

**Every AI coding tool can tell you it finished. UnodeAi can show you what it did.**

A project manager agent breaks your goal into tasks and hands them to specialists. Each one has a role, its
own skills, the model you picked for it, and only the permissions you granted. What an agent *claims* stays
separate from what the framework *observed*. An agent saying “done” is never printed as evidence, and no model
is ever asked to grade another model’s work.

[Get started](#quick-start) · [User guide](USAGE.md) · [Security model](SECURITY.md) ·
[Changelog](CHANGELOG.md) · [Models and pricing](https://www.unodetech.xyz/pricing?lang=en)

<!-- Add the Mission Control screenshot here when a real product asset is available. -->

## Built for the work where “it says it’s done” is not enough

| If you… | UnodeAi gives you |
| --- | --- |
| **Bill for the work** — agency, consultancy, contractor | A run exported as one Markdown file the client can read without installing anything, listing every dispatch, decision, approval and scope grant — and what it left out. A portable JSON variant carries no request text, instructions, command lines or file contents; agents and approvers become document-local ordinals, private routes become bounded categories, and write-time hashes prove change equality without retaining source. It declares both what it withheld and what it kept. |
| **Answer to someone** — regulated, procurement-reviewed, or security-reviewed teams | Evidence that was recorded as the work happened, not reconstructed afterwards. Contract, privacy and GRC roles that are read-only by capability, and a sanctions/export-control skill whose correct output is a refusal routed to a named human. |
| **Run more than one agent** | A coordinator that reports `partial` or `blocked` with a reason per undelivered item instead of going quiet — and, if it ends saying nothing, a closeout UnodeAi writes itself from observed facts, claiming nothing about correctness. |
| **Refuse to hand your code to one vendor** | Per-agent routing across Claude, OpenAI Codex, OpenAI-compatible endpoints and your own gateways. Keys live in the OS keychain. Nothing leaves the machine unasked — no telemetry, no control service, no request at activation. |

## Companies already solved this. We’re teaching it to agents.

A company is not just a group of capable people. It’s a set of agreements: who owns what, who decides, who
reviews, and what gets written down. Those agreements are why a hundred people’s work adds up instead of
colliding.

Nobody designed them in a room. They were worked out over a century of getting it wrong, and they remain the
most tested coordination technology we have.

Agents skipped all of it.

The last three years went into making a single agent more capable. Almost none of it went into how several
agents work together. So a team of agents ends up looking like a company with no job titles, no manager, no
sign-off, and no filing cabinet. Everyone is competent. Nothing is accountable.

If you have given an AI real work, you already know how this feels. It sounds just as confident when it fails
as when it succeeds. Nobody reviews it but you. And when it’s finished, you have a chat log where a record
should be.

A better model doesn’t fix that. Ask a stronger one the same way and it fails the same way, because what was
missing was never intelligence.

**UnodeAi supplies the structure.** Each agent has a role and a mandate. A project manager agent assigns the
work and collects the results. Permissions decide what each one can reach. Finishing means something specific:
a check that ran, or a person who signed off. And the record keeps what an agent claimed apart from what
actually happened, because “I’m done” has never counted as proof in a company either.

This stopped being optional when agent output started leaving the building — into client deliverables, audits
and procurement reviews, where a chat log is not an artifact anyone can accept.

We’ll say what we’re betting on. This structure is proven for people. Whether it works as well for agents is
the question this product exists to answer, and the evidence layer is there so you can judge for yourself.

## What the organization is made of

UnodeAi ships **52 role templates** and **25 team presets** — Software Engineering, Marketing, Sales, Contract
& Compliance, Security & Governance, Business Operations, Revenue Operations, Customer Experience, Data
Intelligence, Product Discovery, and more — so a team is something you assemble, not something you rebuild in
every conversation.

| | The company equivalent |
|---|---|
| **Role** | a job title with a mandate |
| **Skills** | the procedures that job runs on, loaded when they are relevant |
| **Manager** | a project manager agent that assigns work and collects results |
| **Workflow** | a repeatable handoff between roles |
| **Authority** | what this position may reach, and what needs approval first |
| **Evidence** | the file that outlives the conversation |

No single model is best at everything any more, so *which model runs which role* is a decision worth making
per agent rather than per vendor.

## Why us

**The evidence layer is the product, not a feature attached to one.** It is cheap to add a summary view to a
tool that already trusts its agents, and it does not survive contact with a run that went wrong. Here the
separation is structural: verdicts come from recorded writes and observed check results, a delegate's prose
cannot become a green verdict, and the rules are held in place by mutation tests that fail if a sensor stops
sensing.

**Our own claims are auditable too, which is the only reason to believe the rest.** `SECURITY.md` is
re-audited before every release and records what it got wrong — including a boundary the previous release
overstated, corrected in place rather than quietly rewritten. CI builds the shipped artifact, a human
publishes those exact bytes without rebuilding, and the SHA-256 is published so you can check what you
installed against what was reviewed.

**It runs where you already work.** VS Code, Cursor and Devin — with your providers, your keys and your
team.

## Quality is a mechanism, not a promise

UnodeAi separates what an agent says from what the framework actually observed.

| What happened | What UnodeAi can honestly say |
|---|---|
| A delegation returned without a framework-visible trace | **No evidence** |
| Read, search, or other tool activity was recorded, but no change was verified | **Tool activity recorded; delivery not checked** |
| Files changed, but no matching passing verification was observed | **Replied, not verified** |
| A recorded change has an observed passing verification result | **Verified** |
| The coordinator explicitly decided to rely on the result | **Coordinator accepted** |
| The coordinator rejected an earlier result | **Coordinator rejected — amended**, with the earlier verdict and reason still visible |
| A decision belongs with a person | **Human intervention required** |

A green framework verdict means a check actually ran and passed. It never means a model declared its own work
good. Likewise, coordinator acceptance is an agent coordinator's explicit decision — not customer,
enterprise, or human acceptance.

The latest mechanism closes a gap our own field run exposed: a coordinator rejected work after an earlier
verdict had already been shown, but the framework never captured that decision. The coordinator can now record
`accepted`, `rejected`, or `needs-human` after it actually decides. A rejection requires a reason,
forwards it to the delegate, and visibly amends the verdict in Chat, Messages, and the Team card. UnodeAi is
capturing a decision the coordinator already made; it is not adding an LLM judge.

## How work moves

1. **You state the outcome.** Use Solo for a focused task or give the Project Manager a substantial goal.
2. **The PM plans and delegates.** It assigns roles, declares task scope, tracks progress, and keeps parallel
   work from silently colliding.
3. **Specialists work inside your boundaries.** Rules guide them; configured tools, approvals, provider
   routes, and folder access define their actual authority.
4. **Optional isolation keeps parallel changes reviewable.** When you enable worktree mode, delegated work
   can run in isolated lanes. UnodeAi does not infer or enable worktree mode from task wording.
5. **Your real check can gate integration.** When worktree mode is enabled and a verify command is configured
   and approved, its observed result can gate the merge. Without those conditions, UnodeAi does not claim an
   automatic quality gate.
6. **You review the integration.** `autoMerge` is off by default. The integration branch and its evidence
   remain available for review before work lands.
7. **You get the record.** See what changed, which tools ran, what passed, what was not checked, and whether a
   later coordinator decision amended an earlier verdict.

## Your process, as files you can inspect

The working agreement belongs with the project:

| What you define | Where it lives | What it does |
|---|---|---|
| **Repository guidance** | `AGENTS.md`, `CLAUDE.md`, `.unode/rules.md` | Records conventions, constraints, review expectations, and project-specific instructions |
| **Team** | `.unode/team.json` | Defines members, roles, registered model routes, instructions, workflows, and restrictions that can only narrow host authority |
| **Workflows** | The team definition | Encodes repeatable role-to-role work instead of rebuilding the sequence in every chat |

Repository guidance has a documented, inspectable precedence: `AGENTS.md`, then `CLAUDE.md`, then
`.unode/rules.md`. That does not make one file magically impossible to override; it makes the order visible,
reviewable, and changeable through the files you control.

Project knowledge is progressively disclosed. Each turn receives compact, deterministic indexes for the
instruction files and structured Markdown under `docs/`; an agent can load a relevant full source through
the existing root-confined read tool. This reduces standing context without pretending that every task becomes
cheaper — an agent may spend additional turns or tool calls fetching what it needs.

Rules can direct behavior, but they cannot grant authority. Project files do not widen Workspace Trust,
command approval, network consent, MCP grants, write policy, or folder access. Those boundaries remain
host-enforced and separately inspectable.

## Why teams choose UnodeAi

| Advantage | What it means in practice |
|---|---|
| **An AI team that follows your process** | Roles inherit your project rules, handoffs, workflows, and checks instead of requiring your team to adopt a proprietary ritual |
| **Evidence that names its limits** | Status comes from framework-visible actions and checks; later coordinator decisions amend the record rather than rewriting history |
| **Control at the task level** | A delegation can narrow a teammate's folder access for one assignment without permanently changing the agent |
| **A model per role** | Use premium reasoning where it matters, economical models for routine work, and different providers in the same crew |
| **Optional isolated delivery** | User-enabled worktrees separate parallel changes; configured and approved checks can gate integration |
| **Inspectable context and cost** | The context manifest lists sources and estimated text tokens; actual cost appears only where provider usage data supports it |
| **Security controls in the product** | Workspace Trust, per-host egress consent, command/write approval, MCP grants, folder scopes, and credential state are visible controls |

Model choice matters, but it is not the durable moat. Providers change, prices fall, and stronger models
arrive. What lasts is the process, evidence, and authority boundary your team can keep while swapping the
model underneath.

## Built with the team it ships

UnodeAi is built and audited with UnodeAi. Each release asks the shipped product to investigate the prior
release, then turns field evidence into the next mechanical guard.

That practice has changed the product in concrete ways:

- A field run found a read-only result described too generously; the verdict was narrowed to **Tool activity
  recorded; delivery not checked**.
- Another coordinator decision arrived after the displayed verdict; v0.9.47 makes the later rejection visible
  and preserves why it changed.
- Export truncation, temporary task scope, and overlapping delegation are now surfaced because our own audits
  found where a technically correct mechanism was still invisible at the decision point.

This is not a claim that the product validates itself. It is a receipt for how defects are found. Unit tests,
mutation gates, deterministic harness tasks, field runs, and human review each answer different questions;
none is promoted into evidence it did not collect.

## Security without surrendering usefulness

- **No telemetry.** UnodeAi does not run an analytics or remotely reachable control service.
- **Destinations are explicit.** Model data goes to providers you configure; network-capable tools use
  destinations you configured or explicitly approved. UnodeAi does not make an absolute claim that workspace
  data never leaves the machine while you are using a model or approved tool.
- **Workspace Trust is honored.** Execution surfaces stay off in an untrusted workspace.
- **Effects are gated.** Command and write behavior follows the policy you set; UnodeAi-managed MCP integrations
  are default-deny per agent until granted. MCP servers you configure directly in Claude or Codex stay under that
  CLI's own controls.
- **File tools are rooted.** Real-path checks prevent traversal and symlink escapes; task scope can narrow
  access but cannot widen the agent's permanent grant.
- **Secrets use VS Code SecretStorage.** Keys do not belong in team definitions, settings, exports, logs, or
  source control.
- **Human control remains human.** `needs-human` records that a decision is required; coordinator acceptance
  is never presented as enterprise sign-off.

See [SECURITY.md](SECURITY.md) for the complete network, execution, storage, Workspace Trust, and packaging
model.

## Quick start

1. Install UnodeAi and open a trusted workspace.
2. Choose a provider: use the Unode gateway, connect an OpenAI-compatible endpoint, use a local gateway, or
   run Claude or Codex through your existing CLI login.
3. Create or import a team, then choose which model, capabilities, folder access, and MCP grants belong to
   each role.
4. Keep the project guidance you already use in `AGENTS.md` or `CLAUDE.md`, and add
   `.unode/rules.md` when you want UnodeAi-specific team guidance.
5. Optionally enable worktree mode. If you want verified merge gating, configure and approve the verify
   command and keep `autoMerge` off until you deliberately choose otherwise.
6. Give Solo a focused task or give the PM a larger outcome. Review the transcript, evidence, changes, and
   integration branch before finalizing.

The [User guide](USAGE.md) covers provider setup, teams, approvals, worktrees, workflows, MCP, exports, and
troubleshooting.

## A growing ecosystem, with bring-your-own paths

The catalog keeps growing across models, roles, skills, and MCP integrations. Growth is not limited to what
ships in one release:

- Start from built-in software, product, research, writing, operations, marketing, sales, finance, and
  governance roles, then edit them or define your own.
- Attach skill playbooks that are progressively disclosed when relevant instead of placing every procedure in
  every prompt.
- Connect supported MCP integrations per agent, with explicit grants.
- Bring your own OpenAI-compatible endpoint, gateway, model, API key, role instructions, workflows, and MCP
  servers; choose from the growing set of validated skill playbooks.

The point of the ecosystem is choice under one governance model. A larger catalog should not become a reason
to hide what an agent can access or where data can go.

## Providers and capabilities

Use the Unode gateway for one account across many models, connect another OpenAI-compatible provider, route to
a local or self-hosted model, or use Claude or Codex through your own CLI login. Claude and Codex agents can both
lead a team and use UnodeAi playbooks and granted integrations, each under its own permission model.

Codex CLI asks before its App Server starts, and each Codex agent runs under a Codex permission profile you
choose: **Ask for approval** (the default), **Approve for me** (Codex's reviewer decides; UnodeAi shows its review
trail through Codex's `auto-review` mode), or **Full access (unsafe)** — no sandbox, network on, no prompts, always
confirmed first and flagged with a persistent warning. Ask for approval uses Codex's `workspace-write` sandbox with
`on-request` approvals. Routine Codex edits do not create UnodeAi checkpoints. Under Ask for approval, routine commands and edits inside the workspace
sandbox run without a card. Plan mode and host trust, folder and tool ceilings resolve to **Read only**. Codex connects
to OpenAI and to the model provider configured in your Codex; UnodeAi does not control those destinations or claim
that Codex reads are confined to the workspace. Repository CLI configuration loads only after a content-bound
confirmation. The [User guide](USAGE.md) has the full details.

Roles can use different providers in the same crew. The surrounding process — context, permissions, approvals,
task scope, evidence, and verification — remains inspectable when you change the model.

Core capabilities include:

- PM-led delegation with async fan-out, progress, result collection, and file-scope conflict detection
- Long tasks that hit a safety stop return a clear partial answer that the coordinator can continue
- Custom agents, reusable role templates, progressively disclosed skills, and deterministic workflows
- Explicit task-scoped folder access that can narrow but never widen a delegate's permanent grant
- User-enabled git worktrees, reviewable integration branches, and optional verify-command merge gating
- `autoMerge` off by default
- Coordinator `accepted`, `rejected`, and `needs-human` decisions with visible amended verdicts
- Chat, Team, and Messages evidence surfaces, plus exports that disclose retained-window truncation
- Per-turn context manifests with source provenance and estimated text-token counts
- Actual usage and cost only when the selected provider reports enough usage data to support them
- Provider-accurate command/write controls (UnodeAi gates for hosted tools and Claude; Codex's native permission
  profile), rooted file tools, Workspace Trust, per-host egress consent, and default-deny managed MCP grants
- **Your integrations**: each integration's connection and granted agents in one place, with remove-and-revoke
- Custom and bring-your-own options across providers, models, roles, workflows, and integrations, alongside a
  growing catalog of validated skill playbooks

## New in v0.9.87

**See what your team is doing, hear back when workers finish, and keep saved teams' permissions.**

- **Live team progress.** Every task handed to a worker shows its state in Chat, the Team panel, Activity and the
  Dashboard: assigned, working (step and elapsed time), waiting on the model or on your approval, stopped with its
  reason, or done. A task quiet for two minutes is labelled "Stalled"; nothing is cancelled for you.
- **The PM reports back on its own.** When a worker answers a rework request after the PM's turn has ended, the PM
  wakes, reviews the answer and reports to you. Automatic rework stops after two rounds until you reply, so a PM and
  a worker cannot loop unattended.
- **Integration errors say why.** A tool that reports an error counts as a failure, not a success. When an
  integration's process dies on startup, you see its own error output, with secrets hidden.
- **One place for teams.** **Create/Save/Load a Team…** creates a team from a system default, saves the current
  team to this project or to all projects, loads or deletes a saved team, and restores automatic snapshots.
- **Saved teams keep their permissions.** A team saved in the project loads read-only until you confirm. UnodeAi
  recognises its own saves and restores them in one step; any other team file opens a review in which you tick each
  permission.
- **Clearer names and layout.** The CLI routes are called **Claude CLI** and **Codex CLI**, and the Dashboard opens
  on your latest task.

## Previously in v0.9.86

**Long team tasks no longer stall, and integrations tell you the truth when something goes wrong.**

- **Workers always hand back an answer.** The old 12-step limit on OpenAI-compatible agents is gone; a 100-step
  safety stop remains only for runaways. A stopped worker still gives its best answer and says what it could not
  check, and the project manager can continue the same worker instead of starting over.
- **Integrations fail with a reason, never silently.** A missing secret is named before the integration starts. A
  call that is cancelled or times out is reported as "outcome unknown", never as success, and the integration
  reconnects on its own.
- **Manage your integrations in one place.** Marketplace → Integrations → **Your integrations** shows each one's
  connection and which agents have it, with **Remove** that also revokes every grant.
- **Tighter boundaries.** Claude's internal bridges use unpredictable per-session names, so a look-alike MCP server
  gets no special treatment; native Codex MCP calls now appear in chat, labelled as governed by Codex.

## Previously in v0.9.85

**Claude CLI and Codex CLI keep their native intelligence while UnodeAi adds the same governed team layer.**

- Codex keeps its own base instructions and receives the selected UnodeAi role as developer instructions. Its
  Playbooks load through a private native Skill root, with exact discovery, isolation, cleanup, and resume checks.
- Either Claude or Codex can be the one host-selected team coordinator. Codex also supports live steering through
  App Server, and both routes receive the same explicitly granted UnodeAi-managed MCP integrations.
- Native user-level MCP remains native and global CLI configuration is never rewritten. Repository MCP remains
  behind repository-configuration consent. Managed integrations must become ready before an agent freezes its tool
  list; resolved failures require an explicit not-now, retry, or start-without choice, while an unanswered approval
  reaches the deadline and stops startup visibly.
- Executable Skill actions cannot carry scripts. They may select only a handler compiled into the installed VSIX,
  and every run requires Workspace Trust plus a fresh digest-bound approval. Remote/imported Skills remain
  instruction-only. No bundled Skill uses an action yet.

## License

See [LICENSE](LICENSE).
