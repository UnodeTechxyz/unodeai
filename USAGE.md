<p align="center">
  <img src="images/unode.png" alt="UnodeAi" width="96" height="96">
</p>

# UnodeAi User Manual

Version covered: UnodeAi 0.9.93

Product: an organized AI workforce, inside your editor

UnodeAi turns AI agents into an organized team inside your editor. A project manager agent breaks your goal into tasks and hands them to specialists; each agent has its own role, model, tools, chat history, and safety policy. What an agent claims stays separate from what the framework observed. You can work with one agent directly, run a coordinated PM-led crew, or use deterministic workflows for repeatable processes.

The default **Unode** provider uses the OpenAI-compatible Unode gateway at `https://www.unodetech.xyz/v1`, with its own API key (`UNODE_API_KEY`). Live model and pricing information is at `https://www.unodetech.xyz/pricing?lang=en`. Other built-in providers and any number of named local OpenAI-compatible gateway profiles are selectable per agent.

## 1. Install UnodeAi

**Four channels exist and they are not equivalent.** Sideloading a VSIX successfully does not mean the
extension is discoverable in a marketplace, and the two failure modes look nothing alike — so this section
names each channel and what it does and does not give you.

### Open VSX — the channel for this release

UnodeAi publishes to [Open VSX](https://open-vsx.org). Search for `UnodeAi` in Extensions on any editor
that uses Open VSX as its registry, install, and reload if prompted.

### Cursor

Cursor's extension marketplace mirrors Open VSX, so UnodeAi is reachable by search there — **but mirrors
lag**, and a freshly published version can take time to appear or may resolve to an older one.

**How long, measured rather than guessed — and it varies.** For **0.9.33** the new version was not yet
offered 40 minutes after publication, and was being served 6 hours after it. For **0.9.34** it was already
installable **27 minutes** after publication, for **0.9.36** within **42 minutes**, and 0.9.41 was there
within the hour on the day it shipped. Four releases across the same hour: the mirror does not run on a
fixed schedule you can plan around, so treat "minutes to a few hours" as the range and never read a missing version as a broken install. If you need the new
version now, install the VSIX directly:

- **Command Palette (most reliable):** `Ctrl+Shift+P` → `Extensions: Install from VSIX...`
- **Command line:** `cursor --install-extension <path-to>.vsix --force`. If `cursor` is not on `PATH`, it
  ships inside the install directory (Windows: `…\cursor\resources\app\bin\cursor.cmd`).
- **Drag** the `.vsix` onto the Extensions panel — supported in some builds.

Cursor's Extensions panel does not always expose an `⋯` overflow menu, which is why the Command Palette is
listed first. **Fully quit and reopen Cursor after installing** — replacing an extension under a running
window leaves the old extension host in place, and the new version will not be registered until restart.

### Direct VSIX (VS Code)

1. Extensions panel → `⋯` → `Install from VSIX...`, or `code --install-extension <path>.vsix --force`.
2. **Fully quit and reopen VS Code.** Reload Window is not always enough when the extension was replaced
   underneath a running instance.

`--force` matters when the version string is unchanged: a same-version install is otherwise skipped
silently, and you will be testing the build you thought you had replaced.

### Microsoft Marketplace — not a channel for this release

UnodeAi is **not** on the Microsoft VS Code Marketplace. The publisher account is blocked and Microsoft has
declined to reinstate it or state a reason; see `SECURITY.md` and the project's release notes. Any listing
claiming to be UnodeAi there is not ours.

### From source

For contributors:

```bash
npm install
npm run build
```

Then press `F5` in VS Code to launch an Extension Development Host.

Editor validation is recorded against the exact builds named in each release's field record. UnodeAi does not
claim an editor-version support range; the manifest's installation floor is deliberately permissive for lagging
VS Code-based editors and is not a statement that every version in that range was individually validated.

## 2. First-Time Setup

### Run the setup wizard

Open the Command Palette and run:

```text
UnodeAi: Run Setup Wizard
```

The wizard shows three available connection families: **OpenAI-compatible connections** (built-ins plus named custom gateways), **Claude CLI**, and **Codex CLI**. Standard connections keep their registered endpoint. Select **＋ Add custom gateway…** in the OpenAI-compatible connection menu to create one without leaving the wizard. The host prompts for its display name, HTTPS endpoint, and masked key; the key never enters the wizard webview. On success, the new gateway is selected automatically. Claude and Codex setup each open a terminal with that CLI's login command pre-filled; UnodeAi never runs the command for you.

**Setup is three steps: connect a model, choose how you want to work, start.** It was six. The three that
went were a welcome screen listing the other five, a demo on a screen of its own, and a safety screen you had
to pass through — none of which asked you for a decision, while a six-dot progress bar tells a first-time
user how much is being asked of them. The demo is now an optional row on the last step, and the safety
promises are a line you can open there: they are true whether or not anyone reads them, so they belong where
someone can choose to.

The final wizard step leads with **Open Workbench**, not a menu of Dashboard, transcript, and Settings. **Finish and continue** follows the same route when a team exists, so `unode.workbench.autoOpen` still chooses the Workbench or the compact sidebar. With no team it opens the Team panel's create-team path instead of an empty Workbench. Settings remains available from the Team toolbar and Command Palette.

In the work-style step, choosing **Solo**, **Team**, or **Custom** starts that setup directly. There is no
separate Start button to find; cancelled Solo/Team flows tell you to choose that card again.

### Store your API key

Run:

```text
UnodeAi: Set Provider API Key
```

Choose the secret name for your provider:

| Provider | Secret name |
|---|---|
| Unode gateway (default) | `UNODE_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Anthropic / Claude | `ANTHROPIC_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Named Custom gateway | Its host-generated profile secret (managed from the gateway's Providers card) |

**Claude CLI and Codex CLI need no key stored here.** Claude drives the logged-in `claude` CLI. Codex drives the logged-in Codex CLI through `codex app-server --stdio`; use **Settings → Providers → Codex CLI → Choose Codex executable…** (or the `unode.codexCliPath` User setting). The chooser detects supported npm and standard user installs before PATH, shows their versions and full paths, and saves only the entry you confirm. UnodeAi never reads or copies `~/.codex/auth.json`, `~/.codex/config.toml`, or `CODEX_HOME`, and never injects an OpenAI API key. Codex CLI 0.155.0 or newer may be used; Windows validation records 0.155.1, and every newer build must still pass the live App Server handshake and effective-policy checks. Codex consent is bound to that executable; switching binaries asks again. If a new editor has no account-model cache, choose **Load models from Codex** in the Agent Builder. After executable/login verification and consent, a short-lived App Server runs from extension storage—not the workspace—requests only the account-visible model list, stops, and caches it by CLI version. Your native Codex hooks, notification command, MCP servers, plugins and configured model provider remain available after you approve startup. UnodeAi-managed MCP grants are separate: the extension host exposes only that agent's approved tools without adding them to global CLI configuration. MCP tool calls that Codex routes for approval receive a UnodeAi card, but an MCP tool Codex calls from inside its own `exec` code tool (measured with the bundled `node_repl` plugin) runs with no approval request.

Claude Code subscription logins report API-equivalent usage rather than an invoice. UnodeAi shows that as `~$...` with a tooltip; plain `$...` means billed API/key usage. Before a completed turn establishes a billing basis, the UI says **cost unknown** rather than fabricating `$0`.

**Every way of storing a key asks what that key pays.** After the value is stored — whether from this
command, the Settings › Providers **Set key** / **Edit** buttons, the setup wizard, a custom gateway, or the
"Set API Key" prompt after creating a team or agent — UnodeAi asks for that key's **price coefficient**: the
fraction of the gateway's published price your key actually settles at. `1` is list price, `0.33` is a third
of list, `0` is free. Leave it blank or press Esc for `1`. A gateway does not report this number, so UnodeAi
cannot check it; stating it is what makes the per-turn cost display right for a discounted account. The
coefficient belongs to the key, so each connection keeps its own (`unode.priceMultiplier`). Storing a key
also drops the model list and price table the previous key produced, rather than waiting out their caches.

Before v0.9.58 only the command-palette dialog asked, so keys stored any other way silently defaulted to
list price. If your cost figures have looked high, re-store that key or set `unode.priceMultiplier` directly.

Secrets are stored in VS Code SecretStorage. They are not written to `.unode/team.json`, settings files, chat exports, or source control.

To **remove** a key, run `UnodeAi: Set Provider API Key`, pick the same secret, and choose **Clear the stored value**. The choice only appears when something is stored. Keys are held per extension rather than per workspace, so clearing one removes it for every folder on this machine.

**No telemetry or analytics — and nothing beacons on install.** UnodeAi has no tracking or phone-home endpoint, and every metadata fetch refuses an unapproved host before a packet moves, so no host is contacted at activation until you approve one. (That the process emits *zero* traffic of any kind is `UNVERIFIED` pending a clean-profile packet capture; see SECURITY.md.) Chat history and team config stay on your machine, and keys use VS Code SecretStorage. A model turn sends its prompt and included workspace context only to the provider host you approve. Separately, an MCP tool or `fetch_url` call can send the arguments shown for that explicit tool to its configured destination. Use a self-hosted/in-VPC OpenAI-compatible endpoint when you need provider-side zero retention.

**Don't have an account or credits yet?** The **Providers** tab of UnodeAi Settings has a sign-up / top-up button that opens registration in your browser — **Unode Gateway** ([unodetech.xyz](https://www.unodetech.xyz)). Create an account, top up, then paste your key above.

**Unode Account / Profile.** Run **UnodeAi: Open Unode Account / Profile** (or choose it from **Team Actions**) for the local Account tab in Settings. It honestly distinguishes no Unode key, **Connected via API key** (which is *not* a signed-in session), a balance that cannot be read, and a low balance. Account, credit/usage, and pricing actions open Unode's registered HTTPS pages in your system browser; the page contains no password or payment field and opening it sends no request. **Check available balance** uses the existing metadata-consent gate, so an unapproved host remains unavailable rather than prompting or contacting it silently. BYOK, custom gateways, and CLI-authenticated providers work without a Unode account.

## 3. Create, Save, or Load a Team

Open the UnodeAi sidebar from the Activity Bar. It is the compact navigation and status surface: **the roster**
is the primary entry point, followed by compact session rows showing each agent's current responsibility and
lifecycle.

The Team title bar shows the version beside the title and pins **Add Agent**, **⋯ Team Actions**,
**Settings**, **Marketplace**, **Message**, **Solo**, and **Collapse/Expand**. A title bar is a fixed-width
row, so anything beyond what fits is hidden by VS Code in an unlabelled `...` overflow; **⋯ Team Actions**
lists everything not pinned, by name: collapse/expand the roster, Build an Agent, Create/Save/Load a Team,
Start/Stop All Agents, Team Rules, Restore File Checkpoint, concurrency mode, Security, and Generate
Evidence Report.

Each session row keeps the whole member within reach without growing into a second Workbench:

- **Click the row** to open that agent in the shared Workbench (or to jump straight to a pending approval).
- **The controls are always on the row** — Stop/Start, Restart, ⚙️ Configure, Terminal, and Remove once
  the agent is stopped. ⚙️ Configure opens that agent's page in the Agent Builder. Each collapsed row also
  has an 18px status marker and a **Status key**: the marker distinguishes Done (✓), Verified (V), Replied
  but not verified (↩), Consent required (🔒), and approval Denied — timed out (⌛) without relying on colour.
  The dot still conveys activity, but is never the only status signal. A settled result's label (Done,
  Coordinator accepted, …) shows for two minutes, then the row returns to the agent's own state. Since 0.9.88 it
  clears on time; before, it stayed until something else redrew the panel, such as a click.
- **Click ▾** to expand the row in place: model (with the Smart Mode badge), live context / cost / turns,
  skills, and recently changed files. Since 0.9.93 **Provider**, **Role**, **Status** and **Reasoning** stand in
  one strip: two rows of two in a narrow sidebar, one row in a wide one. **Reasoning** shows the baseline the
  agent is configured with: a value, `Provider default`, or `Not supported` on a route that does not take the
  setting. An expanded row keeps its controls visible without hovering, so ⚙️ Configure stays one click away. Very long detail panes scroll within the row; expanded
  state for removed agents is discarded rather than accumulating across roster refreshes.

The roster deliberately does not duplicate the Workbench's transcript, tools, or diffs. The sidebar
**Activity** view remains a separate, agent-to-agent coordination stream rather than a copy of your conversation
with an agent.

### Shared memory and delegation authority

`memory_note` appends a one-line team note to `.unode/memory/notes.md`. The agent selects one structured kind:
`pitfall`, `contract`, or `decision`; the host does not infer that kind from the text. A `contract` is a claimed
interface or ownership constraint to check, not an approved rule. New rows also carry the host-selected routing
tier (`premium`, `standard`, or `economy`) for the turn that wrote them. That is a write-time routing fact, not an
underlying-model identity. Because the Markdown file is mutable, every field read back from it is treated as
recorded context rather than durable proof of its author, tier, age, or truth.

The implementation uses the **first workspace folder** as the primary folder; switching team rosters does not
change that scope. The file remains human-readable and can be edited or versioned with the repository. Loads and
appends fail closed if `.unode/memory/notes.md` or a parent symlink/junction resolves outside that primary folder.
Every prompt row is structurally encoded and explicitly labelled `untrusted` or `human-attested`, and the block is
bounded by both row count (at most 30) and bytes. Exact duplicate rows occupy one prompt slot. Attested rows receive
admission priority, followed by recent unattested rows across every semantic kind; final output stays in file order.

Run **UnodeAi: Review Shared Memory** to inspect an exact row. Dismissing the picker records nothing. A second,
visible confirmation can attest that exact row as reviewed team guidance, and the same surface can revoke it. The
host-owned record contains a workspace-scoped SHA-256 digest and bounded metadata, never the note prose or a person
identity. Editing one byte of the row invalidates the match. In an untrusted workspace, new attestations are
refused and every row remains untrusted.

| Context layer | Scope and origin | What it may affect | What it cannot establish |
| --- | --- | --- | --- |
| Shared note | Mutable `.unode/memory/notes.md` in the first workspace folder; agent/person authored | Bounded context supplied to teammates | Permission, evidence, truth, approval, or instruction priority |
| Human-attested note | Exact-row local confirmation stored in host-owned workspace state | Prompt admission priority and the displayed trust label | Who clicked, factual correctness, freshness, or any tool/command/network/MCP authority |
| Repository guidance | Versioned instruction files and Team Rules | Advisory project guidance subject to host protections | Product safety policy or wider permissions |
| Host authority | Current settings, task contracts, explicit approvals, enforced policy, and receipts | The authority each host mechanism actually owns | Creation or expansion by memory prose |

UnodeAi does not automatically promote memory into Team Rules, skills, workflows, hooks, or task contracts, and
does not claim every recalled note is relevant, current, or correct. The context receipt records only typed counts
of selected untrusted and human-attested rows; it does not reproduce note bodies or say the model obeyed them.

Every crew has one coordinator: the first Project Manager in the saved roster. Only that coordinator can
dispatch, collect, or inspect delegated work. A teammate that wants parallel work sends the coordinator a normal
message explaining the proposal; the coordinator decides whether to issue a structured task. Saved teams that
previously gave another member `delegate` still open, with that retired capability removed in memory and a warning.
The trade-off is deliberate: workers no longer fan out their own work until a future multi-level design can keep
every child handle visible to its lead.

When a delegated task settles, the coordinator also sees host-observed required-input receipts. A missing receipt
is shown as **read not observed**, never as proof that the worker did not read. Actual access failures keep their
separate host-observed reason. This is not an automatic rejection and does not replace the coordinator's decision.

If the workspace is empty, choose `Create/Save/Load a Team…`. You can also run:

```text
UnodeAi: Create/Save/Load a Team…
```

### Default software crew

The default crew is:

| Agent | Main purpose |
|---|---|
| Project Manager | Breaks down work, delegates tasks, tracks progress, runs checks, and coordinates review |
| System Architect | Designs public contracts, architecture, boundaries, and ownership maps |
| Senior Developer | Implements production code and tests |
| Reviewer | Independently reviews work and returns PASS or FAIL |

### Software Engineering Team (full crew)

The team picker's Software group also offers **Software Engineering Team** — the full-discipline crew for
larger work: PM, System Architect, Senior Developer, QA Engineer, Reviewer, and Technical Writer, **plus
the standalone Solo agent every team ships with** — seven agents in total. Compared to the default crew it
adds independent testing and documentation as first-class seats; its suggested verify command is
`npm test`. Every team you create also includes Solo automatically, so a quick single-agent task never
requires switching teams.

If a team already exists when you choose a preset, UnodeAi asks whether to **Keep current team**, **Add to
current team**, or **Replace current team**. Add keeps the existing roster and appends the selected preset;
Replace takes the normal pre-switch snapshot before changing the roster.

### Additional built-in roles

You can add individual agents with:

```text
UnodeAi: Add Agent
```

Common roles include Product Manager, QA Engineer, DevOps Engineer, Technical Writer, Security Engineer, Data Engineer, Reviewer, and Solo.

**What a built-in role can do.** A role holds the tools its own work needs:

- **Engineering roles and the System Architect** read, write and run commands.
- **Roles that verify or calculate what they deliver** can run commands too: the Reviewer, Security Engineer,
  Technical Writer, Sales Engineer, the security specialists, Knowledge Manager, Developer Advocate, Localization
  specialist, and the financial, product, data, support-operations, revenue-operations and SEO analysts.
- **Roles that review or assess** (Reviewer, Application Security Engineer, Privacy & Data Protection Officer,
  GRC Analyst) can write their review, quality report or assessment to a file. They are instructed never to
  change the work they review; nothing in their tool list enforces that. To enforce it yourself, set **Writes**
  to **Ask each**, or untick the capability that grants Write files for that agent in Agent Builder.
- **Drafting roles** (for example Product Manager, Business Analyst, Brand Strategist, Customer Support) read and
  write documents and do not run commands.
- **Sales and customer-success roles** produce drafts and plans for a person to send or run. UnodeAi has no tool
  that sends a message, books a meeting or changes an account record.
- **Research roles** can search the web on the Claude CLI route. On a gateway route they can fetch a page they
  are given but cannot search.

Every command still goes through Workspace Trust, the command policy and your approval. A team saved by an earlier
version keeps the tools it was saved with; an agent that lacks Run commands says so instead of working around it,
and Agent Builder shows beside **Save** what a save would add.

### Website Design & Development

| Preset | Roster (PM +) | Use it for |
|---|---|---|
| **Website Design & Development** | Product Designer, Frontend Engineer, Content Strategist, SEO & Analytics Specialist, QA Engineer | Design, build, and launch a site end to end |

The designer works against your existing design system rather than inventing values, and specifies every
interactive state including loading, error and empty. The frontend engineer reviews at the breakpoints your
project actually declares — and at their boundaries, where defects cluster. Before launch, the SEO
specialist runs a technical audit of crawlability, canonicals, structured data and redirect integrity, and
reports mechanics only: it never predicts a ranking, because that is not something an audit can observe.

### Saving and reopening a team

Configuring a crew is real work — edited instructions, per-agent model tuning, folder access, MCP grants,
attached skills. Switching teams replaces the roster, and until v0.9.54 everything you had configured went
with it.

| Command | What it does |
|---|---|
| **`UnodeAi: Create/Save/Load a Team…`** | Create, save, load, or delete named teams in one place |

**Since v0.9.69 you choose where a team is saved.**

| Scope | Where it lives | Use it for |
|---|---|---|
| **This project** (default) | `.unode/teams/<name>.json` | a crew you want whoever clones the repo to get |
| **All projects** | UnodeAi's own per-user storage | your own crews, in whatever project you open next |

Saving opens a modal with **Save to This project**, **Save to All projects**, and **Cancel**. Each button says
where the team will live; the result names the same scope and location. The saved-team list labels each row with
its scope, so two teams may share a name without ambiguity.
**Automatic snapshots are always per-project**, because they are an undo for a replacement that happened in
that project.

**Create/Save/Load a Team is the one home for named saved teams.** Its **Saved teams** section starts with
**Save current team...**, then lists named project and personal saves. A trash button appears only on a named
save, never on a system default. Automatic snapshots keep their separate delete control inside
**Restore a previous team...**. `unode.saveTeam` and `unode.openSavedTeam` remain available for existing
keybindings, but are hidden from the Command Palette.

**A saved team file never grants execution authority by itself.** A **This project** save also records a
fingerprint of the exact bytes and path in UnodeAi's own storage, which the repository cannot write. Opening
that exact save shows one team-level confirmation listing every agent and the skills, write, run-command, and
delegation permissions it would regain: choose **Restore saved permissions** or **Load read-only**. Change even
one byte, copy the file elsewhere, or open it from a clone and it loads read-only first; UnodeAi then opens an
unticked review for each affected agent. Nothing is granted until you tick it, and every restored tool remains
capped to the saved `allowedTools` ceiling.
After an unticked review, the completion notice reports how many agents regained selected permissions; it calls
the team read-only only when no agent regained any.

Teams saved before 0.9.87 have no fingerprint or full skill declaration. Their surviving primary skill plus the
role template's skills are offered in the same unticked review, all unticked and capped to the old saved ceiling;
save each such team once from 0.9.87 so future exact loads
can be recognised. When a team replacement is confirmed, **Restore a previous team…** in the combined team
picker opens the automatic snapshots of the roster you left.

When you open a saved team, UnodeAi also tells you what it dropped:

- **Folder permissions that point outside the workspace you are in are removed.** A grant is kept only if,
  after the path is resolved and symlinks are followed, it lands inside the current workspace. A grant that
  named a folder in the project you configured it in would otherwise silently hand this project's agents
  access to that one.
- **MCP grants, tool-protocol choices and process settings are never imported from a file.** Project Skills and
  Playbooks are only inert declarations for the explicit restore/review described above. Re-select trusted
  integrations in **UnodeAi: Build an Agent**.
- **`env` and the legacy agent `autoApprove` field are never imported or written.** Use the Workbench's
  **Commands** and **Writes** selectors for UnodeAi-hosted and Claude approvals; Codex agents show their native
  permission profile instead. UnodeAi has no supported project-file control for a
  provider process environment; MCP secret placeholders belong in SecretStorage.

**Upgrading from 0.9.80:** because old saved rosters did not record whether a value came from a project file,
0.9.81 removes only `env` and `autoApprove` from those source-unknown agents. Skills, Playbooks, MCP grants,
routes, backend choices and other user configuration remain intact. An integration still listed in the legacy
team file is imported only when its exact launch configuration was already approved in this workspace; the
upgrade notice names integrations it imported and unapproved project entries it ignored. MCP state moves to
`unode.approvedMcpServers` / `unode.hostMcpServers.v1`. If you downgrade to 0.9.80, approve the integrations
again before using them.

**Project state is root-bound in 0.9.82.** Editors such as Devin can reuse one extension-storage bucket while
opening different folders. UnodeAi binds rosters, transcripts, checkpoints, runs, policy, integration evidence,
MCP approvals/configuration, and other project values to the canonical first workspace-folder root. On a root
change it also clears the live selected agent and presentation state before another turn can start. A new root
therefore starts empty; switching back restores only that root's state. Existing VS Code and Cursor state is
imported only for its same proven root. Old Devin history is intentionally not imported because it cannot be
attributed safely. **Reset Workspace State** clears only the current root's namespace.

If you decline model-network consent on an OpenAI-compatible route, 0.9.82 ends that request immediately. The
decline is not treated as a transport failure, so the same turn does not retry, repair the body, fall back from
streaming, or show the consent dialog again. No request is sent.

Both are in the Team panel's actions menu (the `$(gear)` icon), directly under **Create/Save/Load a Team…** —
which is where you are standing when you find out a roster can be replaced.

**To delete a named saved team, use its trash icon in Create/Save/Load a Team.** The confirmation names the
scope and leaves the running team alone. **This project** deletes `.unode/teams/<name>.json`; anyone who gets
that file through Git loses the save too, and its host-owned fingerprint is removed. **All projects** deletes
only your personal library entry. There is no undo. System defaults have no delete control.

**You do not have to remember to save.** Whenever you confirm a replacement — whether from Create or Load a
Team or from a previous snapshot — UnodeAi writes an automatic snapshot of the roster you are leaving
before removing anything. Cancelling the picker writes nothing. Snapshots appear in the picker marked
*auto-saved*, and the ten most recent are kept. **Teams you named yourself are never pruned**: deleting
something a person named is not a housekeeping decision. If a snapshot cannot be written, UnodeAi says so
and asks whether to switch anyway — being unable to back a team up is not a reason to trap you in it, but it
is not something to leave in a log either.

**A saved team is a portable roster description, not an authority bundle.** It holds inert identity,
instructions and model tuning plus folder/tool/command restrictions that can only narrow the current host.
Per-agent MCP grants, executable Skills/Playbooks and the workspace's MCP server definitions are host-owned and
are deliberately absent. Opening a team never replaces workflows or integration configuration.

**On what a per-project file contains.** Routes reference a registered connection and model, so no API key is
in it; keys live in SecretStorage. Since 0.9.81, neither `.unode/team.json` nor `.unode/teams/*.json` stores or
loads an agent `env`, automatic approval, backend/base-URL override, executable playbook/tool attachment, or MCP
process configuration. A hand-written value is ignored with one notice. `.unode/` remains excluded by the
`.gitignore` UnodeAi writes, but the security boundary does not depend on that exclusion.

### Knowledge-work presets

The team picker also includes non-code presets that use the same PM orchestration model with specialist roles:

| Preset | Roster (PM +) | Use it for |
|---|---|---|
| Business Planning | Strategy Lead, Market Researcher, Financial Analyst | Plan a business direction with strategy, market, and finance input |
| Business Analysis | Business Analyst, Market Researcher | Clarify requirements and market context for a business problem |
| Financial Analysis | Financial Analyst, Business Analyst | Model financial trade-offs and explain the assumptions |
| **Marketing** | Content Strategist, Growth Marketer, Market Researcher, SEO & Analytics Specialist | Run marketing with content, growth, research, and analytics specialists |
| **Sales** | SDR, Account Executive, Sales Engineer, Customer Success Manager | Run a B2B sales motion from outbound through close to renewal and expansion |
| **Contract & Compliance** | Contract Analyst, Privacy & Data Protection Officer, GRC Analyst, Procurement Analyst, Technical Writer | Read agreements, review DPAs and vendor packages against a named framework, and draft playbook-traced redlines |

**The Contract & Compliance team stops where a person with authority has to decide.** That is a property of
the roles, not a caution in the prompt:

- The **Contract Analyst** extracts every field with a quoted source span and writes `not found` rather than
  inferring a value. Its redlines cite the playbook rule behind each change, are addressed to your own side,
  and are never counterparty-ready text.
- The **Privacy & Data Protection Officer** and **GRC Analyst** have no shell and no delegation; they can write
  their assessment to a file and are instructed not to edit what they assess. They produce `present / absent / ambiguous` against a framework they must name before they
  start.
- Any sanctions, export-control, or licensing question is **refused rather than answered.** The agent
  gathers the facts, states the question, and routes it to a named human owner. A wrong determination there
  is a criminal-liability exposure; a screening result an agent produces would be relied on as a clearance.
- Claims about what the law requires must cite primary authority, and **a citation that was not retrieved
  this session is marked `not verified this session`.** Courts have sanctioned fabricated citations.

These teams get analysis-oriented Team Rules (cite sources, separate facts from recommendations, quantify trade-offs) rather than the software crew's rules.

### Build your own agent

Run `UnodeAi: Build an Agent` (or use the Team panel) to open the **Agent Builder** — a form where you create or edit a custom agent without touching JSON.

A new agent opens blank, with **Select a role…** in the Role dropdown. Picking a role is what fills the form in: it populates the name, instructions, icon, color, model, and the role's default skills. You can then change anything you like. If a role switch replaces instructions you had written yourself, the panel offers **Restore my previous Instructions**. If you save without restoring, the replaced text is kept as the agent's undo record — reopen the agent and **Undo template reset** brings it back. A role change never leaves your text unrecoverable.

- **Identity** — name, role (a built-in template or a custom one like *CEO*), and an icon (preset or any `$(codicon)`).
- **Connection / Pay through** — choose the immediate connection first. The builder shows that connection's runtime, billing path, egress/privacy summary, and current capability state before you save. Changing a connection reloads only that connection's model catalog; changing the model never changes where the turn is sent.
- **Capabilities are real limits** — unavailable controls are disabled with an explanation, and the host rejects forged or hand-edited requests for them. Codex CLI acts through its consent-gated App Server and native permission profile; eligible escalations receive single-use approvals. Claude or Codex may lead when the host selects that agent as coordinator. Only that selected coordinator receives team tools; naming an agent `pm` or editing a project file does not grant delegation.
- **Model** — pick from the selected connection's model list with prices. Each shown price names its gateway and source, for example `$1.7/$5.1 per 1M · Roam (live)`; `list` means the offline fallback rather than a refreshed gateway response. This makes a gateway API/page disagreement visible without changing the rate calculation.
- **Tool calling method** — **Auto** starts with the model's native tool protocol. A few model families are
  marked in the builder because a first native tool call may arrive as text; if that happens, UnodeAi
  completes the recovered loop and uses XML from the next session turn onward. You may still explicitly
  choose Native or XML, and typing a model id by hand remains allowed.
- **Model fine-tuning** — per-agent sampling/reasoning settings (temperature, top-P, max output tokens, reasoning effort, presence/frequency penalty). Leave a field blank to use the global default. These are the same values the Settings panel shows for this agent, so the two stay in sync.
- **Smart Mode tier** — a per-agent tier override (Premium / Standard / Economy, or "Use role default") for OpenAI-compatible agents. When Smart Mode is on, that agent runs on the model mapped to its tier — so two same-role agents can run at different tiers. The tier→model mapping itself is global (Settings → Smart Mode). Headless routes display why this control is unavailable rather than ignoring it.
- **Instructions** — write the agent's system prompt.
- **Skill playbooks** — attach any number of authorized Agent Skills. Claude and Codex load an instruction-only projection of `SKILL.md` and its inert references through their native Skill mechanisms from an extension-owned, temporary, per-agent root. A Playbook never grants a tool or widens a sandbox. An extension-bundled Skill may select a fixed action handler compiled into the VSIX; Skill folders and remote catalogs cannot carry scripts or executable files. Every invocation requires Workspace Trust plus a fresh, exact-digest **Allow once** approval through the UnodeAi `run_skill_action` host tool. This is trusted local code with the user's OS authority, not an OS sandbox; effect declarations are disclosure, not enforcement.

An executable Skill action would use this deliberately small manifest at the Skill root. This is an
**illustrative format example**, not a bundled action:

```json
{
  "version": 1,
  "actions": [{
    "id": "run-audit",
    "description": "Run the repository audit and return its report.",
    "handler": "unode.repository-audit.v1",
    "declaredEffects": ["read-workspace"]
  }]
}
```

The handler must be one of the closed set compiled into the installed extension. **No bundled Skill currently
exposes an action.** The fixed runner accepts one JSON object on stdin and returns bounded stdout/stderr. UnodeAi
rejects scripts/binaries under `skills/`, symbolic links, unknown handlers or manifest fields, action input over
64 KiB, and output beyond 64 KiB. A timed-out call resolves even if a detached descendant keeps an output pipe
open; UnodeAi requests one process-tree kill while the original child is owned, but a detached Windows process
may survive because Node cannot place it in a Job Object. The current approval does not enforce
`declaredEffects`; review the digest and assume the compiled handler can use the authority named in the warning.
- **MCP grants** — give the agent access to registered MCP servers (or add a new one). For both Claude and Codex, the extension host remains the external MCP client, publishes only the approved tools, and rechecks the live grant when a tool is called. Agent startup waits up to 45 seconds for every granted managed integration, including first-time approval. A resolved failure offers Not now, Retry, or Start without integrations; an unanswered approval reaches the deadline, stops startup, and reports how to retry instead of waiting forever. The user's native CLI MCP remains separate: Claude native calls stay behind Claude's UnodeAi tool gate, while Codex applies its own native approval behavior. UnodeAi's own Claude bridges get unpredictable per-session names, and only their exact tool names are allowed automatically, so a native server named like a UnodeAi bridge receives no special treatment.

Simultaneous agents wait independently on one shared managed-integration mount, so one agent's deadline cannot
cancel another's valid wait. Missing and empty SecretStorage values fail before the server starts and are reported
by variable name only. Marketplace → **Integrations** → **Your integrations** lists every configured custom or
catalog integration with connection and grant status. **Remove** names affected agents, revokes saved and live grants, cancels active
calls, and removes the configuration and approval record without deleting shared secrets. A call cancelled before
dispatch is `cancelled`; after dispatch, timeout or cancellation is `outcome unknown`, the late result is discarded,
and the connection is quarantined while UnodeAi automatically reconnects through the same approved mount path.
Calls made during recovery wait for that attempt or report the integration temporarily unavailable; they are never
misreported as a revoked grant.

An MCP result carrying the protocol's error flag is recorded as an integration failure even when it contains
text, and it does not trigger a reconnect while the server remains responsive. If a stdio server cannot connect,
the failure reason includes a bounded plain-text stderr tail. Values resolved from SecretStorage placeholders are
redacted; ordinary literals such as `DEBUG=1` remain readable so the diagnostic is still useful.

Native Codex MCP calls appear in chat with server, tool, and status only, labelled as governed by Codex and never
counted as UnodeAi evidence. When a Codex agent's team-tool or managed-integration tool set changes, App Server
cannot resume that thread with a different immutable dynamic-tool surface, so UnodeAi visibly starts a fresh Codex
conversation. The earlier App Server thread is not deleted and the UnodeAi transcript remains; the new model
conversation does not inherit the earlier thread's model context.

**How the form is laid out.** Every section carries its own **Advanced** fold, and folds start closed:
the settings people usually leave alone are one click away rather than in your face. **No fold opens itself**
— if a section is closed, it stays closed until you open it. **Skills** and **Tools** show what is currently
selected and fold the rest into a full list, so a long catalog does not bury the handful you actually use.
Model fine-tuning appears before Skills and Tools.

**A save never widens an agent without saying so.** A saved agent keeps the tools it was saved with, even when
a capability it uses has gained one in a newer version (the System Architect's Architecture Design gained Run
commands in 0.9.92). Saving the agent in the builder applies the capability as it is now, so the form shows
`Saving adds to this agent: Run commands` beside **Save** first. Untick that capability to keep the agent as it is.

**Double-clicking a team member** in the Team panel opens that agent's Workbench conversation.

Save, and the agent joins your team like any preset — ready to chat with or be delegated to by the PM.

## 4. Use Solo Mode

Solo mode is the fast path for simple tasks where a full team would be too much overhead. It creates or selects one generalist agent that works directly with you.

Run:

```text
UnodeAi: Solo Agent (toggle)
```

Use Solo for small edits, quick explanations, one-file fixes, or focused code tasks. Use a full team when you want planning, parallel specialists, independent review, or a verification loop.

## 5. Workbench and Agent Chat

Start work in the editor-first Workbench with:

```text
UnodeAi: Open Workbench
```

The Workbench is one editor tab with one agent selector, a compact header (role, route/model, observed cost and
turns, with the context meter at its right end), a full-width transcript, and a composer pinned at the bottom. Pick an agent, type
your request, and send it. It is a native editor tab, so you can drag it
where your VS Code or Cursor host supports editor-tab movement and close it with the normal tab close. Reopen
it at any time: the selected session, transcript, and running backend turn are shared host state, so closing a
surface never starts a new turn or discards a running one.

The **Chat** sidebar remains available as a compact alternate entrance, including alongside the Workbench.
It is not a second transcript: both containers use the same renderer and selection, and only
visible containers receive live stream updates. `unode.workbench.autoOpen` defaults to `true`, which opens the
Workbench for **Open Chat** and agent-card chat actions; turn it off if you prefer
those actions to focus the sidebar instead. UnodeAi never opens the Workbench merely on activation.

To give the selected agent a precise code excerpt, select text in an in-scope editor or UnodeAi diff and
choose **Add to UnodeAi** from the editor lightbulb. It opens the Workbench and inserts that selection into
the selected agent's composer without sending a turn. The action is absent when there is no team or no
selected agent, and an outside-workspace document is offered only when that agent's existing Folder Access
read scope permits it.

When no turn can run yet, the same renderer in both containers replaces the transcript with one clear repair card: **Create a team** when the workspace has no agents, or **Open Settings** when the saved route is unavailable or its API credential is missing. The card carries no endpoint, secret name, or key; the host resolves those details and the composer stays disabled until the repair is complete.

Use **UnodeAi: Toggle Workbench Composer Focus** (`Ctrl+Alt+Enter` on Windows/Linux,
`Cmd+Option+Enter` on macOS) to move between the editor surface and the Workbench composer. The shortcut does
not use the Cursor-reserved `Ctrl/Cmd+K`, `L`, or `I` chords.

### Context receipt

Every turn carries a collapsed line above the reply: **Attached context: N sources · ~X text tokens
(estimate, attached sources only)**. Open it to see each source that entered the turn — its label, byte
size, token estimate, where it came from, and why it was included. The token number is derived from bytes
and excludes non-text sources; UnodeAi says so on the panel rather than presenting an estimate as a count.

**This number is not the size of the request.** It counts the attached sources and nothing else — the
conversation history, the system prompt, and the tool definitions all consume the model's window without
appearing here. That is why a receipt reading a few thousand tokens can sit beside a gateway rejecting the
turn as too large: the two measure different things. The composer's context meter, not this receipt, is the
number compaction is decided from.

Each file-backed source also shows two **filesystem facts**, not judgements:

| Field | What it says | What it does not say |
|---|---|---|
| **Staleness** | `modified N days ago` or `unchanged for N days`, read from the file's modification time, with a visible note at 90 days or older | That the file is wrong, obsolete, or unsafe. Stable, correct guidance stays correct at any age, and a fresh checkout can reset timestamps |
| **Sensitivity** | `no mechanical signal`, or `possible` together with the signals that matched — secret-pattern matches, conventional paths, owner-only file mode, or `.gitignore` membership | That a secret is present. This is not a classifier, no model inspects the file, and matched content is never copied into the panel |

The sensitivity signal is deliberately tuned to miss less rather than warn less: a source that quietly
carries credentials into model context costs more than an inspection you did not need. Both fields are
**report-only** in this release — nothing is blocked, redacted, or granted because of them. Sources that are
not workspace files, such as a directory-derived index, read `unavailable` rather than guessing.

### Edit history (the inspector rail)

The Workbench title bar has a **Show Changed Files** icon that opens a rail on the right listing what the
**selected agent** just changed, newest first. **The rail is titled *Edit history*, and that wording is
deliberate (0.9.34):** it lists edits that happened, not files that are currently different. A file you
restore with **⟲** stays in the list — it is a record of the edit, not a claim about the file's present
state. Calling it *Changed files* made a restored file read as still-changed. Each entry opens that edit in the **native VS Code diff
editor** — side by side or inline, `F7` to walk the changes, unchanged regions folded, and the right-hand
side is the real file, so you can fix an agent's edit inside the diff you are reviewing. Hover an entry for
**⟲**, which restores that one file to its pre-edit version after a confirmation.

The rail is **off until you open it**, and its state is remembered per workspace. On a narrow editor it
stops reserving a column and becomes an overlay drawer instead — it never hides while the title action still
says **Hide Changed Files**. Nothing in it is unique to the rail: the same restore points are in
**UnodeAi: Restore File Checkpoint…**, and an agent's own changed files are still on its Team roster row.

Worktree lane diffs open in the same native editor. A lane-level **View diff** asks which changed file to
open when there is more than one, instead of printing every file into one buffer. The base side is **pinned
to the commit it was opened against** and the tab title names it (`base a1b2c3d ↔ …`), so a diff you left
open does not quietly re-point when the base branch moves on.

### Context meter and Compact

A meter shows how full this agent's context is — `41% of an assumed 1,048,576 tokens`. In the Workbench it is at the right end of the header bar, beside the **…** menu. In the Chat sidebar, which is narrow and has no header bar, it is in the row of controls below the message box, beside the **⤓** button. The **⤓** button compacts on click.
**The denominator matters as much as the percentage**, so the label always says where the number came from:

| Label | Where the number came from |
|---|---|
| `configured` | You typed it into the agent's **Context window** setting. Always wins. |
| `measured` | The gateway advertised it for this exact model, through the model picker's consented `/models` read. |
| `provider-refused` | The provider rejected a request of that size. See below. |
| `assumed` | Nothing told us, so the documented 1,048,576-token fallback is in use. |

**Every runtime fills the meter in.** An OpenAI-compatible agent measures the conversation UnodeAi
holds for it. A Claude or Codex agent reports the size of each request it sends; the meter shows the projected
size of the next request, derived from the runtime's latest usage report. Codex also reports its model's window,
which then reads `measured`.

**When there is no number, the meter says why** rather than sitting blank:

| Pill reads | Meaning |
|---|---|
| `41% of an assumed 1,048,576 tokens` beside a **⤓** button | Live. Click ⤓ to compact. |
| `Context — start the agent` | The agent is not running yet. ⤓ is greyed out. |
| `Context — measured after the next reply` | A Claude or Codex agent that has not reported a size since it started or last compacted. A Codex agent keeps its last size across a restart, because it resumes the same conversation. ⤓ still works. |

`UnodeAi: Compact Context` performs the same action from the Command Palette, so it can be bound to a key.

**Click ⤓ to compact now.** The reading is text; the action is a square icon button beside the paperclip, and
its hover text and screen-reader name are a full sentence. It compacts whether or not the automatic trigger has
been reached, because you pressing the button is the trigger. The agent must be idle; pressed during a turn, it
says so instead. What compacting means depends on the runtime:

- **OpenAI-compatible:** UnodeAi summarises the older turns with the agent's economy model. It keeps the newest
  turns and every record of work, such as a file write, a command, a delegation or a refusal, word for word.
- **Claude and Codex:** UnodeAi asks the runtime to compact its own conversation, and the runtime writes the
  summary.

Either way the chat shows a receipt, described under [Smart compaction](#smart-compaction). If nothing
could be compacted, it says so rather than claiming success.

**An agent learns its own ceiling from a rejection.** When a gateway refuses a turn as too large ("exceeds
the context window"), that refusal is proof the model accepts less than was sent. UnodeAi records the size of
the refused request as that model's ceiling, switches the meter to `provider-refused`, and compacts on its own
before reaching it — so the same conversation does not fail again in the same place. The request is **not
retried**: it would fail identically and be billed again.

Three cases deliberately record nothing, and the error says which applies: you set **Context window**
yourself (your number stands — lower it); the new limit is no smaller than one already recorded; or the
conversation is too small to explain the rejection, meaning the system prompt, tool definitions, or attached
project knowledge are carrying the weight and compacting history cannot shrink them.

A recorded ceiling is bound to the exact model that produced it, only ever tightens, is saved with the agent
roster so it survives a reload (and travels in `.unode/team.json` whenever the team file is written), and is
overridden the moment you set **Context window** yourself.

### Smart compaction

Each agent compacts its earlier conversation automatically, just before a request would grow past its trigger.
Choose how in the Agent Builder under **Smart compaction**, or open that group straight from the **🗜️** button on the
agent's row in the Team view:

| Mode | What it does |
|---|---|
| **Smart** (default) | Uses a work profile's numbers. **Auto** picks the profile from the agent's role template, then its primary skill, and otherwise uses Balanced; the setting shows what Auto chose and why. |
| **Custom** | Your own window share (10–90%) and practical ceiling (16,384–2,000,000 tokens). |
| **Off** | Never compacts automatically. ⤓ still works. |

**The trigger is the smaller of two numbers:** the window share of this agent's context window, and a practical
ceiling. For example, a Balanced agent with a 1,048,576-token window compacts at 250,000 tokens, because 70% of the
window would be 734,003. Where field evidence shows a model failing earlier, Smart mode also applies that route's
cap: DeepSeek V4 Pro through OpenRouter compacts at 200,000. The setting shows every term and which one won.

| Work profile | Typical work | Window share | Practical ceiling |
|---|---|---|---|
| Balanced | Mixed, unknown, coordinator or custom work | 70% | 250,000 |
| Iterative delivery | Coding, content production, documentation, routine file delivery | 70% | 220,000 |
| Research & synthesis | Market and UX research, analysis, evidence synthesis | 70% | 275,000 |
| QA & debugging | Testing, review, incident analysis, repeated experiments | 75% | 300,000 |
| Deep build | Architecture, greenfield construction, migration, exact-source-heavy work | 75% | 350,000 |

**Edit team profile table…** changes a profile's numbers for every Smart agent in this team. The table is saved
in `.unode/team.json`, and Custom and Off agents are not affected. UnodeAi reads that file when the window opens,
so a change made outside the editor, by hand or by a `git pull`, applies after **Developer: Reload Window**. A
shared team file can also set an agent's mode and numbers, within the same bounds: it can make compaction more
frequent (each one costs summary requests), move it later or turn it off, but it can never grant access or block
a task.

**It schedules maintenance; it never blocks a task.** Compaction runs just before the task is sent, within three
minutes. If it fails or runs out of time, the chat says so and the task is sent unchanged. An identical automatic
failure is not tried again for ten minutes; ⤓ always tries.

**It waits until a compaction is worth it.** On an OpenAI-compatible agent, an automatic compaction that could
remove less than a tenth of the trigger is skipped at no cost, because it would land just under the trigger and
run again on the next turn. It runs a turn or two later, once more has accumulated, so the conversation can run up
to about 10% past the trigger. ⤓ always compacts. When the instructions, tools, kept records and newest turns alone
keep a compaction above its working target, the receipt says so and suggests a higher ceiling.

**What each runtime does:**

- **OpenAI-compatible:** UnodeAi writes the summary. It keeps the recent tail word for word and aims for the
  profile's post-compact target. Each summary request is charged to the task that triggered it, or to the
  Compact itself when you press ⤓.
- **Claude:** Claude writes the summary. UnodeAi also sets Claude's own threshold for compacting inside a long
  turn when the agent starts, so a change to this setting applies when the agent restarts. That threshold cannot
  go below Claude's minimum of 100,000 tokens, and the setting tells you when this moves it.
- **Codex:** Codex writes the summary and does not show it, and it reports no separate cost for it. Codex also
  compacts on its own threshold inside a long turn, in every mode including Off; UnodeAi neither sets nor turns
  that off.

**Every compaction leaves one receipt in the agent's chat.** It gives the size before (and after, when the
runtime reports it), why it ran, and what it cost. It also has a collapsed **What the agent now remembers**
section when the runtime shares the summary: a model-written summary, not evidence. A receipt appears once, even
after a reload.

### Empty replies

A model sometimes answers a request with nothing: no text and no tool call, sometimes after spending tokens on
hidden reasoning. UnodeAi then sends the same request once more, but only when the blank attempt did no work and
asked no one for approval, so a retry can never repeat an action. If the second attempt is also blank, the turn
ends as an **empty reply**, and the agent's chat says so with the facts:

> UnodeAi: The model returned an empty reply after 2 attempts. The last attempt used about 246,668 input tokens
> (provider-reported); no text or tool call was received. Upstream provider: DeepInfra.

For an OpenRouter connection, the upstream provider is the one OpenRouter reports it selected, shown as plain text.
Other routes read `unavailable`. A delegated empty reply never counts as completed work. The Activity view labels
it **Empty reply**, and a rejection reads "Rejected — the model returned an empty reply at about 246,668 input
tokens." UnodeAi reports what it observed; it never claims why the reply was empty.

**A teammate whose reply is empty gets two more chances.** First UnodeAi sends the same task once more with a
host note that the previous reply was empty. If that reply is empty too and the teammate has a fallback model,
UnodeAi switches the teammate to it and tries once more. Each retry is an ordinary new dispatch, so it passes
compaction, permissions, scope, file claims, input grants and spend limits again. A tool-only turn, an error, a
stop, a refusal or an approval is never retried this way. If every reply stays empty, the coordinator is told so
with the last reply's facts, and the card described under
[When a run gets stuck](#when-a-run-gets-stuck-the-card-carries-the-next-step) offers the next step.

### Knowing it is still working

While an agent runs its own turn, the transcript tails with what it is doing and how long it has been doing
it. **A coordinator that has delegated is idle on purpose** — it dispatched, ended its turn, and the work is
elsewhere — so that line used to disappear entirely, and a crew hard at work looked exactly like a crew that
had stopped.

It now reads `delegating to Content Strategist, 42s; delegating to Frontend Engineer, 12s` — one clock per
teammate still out, longest-waiting first, on one line. A count would not have answered the question people
actually ask of it, which is not "is anything running" but "which one has gone quiet".

### Approval signals

Approve or deny only from the inline card in the shared Chat/Workbench transcript, where the command, web
request, or diff that caused it remains visible. The decision is never duplicated in the sidebar.

When a decision is needed, the status bar shows **`🔐 N waiting`** (and hides at zero), the UnodeAi activity
container carries the same count, and the relevant Team row is highlighted with a lock. Click the status-bar
item or that highlighted row to open the relevant Workbench conversation and scroll to the inline card. This is
user-initiated navigation; an arriving agent request never steals editor focus, autofocuses an allow button, or
expands a UnodeAi sidebar you collapsed or switched away from. The status bar still counts it, and while a chat view
is visible the [chime](#a-sound-when-something-waits-for-you) plays.
While a card or approval dialog is actually open, the agent it belongs to reads **Waiting on your approval**
instead of **Stalled**, on every route. A request the policy decides by itself (allowed or refused without asking
you) never shows that state. When two agents need the same public-web approval, both show it while it is open.

**Each approval is decided once (0.9.88).** Whichever comes first settles it: your click, its 15-minute window
running out (a denial), or **Stop**. Anything later is ignored before it can take effect, so a dialog answered
after its window, or a click on a card that was already withdrawn, grants nothing and saves nothing. **Stop removes
that agent's cards at once** and its worker receives a denial; nothing it was asking for runs. If another agent was
waiting on the same approval, its card stays for that agent.

Host egress consent is also shown as **`🔐 Consent required — waiting for you`**, not as an agent error. If a
bounded approval expires, the Team row and transcript say **Denied — timed out** rather than silently returning
to idle. Local decisions record a local approver identity in the host event stream; this is a reusable seam for
future clients, not remote approval or mobile transport in this release.

The shared Workbench transcript supports:

| Feature | What it does |
|---|---|
| Live streaming | Shows replies as they arrive. While a selected agent is running, the transcript tail shows what the extension last observed in the turn and for how long, then the time since the turn started (for example, `Waiting for Claude – 8s · turn 31s` or `Running npm test – 14s · turn 52s`). See [What the live line says](#what-the-live-line-says). The timers stop when the turn ends or the panel is hidden |
| Stop | Interrupts a running turn |
| Steer | Sends an extra instruction to a running agent |
| Plan / Act mode | Controls whether tools are available |
| Tool cards | Shows file reads, writes, commands, MCP calls, diffs, and outputs. Each card is collapsed to its title row — click the row (or the ▶ on its right) to reveal the input, output, and diff. A **blocked** call opens by itself. A card's result (succeeded, refused or failed) is what UnodeAi or the runtime reported for that call, never a guess from the wording of its output, and when the same tool runs more than once at a time each result lands on its own card. Consecutive file reads collapse into one "Read N files" group. A finished card states its duration (`Done · 1.4s`) — see [Step timing](#step-timing) |
| Smooth streaming | Replies render markdown as they stream (code blocks, lists, and tables don't rearrange at the end), and bursty text is paced into a steady flow. A growing paragraph keeps its DOM node across paced paints — including one containing bold, inline code or a link, whose already-rendered parts are left alone as the text grows — so a selection in it is not recreated on the next frame. A paragraph whose tail is genuinely re-parsed, such as a closing `*` turning trailing text into emphasis, is still rebuilt. Turn off with `unode.chat.smoothStreaming`; it also flushes instantly when you switch windows or enable "reduce motion" |
| Analysis cards | Shows model reasoning streams when available |
| Context meter | Approximate context use, always labelled with where its denominator came from; the **⤓** button compacts now — see [Context meter and Compact](#context-meter-and-compact) |
| Todo panel | Shows only agent-reported `update_todos` plans. Its collapsed header states real progress (for example, `4 of 7 done · Wire the command`); expand it for the full checklist |
| Command/write approvals | Shows the approval inline with the command, URL, or diff that caused it; it is never a detached second approval queue |
| Per-agent drafts | Keeps unsent text with the selected agent (up to 20 recent drafts); sending or removing that agent drops its draft |
| Export/import | Saves or restores a selected agent's chat transcript |
| Compact mode | Compresses the chat view for dense workflows |

**A file tool card is a bounded receipt, not the document.** A `read_file` title says whether it holds
Markdown or other file content. Markdown previews use the same structured renderer as replies, and a
truncated preview states how much was omitted beside **Open full file in editor**. That button sends only
the receipt's host-issued ids; the extension resolves the recorded path and re-checks the agent's physical
read roots before VS Code opens it. Expanding a card is also durable across a later tool call regrouping the
card, a transcript refresh, and a Workbench reload.

**The composer is two rows (0.9.34):** the message box gets a full-width row of its own, and everything
else shares one control row beneath it — the two UnodeAi approval selectors on the left, then Insert, Send and
Stop on the right. Those three are **icons, not words**: **↑** sends, **⚡** steers a running agent, **↓**
queues a follow-up behind one, **■** stops. Hover any of them for the word, and every one carries the same
wording as its accessible name, so nothing is lost to a screen reader. For a Codex agent, that pair is replaced
by a per-agent permission selector: **Ask for approval** (default), **Approve for me**, or **Full access (unsafe)**
in Act mode, and forced **Read only** in Plan mode. A host ceiling is named in the disabled control. Full access
always opens a confirmation modal and remains visibly warned in the composer and session card. Below
roughly 450px the visible label drops away while the control keeps showing its current value. In Workbench the transcript uses the full height beneath the transparent
floating composer, and a revealed approval is re-anchored after a resize instead of reserving a permanent
empty band. Only while a decision is pending, its card reserves the dock's measured height, so it can
scroll completely above the composer even in a narrow or zoomed editor. On a short viewport the composer
returns to normal flow so it cannot cover the conversation.

**A send that nobody confirms comes back to you (0.9.88).** If the extension does not acknowledge a message within
about 10 seconds, for example because the extension host restarted, the composer returns your draft and its
attachments with a notice saying the send was not confirmed. Nothing is resent automatically, since the extension
cannot tell whether the old process received it.

### A sound when something waits for you

**A prompt that stops work until you decide plays one short chime when it appears (0.9.88)**: an approval card, an
approval dialog, or a consent dialog such as a new model-network destination, Codex's network access, a
repository's CLI configuration, a media upload, a folder outside the workspace, a coordinator brief to another
provider, or a managed integration that needs your go-ahead. It does not sound again when you answer, when a
second agent joins the same approval, or for dialogs you opened yourself, completion notices, or anything the
policy decided without asking you.

**It needs one interaction first.** VS Code lets a chat view play sound only after you have typed or clicked in
that view since it opened. So the first prompt after you start VS Code, before you have used the chat, is silent,
and so is a prompt when no UnodeAi chat view is visible. The prompt itself always appears normally; a sound that
could not play is noted once in the UnodeAi output log.

Turn it off with **`unode.attentionSound`** (on by default). It is read from your user settings only, so a
repository's settings cannot silence it.

### Step timing

**A finished step says how long it took, or says that nobody measured it.**

- **On the collapsed card:** `Done · 1.4s`. A failed or blocked step is labelled the same way — `Error ·
  0.9s`, `Blocked · 2.3s` — because how long something ran before it failed is often the more useful number.
- **Expand the card** for the absolute start time, the absolute finish time and the duration.
- **A coalesced group** (for example "Read 4 files") shows its span from the first start to the last finish.
- **Your decision is not the step's time.** While you decide on an approval that the only running call is waiting
  for, its card says **Waiting for your approval** instead of counting. When the call finishes, the time you took
  is left out of its duration and named: `Done · 0.3s · human approval 40.0s excluded`, the same time the turn's
  footer leaves out. A group leaves out its calls' waits the same way; for calls that overlapped it leaves out only
  the longest, because they may have waited on the same decision.

**A duration is measured or it is absent — it is never shown as `0s`.** The finish time is recorded at the
moment the call becomes a result, never inferred from when the card was drawn. A card saved by a version
before 0.9.63 has no measured finish and says **duration not recorded**; a group containing one such step
reports a **partial span** rather than presenting a shorter span as if it were the whole.

There is deliberately no timeline, waterfall, statistics panel or timing export, and per-step timings do not
appear in portable evidence.

### Long transcripts

The whole conversation renders, and a card you scroll away from and back to is the same card — it keeps its
expanded state and its already-rendered content instead of being rebuilt.

**0.9.63 briefly virtualised this and it was wrong.** Scrolling scheduled a redraw, the redraw replaced the
transcript and pinned to the bottom, and pinning scrolled again: both the Workbench and the Chat sidebar
repainted at frame rate while a reply streamed, and long content was unreadable. It was removed in 0.9.64. A
test now drives the real scroll listener in both containers and fails if a redraw is ever scheduled from one.

Consent prompts, approvals, cancellations, evidence facts, errors and final answers are never omitted,
reordered or merged by rendering — the product tests that sequence against the real batching and
animation-frame pacing before it ships.

### Reading a document from your workspace

**Since v0.9.69, `read_file` reads a PDF, a Word document or a PowerPoint deck from the folders an agent can
already reach.** It returns the text in the same tool result as any other file, with the same line window and
the same *continue from here* footer — there is no separate step and nothing to page through with a second
tool.

**This was a real gap and it is worth saying what it was.** UnodeAi could already read a PDF it fetched from
a public URL, and one you attached to a chat message. **The one it could not open was the file already
sitting in the folder you had opened.** An agent asked to consult a local white paper had no way to do it,
and a coordinator delegating that work had no way to hand it over.

What the extension does and does not do with those files:

- **Only the document's text is read.** Embedded images, macros, and any link a document points at are never
  opened. Nothing is fetched because a document asked for it.
- **The file is parsed in a separate worker with its own memory limit and a timeout**, so a corrupt or
  hostile document fails closed instead of affecting the editor.
- **Permission is unchanged.** A document outside an agent's read roots is refused exactly as any other file
  is; being a PDF grants nothing.
- **A scanned page says it needs OCR** rather than returning empty text. UnodeAi does not perform OCR.
- A plain `.zip`, and any other binary, is still refused with the same message as before.

### The activity feed

**The Activity panel names the tool and what it acted on** — a workspace-relative path for a file, a
command's program name for a command. Repeated identical actions collapse into one line with a count, and a
heartbeat updates that line rather than adding another.

**A directory operation says List rather than Read.** The card is labelled **List** while it runs and
**Listed N folders** when it completes, so the activity history does not imply file content was opened.

**Before v0.9.69 this feed showed internal plumbing.** A tool line read `Using mcp__unode_files__read_file`
twice when an agent read two different documents, because the entry carried the tool's internal name and not
the file. Two different pieces of work looked like one repeated line.

**Nothing an external MCP tool passes as an argument is written into this feed.** It persists and can be
exported, so a tool the extension does not own renders as its name alone.

### How long a turn took

**A turn reports when it finished and its total elapsed time.** Today's turns show local time, for example
`Finished 17:41:16 · Turn time: 21s`; older turns include the local date as well. The total includes time the
request spent queued behind other work and time the agent spent thinking, not just the tool calls — a turn whose
tool cards all read `0.1s` can still have taken minutes, and before 0.9.68 nothing added that up.

**Time spent waiting for your approval is reported separately and is not counted in the total.** That was
your time, not the agent's. This covers every decision the agent's work stops for: command, write, tool and
web-access approvals, and the consent dialogs for a network destination, a media upload, a read outside the
workspace, a coordinator's brief to another provider, a repository's CLI configuration and the mounting of an MCP
server. It also covers a request that was still queued while you decided, for example while the agent was
starting. When several agents wait on one prompt, each has only its own waiting time taken out.

Per-tool timings are unchanged. A turn whose time was never recorded simply shows no time; the old
**not recorded** line is gone.

**The footer also says where the time went**, on a second line:

`Observed: waiting for provider 15s (2 waits, longest 13s) · reasoning 2s · responding 2s · tools 1s · host 1s`

These parts add up to the turn time exactly. Each is what the extension observed, not what the model reports
about itself:

| Part | What it measures |
|---|---|
| waiting for provider | Time after the extension sent a request, or returned a tool result, during which nothing came back. The extension cannot see why: the provider may have been queueing the request, reading the context or reasoning without sending anything. With more than one wait, the line gives the count and the longest one |
| reasoning | Time from the moment the provider sent reasoning until it sent reply text, called a tool or ended the turn |
| responding | Time from the moment the provider sent reply text until it sent reasoning, called a tool or ended the turn |
| tools | Time while at least one tool call was open. Calls that run in parallel are counted once |
| host | Time the extension spent preparing the turn before its first request |
| queued | Time the request waited before the turn began: behind the agent's earlier work, or for the agent to start |

A part that took no time is left out, except `waiting for provider`. A turn recorded before 0.9.92 has no
such line: its breakdown was not recorded, and the extension does not show zeroes in its place. The same holds
for a saved breakdown that does not add up to its turn.

### What the live line says

While a turn runs, the line at the end of the transcript names what the extension last observed:

| Line | Meaning |
|---|---|
| `Preparing the request` | The turn has begun and no request has been sent yet |
| `Waiting for Claude`, `Waiting for Codex`, `Waiting for <route>` | A request or a tool result has been sent and nothing has come back yet |
| `Reasoning` | The provider sent reasoning. This line appears only then; silence is never shown as thinking |
| `Responding` | The provider is sending reply text |
| `Running npm test`, `Running a tool` | One tool call is open, and the timer beside it is that call's own time |
| `Tool work, 2 calls open` | Tool calls overlapped. The timer is how long the turn has had tool calls open; it is no single call's time, so no tool is named |
| `Waiting for your approval` | A decision of yours is open. It is shown ahead of the tool that asked for it, and the time you take is not counted in the turn time |
| `Working` | The turn is running and the extension has not reported a phase for it yet |

The first timer is the time the turn has spent in the state the line names, and it starts from zero when that
state begins. The second, after `turn`, is the turn time so far. Both are counted the way the footer of the
finished turn reports time: the time you spend on a decision is in neither. While a decision is open the line
reads, for example, `Waiting for your approval – 20s · turn 31s (paused)`, where the first timer is how long you
have been asked; when you have decided, the state that was interrupted continues from the time it had reached.
A tool's own card keeps its own elapsed time, which counts from when that call started and includes any time you
took to approve it, so it can differ from the first timer of the line.

### The answer that ends a turn

**Only the reply that ends a turn looks like a conclusion (0.9.88).** The working lines an agent writes before
each tool call stay visible as steps, in the plain style; the final answer has its own emphasis and is marked as
the conclusion for screen readers. Before 0.9.88 every finished line was styled as an answer, so the end of a
stage did not look like one.

**Its footer holds the host's facts about the turn, once each:**

1. **Why it spoke**, when UnodeAi started the turn itself, for example *Triggered by Frontend Engineer's rework
   reply* or *Triggered by results from Frontend Engineer and QA*. A turn you started has no such line.
2. **Delegations this turn**, for a coordinator, including *0 accepted · 0 refused*. It used to arrive as a
   separate card after the answer; that card is gone, and a count that changes later updates this footer in place.
3. **When it finished and how long it took.**

All three come from the extension, never from the agent's own text.

### What the product no longer does

**0.9.68 removed every automatic prompt that pushed an agent to behave.** Five kinds, including two that
worked by scanning the agent's own sentences for phrases and injecting a message when one matched. They cost
a round-trip each and prevented nothing you could not already see in the transcript.

**Verification did not get weaker.** A task can declare what would prove it done — real checks the extension
runs and records. The removed prompt was the version of that which asked nicely, and it outlived what
replaced it.

**Delegation takes less paperwork too.** Three contract fields that were required and usually left empty are
now optional. **The write scope is still required**, because it is the thing that stops a delegated task
writing outside the folders it was given.

**Nothing that protects you was removed.** Every safety property from earlier releases is re-tested each
release by deliberately breaking it and confirming a test catches it.

### Task-scoped delegation and what a path means

A delegated task can carry a **folder scope**: a ceiling that narrows which folders the teammate may read
and write for that assignment. Three things are deliberately separate, and 0.9.65 is where they became so:

- **What a relative path means.** A path the model writes — `research/x-article.md` — is always resolved
  against the agent's configured working folder, exactly once, for reads and writes alike. **A task scope
  never changes it.** It is the same base the coordinator wrote the task against.
- **What may be touched.** The scope narrows the read and write roots, and those are checked against the
  already-resolved file. Narrower, never wider than the agent's configured Folder Access.
- **Where a command runs.** A shell command's working directory stays inside the writable part of the scope.
  A shell is not a full filesystem sandbox, so its starting directory is a real boundary.

**Before 0.9.65 the first two were the same value**, so a scope moved the base as well as the ceiling: a task
scoped to `research` looked for `research/x-article.md` at `research/research/x-article.md` and reported
*context gap — missing*. A `readwrite` scope was worse — the doubled path was still inside the scope, so the
write was allowed and created the folder. If you saw either, this is what it was.

### When an agent shows you a file

**A tool card is a receipt, not the answer.** An agent that reads a file receives the whole thing; the card
beside it shows a bounded preview. An agent can now publish the file itself as its reply, and **the
extension does the publishing** — the agent names the receipt the extension gave it and picks one of:

| State | Result |
| --- | --- |
| **shown** | the extension publishes the whole file as the reply |
| **partial** | the extension publishes a prefix it cuts itself, by character count |
| **not-delivered** | the extension publishes the stated reason and no file content |

The agent may add framing text before the content. **It never retypes the file**, so nothing can be
mistranscribed and nothing has to be checked. Showing you a document is one read and one publish.

**0.9.66 got this wrong and 0.9.67 fixed it.** For one release the agent had to reproduce the file
character-for-character so the extension could compare the copy against the original it already had. A
single trailing newline was enough to reject it, and it could not start over — one such request cost about
four minutes on the strongest model available. If you saw that, this is what it was.

**Two things are still enforced**, because they prevent something you could not otherwise catch: content
from an earlier turn cannot be published in a later one, and a turn has one final answer.

The receipt line (and on Codex CLI the check line) is addressed to the agent, so a read's tool card shows only the
file. A line in the file that merely looks like one of these is file content and stays on the card.

**Published content appears in an "Exact content" block (0.9.88).** It keeps the file's own characters and line
breaks; a line starting with `#`, `*` or `1.` stays as written instead of becoming a heading or a list. The agent's
framing around it is ordinary text. The caption says what you are looking at:

| Caption | Meaning |
| --- | --- |
| **Exact content** | the whole read, as the extension read it |
| **Exact content (first N characters)** | the agent chose to publish only the start |
| **Exact content (first N characters kept in the transcript)** | the reply was longer than the transcript keeps; the part shown is still exact |

The copy button still copies the whole reply unchanged.

**The extension marks content exact only when it knows the agent received it**, and how it knows depends on the
route:

- **OpenAI-compatible:** the extension sends the content to the model itself, sized to fit what it sends.
- **Claude CLI:** only after Claude CLI reports that exactly the text it was given reached the model. If Claude CLI
  shortened or replaced a large result, it is not shown as exact content.
- **Codex CLI:** Codex does not report what its model actually saw. The extension checks that the model saw the
  **first and the last line** of what it read, and nothing more: **it cannot confirm the middle reached the
  model.** The content in the block is still exactly what the extension read from the file. A Codex coordinator
  reads through the extension for this; after updating to 0.9.88 each Codex coordinator starts one fresh
  conversation, with a notice that its tool set changed, because Codex fixes an agent's tools when its
  conversation starts. Codex workers are not affected.

A coordinator reads in pages sized for its route. A single line too long to fit whole (minified code, a one-line
data dump) is never shown as exact content. A coordinator that reads a file with its CLI's own tools gets no
exact-content block; its answer is ordinary text.

### Input receipts

A task contract's declared inputs each carry a receipt: supplied, reachable, read. **A receipt records the
file the extension actually opened**, matched by resolving it on disk — so an absolute path, a relative one
and a symlink to the same file all count as the same read, and letter case follows your filesystem rather
than an assumption about it.

**The resolved path stays inside the extension.** It is never placed on an input grant, never included in
the task card a teammate's model receives, and never exported — portable evidence carries no filesystem
paths, and this does not become the exception.

Before 0.9.65 a receipt was matched against the text the model typed, so a file that had plainly been read
could be recorded as unread. If an agent tells you it read something while the receipt says it did not,
**on 0.9.65 or later believe the receipt** and report it.

### When a run gets stuck, the card carries the next step

Two endings used to describe a repair in words and leave you to perform it across three surfaces. They now
offer it, and the extension does only what it could already do — the panel sends an opaque id, never a
target or a command.

- **A teammate's replies stayed empty.** After the host retry and the fallback-model attempt (see
  [Empty replies](#empty-replies)), the card offers **Edit agent model**, and then **Retry delegation**. The retry
  is a genuinely new attempt: same task, new input grants, and the same permission, scope and file-claim checks
  as the first dispatch. It is never a revival of the delegation that already ended.
- **An approval timed out.** The card states that the request **cannot be resumed**, and offers nothing —
  because there is nothing to resume. The tool call that asked for it already received its denial and moved
  on. **An approval that expired can never become an approval**, and its id is never re-used. If you still
  want that work done, ask the agent again; it will raise a fresh approval with a fresh window.

**A repair is re-checked at the moment you click it.** If the agent was removed, the session stopped, or the
remedy became unreachable after the card was drawn, nothing runs and the card tells you why. Clicking twice,
or on two surfaces at once, produces exactly one retry.

On the Team roster, a timed-out approval now shows **⌛** as the Status key has always documented; a
delegated task that timed out keeps **!**. They were previously the same marker.

### Plan mode

Plan mode is for analysis only. The extension removes write, command, delegation, and MCP tools at the tool layer for OpenAI-compatible agents. This is stronger than a prompt instruction.

Use Plan when you want a review, estimate, architecture discussion, implementation plan, or risk analysis without changes.

### Act mode

Act mode lets an agent use its allowed tools. Depending on your settings, it may read files, write files, run approved commands, delegate to teammates, or use approved MCP tools. Agents can also **`apply_edit`** (a targeted edit — replace an exact snippet instead of resending the whole file; goes through the same checkpoint/approval safety path), **`search_files`** (regex/text → `file:line`, so they find code instead of writing scratch scripts) **`delete_file`** (sandboxed and checkpointed, so a removal is restorable) and **`delete_dir`** (sandboxed recursive directory delete; refuses `.git`/`.unode` and anything outside the folder, so an agent doesn't shell out to `rmdir /s`) — all stay inside the working folder.

**Works with any model's tool names.** Unode runs many models, and each is trained on its own harness's tool names. When a model calls `Read` / `Bash` / `Write` / `Edit` / `LS` / `Grep` / `Task` (from Claude Code, Cursor, GPT, and others), Unode transparently maps it to the matching Unode tool and arguments — so a model's muscle memory just works rather than failing with "unknown tool".

Use Act when you want the agent to do the work.

### Use @unode in the VS Code Chat panel

UnodeAi also appears in the native VS Code **Chat panel** as `@unode`, in addition to its own sidebar — both run at the same time. In the Chat panel, type:

```text
@unode add a password-reset flow with tests
```

Your crew's Project Manager picks up the goal, delegates, and streams the run back into the chat. Use the **Open in UnodeAi** button to jump to the full team view (per-agent transcripts, worktree lanes, the review board).

`@unode` runs on **your configured UnodeAi agents and models** — not the Chat panel's model — so you keep the multi-agent orchestration and cheap-model cost arbitrage. You need at least one team (run `UnodeAi: Create Default Team` first).

Turn it off with the setting `unode.chatParticipant.enabled` if you want UnodeAi only in its sidebar.

## 6. Run a PM-Led Crew

For complex work, chat with the Project Manager.

A strong PM prompt includes:

```text
Goal: Add password reset to the app.
Scope: Backend route, email token model, UI form, tests.
Constraints: Do not change auth providers. Use the existing email service.
Verification: Run npm test and npm run build.
```

The PM can:

1. Create a task plan.
2. Ask the Architect for public contracts and file ownership.
3. Assign work to specialists.
4. Run independent tasks in parallel when files do not overlap.
5. Run `run_checks` using `unode.verifyCommand`.
6. Route failures back to the right teammate.
7. Ask the Reviewer for a final PASS or FAIL.
8. Summarize the outcome for you.

The Activity panel shows cross-agent events such as assignments, completions, broadcasts, and workflow events.

For independent or longer work, the PM dispatches asynchronously and then returns to an **accepting input** state.
You can give it another instruction immediately. When an async result lands while the PM is idle, it opens one
normal PM turn with the already-classified evidence so the PM can report or continue on its own. If the PM is
already busy, the result stays ready for non-blocking `collect_ready_tasks` — either path delivers it once.
If a result had already settled but had not yet been delivered when the extension host resumes, it remains in
that retained-result queue. This does not resume an in-progress worker; only an already-arrived result is
recoverable.
When a collected batch contains a failed subtask, the collecting step itself is shown as a **failed tool
call**, not merely as text that mentions a failure. The status is the one the host recorded while
collecting, so a step whose delegated work failed cannot appear as a completed call.

Use blocking delegation only when the next decision truly depends on the teammate's answer right now.
If that blocking wait expires, the PM turn is marked unresolved rather than completed. The worker's result
remains eligible to wake the PM for two further wait windows; stopping the run cancels that listener, so a
cancelled task cannot wake the PM later. The timeout names the actual window that expired (for example,
`timed out after 300s waiting for dev`); it does not predict whether a future task will fit that window.
`inspect_task_status` keeps four facts separate: worker state, wait-window state, result state, and read-receipt
state. Only a `ready` result is accompanied by a `collect_ready_tasks` action; pending work tells the PM to end
its turn and wait for the host wake rather than poll.

If a directed teammate or coordinator turn ends while its structured todo list still contains unfinished work,
the host settles it as **partial**. The full report remains visible and the unfinished activity is shown
separately. Partial is terminal for that turn, so waiting cards stop, but it is never counted or rendered as a
completed delivery; a workflow pauses before its gate or next step.

OpenAI-compatible agents do not have a 12-step working limit. They share a 100-iteration emergency backstop,
including Solo, while repeated identical calls are still stopped earlier by anti-spin. If either boundary fires,
UnodeAi asks the model once more with **no tools available** for a decisive answer and a list of unchecked items.
The result starts with a host-authored `Stopped:` line and is typed as partial, never completed or blamed on the
worker. A coordinator should call `continue_task` with that handle (and optionally a narrower focus): the exact
same worker conversation resumes with everything it already read, a fresh allowance, and a newly admitted
attempt grant. The expired attempt's permissions are never revived. A future budget stop uses the same stopped
state but makes no extra model request after the budget boundary.

### Task contracts and input resolution

Since 0.9.61 the model-visible `dispatch_task` path requires a versioned task contract. The PM proposes it;
the host validates and compiles it before choosing an executor. A contract declares the objective and
deliverable, separate read files and write scope, expected file effect, required capabilities, inputs,
constraints, upstream artifact dependencies, verification sensors, and one execution strategy:

| Strategy | Behaviour |
|---|---|
| `delegate-preferred` | Prefer a qualified teammate; use the coordinator only if the same gates also qualify it |
| `delegate-required` | Refuse with `no-executor` when no teammate qualifies |
| `coordinator-only` | Keep an atomic task with the coordinator, after the same capability, scope, input, claim, and sensor checks |

The host builds the candidate set first, then checks permissions, task scope, file claims, every required
input, artifact readiness, and verification-sensor reachability. An exact agent id that fails is never
silently replaced. A role rotates only among candidates that passed every gate. Solo remains the direct
user agent and is not an orchestration fallback.

Contract inputs are `contentAsset`, `workspacePath`, or `upstreamArtifact`. A workspace input says whether
the worker sees current content or a dispatch-time snapshot. Grants bind to one concrete attempt, not to an
agent or a timer; a retry receives a new attempt and the old grant is already dead. Inputs add no shell,
write, network, or MCP permission. Existing workspace read permission is independent unless an enforceable
task scope explicitly narrows it. The worker receives a task card, not the PM's conversation history.

### Coordinator briefs and destination consent

A coordinator may attach one short `coordinator_brief` to a delegated assignment: orientation it has already
established, with `basisRefs` to declared inputs. The worker sees it in the task card as a **coordinator claim,
not a host fact**, and must still report only what it observed. The host validates every referenced input when
it compiles the contract and checks again that the same inputs were actually granted to this particular
attempt. A brief that cites an ungranted input refuses the dispatch, names the input, and never starts the
worker.

The brief travels in the worker's **prompt**, rather than through a read tool, so it can paraphrase documents
you supplied. When the worker's resolved model destination differs from the coordinator's, what happens depends on
one setting: **Allow cross-provider dispatch without approval** (Settings → More, or
`unode.allowCrossProviderDispatchWithoutApproval`).

- **On — the default since 0.9.79.** The brief is sent without a pop-up, and the UnodeAi output channel records
  the destination host, so a send nobody clicked still leaves a trace.
- **Off.** UnodeAi shows a modal for every such dispatch and names the destination. **Send brief** starts the
  assignment; declining refuses it.

Either way the same resolved destination never asks, and a destination that cannot be resolved is refused. The
setting lives in your user settings only — a workspace cannot change it. UnodeAi compares privacy domains rather than a
provider label or model id, falls back to the canonical execution endpoint when a privacy domain is unresolved,
and refuses the dispatch if either destination cannot be resolved. The brief is retained only in the internal
run record for audit and is excluded from portable evidence and activity/conversation exports.

An upstream result is reusable only when its producer explicitly publishes an immutable `artifact-ready`
record. Settling a task is not enough. The artifact retains the provenance of every input granted to its
producer, and the host checks that chain before a coordinator may declare it for a downstream task.

If a required input cannot be used, the worker calls `report_context_gap` with only the input id. The host
records `missing`, `expired`, `outside-task-scope`, or `unreadable` only when its own latest access observation
for that exact input and attempt proves the failure. A successful read clears an older failure, and readable
but substantively insufficient material is for the worker to explain in its result, not for the host to label
unreadable. This task state remains separate from the framework delegation verdict.

**The input-substitution rule follows the contract.** A card for a task declaring at least one required input
tells the worker to report a gap rather than substitute web content for material the host could not supply. A
task declaring no required inputs — including one declaring only optional inputs — is told that no
input-substitution rule applies to it, because `optional` means the task can be completed without that input.
If a source genuinely must be consulted, declare it required. The card neither grants nor removes web access;
that remains the agent's configured capability.

`inspect_task_status` is the coordinator's read-only view of its own handles. It combines durable history with
the coordinator-owned live dispatch layer and reports worker, wait, result, and read-receipt state independently.
It survives result collection and reload, neither consumes a mailbox entry nor messages or wakes a worker, and
does not infer liveness from the mere presence of a retained handle.

Internal run evidence keeps the complete compiled contract and input receipts with only the claims the host
can prove: **supplied**, **reachable**, and **read receipt observed/not observed**. It never claims that a worker
did not read merely because no receipt exists, and it never claims **understood**. Timeout and late-terminal
snapshots remain separate so the historical timeout cannot freeze the current receipt view. Portable evidence
replaces input identities with document-local ordinals and omits objective, deliverable, purpose, constraints, paths,
source ids, attempt ids, artifact handles, and provenance identities; those omissions are declared in the
artifact itself.

### Delegation cards

**One card per request you made (0.9.88).** Every task the coordinator dispatches while working on one of your
requests joins that request's card, including dispatches from a turn it started on its own when a result came
back. A new request gets a new card, even while a worker from the previous one is still busy. Before 0.9.88 a
live card could collect the work of several requests, and a reload split them differently.

**A card sits where its request started, in every chat that shows it.** It follows the last message that came
before the request, so the same cards appear in the same places before and after **Developer: Reload Window**, and
in a worker's chat you open later they sit between that worker's turns rather than after all of them.
Names come back once the team has loaded. A card for an agent that has since been removed from the team reads
**Removed agent (xxxxxxxx)**, with the first characters of its id, instead of a bare id.

### Delegation evidence

When a teammate replies, its task card and the PM's tool result lead with a framework verdict — not the
teammate's own “Done” text:

- **Verified** — a recorded file mutation has an observed passing `run_checks`/completion gate.
- **Tool activity recorded; delivery not checked** — framework-visible read/search activity ran without a
  recorded write. This is a mechanism record, not a claim that the reply delivered the requested result.
- **Replied, not verified** — CheckpointRecorder recorded file changes but checks did not pass or did not
  run. The PM should run checks or send it to review.

  **Since 0.9.70 this verdict rests only on what the extension observed.** Earlier versions also scanned
  the teammate's reply for English phrases that looked like a claim that checks had passed, or that no
  files changed, and recorded a mismatch when the claim disagreed with the record. That reading was
  English-only, so the same claim in another language was invisible to it, and it could mark an explicit
  denial as a false claim. It is gone, together with the two mismatch flags it set, which no longer appear
  in portable evidence. **Reading the reply is your job and your PM's; the extension reports whether a
  check ran.**
- **No evidence** — the reply had no framework-visible tool activity. It is not a completed task.
- **Timed out** — a blocking delegation's wait expired before a result arrived. Since 0.9.59 this is its own
  state with its own accounting: giving up waiting and a teammate that did nothing used to be reported
  identically, which made a slow task look like an idle one.

The changed-file list is populated from recorded checkpoints, and the verification line is populated from
actual commands/gates; neither comes from the teammate's prose. This works for both OpenAI-compatible and
Claude PM delegation.

### Job outcome

**One card per finished team job (0.9.93).** A job is what a coordinator did for one request of yours: from its
first dispatch to its close. When the job closes, Chat shows a **Job outcome · Host-observed** card right after
the coordinator's final reply, in the Chat sidebar and in the Workbench. The card is not a message. It is never
sent to a model, summarized, compacted or counted as tokens, and it is not in an exported chat. Chat stores only
which job the card belongs to and which reply it follows; what the card says is read from the job's record every
time it is shown. A reload therefore shows the same card in the same place, and a fact that arrives late, such
as a turn's spend, changes the card where it stands instead of adding a second one.

**The line.** Closed, the card is one line, for example
`Complete · Verified · 1 file changed · 1/1 checks passed · $1.42 estimated · 40s`. It names what is left over:
`1 task unfinished`, or `1 dispatch refused by team policy`.

**Every figure is a host observation.** Nothing is taken from what an agent wrote, and showing or opening the
card runs nothing.

| Section | What it shows |
|---|---|
| **Outcome** | How the job closed (`Complete` or `Partial`), what the checks showed, who closed it, and whether a person has judged it |
| **Work** | Tasks and attempts, how many settled, stopped or were interrupted, and dispatches refused before they started |
| **Changes** | Files changed by delegated work, as recorded when they were written. Files the coordinator wrote itself are not in the list, and the card says so |
| **Checks** | The checks declared for each task before it started, as the host evaluated them |
| **Remaining** | Tasks that did not finish, and dispatches team policy refused |
| **Usage** | Tokens, and cost per basis. Amounts on different bases are listed separately and never added |
| **Approvals** | Counts of approvals by kind. What was approved is not on the card |
| **Timing** | Elapsed time, the times of the request, the first dispatch and the close, and where the agents' time went |

**What the words mean.**

- `Complete` and `Partial` say how the job was closed. A job with a task that was stopped or interrupted is
  `Partial`, whoever closed it.
- `Verified` appears only when a check declared for the task was seen to pass by the host. A job whose tasks
  declared no check reads `Checks not run` or `No applicable check`, whatever the agents wrote. That is the usual
  line for a review that changes no file.
- `partial`, `not recorded` and `in conflict` beside a figure mean that the record behind it is not whole, was
  never written, or disagrees with itself. The figure is then a lower bound or is left out. A missing price is
  `cost unavailable`, never `$0`.
- **Approvals: `None recorded`** means that no approval was recorded for this job. A consent dialog that is not
  an approval, such as the one for reading outside the workspace, is not counted there. When a turn of the job
  waited for a person, the section says so and for how long.
- **Times** are in your local time, with the time zone named. Hover over a time for the same instant in UTC,
  which is what an exported document shows.

**When a job ends.** A coordinator's closing reply ends its job once no task of it is still running. When you
stop the last running task of a job and the coordinator is idle, the job ends at the stop: the card appears
under the coordinator's last reply in that job, as `Partial`, and its elapsed time runs to the stop. You do not
have to send another message.

**Actions.** A card offers only what applies to its job.

- **Review changes** opens the Workbench with its change rail. The rail lists every recorded edit of the team,
  not only this job's.
- **Open evidence** opens the job's evidence report: the same facts as the card, as a Markdown document. No
  check is run again.
- **Continue unfinished work** composes a new request from the recorded facts: who had each unfinished task,
  what UnodeAi recorded about it, and its handle. It shows you the text first, with **Not now** and **Start new
  request**. Nothing is resumed or retried by itself. While the coordinator is in a turn, the text goes into the
  message box and nothing is sent.
- **Change target** and **Reset counter** are the spend actions. Neither changes the job or its card.

**Jobs from before 0.9.93.** A job that closed before you installed this version has no card. One that was
running across the update gets a card whose timing says `since first dispatch` and whose usage is `partial`,
because the start of the request was not recorded.

**If the job's record is gone.** UnodeAi keeps a bounded number of runs. When the run behind a card is no longer
kept, or two copies of the card's position disagree, the card says that its evidence is unavailable and shows
no figure.

### A coordinator's first action

**A coordinator that does nothing is stopped for you to decide (0.9.93).** A coordinator that receives a request
from you has to do one of three things first: dispatch a task, close the assignment, or reply. If it has done
none of them and its model sends nothing for 60 seconds in one stretch, UnodeAi ends that attempt and shows a
**No first action within 60 seconds** card with **Retry same route**, **Switch route** and **Stop**. Nothing is
retried or switched for you. Time in which a tool runs or an approval waits for you is not counted, and the limit
applies only before the first action, not to the work that follows.

**A dispatch to nobody is refused.** The coordinator receives the team's candidates with your request: the
teammates it can dispatch to, which excludes itself and the Solo agent. A dispatch whose target matches no
teammate is refused with the current references. The coordinator may then look at the roster once more and
dispatch to the exact id it shows. A coordinator that has no teammate to dispatch to at all is not refused for
that: it does the work itself where its strategy allows, as before.

**On the Claude CLI route** the coordinator's team tools are part of its first request, so it does not have to
search for them before it can dispatch. The managed-integrations and Skill-action bridges each have an endpoint
of their own.

### Closing an assignment the coordinator cannot finish

A coordinator states its own conclusion with **`close_assignment`**, and the outcome may be one it is not
proud of:

| Outcome | Meaning |
|---|---|
| `complete` | Everything asked for was delivered. Refused while any settled delegation still has no recorded decision. |
| `partial` | Some was delivered, some was not. Requires one entry per undelivered item, each with a concrete reason. |
| `blocked` | It cannot proceed as specified. Same per-item requirement. |

`partial` and `blocked` are **reportable outcomes, not failures to hide**. A coordinator handed an
impossible or under-specified job previously had no terminal state for it — the vocabulary covered only a
delegate's returned result — so it stopped, which from your side is indistinguishable from a coordinator
that quit thinking.

**If it ends an assignment without saying anything, UnodeAi says it for you.** The closeout you see is
labelled as UnodeAi's, not the coordinator's, and contains only mechanical facts: what settled with no
decision, what was accepted without a passing check, and that no conclusion was stated. **It never says
whether the work was correct** — the host cannot see that, and a sentence implying it could would be worse
than the silence it replaces.

### The brake

**While anything is running, the status bar shows `⏹ Stop N`.** One click ends every running turn. It
appears only while agents are working, so its presence is also the answer to "is the crew still going".

Same action as `UnodeAi: Stop All Agents` in the Team panel's ⋯ menu. It ends turns — it is not a message
asking agents to stop, and it does not wait for them to reach a convenient point.

### Stopping work a coordinator started

**A broadcast is a message, not a brake.** `broadcast` and `send_message` hand something to a teammate; a
teammate already mid-turn finishes it. Asking a coordinator to "stop everything" used to get a broadcast, an
assurance, and no stop — the machinery to cancel existed for the Stop button and nothing the coordinator
could call reached it.

`cancel_task` reaches it. `cancel_task({ all: true })` stops every assignment that coordinator still has
running; `cancel_task({ handle })` stops one. Cancellation is recorded on the run, not inferred.

**A stopped task makes its job partial (0.9.93).** A task that you or the coordinator stopped did not finish, so
the job it belongs to closes as `Partial` and its [Job outcome](#job-outcome) card lists the task under
**Remaining**. When the stop leaves nothing running and the coordinator is idle, the job closes at that moment.

**It stops the teammate, not just the assignment.** `cancel_task({ agent })` ends that teammate's turn
whatever started it — a dispatch, a broadcast, a `send_message`, or a forwarded rework note. That is the same
act the status-bar brake performs, asked for by the coordinator instead of by you.

A coordinator that can start work and not stop it is not a coordinator, so its authority does not depend on
how the work happened to begin. It cannot stop itself: ending the turn that is trying to stop the team would
be the one call that guarantees nothing gets stopped.

If the worker or extension host disappears before a terminal reply, the durable Activity row becomes
**Interrupted — no active worker**. It shows `worker-lost` or `host-restarted`, separate last-observed and
detected times, and any later disposition. It is terminal, stops its timer, and no longer counts as active.
`cancel_task` is idempotent for that handle. Record `abandoned` with a concrete reason to leave it closed, or
dispatch replacement work with `replaces_handle` and `replacement_reason`; admission writes the new handle and
the original task's `superseded` link atomically. The interrupted state remains visible beside either decision.

**The coordinator's chat says so (0.9.89).** An interrupted task also adds one line at the end of the
coordinator's chat: *UnodeAi: Frontend Engineer's task was interrupted: its session stopped before it reported a
result. Ask the PM to redo it with replaces_handle, or record it abandoned.* It appears once per task, also after a
reload, and it is not sent to the model. A task you stopped with **Stop** is cancelled, not interrupted, and gets
no such line.

**A run whose unfinished work was stopped, replaced or abandoned closes once, as partial (0.9.88).** Before, such a
run stayed open for ever: a task you stopped with **Stop** (it becomes *cancelled*, and a cancelled task cannot be
replaced, so the coordinator dispatches the redo as new work), or an interrupted task replaced from your next
message, because the redo belongs to a new run. Now the run closes when nothing in it is still working, every
interrupted task is superseded or abandoned, and the coordinator has moved on (it ended its turn elsewhere, or
dispatched in a newer run from this window). The closeout says **Closed by UnodeAi** and that no coordinator
closeout was observed on that run. It is never recorded as complete, and it never counts as your acceptance of the
work. A run whose tasks all finished normally still waits for its coordinator's own closeout, and a run merged in
from another window's history does not close yours. The run's delegation card shows **run partial** as soon as it
closes, without a reload.

### Coordinator dispositions

After the coordinator has actually decided whether to rely on a settled delegated result, it may record a
disposition. A result arriving does not require a label: forcing one for every delegation would turn a
decision into ceremony. Conversely, the coordinator receives a prompt at the result it is already collecting,
so the recorded decision is observable rather than a decorative tool it never sees.

0.9.47 shipped three dispositions. One round of real use produced **nine distinguishable settled-result
outcomes**, so 0.9.48 records all nine rather than flattening them into the nearest of three. v0.9.80 adds
`abandoned` only for interrupted work:

| Disposition | Meaning | Reason required |
|---|---|---|
| `accepted` | The coordinator relies on the result | — |
| `accepted-with-caveat` | Relied on, with a limitation worth carrying forward | yes |
| `accepted-after-rework` | Relied on after the delegate corrected it | — |
| `accepted-despite-framework-no-evidence` | Relied on although the framework observed no evidence — the decision and the verdict are both kept | — |
| `rejected` | Not relied on | yes |
| `needs-rework` | Sent back to the **same** delegate to correct | yes |
| `superseded` | Overtaken by later work | yes |
| `abandoned` | Interrupted work deliberately left without a replacement | yes |
| `deferred` | Decision postponed deliberately | yes |
| `needs-human` | Handed to a person | yes |

`needs-rework` is a state of its own, not a flag on `rejected`. `rejected` says the coordinator will not
rely on the result; `needs-rework` says the loop continues, and its required reason goes back to the
delegate. Collapsing them would hide whether the work is still moving.

The delegate's reply to a rework request wakes an idle PM, which reviews it and reports to you. So that a PM
and a delegate cannot bounce the same task back and forth unattended, UnodeAi sends at most **2 rework
requests per task after your last message**. A third is recorded but not sent, and the chat says so: "The PM
has asked 〈agent〉 to rework this task 3 times. Automatic rework stopped; accept the result, or ask the PM for
another round." Your next message to the PM allows further rounds.

Where a reason is required it must be concrete. A rejection forwards that reason to the delegate, and the
earlier framework verdict is visibly amended in the Workbench transcript, Activity, and the Team card; it is never silently
rewritten. This captures an explicit coordinator decision. It does not ask an LLM to judge whether prose
"really delivered" the work, and it never infers a disposition from the reply.

**A refused dispatch is a receipt, not a disposition.** When a coordinator declines to send work at all,
there is no result to assess and nothing a disposition could honestly attach to. It is kept as a separate
`rejected-at-dispatch` record with its reason and time, and the metrics report dispatch attempts, work
actually dispatched, and refusals separately — so the coordination effort is preserved without pretending a
result was reviewed.

`delegation_metrics` reports the current coordinator session's completed tasks, explicit
coordinator-accepted tasks, green framework verdicts later rejected, and explicit human-intervention requests.
0.9.48 adds the **other direction**: how often a `no-evidence` or `replied-not-verified` result was
nevertheless accepted. The framework already counted over-crediting; it could not see under-crediting, so a
correct answer built from context already on screen looked identical to a worker that guessed. UnodeAi does
not resolve that difference — the two are mechanically indistinguishable from the evidence retained here, and
reading the prose to tell them apart is exactly the self-grading this design excludes. It counts how often
the distinction mattered instead of inventing a story about why the trace was empty.
**Coordinator-accepted is still not enterprise/customer acceptance.** The coordinator is an agent, and this
counter measures agent decisions. Since 0.9.59 a separate human verdict does exist — see **Reviewing
delivered work** above — and the two are never merged: no coordinator disposition is ever counted as a
person's answer.

### Keeping role guidance current

Default role instructions update with UnodeAi: an agent that still follows its role template receives the
latest guidance on its next start. If you customize an agent's instructions, UnodeAi keeps them verbatim. The
Agent Builder shows whether that customization is based on the current default; when the default changes, it
shows a diff between the two default versions and lets you keep yours, reset to the new template (with Undo),
or merge the changes manually.

### Dispatch-time overlap notice

When an async dispatch overlaps work already in flight, the framework names the in-flight handle, owner, and task at the dispatch decision point. Cancelling a stopped worker frees a live dispatch slot so the next dispatch can proceed.

### PDF links and temporary content

When an agent uses `fetch_url` on a public PDF, the download remains subject to the same public-web approval
and SSRF checks as any other URL. A PDF is accepted only after its `%PDF-` magic bytes agree; it is stored in
an extension-owned temporary directory under an opaque id such as `content-1`, not added to chat history or
saved workspace state. The fetch result is a receipt. Use `read_extracted_content` for a stated page range
or `search_extracted_content` for a stated range; both report the requested/searched pages and the document
total, so a result for pages 1–5 of 42 is never a claim that the document was read.

**You can also attach a local PDF.** It takes the same path: the same `%PDF-` signature check, the same
10 MB ceiling, the same opaque id, and the same page-scoped read and search tools. Its filename is shown to
you but never sent to the model, written to chat history, or exported in evidence. Local PDF attachments
need an OpenAI-compatible agent; the Claude CLI and Codex CLI runners refuse the turn and say so rather than
quietly dropping the file.

Native text PDFs are supported. A scanned page is reported as **OCR required / unavailable**, not as read.
Encrypted, corrupt, over-large, over-long, and expired assets fail closed.

### Sending a stored image to a vision model

A picture you attach in the composer reaches a vision-capable model as it always has. This section is about
the other case: an image an **agent** downloaded with `fetch_url`, which is held as a temporary asset like a
PDF and is not sent anywhere by default.

To use it, the agent must call `send_image_asset_to_model`, and two things must then be true:

1. **The exact route must be known to support vision.** If the connection, model and endpoint you are on has
   never declared vision support, the image is *omitted* rather than tried — unknown is not treated as yes.
2. **You approve a separate upload prompt**, naming the media class, the provider, the host, the byte count,
   and the estimated input cost where the route publishes one.

**Approving a download is not approving an upload**, and neither is the ordinary model-egress approval you
gave for that host. The grant is remembered per host *and* per purpose, so allowing vision on a host never
allows transcription on it. Revoke either from the Security panel.

An approved image is sent with **one** request and then dropped — including when that request fails or you
cancel it — so a later turn cannot resend it without asking again. If the provider rejects it, UnodeAi
records that for that route only, keeps vision available elsewhere, and tells the model the image was
omitted, so a text-only answer is never presented as analysis.

**Video is unsupported in this release.** `fetch_url` refuses video before reading it. No decoder, native
module, or downloaded runtime ships in the extension. Every candidate was measured and rejected rather
than shipping a hidden system dependency.

If you export Portable Run Evidence after a PDF is consulted, it carries only a document-local content
ordinal, the PDF/read/search outcome, extraction state, page coverage, truncation, and OCR state. It never
exports the link, query, attachment name, temporary path, extracted text, or PDF bytes.

### Temporary task scope

A coordinator can attach a temporary folder scope to one `dispatch_task` assignment — it is assignment-only and does not change the agent's saved configuration. The host intersects that scope with the agent's configured Folder Access; it only narrows the grant and never widens it, and a read-only assignment removes write and shell tools. The delegation card shows the temporary scope while it is active and marks it ended afterwards. A backend that cannot enforce the turn-local boundary refuses the scoped assignment and returns a reason rather than pretending it was applied. If a requested file is inside the configured folders but outside this temporary assignment, the host returns a bounded task-scope refusal and the agent can continue with another granted action or report the context gap. A path outside the configured folders remains terminal and requires the user to open the correct project.

**The boundary has not relaxed.** No path that was refused is now readable or writable. Only a typed
`WorkspaceEscapeError` from a real configured-workspace path proof ends the turn. A shell command whose text
*looks* out of root is still blocked and never executes, but that detector is a heuristic rather than a
filesystem proof, so the agent can try another safe action. An expired, unsupported, or unforwarded temporary
asset is also still refused as unavailable; it cannot be recovered or sent, but does not end useful work.

### Activity export truncation

An Activity export keeps a 300-item presentation window over the coordination stream. When events older than that window are omitted, the export declares that fact and the omitted count rather than silently appearing complete.

### Reviewing delivered work (a human verdict)

A coordinator's `accepted` is an agent's opinion about a teammate's result. It has never meant that a person
looked at the work. `UnodeAi: Review Delivered Work` is where a person says so.

Pick a finished run (or open it from the run itself). UnodeAi shows that run's evidence — what was
dispatched, what settled, what the framework observed — and then asks for one of three answers:

| Verdict | What it records |
| --- | --- |
| **Accept delivered work** | A human acceptance of this run |
| **Accept with exceptions** | Acceptance, plus the items you name as still open. At least one is required |
| **Reject delivered work** | A human rejection. This is a real measured outcome, not a failure of the tool |

**A run nobody judged reports `unjudged`, never `accepted`.** Nothing in the product converts a coordinator's
disposition, a green `verified` framework outcome, a closed run, or your silence into a human verdict. If you
dismiss the picker, the run stays unjudged, and that is a truthful state rather than a missing one.

A run with delegated work still active cannot be judged — UnodeAi says so and leaves it unjudged until the
work settles. Verdicts are append-only: judging a run again records the new answer and the run reports the
latest, while the earlier verdict stays readable. Runs from before 0.9.59 load as unjudged.

Verdicts require a contemporaneous approver — the same rule UnodeAi already applies to command and write
approvals. An exercised grant or an expired prompt cannot stand in for a person.

In an exported **portable** evidence artifact the verdict travels as the verdict itself, a **count** of
unresolved items, and a document-local approver ordinal. The text you typed for those items does not leave,
and neither does any approver identity.

### Run evidence packs

The Activity window is not a work boundary. A run begins at a coordinator's first real delegation and closes
only when that coordinator gives a closeout on the run's own host-observed correlation after every delegation
settles. An unfinished coordinator therefore leaves an explicit open run across extension-host restarts.
Messages, context receipts, and permission events without that correlation are deliberately omitted: this can
omit unthreaded coordinator narration, but it prevents a reused PM or worker from being attributed to the wrong
run. Use **UnodeAi: Export… → Run evidence pack** to choose one run and write a standalone Markdown artifact. It
records mechanically observed dispatches/refusals, framework verdicts, append-only coordinator dispositions,
exercised approvals and grants, and context-source labels. It also derives dispatch, settlement, refusal, and
disposition counts from those records without reconstructing chat history. That proves the product can supply
Job B's numbers for a run; it does not replace the later real-round reading of which numbers people still needed
to obtain by hand. The pack says whether activity was omitted relative to that run, distinguishes coordinator
acceptance from human/customer acceptance, and never asks a model to judge correctness. Raw approved commands,
context contents, and credential values are excluded.

**UnodeAi: Export… → Portable run evidence** writes the same run as JSON built for a reader outside your
organisation. The evidence pack above is an internal record: it retains your objective and every task
instruction, redacted only by credential pattern-matching. The portable artifact inverts the rule — **no
prose: nothing you or a model composed as text.** No objective, no instruction, no permission label, no
verification command line, no agent reference a model typed, no file contents. **Agents appear as `agent-1`,
`agent-2`**, never under the names you gave them, since a name can be a client or a deal; a role is carried
only when it is one of the shipped role names.

The current schema is **`portable-run-evidence/5`** (0.9.93). It adds two fields to a delegation that is a
host retry of an earlier attempt: `retryOfHandle`, the attempt it retries, and `retryStage`. A link that failed a
rule is not carried, and the file's `omitted` section says that a link was left out. Like `/4`, it distinguishes
complete and partial run closeout, carries each delegation's independent completion state, counts terminal
interrupted work separately, and names the sensor-bounded input field `readReceipt: observed | not-observed`.
Consumers of `/4` must treat `/5` as a schema upgrade rather than assuming the added fields exist under the old
version.

**Identifying content it does keep is stated too.** Workspace-relative paths of changed files are the evidence,
and a count with a file extension is not something a reviewer can review. Timestamps disclose when the work
was done; every one of them is UTC, and since 0.9.93 the `retained` section says so. Complete change sets also
carry the hashes described below. All are listed in the file's own
`retained` section, because "no prose" is a strong enough claim to stop you checking before you attach it.

**Approver and route identity are bounded at export.** A contemporaneous human command, write, tool, or web
decision is retained exactly in the internal ledger, then becomes a document-local `approver-1` in portable
JSON. An exercised MCP grant is not a new decision and carries no approver; an expired prompt does not invent
one. Built-in destinations survive only when their route kind and canonical endpoint match the builder's
closed table. A custom connection becomes `custom-gateway`, its private hostname is withheld, and only the
bounded privacy state (`known`, `unknown`, or `unresolved-user-selected`) leaves.

**A complete change set can carry a write-time digest, never a diff.** For each successfully observed file
effect the ledger hashes the first before-state and latest after-state immediately, then computes a
deterministic SHA-256 root over those relative paths and hashes. It never retains the source bytes. The
portable builder validates the path set, validates every hash, and recomputes the root. Historical runs,
unrecorded writes, recursive directory deletion, and writes whose content could not be fully observed retain
an accurate `delegation.diffDigest` unavailable declaration instead of a guessed value. Hashes disclose
equality and allow confirmation guesses, so the artifact declares them in `retained` too.

A path is kept only when every segment of it is plainly relative; anything else is dropped and *counted*, so
the artifact tells the reader how many paths it could not carry rather than inventing a rewritten one. What
it withheld is listed too, separated from what was simply never recorded — an absence you cannot see is one
you cannot audit.

**UnodeAi: Export… → Evidence report**, **UnodeAi: Generate Evidence Report** and **Open evidence** on a
[Job outcome](#job-outcome) card all write the same document (0.9.93): the outcome of one finished job, with the
facts its card shows. You choose the job; with no finished job the command says so and writes nothing. Writing
the report runs no check and reads no file of the workspace. Before 0.9.93 this command ran the workspace's
verify command and listed recently changed files; it no longer does either.

**Every exported document says that its times are UTC (0.9.93).** UnodeAi records every time in UTC. The evidence
report, the run evidence pack and the worker progress report state that before their first timestamp, and mark
their own times `(UTC)`. A report written in the evening of 4 October in California is dated 5 October: that
is the UTC date, not an error. Chat shows local time, with the time zone.

Use **UnodeAi: Export… → Worker progress distribution** for the Phase A cross-run report. It splits long worker
tasks by framework-observed evidence, then shows no-material-progress quantiles and buckets rather than a
mean. It does not judge the usefulness of worker prose or enforce a timeout.

## 7. Run Workflows

Workflows are deterministic role-to-role pipelines. They are useful when you want a repeatable process instead of dynamic PM planning.

Run:

```text
UnodeAi: Run Workflow
```

Built-in workflows include:

| Workflow | Steps |
|---|---|
| Code Review Pipeline | Senior Developer -> Tester -> Security |
| Feature Implementation | Architect -> Senior Developer -> QA |
| Bug Fix Pipeline | Senior Developer -> Tester |
| Documentation Generation | Senior Developer -> Technical Writer |
| Feature (Gated, cost-optimized) | Architect -> Senior Developer -> `run_checks` gate -> QA |

To customize workflows, run:

```text
UnodeAi: Edit Workflow
```

Custom workflows are saved with the team configuration.

Conditional workflow branches use a closed set of labels declared by the step. The completing agent selects
one exact label through the structured `select_workflow_branch` action; UnodeAi does not search the agent's
reply for a matching phrase. If no label is selected, the workflow continues linearly.

Workflows saved before 0.9.70 are migrated when the team file loads, and the file still loads. A branch whose
old condition was a substring becomes that exact label, which the agent must now select by name. A branch
that had **no** condition used to mean "always"; it is kept as a **fallback** taken only when no declared
label matched. A fallback is never offered to the agent as a choice, so it cannot be selected in preference
to a real outcome. Each migration is reported in the team file's validation warnings, and re-saving from the
Workflow Editor preserves it.

## 8. Marketplace

Open the Marketplace with:

```text
UnodeAi: Open Marketplace
```

The Marketplace has two tabs:

| Tab | Purpose |
|---|---|
| Agents | Browse the shipped Role Templates and every Agent in your current roster |
| Integrations | Add governed MCP configuration and inspect its host-recorded lifecycle |

**Role Templates** and *Create a team* use the same 52-role source. **Your Agents** also includes agents you
built yourself. A template-based agent says which template it came from and whether its instructions still match;
an older Agent without origin metadata says *origin not recorded*. **Open in Agent Builder** edits that Agent.

An active Integration states its authoritative source, maintenance state, exact package/image/endpoint identity,
verification date, transport, prerequisites and credential-variable names. The host derives the approval label
from what the configuration actually does; the catalog cannot weaken it. `listed`, `configured`, `approved`,
`mounted`, `exercised`, and `succeeded` are separate states. **Check setup** reports the current states without
configuring, approving, mounting, exercising, or granting the Integration. Its answer is a modal dialog with the
editor's single **OK** by default, like other notices that directly answer a command or click. To keep those
results in the corner instead, enable **Show results as quiet corner notifications** under Settings → More. This
user-only choice never changes approval, consent, or action-button dialogs; background notices remain toasts.

Adding a Role Template or importing a team never configures or grants an Integration. Suggested Integrations
are labels only; grant an MCP server to an Agent explicitly in Agent Builder.

**Members come equipped.** Default software roles carry mapped skill **playbooks** (for example, Security carries OWASP Top 10, secrets scanning, and authorization review). The backend progressively loads only an authorized skill when it is needed; full procedures are not copied into the standing prompt.

Skill descriptions may be written in any language. The host checks structural facts such as length and
reserved names, but does not require English keywords or a particular whitespace/token shape.

Every role also starts with the **Using Superpowers** meta-skill, which prompts the agent to check its authorized skills and load the most relevant one before acting. It is guidance only — it does not change any agent's tool permissions.

The active Integration catalog lives in `marketplace/mcp.json`; role cards are projected directly from
`ROLE_TEMPLATES`. `marketplace/agents.json` remains only as a compatibility-reconciliation fixture for its former
13 listings. Catalog validation rejects archived, deprecated, provenance-free, stale and identity-mismatched
active entries.

If `unode.marketplace.catalogUrl` is set and `unode.marketplace.fetchCatalog` is enabled, UnodeAi can merge a hosted catalog with the bundled catalog. If the hosted fetch fails, the bundled catalog still works.

## 9. Team Rules and Memory

Team Rules are saved in:

```text
.unode/rules.md
```

Open the editor with:

```text
UnodeAi: Edit Team Rules
```

The panel separates three different things:

- **Built-in protections** are display-only host enforcement and have no toggles.
- **Team policy** is host enforcement selected by a person. The first policy is off by default: for an
  explicitly marked artifact review, require a different **reported model identity**. This comparison does
  not prove that different underlying models answered or that a review was good.
- **Guidance** is advisory Markdown in `.unode/rules.md`. Agents interpret it; it cannot grant permissions or
  change built-in protections or team policy.

For compatibility with other coding agents, UnodeAi reads root-level `AGENTS.md` and `CLAUDE.md` alongside
`.unode/rules.md`, in that fixed order (the most specific source remains last). Each turn receives a compact
heading/excerpt index rather than those files in full; when a source is relevant, the agent uses the existing
root-confined `read_file` tool to load the full source before relying on it. The authority and precedence have
not changed. Identical content is indexed once, and the index names when an original full-prompt admission
would have reached the 12,000-byte per-file cap.

Structured Markdown under `docs/` is handled the same way: the turn gets a deterministic file/heading index,
not all document bodies. A relevant document remains available on demand through `read_file`. This can mean an
agent makes an additional read; do not assume that a smaller standing prompt lowers total task cost. Repository
instructions and docs can guide behaviour, but cannot grant commands, MCP servers, network destinations, or a
write scope.

When you create, switch, add, remove, or reconfigure a role, UnodeAi maintains one generated roster block
inside this file. It names each active role and one short responsibility so every agent has current team
orientation without paying for biographies each turn. The block has visible `unode:team-roster` markers:
UnodeAi rewrites only a complete marked block. If the markers are absent or incomplete, it appends a new
block rather than guessing which of your text it owns. Keep your own rules outside that block.

Use these files for project conventions, coding preferences, review guidance, and known architecture facts.

Example:

```markdown
# Team rules

- Follow the existing project style.
- Do not add dependencies without asking.
- Run npm test before reporting code work complete.
- Keep PM tasks scoped to non-overlapping file sets when using parallel agents.
```

## 10. Settings

Open the UnodeAi settings panel with:

```text
UnodeAi: Open Settings
```

### Execution hooks

`unode.executionHooks` is a list of restrictive host-hook declarations, not an automatic execution
setting. A declaration from any scope — including a repository's `.vscode/settings.json` — is inert until
you run **UnodeAi: Apply Execution Hooks**, inspect the complete normalized declaration, and confirm it.
The confirmation is stored in UnodeAi's workspace state and binds the declaration digest and settings origin;
editing it or moving it to another origin makes it inert again. Hooks can only block an action already
available to an agent. They never grant file, shell, network, MCP, or model authority, and agents have no
tool to edit either the setting or its approval record.

### Provider settings

Use the Providers tab to see which provider keys are set. Secret values are never displayed.

Each available connection card shows its runtime, billing path, endpoint or CLI setup, and egress/privacy summary. An available card has a **Set as default** action, and the current default is marked **★ Default for new agents**. This is how you switch to **Claude CLI** or **Codex CLI** after the setup wizard.

**Test connection** is on every API-key gateway card — **Roam, Unode, OpenRouter, OpenAI API**, and every named custom gateway — not just custom ones. It resolves that connection's endpoint and key from the registry (never from the panel), asks for metadata consent for that host, then makes one `/models` request and reports success or an actionable failure. It sends no prompt and no workspace content, and neither the key nor any part of it appears in the result or the error. Claude CLI and Codex CLI have no Test connection: they authenticate through their own CLI, not a stored key.

Built-in API-key cards use **Set key**, **Edit**, **Clear key**, **Test connection**, **Set as default**, and
**Check pricing** where that provider publishes pricing. The key itself is never displayed in the card.

The **Unode** and **Roam** cards also carry **Update reference prices** (0.9.89). It takes a fresh anonymous
snapshot of that gateway's public price list, dated today, for the spend estimates described in
[Spend: what a request cost, and reminders](#spend-what-a-request-cost-and-reminders). It sends no key. Its
tooltip shows when the current snapshot was taken.

The **Codex CLI** card carries **Choose Codex executable…** instead of key actions. It opens a file picker,
validates the executable you select, and stores its absolute path in your user-level `unode.codexCliPath`. Nothing
is launched by choosing it, and no Codex configuration or credential is read.

### Capability profile

Each configured agent's **Model Tuning** card includes a closed **Capability profile** section for its
connection × model pair. It lists tool protocol, sampling-parameter compatibility, context-window policy,
and recovery behaviour. Every row names its effective source and the facts available beneath it:
**user override** wins over an **observed this session** fact, which wins over the cold-start **declared**
fact. Observed entries include their timestamp.

Observations are deliberately not saved automatically. A gateway rejecting `temperature` or a model leaking
a native tool call changes only that running session's overlay; UnodeAi may present an approval-required
proposal, but it never changes the saved connection, model, or agent configuration without you applying it.

### Named Custom gateways

Use **Add custom gateway** at the top of the Providers tab to create a local OpenAI-compatible profile. The host prompts for a display name, canonical HTTPS endpoint, and masked API key; the key value never enters the Settings webview. The final confirmation names its background-request policy: custom gateways currently have no scheduled request, so saving one does not authorize background traffic. Each card shows its name, endpoint, whether a key is set, default/in-use state, and the same flat action row as the Roam / Unode / OpenRouter cards:

**Test connection · Edit · Set as default · Load models · Remove**

- **Edit** is one flow for the whole profile: display name → endpoint → what to do with the stored key (**Keep current API key**, **Replace API key**, or **Clear API key**), then a confirmation that names the old and new values and any known local references. Cancel at any prompt and nothing changes.
  - Changing only the **name** is always allowed. Existing agents, Smart Mode mappings, and the default keep the same opaque connection identity, so a rename never re-points anything.
  - Changing the **endpoint or key** is blocked only while an agent on that gateway is actually **running** (starting/running/stopping). An **idle** agent does not block the edit.
  - After the change, a backend built from the old profile is denied on its next request and asks to restart. Clearing a key leaves the profile visible but non-runnable; it never borrows another provider's key.
- **Test connection** and **Load models** are explicit network actions. They ask for metadata consent for that gateway's host and contact only its own `/models` endpoint. They send no prompt, no workspace file, and no key to any other gateway.
- **Remove** is blocked while a current local agent, the new-agent default, or a Smart Mode tier still points at the profile; the message lists exactly what to rebind, and hovering the button states the rule first. After removal the immutable ID becomes a tombstone: an old route pointing at it shows as a repair record rather than being silently re-pointed at another gateway.

Custom model prices and account balances remain unknown unless that exact custom gateway publishes trusted per-connection data. UnodeAi does not borrow a built-in gateway's price, catalog, endpoint, or balance for a custom profile.

Creating a **team** on a custom gateway asks once for the model to use and applies it to every role, because a custom gateway ships no built-in model catalog to resolve per-role tiers from. Cancel that picker and no agents are created — you never get a crew wired to a model the gateway does not serve.

### Migrating the old Custom connection

Older rosters may contain the retired singleton `custom`, `CUSTOM_API_KEY`, `unode.customBaseUrl`, or a per-agent `baseUrl`. In a **trusted** workspace, UnodeAi shows a host-authored preview before changing anything. It uses an agent's valid HTTPS endpoint before the old global setting, keeps different legacy credential identities separate, creates fresh opaque profile IDs, and copies an old key only inside the extension host after confirmation. Cancelling changes nothing and sends no network request.

**There is no command or button for this.** The preview is not something you go and find — it appears by itself when UnodeAi activates in a trusted workspace whose roster still contains pre-0.9.31 `custom` agents. If you never had such a roster, you will never see it, and that is correct. Migration is entirely local: it contacts no network and tests no key, so endpoints that do not resolve still migrate fine.

**Declining is a real answer, and it sticks.** Choose not to migrate and nothing is written: those agents stay visible as non-runnable repairs, and reloading the window does not ask you again for the same roster. Your team file keeps working normally — adding, editing, and deleting agents all save correctly after a decline.

An invalid endpoint, missing key, unknown profile, or archived profile remains visible as a non-runnable repair instead of defaulting to Unode, Roam, OpenAI, or any other gateway. The old setting and key are retained for a compatibility window so a later workspace can migrate independently.

**Codex CLI uses your local Codex login.** Install and log in yourself, then choose the executable from its Settings provider card (the official npm `.cmd` wrapper is resolved to its adjacent native executable). UnodeAi runs bounded local version/login-status checks first; before App Server or a model request starts, it asks for separate consent naming OpenAI and the model provider configured in Codex. UnodeAi does not control the CLI's network behaviour. Declining starts no App Server or model request; revoking the Codex consent in the Security panel kills the running Codex process tree.

Codex keeps its own base instructions, hooks, plugins, native tools, and model-provider configuration. UnodeAi adds
the agent role as developer guidance and loads selected instruction-only Playbooks from a private temporary Skill
root. Either Claude or Codex may be the host-selected team coordinator; only that agent receives team tools, and
Codex supports steering while a turn is active. Agent Builder MCP grants also stay host-owned: Codex sees only the
approved dynamic tools, while the external server and its secrets never enter global Codex configuration.

In Act mode Codex defaults to **Ask for approval**: `workspace-write`, `on-request`, with eligible requests
reviewed by the user. **Approve for me** keeps workspace-write/network-off but sends escalation decisions to
Codex `auto_review`; no UnodeAi card appears, and its review action and result are written into chat. **Full
access (unsafe)** uses no sandbox, enables network access, has no approval prompts, may read/change any file the
account can reach and run any command, and creates no UnodeAi checkpoints. It requires confirmation each time it
is enabled. Routine local commands and edits inside the granted workspace boundary run without
a card. An approval appears only when Codex **requests** an escalation — to cross that sandbox boundary, use
blocked network access, request additional permissions, or invoke a prompted MCP effect. Whether to request one
is Codex's decision, not UnodeAi's: when it does not, the blocked action simply fails. On the measured Windows
0.155.1 binary, a blocked network command or out-of-workspace write under Ask for approval produced a card, and
under Approve for me the same request went to Codex's reviewer instead. These are Codex escalation approvals, not
“ask before every command” or “ask before every write.” The Workbench therefore replaces **Commands** and **Writes** with the active Codex
permission profile. Plan mode and the Workspace Trust, write-folder and tool ceilings resolve the effective
profile to read-only. An agent limited by explicit Folder Access grants can use Ask for approval or Approve for
me, which keep writes inside the granted folders, but never Full access: that has no sandbox and cannot honour a
folder grant, so it resolves to Ask for approval. Routine Codex edits are not UnodeAi checkpoints and cannot be
restored from UnodeAi's checkpoint list.

Codex's reads are **not** a workspace-confinement claim. Measurements showed native Codex reads can reach files
outside the workspace. Treat Codex as able to read files available to your Windows account and send selected
content to its configured provider. UnodeAi does not open your user configuration; Codex loads it natively after
consent. UnodeAi pins the native approval/sandbox profile, disables sandbox network access, and disables Codex
analytics and OTel export.

**Repository CLI configuration asks before it can run.** If the agent's working directory or an ancestor the native CLI searches contains `.claude`, `.mcp.json`, or `.codex` project configuration, UnodeAi shows a redacted summary before either CLI starts. This includes a repository root when VS Code opened only one subfolder; the dialog shows the executable basename of declared hooks without exposing its arguments. HOME `.claude` and `.codex` stay native user configuration and are not inspected. **Trust and load** retains native project and user features. **Continue without project automation** runs Claude with only its user settings and starts Codex with a process-local `untrusted` project override. Trust and load uses the corresponding `trusted` override, so the dialog controls Codex's project layer without editing your config file. Codex skills may still load as instructions in untrusted mode; any effect they request remains subject to the active Codex sandbox and approval profile. The grant is bound to the containing workspace folder, CLI working directory, CLI kind, and exact configuration digest. A change asks again, and the Security panel can revoke it.

**Automatic refresh is user-controlled.** The only scheduled network task is the daily price refresh. Roam and Unode provider cards each expose **Automatic daily price refresh**, on by default for existing behaviour. Unbound `unode.pricingSources` entries have a separate **Global pricing sources** toggle under Settings > More. Both settings live in user storage, not repository settings. A scheduled run never executes at activation, never prompts, and contacts only a host that already has metadata consent. Concurrent triggers coalesce and failures back off. Balance checks, model catalogs, Marketplace catalogs, and custom-gateway model loading remain user-triggered, not scheduled.

Because Anthropic stores no key here, its card offers **Set up Claude CLI** instead of *Set key*. That opens a terminal with `claude login` typed but **not** run — press Enter yourself. If the CLI isn't installed, run `npm install -g @anthropic-ai/claude-code` there first.

**↻ Run Setup Wizard again** re-opens the first-run wizard from here, so you can change gateway or key without reinstalling. It keeps your current default provider — re-running it will not quietly move a Roam setup onto Unode.

Important provider settings:

| Setting | Default | Purpose |
|---|---|---|
| `unode.defaultProvider` | `unode` | Provider used for new agents |
| `unode.unodeBaseUrl` | `https://www.unodetech.xyz/v1` | Deprecated compatibility setting; Unode uses its registered endpoint |
| `unode.baseUrl` | _(partner gateway)_ | Deprecated compatibility setting; Roam uses its registered endpoint |
| `unode.customBaseUrl` | empty | Deprecated migration-only endpoint for the retired singleton Custom connection; never used for normal routing |
| `unode.modelCatalogUrl` | empty | Optional hosted model catalog |
| `unode.extraModels` | `{}` | Add model ids to the pickers without waiting for an update |
| `unode.modelPrices` | `{}` | Manual price overrides |
| `unode.pricingSources` | `[]` | Extra pricing sources |
| `unode.codexCliPath` | empty | Absolute path to the user-installed, logged-in executable used by Codex CLI; settable from the Codex provider card in Settings |
| `unode.priceGroup` | empty | Billing group for displayed prices |
| `unode.workbench.autoOpen` | `true` | Open the Workbench for chat actions; set `false` to keep the compact Chat sidebar as your default |

### Choosing a model (and naming one the picker has not heard of)

The model field is a combobox, not a fixed list: the suggestions are a convenience and **you can always
type an id the extension does not know**. It is passed to the provider as written.

The suggestions themselves come from up to four layers, best first:

1. **`unode.extraModels`** — your own ids, keyed by connection id. Takes effect on save, no reload.
2. **`unode.modelCatalogUrl`** — a hosted catalog, if configured. Changing this URL needs a window reload.
3. **The gateway's live `/v1/models`** — OpenAI-compatible connections only, subject to metadata consent.
4. **The built-in defaults** for that connection.

```jsonc
"unode.extraModels": {
  "claude-cli": ["claude-opus-5", { "id": "claude-sonnet-5", "name": "Sonnet 5", "vision": true }]
}
```

**Claude CLI is the case that needs this**, because a CLI cannot be asked what it serves — there is
no `claude models` command, and an unknown `--model` prints a warning and still exits 0, so the extension
can neither discover nor verify an id. Its picker therefore leads with the CLI's **always-latest family
aliases** — `opus`, `sonnet`, `haiku`, `fable` — which the CLI resolves to the newest model in that family
each time an agent starts. Pick an alias to stay current without touching settings; pick a pinned id such
as `claude-opus-5-5` when a run has to be reproducible later. An alias shows no price in the picker, because it
can name a newer, differently priced model; an aliased agent is costed from the CLI's own reported total.

### Building an agent

**The Agent Builder opens on five things, not eleven.** Name and role, connection and model, instructions,
skill playbooks, and tools — the decisions that are genuinely yours. Model fine-tuning, Smart Mode tier,
folder and command access, and MCP grants live behind one **Advanced** disclosure, because each exists for
the case where a working default is wrong.

**Advanced opens by itself when something inside it needs you** — a folder rule that fails validation, or a
parameter this connection rejects. A message rendered inside a closed section is a message that was not
delivered.

### Why a displayed price can differ from the website

**A billing group belongs to your key, not to your account.** Two keys on the same account can sit in
different groups, with different prices *and* different callable models. The gateway's pricing endpoint says
which groups a key *may* use; it does not say which one actually bills, and the endpoint that would needs a
browser login rather than an API key.

So when a gateway offers several groups, **UnodeAi shows the undiscounted rate rather than guessing a
cheaper one.** An over-estimate is visible and the first invoice corrects it; an under-estimate takes money
without warning and looks right while doing it. The Output channel states the basis on every refresh.

**Often the gateway does not report your rate at all.** The pricing endpoint publishes what a model costs;
what *your key* is charged is settled internally, and naming a group cannot recover a number nobody sent. So
UnodeAi asks you for it when you store a key:

> **Price coefficient for this unode key** — what fraction of the published price does this key pay?
> `1` = list price. Leave it at 1 if you do not know; the gateway does not report this, so UnodeAi cannot
> check it.

**Every newly stored connection carries a value.** Dismissing the prompt with Esc stores `1` rather than
leaving it unset — "this key pays list price" is a fact and "nobody has said" is not, and only one of the
two can be read back. A legacy stored key is never changed during activation: when you open **Settings** or
explicitly run **Refresh Model Prices**, UnodeAi may add a missing `1` for that key, explains why, and links
to the setting. If it cannot safely identify a missing legacy value, it leaves it unstated.

**That repair never blocks what you asked for (0.9.78).** It writes to your *User* Settings JSON, and an
editor refuses that write while the file has an error or a warning in it. Until 0.9.78 the repair ran
*first*, so a single stray comma in `settings.json` could make **Open Settings** and **Refresh Model
Prices** appear to do nothing at all. The panel now opens, and a price refresh completes and reports its
result, before the repair is attempted. If the repair then fails you get a warning saying the coefficient
could not be updated, with an **Open User Settings (JSON)** button — and the thing you asked for has
already happened. Fix the file and run the command again to let the repair through.

**An empty box means list price, and so does Esc.** The box opens empty on purpose: pre-filling `1` let an
Enter still travelling from the preceding key prompt accept list price before you had read the question.
Because it opens empty, empty has to mean something, and it means the same as `1`. **It does not mean
"free"** — that was a real defect in 0.9.56, where `Number('')` is `0` and every model then showed a cost of
zero. If a key really is free, type `0` and say so.

**`0` is allowed.** A free or internally-settled key costs nothing, and that is a fact worth being able to
state. The prompt refuses a negative number; a connection hand-edited in `settings.json` to a negative
number or a non-number reads as **unset**, not as `1`, so the gateway's own answer applies instead of a
number nobody meant.

That is `unode.priceMultiplier`, and it belongs to the key like the group does:

```json
"unode.priceMultiplier": { "unode": 0.33, "roam": 1 }
```

**Exactly one discount is applied.** A stated coefficient and a gateway-reported group ratio answer the same
question — *what does this key pay* — so applying both answers it twice. When a coefficient is set it is the
one that counts, and the gateway's ratio is not multiplied on top. A stated `1` therefore means "list price"
and will suppress a discount the gateway would otherwise have applied; leaving a connection unset lets the
gateway answer.

If your gateway *does* report a ratio for a named group and you have set no coefficient for that connection,
`unode.priceGroup` still works:

```json
"unode.priceGroup": { "roam": "vip", "unode": "default" }
```

Every refresh states which of the two produced the number, in the Output channel.

**A price with no live or user source is a dated reference (0.9.89).** Before, a model the gateway had not
priced yet showed a figure from a built-in table with no date, matched by name, so a newer model could borrow an
older model's price. That table is gone. A picker label now shows a live price, your own `unode.modelPrices`
entry (labelled *your price*), or the dated Unode or Roam reference for that exact model id (for example
*Unode reference 2026-09-27*). A model none of those name shows no price, and never another model's.

### Model tuning

Each agent's card opens **collapsed**, showing only what you need to decide: whether anything has been
changed from the defaults, and the context window this agent compacts against. Two controls stay out where you can reach them
without expanding: **Reasoning Effort**, which is adjusted often, and **Context window**, the one value here
whose being wrong produces a visible failure rather than a subtle one. The remaining twelve sampling and
protocol parameters live behind **Advanced model parameters** — every one already has a sensible default,
and none of them needs changing to start working.

Each agent can have its own model parameters:

| Parameter | Notes |
|---|---|
| Temperature | Lower for code/review, higher for writing/brainstorming |
| Top P | Nucleus sampling control |
| Max tokens | Output budget |
| Reasoning effort | Optional; leave blank unless the model supports it |
| Response format | `Text (provider default)`, `Text`, or `JSON object (structured output)` |
| Stop sequences | Optional custom stopping strings |
| Context window | Per-agent context budget. Your number always wins — over a gateway's advertised value and over a ceiling a rejection proved. Left blank, an agent uses a measured or provider-refused value if it has one, otherwise **1,048,576** tokens (raised from 524,288 in 0.9.33) |

Some parameters are not available for all backends. The UI disables fields that do not apply.

The UI labels the complete tuning set as **Temperature (0–2)**, **Top P (0–1)**, **Max output tokens**,
**Reasoning effort**, **Presence penalty (-2–2)**, **Frequency penalty (-2–2)**, **Response format**,
**Thinking**, **Thinking budget (tokens)**, **Tool choice**, **Stream**, **Context window (tokens)**,
**Stop sequences (one per line, max 4)**, and **Tier for this agent**. Response format choices are
**Text (provider default)**, **Text**, and **JSON object (structured output)**.

**"Provider default" means the field is omitted, not disabled.** Every model parameter here follows the same rule: leave it on its default and UnodeAi does not put that field in the request at all, so the model applies its own default. This matters because gateways differ — some reject `response_format` outright, some reject `"type": "text"` while accepting no field at all. So `Text (provider default)` sends nothing and you get normal prose; the separate `Text` option explicitly sends `response_format: {"type":"text"}`, which is worth choosing only when a gateway needs it stated. Pick `JSON object` only when a program consumes the output — it constrains the model to emit JSON and may not combine with tool use.

### Smart Mode

Smart Mode lets UnodeAi choose a model tier per task.

| Tier | Typical use |
|---|---|
| Premium | PM coordination, architecture, hard reasoning |
| Standard | implementation, security review, documentation quality |
| Economy | routine tests, DevOps patterns, lower-risk work |

Relevant settings:

| Setting | Purpose |
|---|---|
| `unode.smartMode.enabled` | Turn Smart Mode on or off |
| `unode.smartMode.defaultTier` | Fallback tier |
| `unode.smartMode.roleTiers` | Per-role tier overrides |
| `unode.smartMode.taskTierHints` | Per-message-type tier hints |
| `unode.modelTiers` | Connection/model matrix for tiers; named gateway columns use their opaque connection IDs |
| `unode.modelTierParams` | Tier-level model parameters |

## 11. Safety and Approvals

UnodeAi is designed to keep powerful agents observable and permissioned.

### Network consent — two different questions

UnodeAi asks two separate questions before touching the network, and they never blur into each other:

- **Model egress** (per host, before the first agent turn): *may UnodeAi send this host your prompt and the
  workspace files the agent includes?* This is the grant that lets an agent actually run.
- **Metadata** (per host, only when you open a model picker or run **UnodeAi: Refresh Model Prices**): *may
  UnodeAi fetch this host's price list, available models, and — if you stored a key for it — your account's
  discount tier and balance?* **No prompts, code, or workspace content are ever sent under this grant**, and
  approving it does not approve running an agent.

What you'll actually experience:

- A fresh install shows **no prompts and contacts no host you haven't approved** (the consent gate refuses an
  unapproved host before a packet moves; whether *zero* traffic of any kind leaves is `UNVERIFIED` pending a
  packet capture — see SECURITY.md). Background price refreshes silently skip unapproved hosts; you get
  built-in prices until you approve a gateway.
- The first time you open a provider's model picker, one dialog lists the host(s) **that provider** will
  contact, each with exactly what it will be asked for. Untick anything you don't want. Escape declines
  everything — the picker still opens immediately with the built-in model list, and you won't be asked again
  this session.
- Opening one provider's picker never contacts another provider's gateway, even if you approved that gateway
  before.
- Approving a host for **model egress** automatically covers metadata for the same host (your code is strictly
  more sensitive than a price list). The reverse is never true.
- The **UnodeAi: Security** panel lists every grant on its own row — `prompts + workspace files` vs
  `prices, balance & model list only — no code is sent` — each with its own **revoke**.
- If a **Claude CLI** agent is waiting on its first model-egress decision, its Team card shows
  **Consent required** and tells you to respond to the already-open native dialog. It keeps the same start
  pending while you read it: **Allow** resumes the agent, **Cancel** reports an error, and stopping the agent
  first prevents a later Allow from launching it.

### Public-web access

`fetch_url` on gateway routes and Claude CLI `WebSearch` / `WebFetch` are a third, separate egress
decision. They are not model-egress or metadata grants: a requested URL or search query can itself disclose
information.

`unode.webAccess` defaults to `ask`:

| Mode | Behavior |
|---|---|
| `ask` | A chat approval card names the agent and requested web action. You can allow that request, deny it, or allow public-web access for the whole crew for this extension session. The human window is 15 minutes so you can send work and return; an unanswered request is denied visibly. |
| `allow` | Allows public web search and URL fetches for agents that have the `read` capability. |
| `off` | Removes gateway `fetch_url` and Claude `WebSearch` / `WebFetch` from the agent's advertised tools, then denies any stale direct request at the host gate. |

When the host denies a web request, its tool card is shown as **refused**, never as a completed fetch. The
status comes from the host decision made at the gate; UnodeAi does not try to recover it from the wording of
the result. Output written by an external MCP server or subprocess remains explicitly external and is not
treated as a host-authored permission decision.

A refusal may add a reviewed, host-authored explanation of the safe next step while keeping the same bounded
refusal reason. It never forwards a path, credential, command, destination, or your own free-form reason for
denying a request. On OpenAI-compatible connections, task-only artifact and context-gap tools are offered only
while a live contracted attempt exists; a stale direct call still reaches the host handler and receives its
accurate refusal. Claude's connection-time tool schema is unchanged.

The session choice is not stored in the workspace or VS Code settings, and it resets when the extension
host restarts. Web reads remain available to a read-only-folder agent only when that agent has `read`;
folder write scope is not a network permission.

An agent without the `read` capability receives the same no-web tool surface. This prevents a model from
planning around an action the host can only deny; the policy gate remains the final fail-closed check.

### Command approval

Setting:

```text
unode.commandApproval
```

Modes:

| Mode | Behavior |
|---|---|
| `none` | Agents cannot run shell commands |
| `ask` | Prompt before unapproved commands; default in current builds |
| `allowlist` | Only commands matching `unode.allowedCommands` can run |
| `all` | Allows most commands except catastrophic patterns; use only in a sandbox |

Allowed command prefixes are configured with:

```text
unode.allowedCommands
```

The default list is empty. When a normal approval is for an exact member of UnodeAi's reviewed safe list,
the card offers **Enable safe commands**. Choosing it is an explicit workspace-level setting change; inspect
or remove the entries here at any time. You can instead use **Allow once**, **Allow this session**, or
**Allow for project** for the exact command you want. Reviewed safe commands are narrow build, lint, test,
and inspection templates; they do not include arbitrary-code runners or history-mutating Git commands.

**Windows `run_command` uses `cmd.exe`.** PowerShell cmdlets such as `Copy-Item`, `Get-ChildItem`, and `Start-Sleep`
cannot run there. UnodeAi refuses one before showing an approval card and tells the agent both the active shell and
a `cmd.exe` equivalent such as `copy` / `xcopy`, `dir`, `type`, or
`ping -n <seconds+1> 127.0.0.1 >nul`; it is a shell-compatibility refusal, never a claim that you withheld consent.

**How long a command may run.** On an OpenAI-compatible or custom-gateway agent, a command in the foreground is
stopped after 120 seconds unless the agent states a longer limit, up to 10 minutes. A longer job runs in the
background: the agent starts it and then waits for it in one step, up to 5 minutes per wait, instead of checking
on it again and again. Each such check sends the agent's whole context to the model, so one wait costs far less
than a row of checks. **Stop** ends a wait at once. The background command itself keeps running until the agent
stops it or the agent's session ends.
Use an agent shell that supports PowerShell when the cmdlet itself is required. This does not restrict Claude's
separate native PowerShell tool.

Claude CLI agents route both `Bash` **and** `PowerShell` through this same approval, including when
Claude calls them inside a native subagent. A fail-closed `PreToolUse` hook runs before Claude's own allow
rules, so a matching rule in `~/.claude/settings.json` or a project Claude settings file cannot silently
pre-approve a command past UnodeAi. Each Claude agent keeps its own hook and connection files in its own folder
under `.unode/claude/` while it runs, so agents that share a working folder never use each other's.

**Agent commands that name a path outside your folder always ask.** If an agent-emitted `run_command` references an absolute path outside the agent's writable folder, the approval card says so and you are asked — even if you already chose *Allow this session* or *Allow for project* for that command. The approval was granted to the command (`git`), not to the new path. UnodeAi does not refuse on its own here: a rule can only spot the obvious spelling of an escape, so the decision belongs to you. Real containment comes from this gate plus the folder the agent runs in, not from pattern-matching the command text.

**A runner call is rewritten to the project's own script, chosen by what the script runs.** When an agent
types `npx vitest`, UnodeAi looks for a package script that invokes the same runner and runs that instead.
**The script's name is not evidence** — a script called `device-test` that runs `vitest run` is a perfectly
good one-shot script, and one called `test` that runs a bare `vitest` starts watch mode and never returns.
Only the command each script actually executes decides, and for a runner that watches by default, **every
invocation in the body must be explicitly one-shot** — `vitest && vitest run` is not eligible, because the
first half never ends. When no eligible script exists, the direct call is run with `run` added rather than a
watching script being chosen for you.

### Per-agent command narrowing

Command approval above is a **workspace-wide** policy. From 0.9.48 an individual agent can additionally be
narrowed in the Agent Builder, under the same Commands area:

| Choice | Effect |
|---|---|
| **Inherit global** | The default. The agent uses the workspace command policy unchanged |
| **Restrict to selected** | The agent may run only the templates you tick, drawn from the current global allowlist |

The editor offers a checklist, not a text box, and the list is built from the live global allowlist. This is
deliberate: a per-agent setting can only ever **narrow**, never widen, so a command the workspace does not
allow cannot be typed into an agent to grant it. Every saved selection is intersected with the current global
allowlist at the moment of the check, after the global policy has applied its hard denials — so shrinking the
global list later cannot leave a stale agent entry behind as a grant.

An empty **Restrict to selected** list means *this agent runs no commands*, which is a different statement
from **Inherit global**; the two are kept distinct rather than collapsed. The narrowing is a ceiling on
authority. It does not assert that the agent asked for a sensible command — the approval gate, the folder it
runs in, and your own review still do that work.

### Optional local approval frequency table

For a debugging or review period, deliberately enable the **User** setting
`unode.debug.promptedCommandLog` (it is off by default and cannot be enabled by a workspace). UnodeAi then
counts only command templates that actually reached an approval prompt — including a prompt you deny — and
keeps that aggregate in local VS Code extension storage. It does not count allowlisted or already
session-approved commands.

Run `UnodeAi: Show Prompted Command Frequencies` to open a ranked local Output table. The table stores and
shows `CommandPolicy` templates such as `git status` or `npm run build`, never the raw command, its arguments,
URLs, or secrets. Nothing is sent from the machine.

### Claude native subagents

Claude can spawn its own subagents (`Agent` / `Workflow`). UnodeAi does **not** disable them: an inherited,
fail-closed `PreToolUse` hook mediates each child tool call before it runs, including `Bash`, `PowerShell`,
native writes, external effects, and newly introduced Claude tools. When an agent uses one, UnodeAi still
shows a notice that says disabling native subagents affects this agent only, then offers three controls:

| Action | Effect |
|---|---|
| **Stop agent** | Interrupts the current turn right away |
| **Disable subagents** | Persists a per-agent setting; from its next run, `Agent`/`Workflow` are disabled for that agent only |
| **Learn more** | Opens the relevant section of `SECURITY.md` |

UnodeAi never sets that opt-out for you. Read-only Folder Access retains its CLI-level denies as defense in
depth. For a normal agent, external-effect tools (for example Artifact, schedules, notifications, or
messages) and a new/unknown Claude tool show an approval card before execution. "Always allow this tool"
lasts only for the running agent session. If `unode.writeApproval = ask`, native Write/Edit calls show the
same write-approval preview before they run. If the local gate is unreachable, slow, or malformed, the tool
is blocked rather than run.

Delegation through the PM (`dispatch_task`) is unaffected: it runs over UnodeAi's own authenticated bridge and keeps every approval, folder-scope, and verification gate.

### Write approval

Setting:

```text
unode.writeApproval
```

Modes:

| Mode | Behavior |
|---|---|
| `none` | Guarded file tools write with checkpoints; Claude native writes remain mediated but do not prompt |
| `ask` | Prompt before guarded writes with a diff; native Claude Write/Edit receives a before/after preview |

### File sandbox

OpenAI-compatible and Claude CLI agents can only work inside the configured workspace or agent worktree; path traversal and outside-root access are blocked. Codex CLI is different: Act mode uses Codex's workspace-write/on-request sandbox and Plan mode is read-only. UnodeAi does not claim that Codex reads are confined to the workspace.

### Local project discovery (`unode.localReadScope`)

This host-owned setting controls an optional **read-only** discovery root outside the workspace. It has three
values: `workspace` keeps the long-standing workspace-only reach; `parent` (the default) makes the immediate
parent folder available; and `volume` makes the current filesystem volume available. It is ignored in an untrusted workspace, and it never widens writes,
edits, deletes, generic shell commands, or Claude native file access. Per-agent Folder Access and a temporary
task scope remain stricter ceilings.

The first time the crew tries to access the local-scope root in a top-level user request, UnodeAi opens a modal that names the resolved
absolute path. It says agents may **read and search** there, that a `search_files` call without a path can walk
the whole root, and that returned filenames and contents may be sent to that agent's configured model provider.
`volume` adds a warning that it can include other users' profiles. Choose **Allow** to cover that root for the
current extension session. **Deny** or closing the dialog blocks the root for this request across the coordinator
and delegates; immediate retries do not ask again, while a later direct user request may. A failed/unavailable UI
also blocks retries for this request but is not recorded as your decision. The refusal notice offers **Grant
folder access**, and the Security panel lists session-only grants and declines with grant/revoke. Each admitted
access has a tool-card/run-evidence receipt with only an opaque
root id, operation kind, and count — never a path, query, or file contents.

**Agents are told the root exists (0.9.89).** On every route, each turn's project context now names the
`parent` or `volume` root and says it is not granted: the agent calls `read_file` or a search tool when it needs
something there, and the dialog above decides. Before, agents often did not know they could ask. The note grants
nothing, and it is absent for `workspace` and in an untrusted workspace. The context receipt lists it as
**Local read reach guidance**.

In Agent Builder, use **Folder Access (advanced)** to restrict an agent to specific folders. A project file may
also narrow access to a path physically inside that workspace, for example
`{ "path": "docs", "permission": "read" }`; outside paths and symlink escapes are ignored. When present, this replaces the workspace default
instead of adding to it. Claude CLI supports at most one writable folder; read-only Claude agents deny
native write and shell tools. Its extension-owned Playbook plugin contains instruction-only files, so protected
agents can still load the full assigned procedure without acquiring Bash or write authority. The Security panel shows folder grants next to each agent's MCP grants. MCP
servers are not sandboxed by this setting because they run as separate processes.

Codex CLI does not claim Folder Access confines reads. A read-only grant uses Codex's read-only profile;
a writable grant uses the native Ask for approval profile, where routine commands and in-boundary edits can run
without a card. Eligible permission escalations remain individually approval-gated. On Windows the CLI may read
files available to the user's account, so choose this route only with that boundary understood.

### MCP approval

UnodeAi-managed MCP servers are default-deny. Servers that touch files, credentials, networks, browsers, or external systems should require approval before mounting. MCP servers you configure directly in Claude or Codex stay under that CLI's own controls.

## 12. Verification

Set:

```text
unode.verifyCommand
```

Examples:

```text
npm test
npm run build
npx tsc --noEmit
```

The PM's `run_checks` tool uses this command to verify the whole project. This is the main backstop for cross-file breakage caused by parallel work.

The command still obeys `unode.commandApproval`. Because this command comes from your trusted configuration rather than from the model, UnodeAi does not block automatic verification merely because the command mentions an outside absolute path. Instead, if the command is otherwise allowed, UnodeAi runs it and shows a one-time warning for that distinct command string.

## 13. Worktree Fan-Out

Setting:

```text
unode.concurrencyStrategy
```

Modes:

| Mode | Behavior |
|---|---|
| `optimistic` | Shared workspace with conflict detection |
| `worktree` | Eligible agents work in isolated git worktrees under `.unode/worktrees/` |

Worktree mode requires a git repository with a clean tree. Each eligible agent works in its own worktree; when its turn finishes, its work is committed and merged into a Unode **integration branch** (`unode/integration`). Review it with:

```text
UnodeAi: Crew Worktrees (Review)
```

A successful merge command is not by itself evidence that a lane changed integration. UnodeAi compares the
integration branch's `HEAD` before and after the merge: an unchanged `HEAD` is reported as **nothing to
merge**, while a moved `HEAD` is reported as **merged**, independent of Git's display language.

Land accumulated integration work onto your branch with:

```text
UnodeAi: Finalize Worktree Merges to Branch
```

### Verifier-as-gate (0.7.0)

In worktree mode, before an agent's work merges into the integration branch, UnodeAi runs your **verify command** (`unode.verifyCommand` — e.g. `npm test`, `npx tsc --noEmit`) **inside that agent's worktree**:

- **Pass →** the work merges to the integration branch.
- **Fail →** the work is **held on the agent's own branch (not merged)** and the failing output is handed back to the agent to fix and finish again. Only verified work lands.

So a crew only lands work that passes your project's own checks. The **Crew Worktrees (Review)** board shows each lane's status — **✓ verified / ✗ failing / ⚠ unverified** — and **flags any lane that passed by editing the test files** (a weak model can make checks green by weakening a test instead of fixing the code), so you can review those before finalizing.

The gate requires `unode.verifyCommand` to be set **and** approved to run. Enable the reviewed safe list or
approve the exact verifier through the normal command card; a non-approved command is skipped rather than
auto-run. With no verify command there's nothing to gate on, so merges proceed unchanged.

Additional worktree settings:

| Setting | Default | Purpose |
|---|---|---|
| `unode.worktree.verifyBeforeMerge` | `true` | Gate merges on `unode.verifyCommand` passing in the agent's worktree (the verifier-as-gate) |
| `unode.worktree.verifyTimeoutSeconds` | `300` | Hard timeout for the verify command (10–3600); on timeout it's killed and treated as a failure |
| `unode.worktree.autoMerge` | `false` | Automatically land clean integration work into the base branch |
| `unode.worktree.maxParallel` | `4` | Maximum isolated worktrees at once |

## 14. Dashboard and Activity

Open the dashboard with:

```text
UnodeAi: Show Dashboard
```

The dashboard summarizes agents, message activity, workflow state, token use, and estimated cost where usage data is available. A plain `$...` is a cost the provider reported as billed. `~$...` is an estimate: an account estimate from your key's coefficient or group, a dated reference estimate, or an API-equivalent figure for subscription CLI usage. If no completed turn established a cost basis, it says **cost unknown**, never `$0`. The **Spend** section keeps each of these in its own row.

### Spend: what a request cost, and reminders

**Reminders, never a brake (0.9.89).** UnodeAi records the tokens each request used and the best-sourced cost it
can honestly show, and can remind you when a target is crossed. Crossing a target never stops, pauses, refuses or
shortens work: you decide whether to stop. Open it with **UnodeAi: Open Spend**, which opens the Dashboard with its
**Spend** section first.

**What is counted.** Every model turn is recorded once, with the tokens the provider reported:

- On an OpenAI-compatible route, each completed model response that reports its usage is counted as it finishes,
  so a long tool loop can remind you while it runs. The turn's final total then adds only what those responses did
  not already count.
- Claude CLI is counted from its final result; Codex CLI from the change in its running total for that
  conversation.
- If you press **Stop**, or a process dies, only what was observed counts. A response cut off mid-stream keeps the
  usage figure it had already sent (labelled *partial*), or the request and the text that actually streamed
  (labelled *reconstructed*). When nothing attributable arrived, the Spend section lists a **coverage gap** ("this
  request may have used tokens, but the provider result was not completely observed") instead of a guessed amount.

**Where a cost comes from**, in this order, each labelled:

1. a cost the provider reports as **billed**;
2. your own exact-model price in `unode.modelPrices` (**user-configured model price**);
3. an **account estimate** for this exact key: the gateway's price times your key's stated coefficient
   (`unode.priceMultiplier`), or the ratio of your stated group (`unode.priceGroup`), or a group the gateway
   explicitly ties to your key. Exactly one of these applies;
4. the gateway's published list price (**gateway published estimate**), shown but never used for a reminder, because
   a key may pay less;
5. a dated **Unode** or **Roam reference** estimate, used for a dollar reminder only if you chose it;
6. otherwise **price unavailable**, with tokens still shown.

Subscription CLI usage (Claude or Codex signed in with a subscription) shows an **API-equivalent** figure from the
selected reference; it is never a bill and never drives a dollar reminder. Having a key stored, or a gateway listing
the groups a key *may* use, never counts as knowing what that key pays.

**The first-run choice.** The first time a gateway turn finishes with no billed or account price, UnodeAi asks
once which dated estimate dollar reminders may use: **Use token reminders only**, **Use Unode estimate for dollar
reminders**, or **Use Roam estimate for dollar reminders**. The turn has already ended; nothing waits on the
answer and it makes no sound. Closing it records nothing, and it is offered again at most once a week. Change it
any time in **Settings → Spend**. Until you choose, the Unode estimate is shown for comparison only.

**Reference prices are dated.** UnodeAi ships a Unode and a Roam reference captured on 2026-09-27. Each figure names
its capture date and is marked **stale** after 30 days, with one quiet reminder then (and at most every 30 days
after) offering **Update reference prices**. Updating contacts only that gateway's public price list over HTTPS,
sends no key, refuses redirects, and keeps the previous snapshot if anything is wrong. Earlier receipts keep the
prices they were recorded with.

**Targets.** In **Settings → Spend** (or **UnodeAi: Change Spend Reminder Target**) set any of: a per-request
token and/or dollar target; a project total per day or per month, in a time zone you choose; and per-agent shares
of that project total. All are off by default, and they are read from your User Settings only
(`unode.spend.targets`, `unode.spend.referencePriceMode`), so a workspace cannot set them. The page also lists,
for each agent, what a dollar target covers on its route right now.

**The reminder ladder.** For each counter:

- at **80%** a quiet line in the request's coordinator chat and one non-modal warning;
- at **100%, 150%, 200%**, then every further whole multiple (300%, 400%, …) a line saying **Over target — work is
  continuing**, a status-bar item and a Team badge, the attention chime, and a dialog with **Keep going**, **Stop
  this request**, **View spend**, **Change target** and **Reset counter**. Closing it is **Keep going**.
- The usage that crosses a threshold can arrive as the work ends, for example the final report of a turn you just
  stopped. Then the line and dialog say **Over target** and **Nothing in this request is running right now** (for
  a project or agent-share target: **No agent is working right now**) instead of "work is continuing". The buttons
  stay the same.

Each threshold appears once, across windows. If usage jumps past several thresholds at once, only the highest one
is shown (from 50% straight to 450% shows 400%), and the multiples go on without limit. A request that resumes after
30 days without usage can remind again at its current level. There is no timer: a reminder comes only from new
spend. **Stop this request** stops only the still-running turns of the request that crossed the target (its
coordinator and its delegates), once; if that request has already finished it says **Already finished** and stops
nothing. Only reported tokens, billed costs, account estimates and a reference you chose can trigger a reminder;
partial, reconstructed and API-equivalent figures are shown but never do.

**Reset.** **Reset counter…** (Dashboard, Settings or **UnodeAi: Reset Spend Counter…**) resets the current
request, the current project period (with its agent shares), one agent, or every counter for the project. The
counter starts again from zero and the whole ladder can remind you again. Nothing is deleted: history, charts and
receipts stay, and running work is not touched.

**A project can only suggest lower targets.** A repository may include `.unode/budget.json`:

```json
{ "schemaVersion": 1, "max": { "request": { "tokens": 1000000, "usd": "5.00" }, "project": { "tokens": 10000000 } } }
```

UnodeAi reads it strictly (no comments, no duplicate keys, 64 KiB at most, inside the project folder) and shows one
quiet notice per version: *This project proposes lower spend-reminder targets* with **Review** and **Ignore this
project**. It has no effect until you choose **Use this version**, and then only lowers reminders you already
enabled. A changed file is a new proposal. It can never turn a reminder on, choose a reference, reset a counter or
make a sound.

**Across windows and machines.** Usage is recorded per project under the extension's own storage on this machine.
Two windows on one project add up without overwriting each other; another window's usage appears within about 15
seconds. A folderless window keeps per-request totals in memory only. If a usage record cannot be saved at once
(a full or busy disk, say), the Spend section says **Usage updating** and UnodeAi keeps retrying; totals and
reminders include that usage once it is saved, and work is never held up. **Repair spend tracking…** rebuilds the
reminder state from the recorded usage if its control file is ever damaged; usage records are never edited.

**Savings.** The "Mixed-model routing saved about $X" banner prices both your routing and the all-premium baseline
from the same dated reference and names it. If any turn's model is missing from that reference, the banner makes
no claim.

Status colours use VS Code theme tokens rather than fixed colours, and every one of them carries a fallback,
so a theme that leaves a token undefined makes the dot a different colour rather than making it disappear.
**Done is blue, not green** — measured against the four bundled themes, the green it used before fell below
the contrast floor on the default light theme and was nearly indistinguishable from the green *working* dot in
both dark themes. `Verified / mergeable` follows the same blue, and the verification chips are outlined rather
than filled: a fill in the text's own colour makes the pill more visible and the text less readable, so the
outline carries the shape and the text keeps its contrast. The word is always beside the dot, so nothing here
depends on telling two colours apart.

The **Latest tasks** panel sits at the top of the dashboard, newest task first, followed by **Team activity**: one card per agent (status, current task, files, cost, context and actions), as many per row as fit; the totals, savings banner and cost charts come below as reference. It shows your most recent tasks, each broken down by the agents that worked on it (a token bar per agent, plus the task's total tokens and cost) — so you can see exactly where the tokens went across a PM-led, multi-agent run. Use the **Show last: 3 · 5 · 10 · 20** control in the panel header to choose how many tasks to display.

The dashboard updates live while the crew works — you don't need to close and reopen it.

Use the Activity panel for the live team event stream. You can export, import, clear, or compact message history from the Activity view toolbar. Each message carries the turn's raw usage, so it is the most precise place to see one agent's tokens and cache hits for one turn.

### An agent's own conversation log

Two bounded tools let an agent look back at its own Activity log rather than guessing what was decided
earlier: `search_conversation_log` finds entries, and `read_conversation_log` reads at most 20 of them by the
range the search returned. Every read states the range against the total, so a partial read is never
presented as the whole conversation, and it appears as a receipt in the run record.

**An agent reads only its own log.** It cannot read another agent's conversation or any attachment bytes, and
a refusal says the log is not available to *this agent* rather than that it does not exist — those are
different facts. Where the log genuinely cannot be reached, the agent is required to say it is unreadable
rather than unrecoverable: the data may well still be in your Activity panel.

This exists because before 0.9.59 the conversation kept for a restart was the copy trimmed to fit the model's
context window, so a long session quietly lost its middle. The durable record is now separate from what is
sent to the model, with its own bound. What the model receives is unchanged.

**A teammate on a delegated task may use what you told it directly.** A delegated task carries only the sources
the coordinator forwarded. Something you told or attached only to the coordinator is missing for the teammate,
and it says so and stops rather than guessing or searching the web. What you told the teammate itself, in its
own chat, counts.

### Prompt caching — the `cached` number, and why it matters

The Tokens card reads `in / out / cached (N%)`. Cached input is prompt your provider served from its own
cache: **it is billed at roughly one tenth the price**, so on a long conversation it is most of what
determines your bill.

Caching works on a **prefix**. Everything before the first byte that changes can be reused; everything from
that byte on is re-read at full price. UnodeAi therefore keeps the stable part of a request — the model,
the tool definitions and the system prompt — byte-identical for the life of a session, and attaches volatile
state (project rules, shared-memory notes, your open file) at the *end* of the request, where changing it
cannot invalidate anything before it.

Two things are worth knowing:

- **Claude caches nothing unless it is asked to.** Every other provider we reach caches automatically.
  Anthropic does not: the request must carry explicit cache markers. UnodeAi sends them, and then *checks
  whether they landed* — because a missing cache does not fail, it only bills. If a route turns out not to
  cache, the agent's Output channel says so plainly rather than letting you discover it on an invoice.
- **`cached: not reported` is not the same as `cached: 0`.** Some gateways don't pass the cache counter back.
  UnodeAi says "not reported" rather than showing you a healthy-looking zero, and where it can reconstruct the
  real number it labels it an estimate.

If you want to know what a specific agent's caching is doing, open its Output channel (`View → Output`, then
pick `UnodeAi · <agent>`). It stays quiet while caching works and speaks up when it doesn't.

## 15. Import, Export, and Reset

Chat and message histories can be exported or imported from their view toolbars.

Useful commands:

| Command | Purpose |
|---|---|
| `UnodeAi: Export…` | Pick **Message log**, **Run evidence pack**, **Portable run evidence**, **Evidence report**, or another export from the visible list |
| `UnodeAi: Export Chat` | Export selected agent chat |
| `UnodeAi: Import Chat` | Import selected agent chat |
| `UnodeAi: Archive Chat` | Hide the selected chat without deleting it (recoverable) |
| `UnodeAi: View Archived Chats` | Browse and restore an archived chat |
| `UnodeAi: Export Messages` | Hidden implementation command; use **UnodeAi: Export… → Message log** |
| `UnodeAi: Export Run Evidence Pack` | Hidden implementation command; use **UnodeAi: Export… → Run evidence pack** |
| `UnodeAi: Export Portable Run Evidence` | Hidden implementation command; use **UnodeAi: Export… → Portable run evidence** |
| `UnodeAi: Import Messages` | Import message log |
| `UnodeAi: Reset Workspace State` | Clear roster, chats, message log, saved conversations, workflows, and approved MCP servers for this workspace |

**Clear vs. Archive.** The Chat sidebar's title bar and the Workbench session menu have both. **Clear** (`$(clear-all)`) permanently deletes the selected agent's transcript. **Archive** (`$(archive)`) saves it first, then hides it from the live view — the conversation disappears but isn't deleted. Restore it anytime via **View Archived Chats** (the title-bar `…` overflow menu or the Command Palette); archives survive reloads.

`Reset Workspace State` is destructive. Use it only when you want a clean UnodeAi workspace.

## 16. Command Reference

| Command | Purpose |
|---|---|
| `UnodeAi: Run Setup Wizard` | First-run setup |
| `UnodeAi: Set Provider API Key` | Store provider credentials |
| `UnodeAi: Show Team Panel` | Reveal the Team panel |
| `UnodeAi: Create Default Team (PM + Architect + Developer + Reviewer)` | Create the default software crew |
| `UnodeAi: Create/Save/Load a Team…` | Create, save, load, or delete a named team |
| `UnodeAi: Save Team…` | Retained for existing keybindings; opens the save flow but is hidden from the Command Palette |
| `UnodeAi: Open Saved Team…` | Retained for existing keybindings; opens Create/Save/Load a Team but is hidden from the Command Palette |
| `UnodeAi: Add Agent` | Add one agent |
| `UnodeAi: Solo Agent (toggle)` | Toggle Solo mode |
| `UnodeAi: Start All Agents` | Start all team agents |
| `UnodeAi: Stop All Agents` | Stop all team agents |
| `UnodeAi: Open Workbench` | Start work in or reveal the editor Workbench |
| `UnodeAi: Close Workbench` | Close the Workbench editor tab |
| `UnodeAi: Toggle Workbench Composer Focus` | Toggle focus between the Workbench composer and its editor surface |
| `UnodeAi: Show Pending Approval` | Open the relevant inline approval from the status-bar signal |
| `UnodeAi: Open Chat` | Start work in the Workbench by default; focus the sidebar when `unode.workbench.autoOpen` is off |
| `UnodeAi: Open Chat with Agent` | Select a specific agent in the Workbench by default, or in the sidebar when auto-open is off |
| `UnodeAi: Send Message to Agent` | Send a one-off task |
| `UnodeAi: Run Workflow` | Run a workflow template |
| `UnodeAi: Edit Workflow` | Edit custom workflows |
| `UnodeAi: Run Demo Task` | Send a demo task to the PM |
| `UnodeAi: Show Dashboard` | Open dashboard |
| `UnodeAi: Open Spend` | Open the Dashboard with its Spend section first |
| `UnodeAi: Change Spend Reminder Target` | Open Settings → Spend to set or change reminder targets |
| `UnodeAi: Reset Spend Counter…` | Reset a spend counter to zero (history is kept; work is not touched) |
| `UnodeAi: Review Project Spend Targets` | Review this project's `.unode/budget.json` proposal: use this version, or ignore the project |
| `UnodeAi: Repair Spend Tracking…` | Rebuild spend-reminder state from the recorded usage |
| `UnodeAi: Update Unode Reference Prices` | Take a dated, anonymous snapshot of Unode's public price list |
| `UnodeAi: Update Roam Reference Prices` | Take a dated, anonymous snapshot of Roam's public price list |
| `UnodeAi: Review Delivered Work` | Review a completed run's evidence and record a human acceptance verdict |
| `UnodeAi: Review Shared Memory` | Inspect an exact shared-memory row and explicitly attest or revoke its local guidance label |
| `UnodeAi: Apply Execution Hooks` | Show the complete hook declaration and explicitly apply its restrictive host guards |
| `UnodeAi: Open Settings` | Open settings panel |
| `UnodeAi: Open Unode Account / Profile` | Open the local Unode key, balance, and account-links page |
| `UnodeAi: Refresh Model Prices` | Fetch live (discounted) model prices from your approved gateways on demand |
| `UnodeAi: Security` | Review Workspace Trust, approvals, and every network grant (each revocable) |

**In a workspace you have not trusted, agents are read-only.** Writing, editing, deleting and running a
command are all refused, and since 0.9.70 they are refused at one place with one reason, so the message
names Workspace Trust rather than suggesting you grant a folder — which would not have helped. **There is
no per-command exception.** Trusting the workspace is the decision, you make it once in VS Code's own
prompt, and an agent cannot ask you to make it command by command. Reading and analysing files still work.
When an untrusted folder opens, UnodeAi shows this read-only scope once for that activation in a modal dialog:
agents can chat, plan, read and search, but shell commands, file writes/edits/deletes, MCP servers and the verify
command are off. Run **Workspaces: Manage Workspace Trust** to enable them. Trusted and folderless windows do not
show the dialog, and granting trust does not produce a later warning.

Cursor does not currently expose that untrusted state, and a 3.20.10 probe confirmed that repository settings
take effect. UnodeAi therefore reads all 40 authority-bearing settings only from User Settings (then the shipped
default) in every editor, including Smart Mode, model-tier routing, pricing inputs and the skill-library link.
VS Code greys project copies of these application-scoped keys and explains that they belong in the Default
profile; it removes the folder value before extensions can inspect it, so no UnodeAi notice is expected there.
UnodeAi's one-time ignored-values notice is a backstop for editors that do expose a project value. *Allow for project* command approvals live in UnodeAi-owned
workspace storage, not `.vscode/settings.json`; use `Manage Project Command Approvals` to inspect or
revoke them. With no folder open, project writers have no target. If the first folder changes during the session,
running agents and Integrations stop, Team Rules closes, and later turns and saves refuse until you reload; they
never continue in the old folder or fall back to the editor program folder. UnodeAi-created terminals carry a
marker that survives an extension-host restart, so activation and invalidation close inherited terminals and their
process trees too; terminals you created yourself are not touched.
| `Manage Project Command Approvals` | Inspect or revoke this project's host-owned command approvals |
| `UnodeAi: Open Marketplace` | Open marketplace |
| `UnodeAi: Edit Team Rules` | Edit `.unode/rules.md` |
| `UnodeAi: Restore File Checkpoint` | Restore a checkpointed file |
| `UnodeAi: Crew Worktrees (Review)` | Review worktree integration state |
| `UnodeAi: Finalize Worktree Merges to Branch` | Land worktree integration branch |

### Complete registered-command list

The following source-registered command titles are also available. Some are contextual actions and only appear
when the associated view or agent is active.

| Command | Purpose |
|---|---|
| `UnodeAi: Show Team Panel` | Reveal the Team panel |
| `UnodeAi: Show Dashboard` | Open the Dashboard |
| `UnodeAi: Open Dashboard` | Open the Dashboard |
| `UnodeAi: Open Spend` | Open the Dashboard with its Spend section first |
| `UnodeAi: Change Spend Reminder Target` | Open Settings → Spend |
| `UnodeAi: Reset Spend Counter…` | Reset a spend counter (history kept) |
| `UnodeAi: Review Project Spend Targets` | Review this project's `.unode/budget.json` proposal |
| `UnodeAi: Repair Spend Tracking…` | Rebuild spend-reminder state from recorded usage |
| `UnodeAi: Update Unode Reference Prices` | Snapshot Unode's public price list as a dated reference |
| `UnodeAi: Update Roam Reference Prices` | Snapshot Roam's public price list as a dated reference |
| `UnodeAi: Review Delivered Work` | Review a completed run's evidence and record a human acceptance verdict |
| `UnodeAi: Review Shared Memory` | Inspect an exact shared-memory row and explicitly attest or revoke its local guidance label |
| `Manage Project Command Approvals` | Inspect or revoke this project's host-owned command approvals |
| `UnodeAi: Generate Evidence Report` | Write the evidence report of a finished job; nothing is run again |
| `UnodeAi: Start All Agents` | Start all team agents |
| `UnodeAi: Stop All Agents` | Stop all team agents |
| `UnodeAi: Add Agent` | Add an agent |
| `UnodeAi: Team Actions…` | Open the Team title-bar menu: build an agent, create/switch team, start/stop all, team rules, checkpoints, concurrency mode, Security, Settings, Account/Profile, Marketplace, evidence report |
| `UnodeAi: Build an Agent` | Open Agent Builder |
| `UnodeAi: Create Default Team (PM + Architect + Developer + Reviewer)` | Create the default team |
| `UnodeAi: Create/Save/Load a Team…` | Create, save, load, or switch a team |
| `UnodeAi: Save Team…` | Retained for existing keybindings; hidden from the Command Palette |
| `UnodeAi: Open Saved Team…` | Retained for existing keybindings; hidden from the Command Palette |
| `UnodeAi: Solo Agent (toggle)` | Toggle Solo mode |
| `UnodeAi: Send Message to Agent` | Send a message to an agent |
| `UnodeAi: Open Chat` | Start work in the Workbench by default, or the sidebar when auto-open is off |
| `UnodeAi: Open Chat with Agent` | Select the agent in the shared Workbench/sidebar conversation |
| `UnodeAi: Open Workbench` | Start work in or reveal the Workbench |
| `UnodeAi: Close Workbench` | Close the Workbench tab |
| `UnodeAi: Toggle Workbench Composer Focus` | Toggle Workbench composer focus |
| `UnodeAi: Show Pending Approval` | Open the relevant inline approval from the status-bar signal |
| `UnodeAi: Run Workflow` | Run a workflow |
| `UnodeAi: Edit Workflow` | Edit workflows |
| `UnodeAi: Run Setup Wizard` | Run setup |
| `UnodeAi: Run Demo Task` | Run a demo task |
| `UnodeAi: Start Agent` | Start the selected agent |
| `UnodeAi: Stop Agent` | Stop the selected agent |
| `UnodeAi: Restart Agent` | Restart the selected agent |
| `UnodeAi: Remove Agent` | Remove the selected agent |
| `UnodeAi: Edit Agent` | Edit the selected agent |
| `UnodeAi: Show Activity` | Show the team activity stream |
| `UnodeAi: Clear Chat` | Clear the active chat |
| `UnodeAi: Compact Context` | Compact the selected agent's context now: UnodeAi summarises older turns (OpenAI-compatible) or asks Claude or Codex to compact their own conversation, and a receipt reports the result |
| `UnodeAi: Archive Chat` | Archive the active chat |
| `UnodeAi: View Archived Chats` | View archived chats |
| `UnodeAi: Export…` | Pick **Message log**, **Run evidence pack**, **Portable run evidence**, **Worker progress distribution**, or another export from the visible list |
| `UnodeAi: Export Chat` | Export the active chat |
| `UnodeAi: Import Chat` | Import a chat |
| `UnodeAi: Compress Chat View` | Toggle compact chat view |
| `UnodeAi: Clear Messages` | Clear messages |
| `UnodeAi: Export Messages` | Hidden implementation command; use **UnodeAi: Export… → Message log** |
| `UnodeAi: Export Run Evidence Pack` | Hidden implementation command; use **UnodeAi: Export… → Run evidence pack** |
| `UnodeAi: Export Portable Run Evidence` | Hidden implementation command; use **UnodeAi: Export… → Portable run evidence** |
| `UnodeAi: Export Worker Progress Distribution` | Hidden implementation command; use **UnodeAi: Export… → Worker progress distribution** |
| `UnodeAi: Import Messages` | Import messages |
| `UnodeAi: Compress Activity View` | Toggle compact Activity view |
| `UnodeAi: Collapse Team to Icons` | Collapse Team to icons |
| `UnodeAi: Expand Team Cards` | Expand Team cards |
| `UnodeAi: Set Provider API Key` | Store provider credentials |
| `UnodeAi: Show Agent Output` | Show selected-agent output |
| `UnodeAi: Show Prompted Command Frequencies` | Show the local, opt-in frequency table of command templates that reached approval prompts |
| `UnodeAi: Show Agent Terminal` | Show selected-agent terminal output |
| `UnodeAi: Restore File Checkpoint…` | Restore a file checkpoint |
| `UnodeAi: Show Changed Files` | Open the Workbench changed-files rail |
| `UnodeAi: Hide Changed Files` | Close the Workbench changed-files rail |
| `UnodeAi: Restore This File Checkpoint` | Restore one file from the rail to its pre-edit version |
| `UnodeAi: Show Checkpoint Diff` | Show a checkpoint diff |
| `UnodeAi: Open Settings` | Open Settings |
| `UnodeAi: Security` | Open Security |
| `UnodeAi: Refresh Model Prices` | Refresh model prices |
| `UnodeAi: Toggle Concurrency Mode (Optimistic ⇄ Worktree)` | Toggle concurrency mode |
| `UnodeAi: Concurrency — Optimistic (click to switch to Worktree)` | Switch to Worktree mode |
| `UnodeAi: Concurrency — Worktree (click to switch to Optimistic)` | Switch to Optimistic mode |
| `UnodeAi: Open Marketplace` | Open Marketplace |
| `UnodeAi: Add MCP Server` | Add an MCP server |
| `UnodeAi: Finalize Worktree Merges to Branch` | Finalize integration work |
| `UnodeAi: Crew Worktrees (Review)` | Review worktrees |
| `UnodeAi: Reset Workspace State` | Reset workspace state |
| `Enable Safe Commands for This Project` | Enable the reviewed safe-command set only for this project |
| `UnodeAi: Edit Team Rules` | Edit Team Rules |
| `UnodeAi: Set Dashboard Recent-Task Count` | Set Dashboard task count |

## 17. Troubleshooting

### Known issues retained in 0.9.93

- **A job whose coordinator you stop before its first reply gets its card late.** A card follows a reply of the
  coordinator. When you stop the coordinator itself before it has replied in that job, there is no reply to
  follow, so the job closes, and its card appears, only after the coordinator's next reply to anything.
- **A reference price is not applied to a model the gateway names with a prefix.** UnodeAi's dated reference
  prices list a model under its own name, such as `deepseek-v4.1-flash`. A gateway that names it
  `deepseek/deepseek-v4.1-flash` gets no estimate from them, even after you choose **Use Unode estimate for
  dollar reminders**: the turn's tokens are counted, and its cost reads `Price unavailable`. A price you set for
  the model under the gateway's own name in `unode.modelPrices` is used.
- **The Team row of a stopped agent says `cost unknown`.** The row counts turns that completed. An agent whose
  only turn you stopped shows `0 turns` and `cost unknown`, while the Job outcome card shows what that turn
  used.
- **Tests can fail to start for an agent on the Claude CLI or Codex CLI route on Windows.** These agents run
  commands inside their own CLI, in the working folder UnodeAi gives it, and that path can carry a lower-case
  drive letter (`c:\...`). Vitest 4.1 started from such a folder fails every file before any test runs, with
  `Cannot read properties of undefined (reading 'config')`. 0.9.92 corrects this for agents on
  OpenAI-compatible and custom-gateway routes only. Nothing is written or sent; the test run simply fails.

**Fixed in 0.9.93:**

- **A coordinator on the Claude CLI route had to search for its team tools.** Its first request could not
  dispatch or close: it first spent a request finding the tool. The team tools are now part of the first request.
- **A coordinator that never started left you waiting.** A request that reached no dispatch, close or reply
  simply ran on. It now ends after 60 seconds of silence with a card that offers a retry, another route or a
  stop. See [A coordinator's first action](#a-coordinators-first-action).
- **A dispatch to a name that matched nobody made the coordinator do the task itself.** On a team with
  teammates, a target that matched none of them was treated as if no teammate could take the work. It is now
  refused with the current references.
- **Generate Evidence Report ran the verify command again.** It now writes what was recorded when the job ran.

**Fixed in 0.9.92:**

- **A team agent could not run Vitest on Windows.** A command UnodeAi started for an agent on an
  OpenAI-compatible or custom-gateway route inherited the workspace path with a lower-case drive letter, and
  Vitest 4.1 fails from such a folder before any test runs. An agent that had to see its tests pass kept
  retrying. Commands and agent terminals now start in the folder as a terminal spells it.
- **An agent could only wait for a background command by asking again.** Each `check_command` returned at
  once and re-sent the agent's whole context to the model. The agent can now wait in one step, up to five
  minutes, and can give a foreground command up to ten minutes instead of the fixed two.
- **Consent dialogs were counted as the agent's time.** Turn time left out command, write and tool approvals,
  but not the dialogs for a network destination, a media upload, a read outside the workspace, a coordinator's
  brief, a repository's CLI configuration or an MCP mount. All of them are left out now.
- **The live line said `Thinking` while nothing was known.** Silence after a request is now shown as
  `Waiting for <provider>`; `Reasoning` appears only when the provider sends reasoning.

**Fixed in 0.9.91:**

- **Two Claude CLI agents in one folder shared a tool gate (security).** Since 0.9.28, every Claude agent wrote its
  hook file to the same place in the working folder. The agent started last decided the other agents' tool
  approvals, and after it stopped, the others' tools ran without that check. Each agent now
  writes its own files. If you ran two or more Claude CLI agents in the same folder, update.
- **A failed delegation looked like a successful call.** When a teammate's task failed, timed out, was cancelled or
  was refused by team policy, the coordinator's blocking `assign_task` still counted as succeeded, and a reply that
  merely began with the word "Error" was flagged as a failed task. The coordinator now receives how the task
  actually ended; a timeout is reported as an unknown outcome, because the teammate may still finish. A team-policy
  refusal that arrives after an async dispatch now reaches the coordinator instead of being dropped.
- **A result could finish the wrong tool card.** A result was attached to the latest open card with the same tool
  name. Each call now has its own id, on every runtime.
- **A refused team tool or cross-folder read reached Claude as a success.** Claude now receives it as an error.

**Fixed in 0.9.90:**

- **Claude spend was overstated.** The Claude CLI reports a running cost total for its process, and since 0.9.89
  every turn after a process's first recorded that total as its own cost. Each turn is now charged only its own
  increase, so request and agent totals, and dollar reminders on an API key, are right again. Token counts and
  token reminders were never affected; turns recorded before this release keep their old figures.

**Fixed in 0.9.89:**

- **An agent could not wait on a long background command.** Repeated `check_command` polls of the same job were
  blocked as repeated identical calls, so the agent could stop early. A poll now counts as new only when UnodeAi
  itself saw the command make progress (new output, an exit or an error); a job that produces nothing new is still
  stopped by the usual repeat limit, and nothing the model writes can change that.

**Fixed in 0.9.88** (they were listed here since 0.9.82):

- **Chat stuck at Sending… after the extension host restarts** (for example after **Don't Trust**). Within about
  10 seconds the composer gives your draft back, with its attachments, and says the send was not confirmed. Nothing
  is resent for you. Send again; if that also goes unconfirmed, run **Developer: Reload Window**.
- **Delegation cards bunched together with raw agent ids after a reload.** Cards now return to their places, one
  per request, with names. See [Delegation cards](#delegation-cards).
- **A run stayed open after its interrupted task was replaced from a later message.** It now closes once, as
  partial. See [Stopping work a coordinator started](#stopping-work-a-coordinator-started).

### A team finished but the task didn't — **fixed in 0.9.34**

In 0.9.33 a teammate that finished after the Project Manager's bounded wait still reported, and its work
was real and on disk, but the PM never woke to consume it. Later steps of a multi-step plan — running
checks, committing — silently never started, while the panel showed every agent complete.

**Both halves of that are fixed in 0.9.34.** A result that arrives after the wait expires now reaches the
coordinator with its evidence verdict intact, and a result that lands while the PM is mid-turn is held and
re-offered the moment that turn ends instead of being dropped. A message you send still takes priority
over an automatic wake.

If you are on 0.9.33 the workaround still works: send the PM *"continue from the returned results"*.
On 0.9.34 you should not need it — **if you do, that is worth reporting**, because it means a third path
exists that neither fix covers.

### Open Settings or Refresh Model Prices seems to do nothing — **fixed in 0.9.78**

**First, check your editor's User Settings JSON for an error or a warning.** That is the cause, and it is
not obvious, because nothing about the symptom points at that file.

Before 0.9.78 both commands ran a legacy price-coefficient repair *before* doing what you asked. The repair
writes to User Settings JSON, and an editor refuses that write while the file has a problem in it — so the
command failed at its first step and the panel never opened. No error appeared. **This was never specific
to one editor.** It was first reported in Cursor, but the refusal is stock VS Code behaviour — VS Code's own
message for it is *"Unable to write into user settings. Please open the user settings to correct
errors/warnings in it and try again."*

**On 0.9.78 the order is reversed.** The Settings panel opens, and a price refresh completes and reports
its result, before the repair is attempted at all. A repair that then fails shows a warning with an **Open
User Settings (JSON)** button instead of swallowing your command.

**If you are still on 0.9.77 or earlier**, the workaround is the fix: open User Settings JSON
(`Ctrl+Shift+P` → *Preferences: Open User Settings (JSON)*), clear every error and warning, and the
commands work again.

### The UnodeAi icon is gone from the Activity Bar

Run **`View: Reset View Locations`** from the Command Palette.

VS Code lets you drag a view container out of the Activity Bar into the bottom panel or the secondary
side bar, and it remembers that placement in its own settings — so **reinstalling the extension,
restarting VS Code, and updating to a new version all leave the icon missing**. Reset View Locations puts
every container back where it belongs.

You can tell this apart from a genuinely broken install in two seconds: if `Ctrl+Shift+P` → `UnodeAi`
still lists the commands, the extension is installed and running, and only its placement is wrong. (While
the icon is away, every surface is still reachable by command — `UnodeAi: Show Team Panel`,
`UnodeAi: Open Workbench`.)

### Agent says no API key is configured

Run `UnodeAi: Set Provider API Key` and store the right secret for the provider.

### A command was blocked

Check `unode.commandApproval`. If using `allowlist`, add the command prefix to `unode.allowedCommands`. If using `ask`, approve the command from the Workbench approval card.

### A write is waiting for approval

If `unode.writeApproval` is `ask`, approve or deny the diff in the Workbench transcript.

### PM cannot run checks

Set `unode.verifyCommand` and make sure `unode.commandApproval` allows that command.

### A model rejects `reasoning_effort` or `response_format`

Set that field back to its default (`Text (provider default)` for response format, blank for reasoning effort) so it is omitted from the request. Many gateways reject optional model parameters they do not support — including an explicit `"type": "text"` they would have applied anyway.

### "The gateway at … returned HTML, not JSON"

The Base URL points at a web page rather than an OpenAI-compatible API. This is almost always a missing `/v1`
— use `https://host/v1`, not `https://host`. Fix it with **Edit** on that gateway's Providers card, then
**Test connection**. UnodeAi reports this as a plain diagnosis and never echoes the returned page back at you,
because a login or proxy page can carry account information.

### Test connection fails

Read the message — each cause has its own:

| Message | What to do |
|---|---|
| *Set an API key for `<name>` before testing* | No key stored. Card → **Edit** → **Replace API key**. |
| *`<name>` returned HTTP 401/403 while listing models* | The key is wrong, expired, or not valid for this endpoint. |
| *`<name>` returned HTTP 503 …* | The gateway is up but has no capacity right now. This is the gateway's own answer, not a UnodeAi failure; retry later. |
| *returned HTML, not JSON* | Wrong Base URL — see above. |
| *The model catalog for `<name>` could not be reached* | DNS/network/host down, or an endpoint that isn't serving `/models`. |
| *Network access could not be confirmed* | You declined metadata consent for that host. Approve it in the Security panel, or run the test again and accept. |

### Removing a gateway is blocked

Remove refuses while anything still points at the gateway. The message lists each reference. Rebind those
agents in Agent Builder, move the new-agent default elsewhere, and clear it from any Smart Mode tier; then
Remove succeeds and its stored key is cleaned up.

### Editing a gateway is blocked

Editing the endpoint or key is refused only while an agent on that gateway is **running**. Stop the named
agent (an idle agent does not block it) and try again. Renaming is never blocked.

### Agents made conflicting edits

Use the error message to re-read and retry the affected file. For larger parallel jobs, consider `unode.concurrencyStrategy = worktree`.

### Team state feels stale

Use `UnodeAi: Reset Workspace State` only if you want to remove the current roster, histories, workflows, and approvals from the workspace.

## 18. Recommended Operating Patterns

For small changes:

1. Use Solo or one Senior Developer.
2. Keep Act mode on only when edits are needed.
3. Run the project's own test/build scripts.

For complex features:

1. Ask the PM.
2. Require the Architect to publish contracts first.
3. Partition files before parallel work.
4. Set `unode.verifyCommand`.
5. Require an independent Reviewer PASS before considering work done.

For sensitive codebases:

1. Use Plan mode for initial review.
2. Set `unode.commandApproval = ask`.
3. Set `unode.writeApproval = ask`.
4. Keep MCP servers default-deny.
5. Store project constraints in `.unode/rules.md`.
