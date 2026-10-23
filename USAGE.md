<p align="center">
  <img src="images/unode.png" alt="UnodeAi" width="96" height="96">
</p>

# UnodeAi User Manual

Version covered: UnodeAi 0.9.97

Product: accountable AI teams, under your direction, inside your editor

UnodeAi turns AI agents into an organized team inside your editor. A project manager agent breaks your goal into tasks and hands them to specialists. Each agent has its own role, model, tools, chat history, and safety policy. What an agent claims stays separate from what the framework observed. You can work with one agent directly, run a coordinated crew led by the project manager, or use deterministic workflows for repeatable processes.

The default **Unode** provider uses the OpenAI-compatible Unode gateway at `https://www.unodetech.xyz/v1`, with its own API key (`UNODE_API_KEY`). Live model and pricing information is at `https://www.unodetech.xyz/pricing?lang=en`. You can choose the provider for each agent. The choices include the other built-in providers and any number of named local OpenAI-compatible gateway profiles.

## 1. Install UnodeAi

**Four channels exist and they are not equivalent.** Sideloading a VSIX successfully does not mean the
extension can be found in a marketplace. The two kinds of failure look nothing alike, so this section names each
channel and says what it does and does not give you.

### Open VSX — the channel for this release

UnodeAi publishes to [Open VSX](https://open-vsx.org). In any editor that uses Open VSX as its registry, search
for `UnodeAi` in Extensions and install it. Reload if prompted.

### Cursor

Cursor's extension marketplace mirrors Open VSX, so you can find UnodeAi there by searching — **but mirrors
lag**. A freshly published version can take time to appear, or it may resolve to an older one.

**How long, measured rather than guessed — and it varies.** For **0.9.33**, the new version was still not
offered 40 minutes after publication. It was being served 6 hours after publication. For **0.9.34**, it was
already installable **27 minutes** after publication. For **0.9.36** it was there within **42 minutes**, and
0.9.41 was there within the hour on the day it shipped. Four releases were measured across the same hour. They show that
the mirror does not run on a fixed schedule you can plan around. Because of this, treat "minutes to a
few hours" as the range, and never read a missing version as a broken install. If you need the new version now,
install the VSIX directly:

- **Command Palette (most reliable):** `Ctrl+Shift+P` → `Extensions: Install from VSIX...`
- **Command line:** `cursor --install-extension <path-to>.vsix --force`. If `cursor` is not on `PATH`, it
  is inside the install directory (Windows: `…\cursor\resources\app\bin\cursor.cmd`).
- **Drag** the `.vsix` onto the Extensions panel. Some builds support this.

Cursor's Extensions panel does not always show an `⋯` overflow menu. That is why the Command Palette is listed
first. **Fully quit and reopen Cursor after installing**. If you replace an extension while a window is running,
the old extension host stays in place. The new version is not registered until you restart.

### Direct VSIX (VS Code)

1. Extensions panel → `⋯` → `Install from VSIX...`, or `code --install-extension <path>.vsix --force`.
2. **Fully quit and reopen VS Code.** Reload Window is not always enough if the extension was replaced while
   VS Code was running.

`--force` matters when the version string is unchanged. Without it, an install of the same version is skipped
silently, and you end up testing the build you thought you had replaced.

### Microsoft Marketplace — not a channel for this release

UnodeAi is **not** on the Microsoft VS Code Marketplace. The publisher account is blocked. Microsoft has declined
to reinstate it or to give a reason. See `SECURITY.md` and the project's release notes. Any listing there that
claims to be UnodeAi is not ours.

### From source

For contributors:

```bash
npm install
npm run build
```

Then press `F5` in VS Code to launch an Extension Development Host.

Editor validation is recorded against the exact builds named in each release's field record. UnodeAi does not
claim a range of supported editor versions. The manifest sets a deliberately low minimum version for
installation, to allow for VS Code-based editors that lag behind. It does not mean that every version in that
range was validated individually.

## 2. First-Time Setup

### Run the setup wizard

Open the Command Palette and run:

```text
UnodeAi: Run Setup Wizard
```

The wizard shows the three available connection families: **OpenAI-compatible connections** (built-ins plus named custom gateways), **Claude CLI**, and **Codex CLI**. Standard connections keep their registered endpoint. To create a custom gateway without leaving the wizard, select **＋ Add custom gateway…** in the OpenAI-compatible connection menu. The host asks for the gateway's display name, HTTPS endpoint, and key. The key is masked and never enters the wizard webview. When this succeeds, the new gateway is selected automatically. Claude setup and Codex setup each open a terminal with that CLI's login command already filled in. UnodeAi never runs the command for you.

**Setup is three steps: connect a model, choose how you want to work, start.** It used to be six. These three
screens were removed:

- a welcome screen that listed the other five
- a demo on a screen of its own
- a safety screen you had to go through

None of them asked you for a decision. Yet a six-dot progress bar tells a first-time user how much is being
asked of them. The demo is now an optional row on the last step. The safety promises are now a line you can
open on that step. They are true whether or not anyone reads them, so they belong where someone can choose to
read them.

The final wizard step leads with **Open Workbench**, not a menu of Dashboard, transcript, and Settings. When a team exists, **Finish and continue** takes the same route, so `unode.workbench.autoOpen` still decides between the Workbench and the compact sidebar. With no team, it opens the Team panel's create-team path instead of an empty Workbench. Settings is still available from the Team toolbar and the Command Palette.

In the work-style step, choosing **Solo**, **Team**, or **Custom** starts that setup directly. There is no
separate Start button to find. If you cancel a Solo or Team flow, UnodeAi tells you to choose that card again.

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

**Claude CLI and Codex CLI need no key stored here.** Claude drives the logged-in `claude` CLI. Codex drives the logged-in Codex CLI through `codex app-server --stdio`. To see or change which program UnodeAi starts, use **Settings → Providers → Claude CLI** or **Codex CLI → Check / choose CLI…** (or the `unode.claudeCliPath` and `unode.codexCliPath` User settings). See [Which CLI program UnodeAi starts](#which-cli-program-unodeai-starts). UnodeAi never reads or copies `~/.codex/auth.json`, `~/.codex/config.toml`, or `CODEX_HOME`, and never injects an OpenAI API key. You can use Codex CLI 0.155.0 or newer. Windows validation records 0.155.1, and every newer build must still pass the live App Server handshake and the effective-policy checks. Codex consent is bound to that executable, so switching to another binary asks again. If a new editor has no cache of account models, choose **Load models from Codex** in the Agent Builder. After the executable and login are verified and you consent, a short-lived App Server runs from extension storage—not the workspace. It requests only the list of models your account can see, stops, and caches that list for that program and version. After you approve startup, your native Codex hooks, notification command, MCP servers, plugins and configured model provider remain available. MCP grants that UnodeAi manages are separate. The extension host exposes only that agent's approved tools, without adding them to the global CLI configuration. MCP tool calls that Codex routes for approval get a UnodeAi card. But an MCP tool that Codex calls from inside its own `exec` code tool (measured with the bundled `node_repl` plugin) runs with no approval request.

With cached Codex account models, Agent Builder still offers **Refresh models from Codex**. Click it to request
the list again through the same checks and consent; opening the picker does not request it. Refreshing does not
update your CLI or give access to a model that it does not return. The line under the model field then says how
many models that Codex version returned, or why none were loaded, until the next load. Version-check failures show
which executable was checked, its exit status or signal, and its output. On a Codex command approval card, the final Shell line
comes from UnodeAi, not the model's explanation. The Team waiting summary shows the command alone. These cards
still offer only **Allow once** and **Deny**.

Claude Code subscription logins report API-equivalent usage, not an invoice. UnodeAi shows that as `~$...` with a tooltip. A plain `$...` means billed API or key usage. Before a completed turn establishes a billing basis, the UI says **cost unknown** instead of showing a made-up `$0`.

**Every way of storing a key asks what that key pays.** You may store a key from any of these places:

- this command
- the Settings › Providers **Set key** / **Edit** buttons
- the setup wizard
- a custom gateway
- the "Set API Key" prompt after you create a team or agent

Whichever you use, UnodeAi asks for that key's **price coefficient** after the value is stored. This is the
fraction of the gateway's published price that you actually pay with this key. `1` is list price, `0.33` is a
third of list, and `0` is free. Leave it blank or press Esc for `1`. A gateway does not report this number, so
UnodeAi cannot check it. Entering it is what makes the per-turn cost display correct for a discounted account.
The coefficient belongs to the key, so each connection keeps its own (`unode.priceMultiplier`). Storing a key
also drops the model list and price table that the previous key produced, instead of waiting for their caches
to expire.

Before v0.9.58, only the command-palette dialog asked. Keys stored any other way silently defaulted to list
price. If your cost figures have looked high, store that key again or set `unode.priceMultiplier` directly.

Secrets are stored in VS Code SecretStorage. They are not written to `.unode/team.json`, settings files, chat exports, or source control.

To **remove** a key, run `UnodeAi: Set Provider API Key`, pick the same secret, and choose **Clear the stored value**. The choice appears only when something is stored. Keys are held per extension, not per workspace, so clearing one removes it for every folder on this machine.

**No telemetry or analytics — and nothing beacons on install.** UnodeAi has no tracking or phone-home endpoint. Every metadata fetch refuses an unapproved host before a single packet is sent. As a result, no host is contacted at activation until you approve one. (The claim that the process sends *zero* traffic of any kind is still `UNVERIFIED`. It awaits a packet capture on a clean profile. See SECURITY.md.) Chat history and team config stay on your machine, and keys use VS Code SecretStorage. A model turn sends its prompt and the workspace context it includes only to the provider host you approve. Separately, an MCP tool call or a `fetch_url` call can send the arguments shown for that explicit tool to its configured destination. When you need zero retention on the provider side, use a self-hosted or in-VPC OpenAI-compatible endpoint.

**Don't have an account or credits yet?** The **Providers** tab of UnodeAi Settings has a sign-up / top-up button for **Unode Gateway** ([unodetech.xyz](https://www.unodetech.xyz)). It opens registration in your browser. Create an account, top up, then paste your key above.

**Unode Account / Profile.** Run **UnodeAi: Open Unode Account / Profile** (or choose it from **Team Actions**) to open the local Account tab in Settings. It honestly tells these states apart: no Unode key, **Connected via API key** (which is *not* a signed-in session), a balance that cannot be read, and a low balance. Account, credit/usage, and pricing actions open Unode's registered HTTPS pages in your system browser. The page contains no password or payment field, and opening it sends no request. **Check available balance** uses the existing metadata-consent gate. An unapproved host therefore stays unavailable. The check neither prompts you about that host nor contacts it silently. BYOK, custom gateways, and CLI-authenticated providers work without a Unode account.

## 3. Create, Save, or Load a Team

Open the UnodeAi sidebar from the Activity Bar. It is the compact view for navigation and status. In it,
**the roster** is the main entry point, followed by compact session rows. Each row shows one agent's current
responsibility and lifecycle.

The Team title bar shows the version beside the title. It pins **Add Agent**, **⋯ Team Actions**,
**Settings**, **Marketplace**, **Message**, **Solo**, and **Collapse/Expand**. A title bar is a fixed-width row.
If something does not fit, VS Code hides it in an unlabelled `...` overflow. **⋯ Team Actions** lists
everything that is not pinned, by name: collapse/expand the roster, Build an Agent, Create/Save/Load a Team,
Start/Stop All Agents, Team Rules, Restore File Checkpoint, concurrency mode, Security, and Generate Evidence
Report.

Each session row keeps everything about its agent within reach, without growing into a second Workbench:

- **Click the row** to open that agent in the shared Workbench (or to jump straight to a pending approval).
- **The controls are always on the row**: Stop/Start, Restart, ⚙️ Configure, Terminal, and Remove (once the
  agent is stopped). ⚙️ Configure opens that agent's page in the Agent Builder. Each collapsed row also has an
  18px status marker and a **Status key**. The marker tells these states apart without relying on colour: Done
  (✓), Verified (V), Replied but not verified (↩), Consent required (🔒), and approval Denied — timed out (⌛).
  The dot still shows activity, but it is never the only status signal. A settled result's label (Done,
  Coordinator accepted, …) shows for two minutes. Then the row returns to the agent's own state. Since 0.9.88 the
  label clears on time. Before that, it stayed until something else redrew the panel, such as a click.
- **Click ▾** to expand the row in place. It shows the model (with the Smart Mode badge), live context / cost /
  turns, skills, and recently changed files. Since 0.9.93, **Provider**, **Role**, **Status** and **Reasoning**
  sit in one strip. In a narrow sidebar the strip is two rows of two, and in a wide one it is a single row.
  **Reasoning** shows the baseline the agent is configured with: a value, `Provider default`, or `Not supported`
  on a route that does not take the setting. An expanded row keeps its controls visible without hovering, so
  ⚙️ Configure stays one click away. Very long detail panes scroll within the row. The expanded state of a
  removed agent is discarded, so it does not pile up across roster refreshes.

The roster deliberately does not repeat the Workbench's transcript, tools, or diffs. The sidebar **Activity** view
is still a separate stream for agent-to-agent coordination. It is not a copy of your conversation with an agent.

### Shared memory and delegation authority

`memory_note` appends a one-line team note to `.unode/memory/notes.md`. The agent picks one structured kind:
`pitfall`, `contract`, or `decision`. The host does not infer the kind from the text. A `contract` is a claimed
interface or ownership constraint that should be checked. It is not an approved rule. New rows also carry the
routing tier (`premium`, `standard`, or `economy`) that the host selected for the turn that wrote them. The
tier records how that turn was routed when the row was written. It does not identify the underlying model. The
Markdown file can be changed, so every field read back from it is treated as recorded context. It is not durable
proof of the row's author, tier, age, or truth.

UnodeAi uses the **first workspace folder** as the primary folder. Switching team rosters does not change that
scope. The file stays human-readable, and you can edit it or version it with the repository. UnodeAi refuses to
load or append notes if `.unode/memory/notes.md`, or a parent symlink or junction, resolves outside that primary
folder. Every row in the prompt is structurally encoded and explicitly labelled `untrusted` or `human-attested`.
The block is limited both by row count (at most 30) and by bytes. Exact duplicate rows take up one prompt slot.
Attested rows get admission priority, followed by recent unattested rows of every semantic kind. The final output
stays in file order.

Run **UnodeAi: Review Shared Memory** to inspect an exact row. Dismissing the picker records nothing. A second,
visible confirmation can attest that exact row as reviewed team guidance. The same view can revoke the
attestation. The record is owned by the host. It holds a workspace-scoped SHA-256 digest and bounded metadata. It
never holds the note text or a person's identity. Editing one byte of the row breaks the match. In an untrusted
workspace, new attestations are refused and every row stays untrusted.

| Context layer | Scope and origin | What it may affect | What it cannot establish |
| --- | --- | --- | --- |
| Shared note | Editable `.unode/memory/notes.md` in the first workspace folder, written by agents or people | Limited context given to teammates | Permission, evidence, truth, approval, or instruction priority |
| Human-attested note | Exact-row local confirmation stored in host-owned workspace state | Prompt admission priority and the displayed trust label | Who clicked, factual correctness, freshness, or any tool/command/network/MCP authority |
| Repository guidance | Versioned instruction files and Team Rules | Advisory project guidance subject to host protections | Product safety policy or wider permissions |
| Host authority | Current settings, task contracts, explicit approvals, enforced policy, and receipts | The authority each host mechanism actually owns | Creation or expansion by memory prose |

UnodeAi does not automatically promote memory into Team Rules, skills, workflows, hooks, or task contracts. It
does not claim that every recalled note is relevant, current, or correct. The context receipt records only counts,
by type, of the untrusted and human-attested rows that were selected. It does not reproduce note text, and it does
not say the model obeyed the notes.

Every crew has one coordinator. It is the first Project Manager in the saved roster. Only that coordinator can
dispatch, collect, or inspect delegated work. A teammate that wants parallel work sends the coordinator a normal
message that explains the proposal. The coordinator decides whether to issue a structured task. Saved teams that
previously gave another member `delegate` still open. UnodeAi removes that retired capability in memory and shows
a warning. This trade-off is deliberate. Workers no longer split their own work into parallel tasks. This will
remain the case until a future multi-level design can keep every child handle visible to its lead.

When a delegated task settles, the coordinator also sees receipts for the required inputs, as observed by the host.
A missing receipt is shown as **read not observed**, never as proof that the worker did not read the input. Actual
access failures keep their own reason, also observed by the host. None of this is an automatic rejection, and it
does not replace the coordinator's decision.

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

The team picker's Software group also offers **Software Engineering Team**. This is the full-discipline crew
for larger work: PM, System Architect, Senior Developer, QA Engineer, Reviewer, and Technical Writer, **plus
the standalone Solo agent every team ships with**. That makes seven agents in total. Compared with the default
crew, it adds independent testing and documentation as seats of their own. Its suggested verify command is
`npm test`. Every team you create also includes Solo automatically, so a quick single-agent task never
requires switching teams.

If a team already exists when you choose a preset, UnodeAi asks whether to **Keep current team**, **Add to
current team**, or **Replace current team**. Add keeps the existing roster and appends the selected preset.
Replace takes the normal pre-switch snapshot before it changes the roster.

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
  change the work they review. Nothing in their tool list enforces that. To enforce it yourself, set **Writes**
  to **Ask each**, or untick the capability that grants Write files for that agent in Agent Builder.
- **Drafting roles** (for example Product Manager, Business Analyst, Brand Strategist, Customer Support) read and
  write documents and do not run commands.
- **Sales and customer-success roles** produce drafts and plans for a person to send or run. UnodeAi has no tool
  that sends a message, books a meeting or changes an account record.
- **Research roles** can search the web on the Claude CLI route. On a gateway route they can fetch a page they
  are given but cannot search.

Every command still goes through Workspace Trust, the command policy and your approval. A team saved by an earlier
version keeps the tools it was saved with. An agent that lacks Run commands says so instead of working around it.
Agent Builder shows, beside **Save**, what a save would add.

### Website Design & Development

| Preset | Roster (PM +) | Use it for |
|---|---|---|
| **Website Design & Development** | Product Designer, Frontend Engineer, Content Strategist, SEO & Analytics Specialist, QA Engineer | Design, build, and launch a site end to end |

The designer works from your existing design system instead of inventing values. It specifies every interactive
state, including loading, error and empty. The frontend engineer reviews at the breakpoints your project actually
declares — and at their boundaries, where defects cluster. Before launch, the SEO specialist runs a technical
audit of crawlability, canonicals, structured data and redirect integrity. It reports only on these mechanics. It
never predicts a ranking, because a ranking is not something an audit can observe.

### Saving and reopening a team

Configuring a crew is real work: edited instructions, per-agent model tuning, folder access, MCP grants, and
attached skills. Switching teams replaces the roster. Until v0.9.54, everything you had configured was lost along
with it.

| Command | What it does |
|---|---|
| **`UnodeAi: Create/Save/Load a Team…`** | Create, save, load, or delete named teams in one place |

**Since v0.9.69 you choose where a team is saved.**

| Scope | Where it lives | Use it for |
|---|---|---|
| **This project** (default) | `.unode/teams/<name>.json` | a crew you want whoever clones the repo to get |
| **All projects** | UnodeAi's own per-user storage | your own crews, in whatever project you open next |

Saving opens a dialog with **Save to This project**, **Save to All projects**, and **Cancel**. Each button says
where the team will be saved. The result names the same scope and location. The saved-team list labels each row
with its scope, so two teams may share a name without confusion.
**Automatic snapshots are always per-project**, because they are there to undo a replacement that happened in
that project.

**Create/Save/Load a Team is the one home for named saved teams.** Its **Saved teams** section starts with
**Save current team...**, then lists named project and personal saves. A trash button appears only on a named
save, never on a system default. Automatic snapshots keep their separate delete control inside
**Restore a previous team...**. `unode.saveTeam` and `unode.openSavedTeam` are still available for existing
keybindings, but they are hidden from the Command Palette.

**A saved team file never grants execution authority by itself.** A **This project** save also records a
fingerprint of the file's exact bytes and path. The fingerprint is kept in UnodeAi's own storage, which the
repository cannot write to. When you open that exact save, UnodeAi shows one confirmation for the whole team. It
lists every agent, with the skills, write, run-command, and delegation permissions that agent would regain.
Choose **Restore saved permissions** or **Load read-only**. If you change even one byte, copy the file elsewhere,
or open it from a clone, the team first loads read-only. UnodeAi then opens an unticked review for each affected
agent. Nothing is granted until you tick it. Every restored tool stays capped at the saved `allowedTools` ceiling.
After an unticked review, the completion notice reports how many agents regained selected permissions. It calls
the team read-only only when no agent regained any.

Teams saved before 0.9.87 have no fingerprint or full skill declaration. For these teams, the same unticked review
offers their surviving primary skill plus the role template's skills. All of them are unticked and capped at the
old saved ceiling. Save each such team once from 0.9.87 on, so that future exact loads can be recognised. When a
team replacement is confirmed, **Restore a previous team…** in the combined team picker opens the automatic
snapshots of the roster you left.

When you open a saved team, UnodeAi also tells you what it dropped:

- **Folder permissions that point outside the workspace you are in are removed.** A grant is kept only if its
  path, once resolved with symlinks followed, lands inside the current workspace. Without this rule, a
  grant that named a folder in the project where you configured it would silently give this project's agents access to
  that folder.
- **MCP grants, tool-protocol choices and process settings are never imported from a file.** Project Skills and
  Playbooks are only inert declarations, used for the explicit restore and review described above. Select
  trusted integrations again in **UnodeAi: Build an Agent**.
- **`env` and the legacy agent `autoApprove` field are never imported or written.** For UnodeAi-hosted and
  Claude approvals, use the Workbench's **Commands** and **Writes** selectors. Codex agents show their native
  permission profile instead. UnodeAi has no supported project-file setting for the environment of a provider
  process. MCP secret placeholders belong in SecretStorage.

**Upgrading from 0.9.80:** old saved rosters did not record whether a value came from a project file. Because the
source of their agents' values is unknown, 0.9.81 removes only `env` and `autoApprove` from those agents. Skills,
Playbooks, MCP grants, routes, backend choices and other user configuration stay intact. An integration still
listed in the legacy team file is imported only if its exact launch configuration was already approved in this
workspace. The upgrade notice names the integrations it imported and the unapproved project entries it ignored.
MCP state moves to `unode.approvedMcpServers` / `unode.hostMcpServers.v1`. If you downgrade to 0.9.80, approve the
integrations again before you use them.

**Project state is root-bound in 0.9.82.** Editors such as Devin can reuse one extension-storage bucket when they
open different folders. UnodeAi ties project values to the canonical root of the first workspace folder. These
include rosters, transcripts, checkpoints, runs, policy, integration evidence, and MCP approvals and
configuration. When the root changes, UnodeAi also clears the live selected agent and the presentation state
before another turn can start. A new root therefore starts empty. Switching back restores only that root's state.
Existing VS Code and Cursor state is imported only when it is proven to belong to the same root. Old Devin history
is deliberately not imported, because it cannot be attributed safely. **Reset Workspace State** clears only the
current root's namespace.

If you decline model-network consent on an OpenAI-compatible route, 0.9.82 ends that request immediately. The
decline is not treated as a transport failure. The same turn therefore does not retry, repair the body, fall back
from streaming, or show the consent dialog again. No request is sent.

Both are in the Team panel's actions menu (the `$(gear)` icon), directly under **Create/Save/Load a Team…**. That
is where you are when you find out that a roster can be replaced.

**To delete a named saved team, use its trash icon in Create/Save/Load a Team.** The confirmation names the
scope and does not touch the running team. **This project** deletes `.unode/teams/<name>.json`. Anyone who gets
that file through Git loses the save too, and its host-owned fingerprint is removed. **All projects** deletes
only your personal library entry. There is no undo. System defaults have no delete control.

**You do not have to remember to save.** Whenever you confirm a replacement, UnodeAi writes an automatic snapshot
of the roster you are leaving before it removes anything. This applies whether the replacement comes from Create
or Load a Team or from a previous snapshot. Cancelling the picker writes nothing. Snapshots appear in the picker
marked *auto-saved*, and the ten most recent are kept. **Teams you named yourself are never pruned**, because
deleting something a person named is not a housekeeping decision. If a snapshot cannot be written, UnodeAi says
so and asks whether to switch anyway. Being unable to back up a team is not a reason to trap you in it. But it is
also not something to just leave in a log.

**A saved team is a portable roster description, not an authority bundle.** It holds inert identity, instructions
and model tuning. It also holds folder, tool and command restrictions, which can only narrow what the current host
allows. Per-agent MCP grants, executable Skills/Playbooks and the workspace's MCP server definitions are owned by
the host and are deliberately left out. Opening a team never replaces workflows or integration configuration.

**On what a per-project file contains.** Routes refer to a registered connection and model, so the file holds no
API key. Keys live in SecretStorage. Since 0.9.81, neither `.unode/team.json` nor `.unode/teams/*.json` stores or
loads an agent `env`, automatic approval, a backend or base-URL override, an executable playbook or tool
attachment, or MCP process configuration. A hand-written value is ignored, with one notice. The `.gitignore` that
UnodeAi writes still excludes `.unode/`, but the security boundary does not depend on that exclusion.

### Knowledge-work presets

The team picker also includes non-code presets. They use the same PM-led orchestration, with specialist roles:

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

- The **Contract Analyst** extracts every field with a quoted source span. It writes `not found` instead of
  inferring a value. Its redlines cite the playbook rule behind each change. They are addressed to your own
  side, and they are never text ready to send to the counterparty.
- The **Privacy & Data Protection Officer** and **GRC Analyst** have no shell and no delegation. They can write
  their assessment to a file, and they are instructed not to edit what they assess. They produce
  `present / absent / ambiguous` results against a framework that they must name before they start.
- Any sanctions, export-control, or licensing question is **refused rather than answered.** The agent
  gathers the facts, states the question, and routes it to a named human owner. A wrong determination there
  creates exposure to criminal liability. A screening result from an agent would be relied on as a clearance.
- Claims about what the law requires must cite primary authority, and **a citation that was not retrieved
  this session is marked `not verified this session`.** Courts have sanctioned fabricated citations.

These teams get analysis-oriented Team Rules (cite sources, separate facts from recommendations, quantify trade-offs) rather than the software crew's rules.

### Build your own agent

Run `UnodeAi: Build an Agent` (or use the Team panel) to open the **Agent Builder** — a form where you create or edit a custom agent without touching JSON.

A new agent opens blank, with **Select a role…** in the Role dropdown. Picking a role fills in the form: the name, instructions, icon, color, model, and the role's default skills. You can then change anything you like. If a role switch replaces instructions you wrote yourself, the panel offers **Restore my previous Instructions**. If you save without restoring, the replaced text is kept as the agent's undo record. Reopen the agent, and **Undo template reset** brings it back. A role change never leaves your text unrecoverable.

- **Identity** — name, role (a built-in template or a custom one like *CEO*), and an icon (preset or any `$(codicon)`).
- **Connection / Pay through** — choose the immediate connection first. Before you save, the builder shows that connection's runtime, billing path, egress/privacy summary, and current capability state. Changing a connection reloads only that connection's model catalog. Changing the model never changes where the turn is sent.
- **Changing the provider type starts a new model conversation (0.9.94)** — you can move an agent between an OpenAI-compatible connection, Claude CLI and Codex CLI. Each of the three stores the model's conversation in its own format, and none can continue another's. After such a change, the model starts with nothing. When you save, Agent Builder discards the saved conversation and says so. This also applies to a stopped agent. An agent changed to another type and back therefore does not get its old conversation back. If a saved conversation of another type is still found when an agent starts, it is discarded at that point. For example, this can happen on an agent that was changed before this version. For an agent on an OpenAI-compatible connection or Codex CLI, the chat then says so. An agent on Claude CLI keeps no conversation between starts, so its chat has nothing to add. The messages in Chat stay where they are, but the new model has not seen them. Changing only the model, or moving between two OpenAI-compatible connections, keeps the conversation.
- **Capabilities are real limits** — unavailable controls are disabled with an explanation. The host rejects forged or hand-edited requests for them. Codex CLI acts through its consent-gated App Server and native permission profile. Eligible escalations receive single-use approvals. Claude or Codex may lead when the host selects that agent as coordinator. Only that selected coordinator receives team tools. Naming an agent `pm` or editing a project file does not grant delegation.
- **Model** — pick from the selected connection's model list, which shows prices. Each price shown names its gateway and source, for example `$1.7/$5.1 per 1M · Roam (live)`. `list` means the offline fallback, not a refreshed gateway response. This makes it visible when a gateway's API and page disagree, without changing the rate calculation.
- **Tool calling method** — **Auto** starts with the model's native tool protocol. The builder marks a few model
  families because their first native tool call may arrive as text. If that happens, UnodeAi completes the
  recovered loop and uses XML from the next session turn onward. You can still choose Native or XML explicitly.
  Typing a model id by hand is still allowed.
- **Model fine-tuning** — per-agent sampling/reasoning settings (temperature, top-P, max output tokens, reasoning effort, presence/frequency penalty). Leave a field blank to use the global default. These are the same values the Settings panel shows for this agent, so the two stay in sync.
- **Smart Mode tier** — a per-agent tier override (Premium / Standard / Economy, or "Use role default") for OpenAI-compatible agents. When Smart Mode is on, that agent runs on the model mapped to its tier. Two agents with the same role can therefore run at different tiers. The tier→model mapping itself is global (Settings → Smart Mode). Headless routes show why this control is unavailable, rather than ignoring it.
- **Instructions** — write the agent's system prompt.
- **Skill playbooks** — attach any number of authorized Agent Skills. Claude and Codex load an instruction-only projection of `SKILL.md` and its inert references through their native Skill mechanisms. They load it from a temporary, per-agent root that the extension owns. A Playbook never grants a tool or widens a sandbox. An extension-bundled Skill may select a fixed action handler compiled into the VSIX. Skill folders and remote catalogs cannot carry scripts or executable files. Every invocation requires Workspace Trust plus a fresh **Allow once** approval for the exact digest, given through the UnodeAi `run_skill_action` host tool. This is trusted local code that runs with the user's OS authority. It is not an OS sandbox. Effect declarations are disclosure, not enforcement.

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
rejects scripts or binaries under `skills/`, symbolic links, unknown handlers or manifest fields, action input
over 64 KiB, and output beyond 64 KiB. A timed-out call still resolves, even if a detached descendant keeps an
output pipe open. While UnodeAi owns the original child process, it requests one process-tree kill. However, a
detached Windows process may survive, because Node cannot place it in a Job Object. The current approval does
not enforce `declaredEffects`. Review the digest, and assume the compiled handler can use the authority named in
the warning.
- **MCP grants** — give the agent access to registered MCP servers, or add a new one. For both Claude and Codex, the extension host remains the external MCP client. It publishes only the approved tools and rechecks the live grant when a tool is called. Agent startup waits up to 45 seconds for every granted managed integration, including first-time approval. If that wait ends in a failure, startup offers Not now, Retry, or Start without integrations. An approval that nobody answers reaches the deadline. Startup then stops and reports how to retry, instead of waiting forever. The user's native CLI MCP remains separate. Claude's native calls stay behind Claude's UnodeAi tool gate, while Codex applies its own native approval behavior. UnodeAi's own Claude bridges get unpredictable per-session names, and only their exact tool names are allowed automatically. A native server named like a UnodeAi bridge therefore receives no special treatment.

Agents running at the same time wait independently on one shared managed-integration mount. One agent's
deadline therefore cannot cancel another agent's valid wait. A missing or empty SecretStorage value fails before
the server starts, and it is reported by variable name only. Marketplace → **Integrations** →
**Your integrations** lists every configured custom or catalog integration with its connection and grant status.
**Remove** names the affected agents, revokes saved and live grants, and cancels active calls. It removes the
configuration and approval record without deleting shared secrets. A call cancelled before dispatch is
`cancelled`. After dispatch, a timeout or cancellation is `outcome unknown`. In that case, the late result is discarded,
and the connection is quarantined while UnodeAi reconnects automatically through the same approved mount path.
Calls made during recovery wait for that attempt or report the integration as temporarily unavailable. They are
never misreported as a revoked grant.

An MCP result that carries the protocol's error flag is recorded as an integration failure, even when it
contains text. It does not trigger a reconnect while the server remains responsive. If a stdio server cannot
connect, the failure reason includes a bounded plain-text tail of its stderr. Values resolved from SecretStorage
placeholders are redacted. Ordinary literals such as `DEBUG=1` stay readable, so the diagnostic is still useful.

Native Codex MCP calls appear in chat with only the server, tool, and status. They are labelled as governed by
Codex and are never counted as UnodeAi evidence. When a Codex agent's set of team tools or managed-integration
tools changes, App Server cannot resume that thread with a different immutable dynamic-tool surface. UnodeAi
therefore visibly starts a fresh Codex conversation. The earlier App Server thread is not deleted, and the
UnodeAi transcript remains. The new model conversation does not inherit the earlier thread's model context.

**How the form is laid out.** Every section has its own **Advanced** fold, and folds start closed. The settings
people usually leave alone are one click away instead of in your way. **No fold opens itself** — a closed
section stays closed until you open it. **Skills** and **Tools** show what is currently selected and fold the
rest into a full list. A long catalog therefore does not bury the handful you actually use. Model fine-tuning
appears before Skills and Tools.

**A save never widens an agent without saying so.** A saved agent keeps the tools it was saved with, even when
a capability it uses has gained a tool in a newer version. For example, the System Architect's Architecture
Design gained Run commands in 0.9.92. Saving the agent in the builder applies the capability as it is now.
Before you save, the form therefore shows `Saving adds to this agent: Run commands` beside **Save**. Untick that
capability to keep the agent as it is.

**Double-clicking a team member** in the Team panel opens that agent's Workbench conversation.

Save, and the agent joins your team like any preset. You can chat with it, and the PM can delegate to it.

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

The Workbench is one editor tab. It has one agent selector, a compact header, a full-width transcript, and a
composer pinned at the bottom. The header shows the role, route/model, observed cost and turns, with the context
meter at its right end. Pick an agent, type your request, and send it. The Workbench is a native editor tab, so
you can drag it wherever your VS Code or Cursor host supports moving editor tabs. You can close it like any
other tab, and reopen it at any time. The selected session, transcript, and running backend turn are shared host
state, so closing a surface never starts a new turn or discards a running one.

The **Chat** sidebar is still available as a compact alternative entry point, and you can use it alongside the
Workbench. It is not a second transcript. Both containers use the same renderer and selection, and only visible
containers receive live stream updates. `unode.workbench.autoOpen` defaults to `true`. With that value,
**Open Chat** and the chat actions on agent cards open the Workbench. Turn the setting off if you prefer those
actions to focus the sidebar instead. UnodeAi never opens the Workbench just because the extension activated.

To give the selected agent a precise code excerpt, select text in an in-scope editor or UnodeAi diff. Then
choose **Add to UnodeAi** from the editor lightbulb. This opens the Workbench and inserts the selection into the
selected agent's composer without sending a turn. The action does not appear when there is no team or no
selected agent. A document outside the workspace is offered only when that agent's existing Folder Access read
scope permits it.

When no turn can run yet, the same renderer in both containers replaces the transcript with one clear repair card. It offers **Create a team** when the workspace has no agents, or **Open Settings** when the saved route is unavailable or its API credential is missing. The card carries no endpoint, secret name, or key. The host resolves those details, and the composer stays disabled until the repair is complete.

Use **UnodeAi: Toggle Workbench Composer Focus** (`Ctrl+Alt+Enter` on Windows/Linux,
`Cmd+Option+Enter` on macOS) to move between the editor surface and the Workbench composer. The shortcut does
not use the Cursor-reserved `Ctrl/Cmd+K`, `L`, or `I` chords.

### Context receipt

Every turn has a collapsed line above the reply: **Attached context: N sources · ~X text tokens
(estimate, attached sources only)**. Open it to see each source that entered the turn: its label, byte size,
token estimate, where it came from, and why it was included. The token number is calculated from bytes and
leaves out non-text sources. UnodeAi says so on the panel, rather than presenting an estimate as a count.

**This number is not the size of the request.** It counts the attached sources and nothing else. The
conversation history, the system prompt, and the tool definitions all use up the model's window without
appearing here. That is why a receipt can show a few thousand tokens while a gateway rejects the same turn as
too large. The two measure different things. Compaction is decided from the composer's context meter, not from
this receipt.

**An attachment is listed only after the agent's route sent it.** A text file, image or PDF you attach joins the
receipt when the route has handed over the request that carries it: when the Claude CLI took the turn, when the
provider accepted a request with it (OpenAI-compatible), or when Codex App Server accepted the turn. A turn with
attachments therefore shows its receipt a moment after you press Send. A turn that is refused or fails before
that shows no receipt, and its request summary counts no attached sources. A text file whose bytes are not text
is named to the model but not listed. If an OpenAI-compatible model rejects images, the retry carries a note in
place of the image, and the image is not listed. A turn without attachments shows its receipt when it is sent, as
before. Until 0.9.96, every attachment was listed as soon as you pressed Send, whatever the route did with it.

Each file-backed source also shows two **filesystem facts**, not judgements:

| Field | What it says | What it does not say |
|---|---|---|
| **Staleness** | `modified N days ago` or `unchanged for N days`, read from the file's modification time, with a visible note at 90 days or older | That the file is wrong, obsolete, or unsafe. Stable, correct guidance stays correct at any age, and a fresh checkout can reset timestamps |
| **Sensitivity** | `no mechanical signal`, or `possible` together with the signals that matched — secret-pattern matches, conventional paths, owner-only file mode, or `.gitignore` membership | That a secret is present. This is not a classifier, no model inspects the file, and matched content is never copied into the panel |

The sensitivity signal is deliberately tuned to miss less, not to warn less. A source that quietly carries
credentials into model context costs more than an inspection you did not need. Both fields are
**report-only** in this release. Nothing is blocked, redacted, or granted because of them. Sources that are
not workspace files, such as a directory-derived index, read `unavailable` instead of guessing.

### Edit history (the inspector rail)

The Workbench title bar has a **Show Changed Files** icon. It opens a rail on the right that lists what the
**selected agent** just changed, newest first. **The rail is titled *Edit history*, and that wording is
deliberate (0.9.34):** it lists edits that happened, not files that are currently different. A file you
restore with **⟲** stays in the list. The entry is a record of the edit, not a claim about the file's present
state. When the rail was called *Changed files*, a restored file looked as if it were still changed. Each entry
opens that edit in the **native VS Code diff
editor**. You can view it side by side or inline, and press `F7` to step through the changes. Unchanged regions
are folded. The right-hand side is the real file, so you can fix an agent's edit inside the diff you are
reviewing. Hover over an entry to show **⟲**, which restores that one file to its pre-edit version after a
confirmation.

The rail is **off until you open it**, and its state is remembered for each workspace. **Close it with the `×`
at its top right, or press `Escape`**, as well as with the title action. Once it has closed, focus goes back to the
**Review changes** button that opened it, when that button is still on screen; otherwise to the session menu button,
or the message box. Focus you had already put somewhere else stays there. An `Escape` that closes the session menu
closes only the menu. In a narrow editor, it
stops reserving a column and becomes an overlay drawer instead. It never hides while the title action still
says **Hide Changed Files**. Nothing in the rail is unique to it. The same restore points are in
**UnodeAi: Restore File Checkpoint…**, and an agent's own changed files are still on its Team roster row.

#### Restoring a file

A restore is a new write. It is checked when you ask for it, not when the edit was recorded, and a restore point
carries no permission of its own.

- **It acts on the file the agent changed.** Each restore point records the file as the agent's tool resolved it:
  in its worktree, in the subfolder its Folder Access gives it, or in another folder of a multi-root workspace. The
  confirmation names that file in full. Earlier versions read every recorded path against the first workspace
  folder, so a restore could overwrite or delete a different file with the same relative path there. An edit
  recorded by an earlier version does not say which folder its path belongs to. It stays in the Edit history for
  review, with **⟲** disabled.
- **It needs the authority of now.** The workspace must be trusted, and the file must be inside an open workspace
  folder. A file with unsaved changes in an editor is refused: save or revert them first.
- **It never discards newer work.** The file must still hold what UnodeAi last recorded for it. If you, another
  program, or anything UnodeAi did not record changed it since, the restore is refused and the file is left as it
  is. Open the edit to compare and copy what you need.
- **It says what it undoes.** Restoring an older edit also undoes every later recorded edit of the same file, by
  any agent. The confirmation counts them and names whose they are, for example `3 edits (2 by Dev, 1 by QA)`. If
  the file changes while the confirmation is open, the restore is refused.
- **It puts back the exact bytes when UnodeAi kept them.** Before UnodeAi's own file tools (`write_file`,
  `apply_edit`, `apply_patch`, `delete_file`) replace or delete an existing file, they keep its exact bytes, and only
  then make the change. A restore of that change puts those bytes back, so a file that is not UTF-8 text, or a binary
  file, comes back byte for byte. The confirmation says which kind of restore point it uses: **exact bytes kept
  before the edit**, or **text copy kept by UnodeAi** for a restore point that holds only the text, such as one
  recorded for Claude or Codex, or by an earlier version. When the exact bytes can no longer be read, or no longer
  match what was kept, the restore is refused; the text copy is never used in their place.
- **It reports what happened.** The restored content goes to a temporary file beside the target, which replaces the
  target after a last check, and the result is read back. If the read-back does not hold the restored content,
  UnodeAi says it could not confirm the restore and keeps the restore point; it does not write again to hide the
  failure. A restored edit then shows **Restore unavailable: This change was already restored.**
- **What cannot be restored.** A deleted folder is listed with the files it held, not their contents. A file with
  a second name on disk (a hard link) is refused, because a restore cannot change only one of its names. A text
  copy is not the file's bytes: when a text restore point was kept of a file that is not UTF-8 text, its restore is
  disabled, since the kept text is not the original content. A Codex restore point records the
  change Codex proposes, before Codex writes it, and UnodeAi reads that proposal with LF line endings. When the file
  Codex wrote is not byte for byte that proposal, for example because it kept CRLF line endings, the restore is
  refused as a change UnodeAi did not record.

Between the last check and the replacement, another program can still change the file; the checks narrow that
window but do not close it.

**Where the exact bytes are kept, and how many.** They are kept on this computer, in UnodeAi's own extension
storage, in a folder of their own for each workspace; never in the project and never sent anywhere. One copy holds
at most 32 MiB, a workspace keeps at most 256 MiB of them, each for at most 30 days, and a workspace keeps at most
200 restore points of both kinds together; the oldest go first to make room. A copy in use is never removed to
make room: the one a change is being made with, and the first one a request kept of a file, until that request
ends. When a copy cannot be kept, because every restore point that could make room is still in use or because the
storage cannot be used or written, the change is not made; the agent is told why, and to ask you or, when there is
no room, to write the content to a new file instead. A file larger than 32 MiB is not replaced or deleted by these
tools at all. When UnodeAi starts, it removes what an interrupted copy left in its own folder; it never writes a
project file then. A restore point whose copy is gone is removed from the Edit history.

Worktree lane diffs open in the same native editor. A lane-level **View diff** asks which changed file to open
when there is more than one, instead of printing every file into one buffer. The base side is **pinned
to the commit it was opened against**, and the tab title names that commit (`base a1b2c3d ↔ …`). A diff you
left open therefore does not quietly switch to a new base when the base branch moves on.

### Context meter and Compact

A meter shows how full this agent's context is, for example `41% of an assumed 1,048,576 tokens`. In the Workbench, it is at the right end of the header bar, beside the **…** menu. The Chat sidebar is narrow and has no header bar. There, the meter is in the row of controls below the message box, beside the **⤓** button. Click the **⤓** button to compact.
**The denominator matters as much as the percentage**, so the label always says where the number came from:

| Label | Where the number came from |
|---|---|
| `configured` | You typed it into the agent's **Context window** setting. Always wins. |
| `measured` | The gateway advertised it for this exact model, through the model picker's consented `/models` read. |
| `provider-refused` | The provider rejected a request of that size. See below. |
| `assumed` | Nothing told us, so the documented 1,048,576-token fallback is in use. |

**Every runtime fills the meter in.** An OpenAI-compatible agent measures the conversation UnodeAi
holds for it. A Claude or Codex agent reports the size of each request it sends. The meter shows the projected
size of the next request, based on the runtime's latest usage report. Codex also reports its model's window,
and the label then reads `measured`.

**When there is no number, the meter says why** instead of staying blank:

| Pill reads | Meaning |
|---|---|
| `41% of an assumed 1,048,576 tokens` beside a **⤓** button | Live. Click ⤓ to compact. |
| `Context — start the agent` | The agent is not running yet. ⤓ is greyed out. |
| `Context — measured after the next reply` | A Claude or Codex agent that has not reported a size since it started or last compacted. A Codex agent keeps its last size across a restart, because it resumes the same conversation. ⤓ still works. |

`UnodeAi: Compact Context` performs the same action from the Command Palette, so it can be bound to a key.

**Click ⤓ to compact now.** The reading is text. The action is a square icon button beside the paperclip, and
its hover text and screen-reader name are a full sentence. It compacts whether or not the automatic trigger has
been reached, because pressing the button is itself the trigger. The agent must be idle. If you press the
button during a turn, it says so instead. What compacting means depends on the runtime:

- **OpenAI-compatible:** UnodeAi summarises the older turns with the agent's economy model. It keeps the newest
  turns and every record of work, such as a file write, a command, a delegation or a refusal, word for word.
- **Claude and Codex:** UnodeAi asks the runtime to compact its own conversation, and the runtime writes the
  summary.

Either way, the chat shows a receipt, described under [Smart compaction](#smart-compaction). If nothing
could be compacted, it says so instead of claiming success.

**An agent learns its own ceiling from a rejection.** When a gateway refuses a turn as too large ("exceeds
the context window"), the refusal proves that the model accepts less than was sent. UnodeAi records the size
of the refused request as that model's ceiling and switches the meter to `provider-refused`. It then compacts
on its own before reaching that ceiling, so the same conversation does not fail again in the same place. The request is **not
retried**: it would fail in the same way and be billed again.

In three cases, UnodeAi deliberately records nothing, and the error says which case applies:

- You set **Context window** yourself. Your number stands, so lower it yourself.
- The new limit is no smaller than one already recorded.
- The conversation is too small to explain the rejection. This means that the system prompt, tool definitions,
  or attached project knowledge are carrying the weight, and compacting history cannot shrink them.

A recorded ceiling is bound to the exact model that produced it, and it only ever tightens. It is saved with
the agent roster, so it survives a reload. It also travels in `.unode/team.json` whenever the team file is
written. It is overridden as soon as you set **Context window** yourself.

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
in `.unode/team.json`, and Custom and Off agents are not affected. UnodeAi reads that file when the window opens.
A change made outside the editor, by hand or by a `git pull`, therefore applies after
**Developer: Reload Window**. A shared team file can also set an agent's mode and numbers, within the same
bounds. It can make compaction more frequent (each one costs summary requests), move it later, or turn it off.
It can never grant access or block a task.

**It schedules maintenance; it never blocks a task.** Compaction runs just before the task is sent, within three
minutes. If it fails or runs out of time, the chat says so and the task is sent unchanged. An identical automatic
failure is not tried again for ten minutes. ⤓ always tries.

**It waits until a compaction is worth it.** On an OpenAI-compatible agent, an automatic compaction that could
remove less than a tenth of the trigger is skipped at no cost. Such a compaction would land just under the
trigger and run again on the next turn. Instead, it runs a turn or two later, once more has accumulated. The
conversation can therefore run up to about 10% past the trigger. ⤓ always compacts. When the instructions,
tools, kept records and newest turns alone keep a compaction above its working target, the receipt says so and
suggests a higher ceiling.

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
runtime reports it), why it ran, and what it cost. When the runtime shares the summary, the receipt also has a
collapsed **What the agent now remembers** section. That section is a model-written summary, not evidence. A
receipt appears once, even after a reload.

### Empty replies

A model sometimes answers a request with nothing: no text and no tool call. Sometimes this happens after it has
spent tokens on hidden reasoning. UnodeAi then sends the same request once more. It does this only when the
blank attempt did no work and asked no one for approval, so a retry can never repeat an action. If the second
attempt is also blank, the turn ends as an **empty reply**. The agent's chat says so and gives the facts:

> UnodeAi: The model returned an empty reply after 2 attempts. The last attempt used about 246,668 input tokens
> (provider-reported); no text or tool call was received. Upstream provider: DeepInfra.

For an OpenRouter connection, the upstream provider is the one that OpenRouter reports it selected, shown as
plain text. Other routes read `unavailable`. A delegated empty reply never counts as completed work. The
Activity view labels it **Empty reply**, and a rejection reads "Rejected — the model returned an empty reply at
about 246,668 input tokens." UnodeAi reports what it observed. It never claims a reason for the empty reply.

**A teammate whose reply is empty gets two more chances.** First, UnodeAi sends the same task once more, with a
host note saying that the previous reply was empty. If that reply is empty too and the teammate has a fallback
model, UnodeAi switches the teammate to it and tries once more. Each retry is an ordinary new dispatch, so it
goes through compaction, permissions, scope, file claims, input grants and spend limits again. A tool-only turn,
an error, a stop, a refusal or an approval is never retried this way. If every reply stays empty, the
coordinator is told so, along with the last reply's facts. The card described under
[When a run gets stuck](#when-a-run-gets-stuck-the-card-carries-the-next-step) offers the next step.

### Knowing it is still working

While an agent runs its own turn, the end of the transcript shows what it is doing and how long it has been
doing it. **A coordinator that has delegated is idle on purpose**. It has dispatched the task and ended its
turn, and the work is happening elsewhere. That line therefore used to disappear entirely, and a crew hard at work
looked exactly like a crew that had stopped.

It now reads `delegating to Content Strategist, 42s; delegating to Frontend Engineer, 12s`. That is one clock
for each teammate still out, longest-waiting first, all on one line. A count would not have answered the
question people actually ask. That question is not "is anything running" but "which one has gone quiet".

### Approval signals

Approve or deny only from the inline card in the shared Chat/Workbench transcript. The command, web request, or
diff that caused it stays visible there. The decision is never duplicated in the sidebar.

When a decision is needed, the status bar shows **`🔐 N waiting`**, and the item hides at zero. The UnodeAi
activity container shows the same count, and the relevant Team row is highlighted with a lock. Click the
status-bar item or that highlighted row to open the relevant Workbench conversation and scroll to the inline
card. You start this navigation yourself. An arriving agent request never steals editor focus or autofocuses an
allow button. It also never expands a UnodeAi sidebar that you collapsed or switched away from. The status bar
still counts the request, and the [chime](#a-sound-when-something-waits-for-you) plays while a chat view is
visible.
While a card or approval dialog is actually open, the agent it belongs to reads **Waiting on your approval**
instead of **Stalled**, on every route. A request the policy decides by itself (allowed or refused without asking
you) never shows that state. When two agents need the same public-web approval, both show it while it is open.

**Each approval is decided once (0.9.88).** Whichever comes first settles it: your click, its 15-minute window
running out (a denial), or **Stop**. Anything later is ignored before it can take effect. As a result, a dialog
answered after its window, or a click on a card that was already withdrawn, grants nothing and saves nothing. **Stop removes
that agent's cards at once**, and its worker receives a denial. Nothing it was asking for runs. If another agent
was waiting on the same approval, its card stays for that agent.

Host egress consent is also shown as **`🔐 Consent required — waiting for you`**, not as an agent error. If a
time-limited approval expires, the Team row and transcript say **Denied — timed out** instead of silently
returning to idle. Local decisions record a local approver identity in the host event stream. This is a reusable
extension point for future clients. It is not remote approval or mobile transport in this release.

The shared Workbench transcript supports:

| Feature | What it does |
|---|---|
| Live streaming | Shows replies as they arrive. While a selected agent is running, the end of the transcript shows what the extension last observed in the turn and for how long, followed by the time since the turn started (for example, `Waiting for Claude – 8s · turn 31s` or `Running npm test – 14s · turn 52s`). See [What the live line says](#what-the-live-line-says). The timers stop when the turn ends or the panel is hidden |
| Stop | Interrupts a running turn |
| Steer | Sends an extra instruction to a running agent |
| Plan / Act mode | Controls whether tools are available |
| Tool cards | Shows file reads, writes, commands, MCP calls, diffs, and outputs. Each card is collapsed to its title row. Click the row (or the ▶ on its right) to show the input, output, and diff. A **blocked** call opens by itself. A card's result (succeeded, refused or failed) is what UnodeAi or the runtime reported for that call. It is never a guess from the wording of its output. When the same tool runs more than once at a time, each result lands on its own card. Consecutive file reads collapse into one "Read N files" group. A finished card states its duration (`Done · 1.4s`). See [Step timing](#step-timing) |
| Smooth streaming | Replies render markdown as they stream (code blocks, lists, and tables don't rearrange at the end). Bursty text is paced into a steady flow. A growing paragraph keeps its DOM node across paced paints, so a selection in it is not recreated on the next frame. This includes a paragraph that contains bold, inline code or a link. Its already-rendered parts are left alone as the text grows. A paragraph whose tail is genuinely re-parsed is still rebuilt, for example when a closing `*` turns trailing text into emphasis. Turn it off with `unode.chat.smoothStreaming`. It also flushes instantly when you switch windows or enable "reduce motion" |
| Analysis cards | Shows model reasoning streams when available |
| Context meter | Approximate context use, always labelled with where its denominator came from; the **⤓** button compacts now — see [Context meter and Compact](#context-meter-and-compact) |
| Todo panel | Shows only agent-reported `update_todos` plans. Its collapsed header states real progress (for example, `4 of 7 done · Wire the command`); expand it for the full checklist |
| Command/write approvals | Shows the approval inline with the command, URL, or diff that caused it. It is never a detached second approval queue |
| Per-agent drafts | Keeps unsent text with the selected agent (up to 20 recent drafts). Sending, or removing that agent, drops its draft. The Workbench also keeps a saved copy, so it can be rebuilt after an extension host restart. See [After an extension host restart](#after-an-extension-host-restart) |
| Export/import | Saves or restores a selected agent's chat transcript |
| Compact mode | Compresses the chat view for dense workflows |

**A file tool card is a bounded receipt, not the document.** A `read_file` title says whether the card holds
Markdown or other file content. Markdown previews use the same structured renderer as replies. A truncated
preview states how much was left out, beside **Open full file in editor**. That button sends only the
receipt's host-issued ids. The extension resolves the recorded path and re-checks the agent's physical read
roots before VS Code opens the file. It opens only a regular file; when it cannot open one, a notice says why. A
card you expand also stays expanded when a later tool call regroups it, when the transcript refreshes, and when the
Workbench reloads.

#### File links in a reply

**A Markdown link to a file in an agent's reply opens that file in an editor tab of this window.** This covers a
relative path such as `[the plan](docs/plan.txt)` or `[notes](<docs/My Notes.md>)`, and an absolute path on this
computer, such as `C:\work\docs\draft.md` on Windows. `#L12`, `#L12C3`, `:12` or `:12:3` after the path opens the
file at that line; a line past the end goes to the last line. Click the link, or reach it with Tab and press Enter.
It works the same in the sidebar chat and in the Workbench, while the reply streams, after it ends, and after a
reload. UnodeAi does not turn other blue text or a bare file name into a link.

- **The click sends only the link's id.** UnodeAi finds the reply and the link again in the conversation it keeps.
  It reads a relative path against the folder the agent was working in when it wrote the reply, so a later change
  of the agent's folder does not move the link. In a multi-root workspace where the agent works in the default
  first folder, UnodeAi asks which folder the link is in. It never picks one by finding a file of the same name.
- **The agent's current read folders and the file decide.** Before the editor opens, UnodeAi checks the agent's
  Folder Access as it is now and the file's real path, with symlinks and junctions followed. Nothing is run, written
  or sent to the agent.
- **A link that does not open says why.** A missing or renamed file, a directory, a file outside the agent's read
  folders, a reply that is no longer in the kept conversation, a remote window and a virtual workspace folder each
  show a notice (file links in remote windows are not supported yet). A notice about a link offers **Copy reference path**, which copies the link as written. A location
  that is not a line (`#install`) opens the file at its start and says so.
- **Other links are never followed.** `file:`, `command:`, `javascript:`, `data:` and `vscode:` links, network
  shares, device paths, a path that depends on a current drive (`C:notes.md`), a path with `..`, and a path encoded
  to hide a character are shown as text, with the reason beside them. Web links (`http`, `https`) work as before. A
  file link in an Analysis card or a file preview is shown as text.
- **A link shows where a file is, not that the agent saved it.** Only a file tool card says what a tool wrote.

**The composer is two rows (0.9.34):** the message box gets a full-width row of its own. Everything else
shares one control row beneath it, with the two UnodeAi approval selectors on the left, then Insert, Send and
Stop on the right. Those three are **icons, not words**: **↑** sends, **⚡** steers a running agent, **↓**
queues a follow-up behind one, **■** stops. Hover over any of them to see the word. Each one also uses that
wording as its accessible name, so nothing is lost to a screen reader. For a Codex agent, that pair is replaced
by a per-agent permission selector: **Ask for approval** (default), **Approve for me**, or **Full access (unsafe)**
in Act mode, and forced **Read only** in Plan mode. A host ceiling is named in the disabled control. Full access
always opens a confirmation modal, and the composer and session card keep showing a visible warning for it.
Below roughly 450px, the visible label drops away, but the control still shows its current value. In Workbench,
the transcript uses the full height beneath the transparent floating composer. After a resize, a revealed
approval is re-anchored instead of reserving a permanent empty band. Only while a decision is pending does its
card reserve the dock's measured height. This lets the card scroll completely above the composer, even in a
narrow or zoomed editor. On a short viewport, the composer returns to normal flow so that it cannot cover the
conversation.

**A send that nobody confirms comes back to you (0.9.88).** If the extension does not acknowledge a message within
about 10 seconds (for example, because the extension host restarted), the composer returns your draft and its
attachments. A notice says that the send was not confirmed. Nothing is resent automatically, since the extension
cannot tell whether the old process received it. When a send is confirmed, early or late, the composer clears
only what was sent (0.9.96): text you changed after Send stays, and only the attachments that went with the
message are removed.

#### After an extension host restart

**The Workbench offers to reopen (0.9.96).** **Developer: Restart Extension Host**, **Restart Extensions** after
an update, and choosing **Don't Trust** restart the extension host without reloading the window. VS Code then
keeps the Workbench tab on screen, but never connects it to the new host. The page looks live, but nothing typed
or sent in it reaches UnodeAi. Once such a tab has been in view for two seconds without connecting, UnodeAi asks
whether to reopen it:

- **Reopen Workbench** opens a new Workbench in the same editor group, closes the old tab, and selects the agent
  you last chose. Its composer holds the unsent text from the last saved copy, and a line under the composer says
  so. Text typed in the old tab in the last seconds before the restart, or after it, is not in that copy.
- **Keep Old Tab** changes nothing. Copy what you need from the old tab, then close it, or choose **Open
  Workbench**, which asks again.

Nothing is sent or started by either choice. Attachments are not kept in the copy, so attach them again. The
sidebar Chat needs none of this, because VS Code connects it to the new host itself. **Reload Window** and closing
and reopening the window restore the Workbench in place, as before. Since 0.9.96 they also select the agent you
last chose, if it is still in the team.

**VS Code may report a PowerShell exit code 1 after a restart.** When the extension host restarts or the window
reloads, UnodeAi closes each agent's `Unode: <agent>` terminal. It first ends that terminal's shell together with
any command still running in it, so that nothing an agent started keeps running. If VS Code sees the shell end
before UnodeAi closes the terminal, it reports `The terminal process "...\powershell.exe" terminated with exit
code: 1.` (or names the shell of your terminal profile). That is the agent's shell, ended on purpose. Your own
terminals are not closed. The same can happen when an agent is restarted or removed, or after a command times out.

**The saved copy of unsent Workbench text.** Besides the copy VS Code keeps in the page, the Workbench keeps a
second, text-only copy of each agent's unsent text in this workspace's UnodeAi state on this computer. It is never
synced and never sent to a model. It holds up to 20 drafts and 2,000,000 characters in all. A draft longer than
1,000,000 characters gets no copy, and the line under the composer says so. That line also says when a copy could
not be saved, for example with no workspace folder open. Sending a draft, deleting its text, removing its agent,
closing the Workbench and **Reset Workspace State** remove the copy.

**A draft belongs to one agent, not just to its name.** If you remove an agent and later create one with the same
name, the new agent starts with an empty composer, in the Workbench and in the sidebar. Drafts typed in 0.9.95 or
earlier are kept for the agents in your team when 0.9.96 first starts. While the window is still loading the team,
UnodeAi drops no draft. If the team does not load, for example because an agent's connection is missing on this
computer, UnodeAi keeps every draft and its saved copy until the team loads at a later start, and offers no
Workbench for reopening. A draft typed meanwhile gets no saved copy, and the line under the composer says so.

**An older copy.** If VS Code restores a second Workbench tab while one is already connected, for example after
you opened the Workbench while a restored tab was still in the background, that tab is titled **UnodeAi Workbench
(older copy)**. It shows the unsent text it had saved, so you can copy it, and nothing in it runs or is sent.
Close it when you are done.

### A sound when something waits for you

**A prompt that stops work until you decide plays one short chime when it appears (0.9.88)**. The prompt can be
an approval card, an approval dialog, or a consent dialog. A consent dialog asks, for example, about a new
model-network destination, Codex's network access, a repository's CLI configuration, a media upload, a folder
outside the workspace, a coordinator brief to another provider, or a managed integration that needs your
go-ahead. The chime does not sound again when you answer or when a second agent joins the same approval. It
also does not sound for dialogs you opened yourself, for completion notices, or for anything the policy decided
without asking you.

**It needs one interaction first.** VS Code lets a chat view play sound only after you have typed or clicked in
that view since it opened. This means that the first prompt after you start VS Code is silent if it appears
before you have used the chat. A prompt is also silent when no UnodeAi chat view is visible. The prompt itself
always appears normally. If a sound could not play, the UnodeAi output log notes this once.

Turn it off with **`unode.attentionSound`** (on by default). It is read from your user settings only, so a
repository's settings cannot silence it.

### Step timing

**A finished step says how long it took, or says that nobody measured it.**

- **On the collapsed card:** `Done · 1.4s`. A failed or blocked step is labelled the same way — `Error ·
  0.9s`, `Blocked · 2.3s` — because how long something ran before it failed is often the more useful number.
- **Expand the card** for the absolute start time, the absolute finish time and the duration.
- **A coalesced group** (for example "Read 4 files") shows its span from the first start to the last finish.
- **Your decision is not the step's time.** If the only running call is waiting for your approval, its card says
  **Waiting for your approval** while you decide, instead of counting. When the call finishes, its duration
  leaves out the time you took, and the card names that time: `Done · 0.3s · human approval 40.0s excluded`. It
  is the same time that the turn's footer leaves out. A group leaves out its calls' waits the same way. For calls
  that overlapped, it leaves out only the longest wait, because they may have waited on the same decision.

**A duration is measured or it is absent — it is never shown as `0s`.** The finish time is recorded at the
moment the call becomes a result. It is never inferred from when the card was drawn. A card saved by a version
before 0.9.63 has no measured finish, and it says **duration not recorded**. A group that contains one such step
reports a **partial span**. It does not present a shorter span as if it were the whole.

There is deliberately no timeline, waterfall, statistics panel or timing export. Per-step timings do not appear
in portable evidence.

### Long transcripts

The whole conversation is rendered. If you scroll away from a card and back again, it is still the same card. It
keeps its expanded state and its already-rendered content instead of being rebuilt.

**0.9.63 briefly virtualised this and it was wrong.** Scrolling scheduled a redraw. The redraw replaced the
transcript and pinned the view to the bottom, and pinning scrolled again. As a result, both the Workbench and the
Chat sidebar repainted at frame rate while a reply streamed, and long content was unreadable. The virtualisation
was removed in 0.9.64. A test now drives the real scroll listener in both containers. It fails if a redraw is
ever scheduled from one.

Rendering never omits, reorders or merges consent prompts, approvals, cancellations, evidence facts, errors or
final answers. Before the product ships, its tests check that sequence against the real batching and
animation-frame pacing.

### Reading a document from your workspace

**Since v0.9.69, `read_file` reads a PDF, a Word document or a PowerPoint deck from the folders an agent can
already reach.** It returns the text in the same tool result as any other file. It uses the same line window
and the same *continue from here* footer. There is no separate step, and there is nothing to page through with
a second tool.

**This was a real gap and it is worth saying what it was.** UnodeAi could already read a PDF that it fetched
from a public URL, and one that you attached to a chat message. **The one it could not open was the file already
sitting in the folder you had opened.** An agent asked to consult a local white paper had no way to do it. A
coordinator that delegated that work had no way to hand it over.

What the extension does and does not do with those files:

- **Only the document's text is read.** Embedded images, macros, and any links in a document are never opened.
  Nothing is fetched because a document asked for it.
- **The file is parsed in a separate worker with its own memory limit and a timeout**, so a corrupt or
  hostile document makes the read fail instead of affecting the editor.
- **Permission is unchanged.** A document outside the folders an agent may read is refused, exactly like any
  other file. Being a PDF grants nothing.
- **A scanned page says it needs OCR** rather than returning empty text. UnodeAi does not perform OCR.
- A plain `.zip`, and any other binary, is still refused with the same message as before.

### The activity feed

**The Activity panel names the tool and what it acted on**. For a file, it shows a workspace-relative path. For
a command, it shows the command's program name. Repeated identical actions collapse into one line with a count.
A heartbeat updates that line instead of adding another.

**A directory operation says List rather than Read.** The card is labelled **List** while it runs and
**Listed N folders** when it completes. This way, the activity history does not imply that file content was
opened.

**Before v0.9.69 this feed showed internal plumbing.** When an agent read two different documents, the feed
showed the line `Using mcp__unode_files__read_file` twice. That happened because the entry carried the tool's
internal name and not the file. Two different pieces of work looked like one repeated line.

**Nothing an external MCP tool passes as an argument is written into this feed.** The feed persists and can be
exported, so a tool that the extension does not own is shown by its name alone.

### How long a turn took

**A turn reports when it finished and its total elapsed time.** Today's turns show local time, for example
`Finished 17:41:16 · Turn time: 21s`. Older turns also include the local date. The total is not just the tool
calls. It includes time the request spent queued behind other work and time the agent spent thinking. A turn
whose tool cards all read `0.1s` can still have taken minutes, and before 0.9.68 nothing added that up.

**Time spent waiting for your approval is reported separately and is not counted in the total.** That time was
yours, not the agent's. This covers every decision that the agent's work stops for:

- Command, write, tool and web-access approvals.
- The consent dialogs for a network destination, a media upload, a read outside the workspace, a coordinator's
  brief to another provider, a repository's CLI configuration and the mounting of an MCP server.

This also applies to a request that was still queued while you decided, for example while the agent
was starting. When several agents wait on one prompt, each agent has only its own waiting time taken out.

Per-tool timings are unchanged. A turn whose time was never recorded simply shows no time. The old
**not recorded** line is gone.

**The footer also says where the time went**, on a second line:

`Observed: waiting for provider 15s (2 waits, longest 13s) · reasoning 2s · responding 2s · tools 1s · host 1s`

These parts add up to the turn time exactly. Each part is what the extension observed, not what the model
reports about itself:

| Part | What it measures |
|---|---|
| waiting for provider | Time after the extension sent a request, or returned a tool result, during which nothing came back. The extension cannot see why. The provider may have been queueing the request, reading the context, or reasoning without sending anything. With more than one wait, the line gives the count and the longest one |
| reasoning | Time from the moment the provider sent reasoning until it sent reply text, called a tool or ended the turn |
| responding | Time from the moment the provider sent reply text until it sent reasoning, called a tool or ended the turn |
| tools | Time while at least one tool call was open. Calls that run in parallel are counted once |
| host | Time the extension spent preparing the turn before its first request |
| queued | Time the request waited before the turn began, either behind the agent's earlier work or for the agent to start |

A part that took no time is left out, except `waiting for provider`. A turn recorded before 0.9.92 has no
such line. Its breakdown was not recorded, and the extension does not show zeroes in its place. The same is
true of a saved breakdown that does not add up to its turn.

### What the live line says

While a turn runs, the line at the end of the transcript names what the extension last observed:

| Line | Meaning |
|---|---|
| `Preparing the request` | The turn has begun and no request has been sent yet |
| `Waiting for Claude`, `Waiting for Codex`, `Waiting for <route>` | A request or a tool result has been sent and nothing has come back yet |
| `Reasoning` | The provider sent reasoning. This line appears only then. Silence is never shown as thinking |
| `Responding` | The provider is sending reply text |
| `Running npm test`, `Running a tool` | One tool call is open. The timer beside it is that call's own time |
| `Tool work, 2 calls open` | Tool calls overlapped. The timer is how long the turn has had tool calls open. It is not the time of any single call, so no tool is named |
| `Waiting for your approval` | A decision of yours is open. It is shown ahead of the tool that asked for it. The time you take is not counted in the turn time |
| `Working` | The turn is running and the extension has not reported a phase for it yet |

The first timer is the time the turn has spent in the state that the line names. It starts from zero when that
state begins. The second timer, after `turn`, is the turn time so far. Both are counted the same way as the time
in the finished turn's footer. Neither includes the time you spend on a decision. While a decision is open, the
line reads, for example, `Waiting for your approval – 20s · turn 31s (paused)`. Here the first timer is how long
the decision has been waiting for you. When you have decided, the interrupted state continues from the time it
had reached.

A tool's own card keeps its own elapsed time. That time counts from when the call started, and it includes any
time you took to approve it. It can therefore differ from the line's first timer.

### The answer that ends a turn

**Only the reply that ends a turn looks like a conclusion (0.9.88).** The working lines that an agent writes
before each tool call stay visible as steps, in the plain style. The final answer has its own emphasis, and it
is marked as the conclusion for screen readers. Before 0.9.88 every finished line was styled as an answer, so the
end of a stage did not look like one.

**Its footer holds the host's facts about the turn, once each:**

1. **Why it spoke**, when UnodeAi started the turn itself, for example *Triggered by Frontend Engineer's rework
   reply* or *Triggered by results from Frontend Engineer and QA*. A turn you started has no such line.
2. **Delegations this turn**, for a coordinator, including *0 accepted · 0 refused*. It used to arrive as a
   separate card after the answer. That card is gone. A count that changes later updates this footer in place.
3. **When it finished and how long it took.**

All three come from the extension, never from the agent's own text.

### Request summary

**One host-observed card for every turn that hands control back to you (0.9.94).** When a turn you started
ends, Chat shows a **Request summary · Observed by UnodeAi** card. It appears right after the item that ended the
turn. That item is the reply or, for a turn that ended without one, UnodeAi's own line saying so. A coordinator
turn that UnodeAi started to hand over a teammate's result also gets a card. A teammate's delegated turn does
not, because the coordinator's turn and the job's own card account for it; the files it changed are in the
coordinator's card for the request. The card is not a message. It is
never sent to a model, summarized, compacted or counted as tokens. It is not in an exported chat either.

**The line.** The closed card is one line, for example `Answered · no verified file change observed · $0.18 · 18s`
or `Verified · 2 files changed · 1 check run passed · 46s`. Open it to see the nine sections below.

**What the first word means.** It comes from what UnodeAi observed, never from what the reply says.

| Word | Meaning |
|---|---|
| `Answered` | A reply was delivered. UnodeAi recorded no change and ran no check. It does not say that the reply is right |
| `Finished — not verified` | The turn ended and UnodeAi recorded a change. UnodeAi did not run the verification command. Until 0.9.95 this read `Completed — not verified` |
| `Verified` | UnodeAi itself ran the configured verification command in this turn, and it exited 0 |
| `Finished — checks failed` | A run of that command by UnodeAi failed. Until 0.9.95 this read `Completed — checks failed` |
| `In progress` | A coordinator's turn ended and delegated tasks of its job were running, or were taken up after it ended |
| `Needs you` | An approval was not granted, a request limit waits for your decision, or UnodeAi ended the attempt at the first-action deadline |
| `Blocked` | A coordinator's job is open, nothing of it is running, and team policy refused a dispatch |
| `Stopped` | The turn was stopped |
| `Failed` | The turn reported an error, or the agent's process ended before a result |
| `No conclusion recorded` | The turn ended without a final reply, or a coordinator's turn ended with its job open and nothing running |
| `Job closed` | The team job that this turn belonged to has since closed. Its **Job outcome** card is the record of that job |

**The sections.**

| Section | What it shows |
|---|---|
| **Result** | How the turn ended and when |
| **Work** | Tool calls by result, a coordinator's dispatches in this turn, and how many reasoning items were shown |
| **Changes** | The files this request changed, as UnodeAi observed them, each by path once with how UnodeAi knows it. No contents. See [The changes of a request](#the-changes-of-a-request) |
| **Checks** | Runs of the configured verification command that UnodeAi itself started in this turn |
| **Access & approvals** | Approval decisions by kind: allowed, denied, expired |
| **Context** | How many sources UnodeAi attached to the turn, and their estimated size |
| **Team & routes** | The agent and its route: the CLI or the provider, and the model. No key and no endpoint |
| **Usage & timing** | Tokens, cost per basis, the turn's time, and a request limit when one is set |
| **Remaining** | What UnodeAi recorded as unfinished: delegated tasks still running, a decision that waits for you |

**Where UnodeAi cannot see, the card says so.**

- `no verified file change observed, other effects not covered` and `N files changed, other effects not covered`
  mean that a shell command, or an action of the provider's own tools, ran in the request. UnodeAi does not see
  which files a command changed. A card of a turn that ended before this version says `more possible` instead.
- `changes not observed on this route`, `not recorded`, `partial` and `coverage limited` mean what they say.
  The figure is a lower bound, or it is left out. Nothing missing is shown as zero. A missing price shows as
  tokens only, never `$0`.
- `Remaining: none recorded` means that UnodeAi recorded nothing unfinished. It does not say that nothing remains.
- A command that the agent ran itself, such as `npm test`, is not a check here. Neither is a result that the
  agent reports in its reply. Only UnodeAi's own run of `unode.verifyCommand` counts as a check.

**Rows that say how much UnodeAi holds (0.9.95).** Three rows used to read as a bare `coverage: complete`.
That looked like test coverage, or like a statement about the work. Each row is now named for its subject, and
`complete` says what is complete:

| Row | What it is about |
|---|---|
| **Tool event record** (Work) | Whether every tool call UnodeAi saw in the turn has exactly one result |
| **Change visibility** (Changes) | Whether every file change UnodeAi observed in the request is in the list |
| **Usage attribution** (Usage & timing) | Whether the usage recorded for the turn is settled and attributed to it |

Two more rows say only what was recorded:

- **Verification runs.** If UnodeAi ran no verification in the turn, the row says whether UnodeAi had a
  command to run for that agent when the turn closed. It reads `configured, not run` or `not configured`. The
  card of a turn that ended before 0.9.95 reads `configuration not recorded`, because that fact was not kept
  then.
- **Approval decisions: none recorded** means that no decision was recorded. It does not say that none was
  needed.

**One card per turn.** The turn that closes a team job shows that job's **Job outcome** card and no Request
summary. An earlier turn of the same job keeps its own card. While the job runs, that card reads `In progress`.
Once the job has closed, it reads `Job closed` and points to the Job outcome. A later reply never takes a card
or moves one.

**A task is part of a job once a teammate takes it up.** A coordinator's turn can end before that, for example
while the teammate is still starting. Its card then reads `Answered` for that moment. It changes to
`In progress` when the task is taken up. This state says that the task was running after the turn ended, not
that it was running when the turn ended.

**Kept through a reload.** UnodeAi keeps these records in this workspace's state. It keeps them for the last 100
such turns of each agent, and for every turn that the agent's conversation still shows. A fact that arrives
late, such as a turn's settled spend, updates the card in place. Clearing a conversation removes its records. A
turn that ended before you installed 0.9.94 has no card. Nothing is made up for it.

#### The changes of a request

**The Changes section is about the whole request**, not one turn: the turns you started, and the work teammates did
for it, even after the coordinator's turn ended. A teammate's later task for another request is not in it. Each
file is listed once, by its path relative to the folder of the agent that changed it, as UnodeAi last observed it.
A file written three times is one entry; a file written and then deleted reads `deleted`.

| Row or mark | What it means |
|---|---|
| **Host-verified files** | UnodeAi's own file tools (`write_file`, `apply_edit`, `apply_patch`, `delete_file`, `delete_dir`, `save_attachment`) changed the file, and UnodeAi read the result back as written |
| **CLI native observed** | Claude's or Codex's own file tool changed the file, and UnodeAi read back the bytes that change was to leave. That does not prove who wrote them |
| **Effect uncertain** | The change may or may not have happened: the read-back found other bytes, a delete found something still at the path, the tool stopped part way, or another request changed the same file meanwhile. Check the file |
| `none` | No such change was observed. It does not say that nothing changed |

- **Only what UnodeAi observed counts.** An approval, an attempt, a tool that reports success but left the file as it
  was, or a reply that says a file was saved, is not a change. A write that leaves a file exactly as it was is not
  listed.
- **A native change is never shown as `none`.** Its count stands beside the verified one.
- **The card follows the file.** A restore you make from the Edit history updates the cards of the request whose
  change it undid: `restored by you since`, `removed by your restore since` for a file the change had created, or
  `your restore of it was not confirmed`, which makes the entry uncertain. Another request's card of the same file is
  left as it is.
- **What is not covered.** A shell command and a change Codex applies in its own sandbox without asking UnodeAi
  are not seen file by file; the card then says that other file effects are not fully covered. A file outside the
  agent's folder is counted and not shown. At most 50 files are listed; the counts include the rest.
- A card of a turn that ended before this version lists that turn's recorded writes, without these grades.

### What the product no longer does

**0.9.68 removed every automatic prompt that pushed an agent to behave.** There were five kinds. Two of them
worked by scanning the agent's own sentences for phrases and injecting a message when one matched. The prompts
cost a round-trip each, and they prevented nothing that you could not already see in the transcript.

**Verification did not get weaker.** A task can declare what would prove it done: real checks that the
extension runs and records. The removed prompt was the version of this that asked nicely. It outlived what
replaced it.

**Delegation takes less paperwork too.** Three contract fields used to be required and were usually left empty.
They are now optional. **The write scope is still required**, because it is what stops a delegated task from
writing outside the folders it was given.

**Nothing that protects you was removed.** Every safety property from earlier releases is re-tested in each
release. Each property is broken on purpose, to confirm that a test catches it.

### Task-scoped delegation and what a path means

A delegated task can carry a **folder scope**. This is a ceiling that narrows which folders the teammate may
read and write for that assignment. Three things are deliberately kept separate. They became separate in 0.9.65:

- **What a relative path means.** A path the model writes, such as `research/x-article.md`, is always resolved
  against the agent's configured working folder, exactly once, for reads and writes alike. **A task scope
  never changes it.** That folder is the same base that the coordinator wrote the task against.
- **What may be touched.** The scope narrows the read and write roots. Those roots are checked against the file
  after its path has been resolved. They are narrower, never wider, than the agent's configured Folder Access.
- **Where a command runs.** A shell command's working directory stays inside the writable part of the scope.
  A shell is not a full filesystem sandbox, so its starting directory is a real boundary.

**Before 0.9.65 the first two were the same value**, so a scope moved the base as well as the ceiling. For
example, a task scoped to `research` looked for `research/x-article.md` at `research/research/x-article.md`. It
then reported *context gap — missing*. A `readwrite` scope was worse. The doubled path was still inside the
scope, so the write was allowed and created the folder. If you saw either problem, this was the cause.

### When an agent shows you a file

**A tool card is a receipt, not the answer.** An agent that reads a file receives the whole file. The card
beside it shows a limited preview. An agent can now publish the file itself as its reply, and **the
extension does the publishing**. The agent names the receipt that the extension gave it and picks one of these
states:

| State | Result |
| --- | --- |
| **shown** | the extension publishes the whole file as the reply |
| **partial** | the extension publishes a prefix it cuts itself, by character count |
| **not-delivered** | the extension publishes the stated reason and no file content |

The agent may add framing text before the content. **It never retypes the file**, so nothing can be
copied wrongly and nothing has to be checked. Showing you a document is one read and one publish.

**0.9.66 got this wrong and 0.9.67 fixed it.** For one release the agent had to reproduce the file
character-for-character. This let the extension compare the copy against the original it already had. A single
trailing newline was enough to reject the copy, and the agent could not start over. One such request cost about
four minutes on the strongest model available. If you saw that, this was the cause.

**Two things are still enforced**, because they prevent something you could not otherwise catch. Content
from an earlier turn cannot be published in a later one. A turn has one final answer.

The receipt line is addressed to the agent, and so is the check line on Codex CLI. A read's tool card therefore
shows only the file. A line in the file that merely looks like one of these lines is file content, and it stays
on the card.

**Published content appears in an "Exact content" block (0.9.88).** It keeps the file's own characters and line
breaks. A line that starts with `#`, `*` or `1.` stays as written instead of becoming a heading or a list. The
agent's framing around it is ordinary text. The caption says what you are looking at:

| Caption | Meaning |
| --- | --- |
| **Exact content** | the whole read, as the extension read it |
| **Exact content (first N characters)** | the agent chose to publish only the start |
| **Exact content (first N characters kept in the transcript)** | the reply was longer than the transcript keeps. The part shown is still exact |

The copy button still copies the whole reply unchanged.

**The extension marks content exact only when it knows the agent received it**. How it knows depends on the
route:

- **OpenAI-compatible:** the extension sends the content to the model itself, sized to fit what it sends.
- **Claude CLI:** only after Claude CLI reports that exactly the text it was given reached the model. If Claude CLI
  shortened or replaced a large result, it is not shown as exact content.
- **Codex CLI:** Codex does not report what its model actually saw. The extension checks that the model saw the
  **first and the last line** of what it read, and nothing more: **it cannot confirm the middle reached the
  model.** The content in the block is still exactly what the extension read from the file. A Codex coordinator
  reads through the extension for this. After you update to 0.9.88, each Codex coordinator starts one fresh
  conversation, with a notice that its tool set changed. This is because Codex fixes an agent's tools when its
  conversation starts. Codex workers are not affected.

A coordinator reads in pages sized for its route. A single line too long to fit whole (minified code, a one-line
data dump) is never shown as exact content. A coordinator that reads a file with its CLI's own tools gets no
exact-content block. Its answer is ordinary text.

### Input receipts

Each declared input of a task contract carries a receipt: supplied, reachable, read. **A receipt records the
file the extension actually opened**, matched by resolving it on disk. An absolute path, a relative path and a
symlink to the same file therefore all count as the same read. Letter case follows your filesystem, not an
assumption about it.

**The resolved path stays inside the extension.** It is never placed on an input grant, never included in
the task card that a teammate's model receives, and never exported. Portable evidence carries no filesystem
paths, and this path is no exception.

Before 0.9.65, a receipt was matched against the text that the model typed. A file that had plainly been read
could therefore be recorded as unread. If an agent tells you it read something but the receipt says it did not,
**on 0.9.65 or later believe the receipt** and report it.

### When a run gets stuck, the card carries the next step

Two endings used to describe a repair in words and leave you to carry it out across three surfaces. They now
offer the repair. The extension does only what it could already do. The panel sends an opaque id, never a
target or a command.

- **A teammate's replies stayed empty.** After the host retry and the fallback-model attempt (see
  [Empty replies](#empty-replies)), the card offers **Edit agent model**, and then **Retry delegation**. The retry
  is a genuinely new attempt. It has the same task, new input grants, and the same permission, scope and
  file-claim checks as the first dispatch. It never revives the delegation that already ended.
- **An approval timed out.** The card states that the request **cannot be resumed**, and it offers nothing,
  because there is nothing to resume. The tool call that asked for the approval already received its denial and
  moved on. **An approval that expired can never become an approval**, and its id is never re-used. If you still
  want that work done, ask the agent again. It will raise a fresh approval with a fresh window.

**A repair is re-checked at the moment you click it.** If the agent was removed, the session stopped, or the
remedy became unreachable after the card was drawn, nothing runs. The card tells you why. Clicking twice, or
on two surfaces at once, produces exactly one retry.

On the Team roster, a timed-out approval now shows **⌛**, as the Status key has always documented. A
delegated task that timed out keeps **!**. Previously, both used the same marker.

### Plan mode

Plan mode is for analysis only. The extension removes write, command, delegation, and MCP tools at the tool layer for OpenAI-compatible agents. This is stronger than a prompt instruction.

Use Plan when you want a review, estimate, architecture discussion, implementation plan, or risk analysis without changes.

### Act mode

Act mode lets an agent use its allowed tools. Depending on your settings, it may read files, write files, run approved commands, delegate to teammates, or use approved MCP tools. Agents can also use the following tools. All of them stay inside the working folder.

- **`apply_edit`** makes a targeted edit. It replaces an exact snippet instead of resending the whole file, and it goes through the same checkpoint/approval safety path.
- **`search_files`** searches by regex or text and returns `file:line`, so agents find code instead of writing scratch scripts.
- **`delete_file`** is sandboxed and checkpointed, so a removal can be restored.
- **`delete_dir`** is a sandboxed recursive directory delete. It refuses `.git`/`.unode`, also by a short name, a link or a stream spelling, and anything outside the folder, so an agent doesn't shell out to `rmdir /s`.
- **A delete is reported done only when UnodeAi then finds the path empty.** After `delete_file` or `delete_dir` removes its target, UnodeAi looks at the path once more. If something is there, or the look fails, the agent is told that the delete is not confirmed and what is at the path, and the Request summary lists it as `effect uncertain`. Nothing is deleted again or put back.
- **A file tool acts on the path it names, or on none.** When a model writes a workspace path under another prefix (`/Users/dev/workspace-…/README.md`), every file tool, reads included, refuses it and names the workspace paths it could mean, and the model calls again with one. Reads no longer guess which workspace file was meant.
- **On Windows**, the file tools refuse a name holding `:` (an alternate data stream), a reserved device name such as `NUL` or `con.md`, and a name ending in a dot or a space.
- **A folder whose name starts with two dots**, such as `..cache` or `..agent`, is an ordinary folder of the workspace. The file tools read, list, search, write, edit and delete in it, a command can run in it, Folder Access and a task scope can name it, a checkpoint of a file in it restores there, and `@..cache/notes.md` attaches the file. Only a whole `..` step leaves a folder: the folder above, a sibling whose name starts like the workspace's (`repo-cache` beside `repo`), another drive or share, and a link that leads out are still refused. Until 0.9.96 most of these refused such a folder as if it were the folder above.

**Works with any model's tool names.** Unode runs many models, and each one is trained on the tool names of its own harness. When a model calls `Read` / `Bash` / `Write` / `Edit` / `LS` / `Grep` / `Task` (from Claude Code, Cursor, GPT, and others), Unode transparently maps the call to the matching Unode tool and arguments. A model's muscle memory just works, instead of failing with "unknown tool".

Use Act when you want the agent to do the work.

### Use @unode in the VS Code Chat panel

UnodeAi also appears in the native VS Code **Chat panel** as `@unode`, as well as in its own sidebar. Both run at the same time. In the Chat panel, type:

```text
@unode add a password-reset flow with tests
```

Your crew's Project Manager picks up the goal, delegates, and streams the run back into the chat. Use the **Open in UnodeAi** button to jump to the full team view (per-agent transcripts, worktree lanes, the review board).

`@unode` runs on **your configured UnodeAi agents and models**, not on the Chat panel's model. That way you keep the multi-agent orchestration and the cost savings of cheap models. You need at least one team (run `UnodeAi: Create Default Team` first).

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

For independent or longer work, the PM dispatches the task asynchronously and then returns to an
**accepting input** state. You can give it another instruction right away. If an async result arrives while the
PM is idle, one normal PM turn opens with the evidence, already classified. The PM can then report or continue
on its own. If the PM is busy, the result stays ready for the PM to collect with the non-blocking
`collect_ready_tasks`. Either way, the result is delivered once.
If a result had already settled but had not yet been delivered when the extension host resumes, it stays in
that retained-result queue. This does not resume a worker that was still in progress. Only a result that had
already arrived can be recovered.
When a collected batch contains a failed subtask, the collecting step itself is shown as a **failed tool
call**, not just as text that mentions a failure. The status is the one the host recorded while collecting.
A step whose delegated work failed therefore cannot appear as a completed call.

Use blocking delegation only when the next decision really depends on the teammate's answer right now.
If that blocking wait expires, the PM turn is marked unresolved, not completed. The worker's result can still
wake the PM during two further wait windows. Stopping the run cancels that listener, so a cancelled task cannot
wake the PM later. The timeout names the window that actually expired, for example
`timed out after 300s waiting for dev`. It does not predict whether a future task will fit in that window.

**A timeout ends the wait, not the task.** An asynchronous task has the same wait windows. When a wait runs out,
the task is not stopped. The timeout says so, and says whether UnodeAi sees the task still running; it never
says the task finished. The run record keeps the task active, not settled, and no budget is extended. The task can
still be stopped with `cancel_task` and its handle, also after the further wait windows have closed. A reply that
arrives after they closed is recorded as the end of the task. It is delivered to no one and does not wake the PM.

`inspect_task_status` keeps the facts apart: the task's own execution state, the teammate's activity, the
wait-window state, the result state and the read-receipt state. The execution state belongs to that one handle:
`running`, `queued`, `stopping`, `stopped`, `stop-unconfirmed`, `ended`, `not running` or `unknown`. It says
`stopped` only when UnodeAi saw the task's process tree stop. A teammate that is busy with a later turn is shown as
`busy, not with this task`, never as this task running. Only a `ready` result comes with a `collect_ready_tasks`
action. For pending work, the PM is told to end its turn and wait for the host to wake it, rather than poll.

If a directed teammate or coordinator turn ends while its structured todo list still has unfinished work, the
host settles that turn as **partial**. The full report stays visible, and the unfinished activity is shown
separately. Partial is a final state for that turn, so waiting cards stop. It is never counted or shown as a
completed delivery, and a workflow pauses before its gate or next step.

OpenAI-compatible agents do not have a 12-step working limit. All of them, Solo included, share a 100-iteration
emergency backstop. Anti-spin still stops repeated identical calls earlier. If either limit is reached, UnodeAi
asks the model once more, with **no tools available**, for a decisive answer and a list of unchecked items.
The result starts with a `Stopped:` line written by the host. It is typed as partial, never as completed, and it
is never blamed on the worker. A coordinator should call `continue_task` with that handle, optionally with a
narrower focus. The exact same worker conversation then resumes, with everything it already read, a fresh
allowance and a newly admitted attempt grant. The expired attempt's permissions are never revived. A future
budget stop uses the same stopped state, but it makes no extra model request after the budget boundary.

### Task contracts and input resolution

Since 0.9.61 the model-visible `dispatch_task` path requires a versioned task contract. The PM proposes the
contract. The host validates and compiles it before it chooses an executor. A contract declares the objective
and deliverable, separate read files and write scope, the expected file effect, required capabilities, inputs,
constraints, upstream artifact dependencies and verification sensors. It also declares one execution strategy:

| Strategy | Behaviour |
|---|---|
| `delegate-preferred` | Prefer a qualified teammate. Use the coordinator only if it also passes the same gates |
| `delegate-required` | Refuse with `no-executor` when no teammate qualifies |
| `coordinator-only` | Keep an atomic task with the coordinator, after the same capability, scope, input, claim, and sensor checks |

The host builds the candidate set first. It then checks permissions, task scope, file claims, every required
input, artifact readiness, and whether the verification sensors can be reached. If an exact agent id fails, it
is never silently replaced. A role rotates only among candidates that passed every gate. Solo remains the
user's direct agent and is not an orchestration fallback.

Contract inputs are `contentAsset`, `workspacePath`, or `upstreamArtifact`. A workspace input says whether
the worker sees the current content or a snapshot taken at dispatch time. A grant is bound to one concrete
attempt, not to an agent or a timer. A retry receives a new attempt, and the old grant is already dead by then.
Inputs add no shell, write, network, or MCP permission. Existing workspace read permission is independent
unless an enforceable task scope explicitly narrows it. The worker receives a task card, not the PM's
conversation history.

**Evidence a reviewer can submit (0.9.94).** A reviewer that reads with `line_numbers: true` gets a short
receipt for what it was shown, such as `R1`. A search gives one such as `S1`, which names the folders it searched
and says whether it covered them. The reviewer can close its review citing those receipts. A finding it calls
`observed` or `source-traced` must cite lines it was shown. A finding it cannot cite is `inferred`. UnodeAi
checks each citation against what that same attempt was shown. It refuses a citation of lines the reviewer never
saw. UnodeAi, not the reviewer, then tells the coordinator one of two things: that the review's evidence was not
submitted, or that its citations were checked. "Citations checked" means that each cited receipt belongs to that
attempt and each cited line was displayed to the reviewer. It does not mean that a finding is right. The review's
overall coverage is shown as the reviewer reported it. UnodeAi does not confirm it. UnodeAi refuses `complete`
for a search that stopped early, and says when no search was cited. The record holds only counts. It is kept with
the run, so it is still there after a reload, and it is in the evidence pack. The portable export does not carry
it, and says so. A reviewer on the Codex route cannot submit evidence.

**A review of a file in your workspace (0.9.95).** A coordinator marks a task as a review by naming the input
that is reviewed. That input may be an upstream artifact, as before. It may also be one required workspace file,
which the reviewer reads where it stands (`workspacePath`, freshness `current`). Until 0.9.95 only an artifact
could be named. A review of a workspace file could therefore never be closed with evidence, whatever the reviewer
cited. A dispatch-time snapshot, an optional input and a content asset cannot be the reviewed input. They reach
the reviewer through tools that issue no receipt.

When the review is dispatched, UnodeAi notes what the file is. It closes the review only against that file:

- The reviewer reads it with `read_file` and `line_numbers: true`, and closes the review citing its receipts,
  such as `R1`.
- If the file was changed after dispatch, the close is refused: `review target changed; dispatch a new review`.
  This applies whoever changed it: the reviewer, you in an editor, or any other program. The coordinator is
  then told that the review's evidence was not submitted, whatever the reviewer's reply says.
- A review does not start when the file is missing, is a folder, lies outside the workspace or is larger than a
  read can display (10 MiB).

If your team has the rule that a reviewer must run on a different model from the author, a review of a
workspace file is not started. A workspace file has no recorded author to compare with.

The `line_numbers` option of `read_file` now tells an agent to cite receipts in `close_assignment` only where
that agent's tool list offers `close_assignment`. Before, every agent was told to, including agents that have
no such tool. On Claude CLI, the tool list is fixed when the agent starts. It offers the reviewer's close to
every agent except a coordinator, so those agents still see the sentence.

### Coordinator briefs and destination consent

A coordinator may attach one short `coordinator_brief` to a delegated assignment. The brief gives orientation that
the coordinator has already established, with `basisRefs` to declared inputs.
The worker sees it in the task card as a **coordinator claim,
not a host fact**. The worker must still report only what it observed. The host validates every referenced
input when it compiles the contract. It then checks again that the same inputs were actually granted to this
particular attempt. If a brief cites an input that was not granted, the dispatch is refused, the input is named,
and the worker never starts.

The brief travels in the worker's **prompt**, not through a read tool, so it can paraphrase documents you
supplied. The worker's resolved model destination may differ from the coordinator's. What happens then depends
on one setting: **Allow cross-provider dispatch without approval** (Settings → More, or
`unode.allowCrossProviderDispatchWithoutApproval`).

- **On — the default since 0.9.79.** The brief is sent without a pop-up. The UnodeAi output channel records the
  destination host, so a send that nobody clicked still leaves a trace.
- **Off.** UnodeAi shows a modal for every such dispatch and names the destination. **Send brief** starts the
  assignment. If you decline, the assignment is refused.

Either way, UnodeAi never asks when the resolved destination is the same as the coordinator's, and a destination
that cannot be resolved is refused. The setting lives only in your user settings. A workspace cannot change it.
UnodeAi compares privacy domains, not a provider label or a model id. When a privacy domain is unresolved, it
falls back to the canonical execution endpoint. It refuses the dispatch if either destination cannot be
resolved. The brief is kept only in the internal run record, for audit. It is left out of portable evidence and
of activity and conversation exports.

An upstream result can be reused only when its producer explicitly publishes an immutable `artifact-ready`
record. Settling a task is not enough. The artifact keeps the provenance of every input granted to its
producer. The host checks that chain before a coordinator may declare the artifact for a downstream task.

If a required input cannot be used, the worker calls `report_context_gap` with only the input id. The host
records `missing`, `expired`, `outside-task-scope`, or `unreadable` only when its own latest access observation
for that exact input and attempt proves the failure. A successful read clears an older failure. If material is readable
but falls short in substance, it is up to the worker to explain that in its result. The host does not label such
material unreadable. This task state stays separate from the framework delegation verdict.

**The input-substitution rule follows the contract.** If a task declares at least one required input, its card
tells the worker to report a gap instead of substituting web content for material the host could not supply.
A task that declares no required inputs is told that no input-substitution rule applies to it. That includes a
task that declares only optional inputs, because `optional` means the task can be completed without that input.
If a source really must be consulted, declare it required. The card neither grants nor removes web access.
That stays the agent's configured capability.

`inspect_task_status` is the coordinator's read-only view of its own handles. It combines durable history with
the live dispatch layer that the coordinator owns. It reports worker, wait, result, and read-receipt state
independently. It survives result collection and reload. It does not consume a mailbox entry, and it does not
message or wake a worker. It also does not conclude that a worker is alive just because a retained handle exists.

Internal run evidence keeps the complete compiled contract. It also keeps the input receipts, which hold only the
claims the host can prove: **supplied**, **reachable**, and **read receipt observed/not observed**. It never claims
that a worker did not read just because no receipt exists, and it never claims **understood**. Timeout and
late-terminal snapshots stay separate, so the historical timeout cannot freeze the current receipt view.
Portable evidence replaces input identities with ordinals that are local to the document. It leaves out the
objective, deliverable, purpose, constraints, paths, source ids, attempt ids, artifact handles, and provenance
identities. The artifact itself declares those omissions.

### After a restart: what an agent continues

**A request that never got an answer is not carried out again (0.9.95).** An agent's conversation with its model
is saved, so that an agent you restart, or a window you reload, continues where it left off. Until 0.9.95, if
that conversation ended on a request that the model had never answered, that request came back too. The model
then found two open requests, the old one and your next one, and carried out both.

Before UnodeAi hands a request to an agent, it now records that the agent has one. When it has seen the request
end, it records the end. What happens after a restart follows from that record:

| What happened to the earlier request | What the agent continues | What you see, once |
|---|---|---|
| It was answered | Everything | Nothing |
| The window closed or crashed while it was running | Everything before it | `Your earlier request was interrupted and was not resumed. Send it again if you still want it.` |
| It ended without an answer, as after a provider failure or an empty reply | Everything before it | `Your earlier request ended without an answer and was not resumed. Send it again if you still want it.` |

- The request stays in Chat as history. "Continue" does not resume it. Send it again if you still want it.
- This applies to OpenAI-compatible agents, whose conversation UnodeAi keeps. A Claude CLI agent starts every
  session fresh, and nothing changes for it.
- A Codex CLI agent's conversation is kept by Codex, and UnodeAi cannot look into it. If the window closed or
  crashed while its request was running, the agent starts a new Codex conversation and shows the first line.
  After a Stop it resumes its conversation as before.
- **Once, after the update to 0.9.95:** a Codex CLI agent with a conversation saved by an earlier version starts
  a new Codex conversation, because that version did not record whether the last request had finished. The
  messages in Chat stay. The line reads `This conversation was saved by an earlier version of UnodeAi, which did
  not record whether its last request had finished. The agent starts a new conversation; the messages above stay
  as history.` An OpenAI-compatible agent whose saved conversation ends on a request without an answer shows the
  second line of the table once.
- If UnodeAi cannot save the record that a request is starting, it does not send the request: `UnodeAi did not
  send this request: it could not save the record that the request was starting. Send it again.`
- The note telling the model that restored file contents may be out of date is no longer stored as one of your
  messages. It travels with your requests until the model has answered once.

### Delegation cards

**One card per request you made (0.9.88).** Every task that the coordinator dispatches while it works on one of
your requests joins that request's card. This includes dispatches from a turn that the coordinator started on
its own when a result came back. A new request gets a new card, even while a worker from the previous one is
still busy. Before 0.9.88 a live card could collect the work of several requests, and a reload split them
differently.

**A card sits where its request started, in every chat that shows it.** It follows the last message that came
before the request. The same cards therefore appear in the same places before and after
**Developer: Reload Window**. In a worker's chat that you open later, the cards sit between that worker's turns,
not after all of them. Names come back once the team has loaded. A card for an agent that has since been removed
from the team reads **Removed agent (xxxxxxxx)**, with the first characters of its id, instead of a bare id.

**The counts are of the work as it stands (0.9.95).** A card's line counts each task once:
`1 complete · 0 partial · 0 blocked`. Two kinds of attempt stay in the card as rows but are counted as
`N in history`, not as tasks: an attempt the coordinator superseded with a replacement, and an attempt UnodeAi
itself retried. Before 0.9.95 a superseded attempt kept the count it had when its result arrived. A card could
therefore keep showing a replaced attempt as done. The counts are the same before and after
**Developer: Reload Window**. An attempt the coordinator abandoned has no replacement, so it still counts, as
blocked.

If every file change that an attempt requested was refused, the attempt is counted as blocked. If it made some
of its changes and had others refused, it is counted as partial. This holds whatever its reply says. UnodeAi
reads this from its own tool results: a write that it refused and that the agent never made. A refused command
is not counted, because UnodeAi cannot tell whether a command would have changed a file.

**The Team panel shows what an agent is doing now.** A lost task that the coordinator has since superseded or
abandoned stays in its card. It no longer holds the agent's row at `Interrupted`. An interruption that nobody
has decided about still does, however old it is. It is work that waits for a decision.

### Delegation evidence

When a teammate replies, its task card and the PM's tool result start with a framework verdict, not with the
teammate's own “Done” text:

- **Task checks passed** — the host saw the checks declared for the task pass. Until 0.9.95 this label read
  **Verified**. That word now belongs to the Request summary alone, where it means a passed run of the
  project's verification command.
- **Tool activity recorded; delivery not checked** — the framework saw read or search activity, and no write
  was recorded. This is a mechanism record, not a claim that the reply delivered the requested result.
- **Replied, not verified** — CheckpointRecorder recorded file changes, but checks did not pass or did not
  run. The PM should run checks or send the task to review.

  **Since 0.9.70 this verdict rests only on what the extension observed.** Earlier versions also scanned
  the teammate's reply for English phrases that looked like a claim. The claim might be that checks had
  passed, or that no files changed. When the claim disagreed with the record, those versions recorded a
  mismatch. That reading worked only in English, so it could not see the same claim in another language. It
  could also mark an explicit denial as a false claim. That reading is gone, together with the two mismatch
  flags it set. Those flags no longer appear in portable evidence.
  **Reading the reply is your job and your PM's; the extension reports whether a
  check ran.**
- **No evidence** — the reply had no tool activity that the framework could see. It is not a completed task.
- **Timed out** — a blocking delegation's wait expired before a result arrived. Since 0.9.59 this is its own
  state with its own accounting. Before that, giving up waiting and a teammate that did nothing were reported
  the same way. That made a slow task look like an idle one.

The changed-file list comes from recorded checkpoints. The verification line comes from the commands and gates
that actually ran. Neither comes from the teammate's prose. This works for both OpenAI-compatible and Claude PM
delegation.

### Job outcome

**One card per finished team job (0.9.93).** A job is what a coordinator did for one of your requests, from its
first dispatch to its close. When the job closes, Chat shows a **Job outcome · Host-observed** card right after
the coordinator's final reply. It appears in the Chat sidebar and in the Workbench. The card is not a message.
It is never sent to a model, summarized, compacted or counted as tokens. It is not in an exported chat. Chat
stores only which job the card belongs to and which reply it follows. What the card says is read from the job's
record every time it is shown. A reload therefore shows the same card in the same place. A fact that arrives
late, such as a turn's spend, changes the card where it stands instead of adding a second one.

**The line.** Closed, the card is one line, for example
`Complete · Task checks passed · 1 file changed · 1/1 checks passed · $1.42 estimated · 40s`.
It names what is left over: `1 task unfinished`, or `1 dispatch refused by team policy`.

**Every figure is a host observation.** Nothing is taken from what an agent wrote. Showing or opening the card
runs nothing.

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
- `Task checks passed` appears only when the host saw a check declared for the task pass. If a job's tasks
  declared no check, the job reads `Checks not run` or `No applicable check`, whatever the agents wrote and
  whatever commands they ran. A command's exit status counts only where a task declared that command as its
  check, and a command UnodeAi refused never ran. A review that changes no file usually gets one of these two
  lines. Until 0.9.95 the card said `Verified` here. The checks a task declares are not the project's
  verification command. One of them can be as small as "a file change was recorded". That is why the card no
  longer uses the Request summary's word for them.
- If a task had a file change refused and never made it, the task is listed under **Remaining** as unfinished.
  The line then says `1 task unfinished`, whatever the task's reply says.
- `partial`, `not recorded` and `in conflict` beside a figure mean that the record behind it is incomplete, was
  never written, or disagrees with itself. The figure is then a lower bound or is left out. A missing price is
  `cost unavailable`, never `$0`.
- **Approvals: `None recorded`** means that no approval was recorded for this job. A consent dialog that is not
  an approval, such as the one for reading outside the workspace, is not counted there. When a turn of the job
  waited for a person, the section says so, and for how long.
- **Times** are in your local time, with the time zone named. Hover over a time to see the same instant in UTC.
  That is what an exported document shows.

**When a job ends.** A coordinator's closing reply ends its job once none of the job's tasks is still running.
If you stop the last running task of a job while the coordinator is idle, the job ends there. The card appears
under the coordinator's last reply in that job, as `Partial`. Its elapsed time is counted up to the moment you
stopped the task. You do not have to send another message.

**When you stop the coordinator itself (0.9.94).** If you stop a coordinator before it has replied in a job,
there is no reply for the card to follow. Once nothing in the job is still running, the job ends at the moment
you stopped the coordinator, as `Partial`. Its card appears under the stopped turn, in place of that turn's
Request summary. No later message is needed.

- **The stop takes the coordinator's tasks with it** on the OpenAI-compatible and Claude CLI routes. On those routes, a task
  the coordinator has handed out is cancelled, so the job ends when you stop the coordinator.
- **A task that keeps running keeps the job open.** The stopped turn's Request summary then says that the job is
  open. The job ends when that task is stopped or when the coordinator later closes it.
- **A task nobody took up is not a job.** A dispatch is recorded when the teammate takes the task up.
  If you stop a coordinator after it handed a task over, but before the teammate took it up, there is no job.
  The task is cancelled, and the stopped turn keeps its own Request summary, which begins with `Stopped`.

**Actions.** A card offers only what applies to its job.

- **Review changes** opens the Workbench with its change rail. The rail lists every recorded edit by the team,
  not only this job's edits. Its `×` or `Escape` closes it again.
- **Open evidence** opens the job's evidence report. It holds the same facts as the card, as a Markdown document.
  No check is run again.
- **Continue unfinished work** composes a new request from the recorded facts: who had each unfinished task,
  what UnodeAi recorded about it, and its handle. It shows you the text first, with **Not now** and **Start new
  request**. Nothing is resumed or retried automatically. While the coordinator is in a turn, the text goes into
  the message box and nothing is sent.
- **Change target** and **Reset counter** are the spend actions. Neither changes the job or its card.

**Jobs from before 0.9.93.** A job that closed before you installed this version has no card. A job that was
running during the update gets a card. Its timing says `since first dispatch` and its usage is `partial`,
because the start of the request was not recorded.

**If the job's record is gone.** UnodeAi keeps a limited number of runs. The run behind a card may no longer be
kept, or two copies of the card's position may disagree. In either case, the card says that its evidence is
unavailable and shows no figure.

### A coordinator's first action

**A coordinator that does nothing is stopped for you to decide (0.9.93).** When a coordinator receives a request
from you, it has to do one of three things first: dispatch a task, close the assignment, or reply. If it has
done none of them, and its model sends nothing for 60 seconds in a row, UnodeAi ends that attempt. It then shows
a **No first action within 60 seconds** card with **Retry same route**, **Switch route** and **Stop**. Nothing is
retried or switched for you. Time in which a tool runs or an approval waits for you is not counted. The limit
applies only before the first action, not to the work that follows.

**A dispatch to nobody is refused.** Along with your request, the coordinator receives the team's candidates.
These are the teammates it can dispatch to, which excludes itself and the Solo agent. If a dispatch's target
matches no teammate, the dispatch is refused, and the refusal gives the current references. The coordinator may
then look at the roster once more and dispatch to the exact id it shows. A coordinator that has no teammate to
dispatch to at all is not refused for that. It does the work itself where its strategy allows, as before.

**On the Claude CLI route** the coordinator's team tools are part of its first request, so it does not have to
search for them before it can dispatch. The managed-integrations and Skill-action bridges each have an endpoint
of their own.

### Closing an assignment the coordinator cannot finish

A coordinator states its own conclusion with **`close_assignment`**. The outcome may be one it is not
proud of:

| Outcome | Meaning |
|---|---|
| `complete` | Everything asked for was delivered. Refused while any settled delegation still has no recorded decision. Also refused while delegated work, including a rework, is still running. |
| `partial` | Some of it was delivered and some was not. Requires one entry per undelivered item, each with a concrete reason. |
| `blocked` | It cannot proceed as specified. Same per-item requirement. |

`partial` and `blocked` are **reportable outcomes, not failures to hide**. A coordinator handed an
impossible or under-specified job used to have no final state for it. The vocabulary covered only a result
returned by a delegate. The coordinator therefore just stopped. From your side, that could not be told apart
from a coordinator that quit thinking.

**If it ends its turn without recording a close, UnodeAi says what is still owed.** The line is labelled as
UnodeAi's, not the coordinator's: `UnodeAi: No assignment close was recorded; 1 delegation result still needs a
decision.` It names a decision that is waiting, a result the coordinator rejected or deferred, or a rework that
stopped. **It says nothing about checks or completion (0.9.95).** Until then, it could add "no observed passing
check" directly above a Job outcome that said the task's checks had passed. This happened because the two counted
different attempts. The line is written before the job closes and cannot see that card. The Job outcome alone
therefore now reports checks and completion. When every result that stands has been accepted, UnodeAi adds no line.

A superseded result and an attempt UnodeAi retried owe no decision, so neither holds back `complete`.

**A recorded close lasts until your next request.** That request begins a new assignment. The close
covers the results that had come back when it was recorded. Those results owe the new assignment no
decision, and they do not hold back its `complete`. Work still running at the close is not covered, and
neither is a rework asked for after the close. The new assignment carries them, and owes their results a
decision. Once the coordinator takes work on, or carries some, the line is owed again. The close stands
until your next request. A result that returns after the close adds no line to the coordinator's reply,
but it still needs a decision before `complete`. A request sent while no close is recorded continues the
same assignment. Before 0.9.95, a close stood for the rest of the coordinator's session, so after
one closed job the line never came again.

### The brake

**While anything is running, the status bar shows `⏹ Stop N`.** One click ends every running turn. It
appears only while agents are working, so it also tells you whether the crew is still going.

It does the same thing as `UnodeAi: Stop All Agents` in the Team panel's ⋯ menu. It ends turns. It is not a message
asking agents to stop, and it does not wait for them to reach a convenient point.

**An ended turn is not yet a stopped process.** Stop ends the turn at once. The task it was running loses its
permissions first, so a late tool call from that task is refused. Then UnodeAi stops the agent's whole process tree,
including a CLI that a launcher such as the npm `claude.cmd` started, and checks that each of those processes is
gone. A process that had already left that tree is outside what UnodeAi can see. So is everything an agent's CLI
started when the CLI itself had already ended before the Stop: that end says nothing about the processes it started,
so the stop is not confirmed. Until then the Team panel shows
the agent as **Stopping**. When UnodeAi cannot confirm the stop, the agent
shows **Stop unconfirmed** with the reason, and UnodeAi does not start that agent again on its own: a new message to
it is refused with that reason, so no second process runs beside one that may still be running. Close any process of
that agent that is left, then start or restart the agent yourself; it then starts.

**A crash is an unconfirmed stop too.** When an agent's Claude CLI or Codex App Server ends by itself, nothing watched
the processes it had started end. The agent shows **Stop unconfirmed** (`it ended by itself, and the processes it had
started were not seen to end`), and so does the task it was running in `inspect_task_status`. UnodeAi does not
restart it, even when the agent is set to restart after a crash, and a new message to it is refused as above. Start
the agent yourself to go on.

### Stopping work a coordinator started

**A broadcast is a message, not a brake.** `broadcast` and `send_message` hand something to a teammate. A
teammate that is already mid-turn finishes that turn. Asking a coordinator to "stop everything" used to get a
broadcast, an assurance, and no stop. The means to cancel existed for the Stop button, but nothing the
coordinator could call reached it.

`cancel_task` reaches it. `cancel_task({ all: true })` stops every assignment that the coordinator still has
running. `cancel_task({ handle })` stops one. The cancellation is recorded on the run, not inferred.

**A handle stops only its own task.** `cancel_task({ handle })` stops that task's turn, or removes it from the
teammate's queue if it has not started. A later turn of the same teammate, such as a new request of yours, is not
stopped. When UnodeAi finds no running or queued instance of that task, the reply says so and nothing is stopped.
The handle keeps working after the task's wait timed out, and after the coordinator's tools were rebuilt. The reply
says what UnodeAi saw of the stop; `inspect_task_status` shows when it is confirmed.

**A stopped task makes its job partial (0.9.93).** A task that you or the coordinator stopped did not finish.
The job it belongs to therefore closes as `Partial`, and the job's [Job outcome](#job-outcome) card lists the task
under **Remaining**. If stopping it leaves nothing running and the coordinator is idle, the job closes at that
moment.

**`agent` stops the teammate, not just an assignment.** `cancel_task({ agent })` ends that teammate's turn,
whatever started it: a dispatch, a broadcast, a `send_message`, or a forwarded rework note. It does what the
status-bar brake does, but the coordinator asks for it instead of you.

A coordinator that can start work but not stop it is not a coordinator. Its authority therefore does not depend
on how the work happened to begin. It cannot stop itself. Ending the turn that is trying to stop the team would
be the one call that guarantees nothing gets stopped.

If the worker or the extension host disappears before a final reply, the saved Activity row becomes
**Interrupted — no active worker**. The row shows `worker-lost` or `host-restarted`, a last-observed time and a
separate detected time, and any later disposition. This state is final. Its timer stops, and it no longer counts
as active. `cancel_task` is idempotent for that handle. Calling it more than once has the same effect as calling it once.
For the interrupted task you have two choices, and the interrupted state stays visible beside either one:

- To leave the task closed, record `abandoned` with a concrete reason.
- To replace it, dispatch replacement work with `replaces_handle` and `replacement_reason`. When the replacement
  is admitted, UnodeAi writes the new handle and the original task's `superseded` link together, in one atomic
  step.

**The coordinator's chat says so (0.9.89).** An interrupted task also adds one line at the end of the
coordinator's chat: *UnodeAi: Frontend Engineer's task was interrupted: its session stopped before it reported a
result. Ask the PM to redo it with replaces_handle, or record it abandoned.* The line appears once per task. It
is also shown after a reload, and it is not sent to the model. A task you stopped with **Stop** is cancelled, not
interrupted, and gets no such line.

**A run whose unfinished work was stopped, replaced or abandoned closes once, as partial (0.9.88).** Before, such a
run stayed open forever, because the redo belongs to a new run. This happened in two cases:

- A task you stopped with **Stop**. It becomes *cancelled*. A cancelled task cannot be replaced, so the
  coordinator dispatches the redo as new work.
- An interrupted task that was replaced from your next message.

Now the run closes when all of these are true:

- Nothing in the run is still working.
- Every interrupted task is superseded or abandoned.
- The coordinator has moved on. It ended its turn elsewhere, or it dispatched in a newer run from this window.

The run's closing summary says **Closed by UnodeAi**. It also says that no closing summary from the coordinator
was observed on that run. Such a run is never recorded as complete, and it never counts as your acceptance of the
work. A run whose tasks all finished normally still waits for its coordinator's own closing summary. A run merged
in from another window's history does not close yours. The run's delegation card shows **run partial** as soon as
it closes, without a reload.

### Long tasks delivered in batches

**A long deliverable can arrive section by section.** When a task's deliverable is long, for example an article of
more than about 3,000 words, the coordinator can dispatch it with `delivery: { mode: "incremental", sections: [...] }`
in the task contract. You can ask for it too: tell the coordinator to deliver a task in batches. The coordinator
decides when it dispatches; no extra model call decides whether a task is long. The worker's task card lists the
expected sections in order and the per-batch target, and the worker saves each completed section with
`save_task_checkpoint`. This works on OpenAI-compatible, Claude and Codex agents alike. A task without `delivery`
returns one final reply, as before, and is not offered the tool. A Codex conversation that started before this
version cannot be given the tool (App Server fixes a conversation's tools when it starts): such a task is told that
it cannot save batches there and delivers in its reply; a new conversation for that agent offers the tool.

**A saved batch is on disk before it is confirmed.** UnodeAi writes the batch and flushes it to disk, then answers
with its checkpoint id, size, SHA-256 and revision. A write that fails confirms nothing and says so. Sending the
same batch again returns the same receipt; another text under a batch number already saved is refused. A section
is revised only by saving it again with the next revision and the id of the batch it replaces. A batch can hold at
most 256 KiB of text.

**A batch is partial work, not the result.** It grants no permission: no file, command or network access. It
extends no wait, budget or deadline, and it never wakes the coordinator or starts a turn. The task still ends with
its own result. That result, a stop and `inspect_task_status` name the saved batches: how many, which
sections they cover, which remain, when the last was saved, and the host's final check. The final check is complete
only when every expected section is saved, no two batches claim the same section revision, and every required input
was observed read. It checks that the set is whole, not what it says.

**When a batch is due.** While the task runs, UnodeAi counts the generated tokens the provider reported for it and
its working time. A batch is due after 8,000 generated tokens, or two minutes of working time, since the last saved
batch; after four minutes with no saved batch at all, the task shows **no recoverable work product yet**. Input and
cache tokens are not generated tokens, and a repeated usage report is not counted twice. The reasoning share is
shown apart, where the provider reports one. When the counts arrive depends on the connection: an
OpenAI-compatible response and a Claude message report their output when they end, Codex when App Server reports
its thread usage. A long reasoning step without text therefore reports nothing until it ends, and meanwhile only the
time applies. Time waiting for your approval is not working time and is shown separately. Where a connection gives no live count, the count shows as **unavailable** and only the time applies;
UnodeAi never derives a live count from a turn's final total. The worker is reminded once per due period, on the
result of the next tool UnodeAi serves it. Nothing is cut, resent or stopped: you can wait, or press Stop.

**A Stop wins, and a stopped task's draft is yours.** A Stop ends the task's permissions first (see
[The brake](#the-brake)): a batch that arrives after it is refused, also one that was being written when the Stop
came. The batches confirmed before the Stop are kept as the stopped task's draft. The coordinator is told they exist
but is not given them. Run `UnodeAi: Saved Task Batches…`, pick the task, and choose **Open as an unsaved document**:
the latest revision of each section opens in an editor, with the task's state and final check at the top. Nothing is
sent anywhere, resumed or run again. A task whose result windows closed while it still ran can save no further
batch either; what it saved before stays readable for the coordinator.

**Using partial work in a later task.** The coordinator reads its own task's batches with `read_saved_batches`.
With `as_task_input: true` it publishes them as an artifact that a later contract can declare. That artifact keeps
the source task's input provenance, can be declared only by the same coordinator, and is shown on the next task's
card as partial work, marked incomplete when the final check is. It grants the next task nothing else.

**Where saved batches are kept.** On this machine only, in this workspace's own extension storage: not in the
project, not synced, not sent anywhere. They contain the task's text, so treat them as work product. Limits: 2 MiB
per task and 16 MiB per workspace. When a limit is reached the new batch is refused and every saved batch is kept.
A running task's batches are never removed. A task's batches are kept for 30 days after it ended, and you can delete
them earlier with `UnodeAi: Saved Task Batches…`. A deleted or expired task is listed as no longer available, never
as saved.

### Coordinator dispositions

Once the coordinator has actually decided whether to rely on a settled delegated result, it may record a
disposition. A result that arrives does not need a label. Forcing one for every delegation would turn a decision
into a formality. On the other hand, the coordinator gets a prompt with the result it is already collecting. The
recorded decision can therefore be observed, rather than being a decorative tool the coordinator never sees.

0.9.47 shipped three dispositions. One round of real use produced **nine distinguishable settled-result
outcomes**. 0.9.48 therefore records all nine, rather than forcing each into the nearest of the three. v0.9.80
adds `abandoned`, for interrupted work only:

| Disposition | Meaning | Reason required |
|---|---|---|
| `accepted` | The coordinator relies on the result | — |
| `accepted-with-caveat` | Relied on, with a limitation worth carrying forward | yes |
| `accepted-after-rework` | Relied on after the delegate corrected it | — |
| `accepted-despite-framework-no-evidence` | Relied on although the framework observed no evidence. Both the decision and the verdict are kept | — |
| `rejected` | Not relied on | yes |
| `needs-rework` | Sent back to the **same** delegate to correct | yes |
| `superseded` | Overtaken by later work | yes |
| `abandoned` | Interrupted work deliberately left without a replacement | yes |
| `deferred` | Decision postponed deliberately | yes |
| `needs-human` | Handed to a person | yes |

`needs-rework` is a state of its own, not a flag on `rejected`. `rejected` says the coordinator will not
rely on the result. `needs-rework` says the loop continues, and its required reason goes back to the
delegate. Merging the two would hide whether the work is still moving.

The delegate's reply to a rework request wakes an idle PM. The PM reviews the reply and reports to you. The reply
is a new result. The `needs-rework` that asked for it is not a decision on it. The reply therefore needs a decision
of its own, such as `accepted-after-rework`, before the PM can close as `complete` (0.9.95). To stop a PM and a
delegate from bouncing the same task back and forth unattended, UnodeAi sends at most **2 rework
requests per task after your last message**. A third request is recorded but not sent, and the chat says so: "The
PM has asked 〈agent〉 to rework this task 3 times. Automatic rework stopped; accept the result, or ask the PM for
another round." Your next message to the PM allows further rounds.

Where a reason is required, it must be concrete. A rejection forwards that reason to the delegate. The earlier
framework verdict is also visibly amended in the Workbench transcript, Activity, and the Team card. It is never
silently rewritten. This records an explicit decision by the coordinator. It does not ask an LLM to judge whether
prose "really delivered" the work, and it never infers a disposition from the reply.

**A decision is recorded about a task that has ended.** A task whose wait timed out but which is still running
takes no disposition: `deferred` on it would show running work as settled. The coordinator is told to stop it with
`cancel_task` or to wait for its result. A task cancelled after its wait timed out keeps the timeout as its result
and takes a disposition, as before. That holds after the coordinator's tools were rebuilt too, for example after
its backend restarted: the decision is checked against the recorded task, not against the tools' memory. A task
cancelled before any result takes none. A decision never changes the timeout verdict it was made about.

**A refused dispatch is a receipt, not a disposition.** When a coordinator declines to send work at all, there is
no result to assess. There is nothing a disposition could honestly attach to. The refusal is kept as a separate
`rejected-at-dispatch` record, with its reason and time. The metrics report dispatch attempts, work actually
dispatched, and refusals separately. This keeps a record of the coordination effort without pretending that a
result was reviewed.

`delegation_metrics` reports these counts for the current coordinator session:

- completed tasks
- tasks the coordinator explicitly accepted
- green framework verdicts that were later rejected
- explicit requests for human intervention

0.9.48 adds the **other direction**: how often a `no-evidence` or `replied-not-verified` result was
nevertheless accepted. The framework already counted over-crediting, but it could not see under-crediting. A
correct answer built from context already on screen therefore looked identical to the answer of a worker that
guessed. UnodeAi does not resolve that difference. From the evidence kept here, the two cannot be told apart
mechanically. Reading the prose to tell them apart is exactly the self-grading this design rules out. UnodeAi
counts how often the distinction mattered, instead of inventing a story about why the trace was empty.
**Coordinator-accepted is still not enterprise/customer acceptance.** The coordinator is an agent, and this
counter measures agent decisions. Since 0.9.59 a separate human verdict does exist (see **Reviewing
delivered work** below). The two are never merged. No coordinator disposition is ever counted as a
person's answer.

### Keeping role guidance current

Default role instructions update along with UnodeAi. An agent that still follows its role template gets the
latest guidance the next time it starts. If you customize an agent's instructions, UnodeAi keeps them exactly as
they are. The Agent Builder shows whether your customization is based on the current default. When the default
changes, it shows a diff between the two default versions. You can then keep yours, reset to the new template
(with Undo), or merge the changes by hand.

### Dispatch-time overlap notice

When an async dispatch overlaps work that is already in progress, the framework names that work's handle, owner, and task at the moment of the dispatch decision. Cancelling a stopped worker frees a live dispatch slot, so the next dispatch can go ahead.

### PDF links and temporary content

When an agent uses `fetch_url` on a public PDF, the download still goes through the same public-web approval
and SSRF checks as any other URL. A PDF is accepted only after its `%PDF-` magic bytes match. It is stored in a
temporary directory that the extension owns, under an opaque id such as `content-1`. It is not added to chat
history or to saved workspace state. The fetch result is a receipt. Use `read_extracted_content` to read a stated
page range, or `search_extracted_content` to search a stated range. Both report the pages requested or searched
and the document's total page count. A result for pages 1–5 of 42 is therefore never a claim that the document
was read.

**You can also attach a local PDF.** It goes through the same steps: the same `%PDF-` signature check, the same
10 MB limit, the same opaque id, and the same page-scoped read and search tools. Its filename is shown to you, but
the filename is never sent to the model, written to chat history, or exported in evidence. Local PDF attachments need an
OpenAI-compatible agent. The Claude CLI and Codex CLI runners refuse the turn and say so, rather than quietly
dropping the file.

Native text PDFs are supported. A scanned page is reported as **OCR required / unavailable**, not as read.
Encrypted, corrupt, over-large, over-long, and expired assets fail closed.

### Attachments on a Codex agent

A Codex agent receives the text files and images you attach in the composer. A text file goes into the turn's
text in the same block, and with the same 120,000-character cut, as on the other routes. An image goes to Codex
App Server as an image input that carries the image's own bytes. UnodeAi does not resize or convert it.

**An image is sent only to a model that accepts images.** When the agent starts, UnodeAi reads the model list of
Codex App Server. The turn is refused before anything is sent when that list does not show that the thread's
model accepts images, or when App Server names no model for the thread. The reply says so. Remove the image, or
choose a Codex model that accepts images. A PDF is refused as before, and so is any other kind of attachment.

**A teammate gets a forwarded source in its turn.** Codex has no UnodeAi content reader. When a coordinator
forwards one of your sources to a Codex teammate, UnodeAi puts the source into that teammate's turn: text as text,
an image as an image input. It applies the same grant check as the reader tools on the other routes, at the moment
the turn is sent. A source is not sent, and the turn names it as not delivered, when:

- the assignment does not grant it, or its grant was withdrawn, for example because the coordinator's task
  attempt ended;
- UnodeAi no longer holds it;
- it is a PDF, or an image for a model that does not accept images;
- it would take the forwarded text in one turn past 200,000 characters. It is not cut short.

The turn's receipt lists a forwarded source only once App Server has accepted the turn that carries it.

Until 0.9.96, a Codex agent received neither text files nor images, while its **Attached context** line listed
them.

### Sending a stored image to a vision model

A picture you attach in the composer reaches a vision-capable model as it always has. This section is about
the other case: an image that an **agent** downloaded with `fetch_url`. Such an image is held as a temporary
asset, like a PDF, and by default it is not sent anywhere.

To use it, the agent must call `send_image_asset_to_model`, and two things must then be true:

1. **The exact route must be known to support vision.** If the connection, model and endpoint you are using
   have never declared vision support, the image is *omitted* rather than tried. Unknown is not treated as yes.
2. **You approve a separate upload prompt**. It names the media class, the provider, the host, the byte count,
   and the estimated input cost if the route publishes one.

**Approving a download is not approving an upload**, and neither is the ordinary model-egress approval you
gave for that host. The grant is remembered per host *and* per purpose. Allowing vision on a host therefore
never allows transcription on it. Revoke either one from the Security panel.

An approved image is sent with **one** request and then dropped. It is dropped even when that request fails or
you cancel it. A later turn therefore cannot resend the image without asking again. If the provider rejects it,
UnodeAi records that for that route only and keeps vision available elsewhere. It also tells the model that the
image was omitted, so a text-only answer is never presented as analysis.

**Video is unsupported in this release.** `fetch_url` refuses video before reading it. No decoder, native
module, or downloaded runtime ships in the extension. Every candidate was measured and rejected, so that the
extension does not ship a hidden system dependency.

If you export Portable Run Evidence after a PDF is consulted, the export carries only a document-local content
ordinal, the PDF/read/search outcome, the extraction state, page coverage, truncation, and the OCR state. It
never exports the link, the query, the attachment name, the temporary path, the extracted text, or the PDF bytes.

### Attachments in your message

A file you attach is shown as a chip in your message: an image by the small preview made when you attached it, a
text file as `TXT`. The conversation keeps only that preview, never the image, so the chip still shows it after a
reload; an image whose preview could not be made reads `IMG`. Until 0.9.96 an image read `TXT` once it was sent. A
PDF you attach is not kept in the conversation.

### Saving a file you attached

Ask an agent to save a file you attached, for example "save the logo as `assets/logo.png`". The agent calls
`save_attachment` with the attachment's id and a path in its writable folders, and UnodeAi writes **exactly the
bytes you attached**: nothing is converted, resized or re-encoded, and nothing is downloaded in its place.

- **What can be saved.** A PNG image as `.png`, a JPEG image as `.jpg` or `.jpeg`, a PDF as `.pdf`, and a text file
  you attached under a text extension: `.txt`, `.md`, `.markdown`, `.csv`, `.tsv`, `.json`, `.yaml`, `.yml`,
  `.xml`, `.html`, `.htm`, `.css`, `.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.jsx`, `.py`, `.sh`, `.ps1`, `.sql`,
  `.toml`, `.ini` or `.log`. The type is read from the file's bytes, not from its name. A destination whose
  extension does not match, or that has none, is refused. GIF and WebP images are not saved. A text file is saved
  with its original bytes: a byte-order mark, CRLF line endings, or an encoding other than UTF-8 stay as they were,
  even though the model sees the text the way it did before. A "text" file whose bytes are an image, an archive or
  a program is refused.
- **Only what you attached.** Only a file you attached to this request can be saved, and only by the agent it was
  given to. A teammate can save it only when the coordinator handed it on with the task. A page or image an agent
  downloaded, and text passed between agents, are never saved this way.
- **For 30 minutes.** UnodeAi keeps an attachment for 30 minutes after you attached it. Saving it does not extend
  that. After that, the agent asks you to attach the file again.
- **The same checks as any write.** Your `unode.writeApproval` setting applies. The card shows the destination, the
  type read from the bytes, the size, the SHA-256 and whether it replaces a file. Replacing a file UnodeAi cannot
  vouch for asks you once, as in [Work that is not the agent's](#work-that-is-not-the-agents), and the file's exact
  bytes are kept as a restore point before it is replaced; when they cannot be kept, nothing is replaced. If Workspace
  Trust is lost, the agent stops, the attachment expires or stops being given to the agent, or the destination
  changes while the card is open, nothing is written.
- **The card waits for you.** It stays open for up to 15 minutes, on every route. When the agent's call ends before
  you answer (you stop the agent, or the agent gives up), the card closes, and a late Approve writes nothing.
- **What the result says.** The agent is told the path, the byte count and the SHA-256 that UnodeAi read back from
  the saved file, whether it created or replaced a file, and the restore point of a replaced file. You can compare
  that SHA-256 with your original. When the saved file cannot be confirmed, the agent is told so, and nothing reports
  it saved.
- **Every route.** An agent that may write has the tool: an OpenAI-compatible agent directly, a Claude agent through
  UnodeAi's file tools, a Codex agent as a UnodeAi tool. It is refused in Plan mode, and a coordinator with teammates saves only
  under a task contract that selects it, as for any write. Claude and Codex agents still do not receive a PDF
  attached to their own message; they can save a PDF a coordinator hands them. For a Codex agent that may write,
  the first turn of an existing conversation after this update starts a fresh Codex thread, because Codex cannot
  add a tool to a thread it resumes; the earlier messages stay in the chat.

### Temporary task scope

**A scope may name one file (0.9.95).** An entry in a temporary task scope, or in an agent's Folder Access, may
name one existing file instead of a folder. The entry then grants exactly that file. The agent can read it. With
Read+Write, the agent can also overwrite, edit, patch and delete it. Nothing beside it, above it or below it is
granted. The entry cannot be used to create another file. Until 0.9.95, such an entry was accepted but then
refused every write, because the file was treated as a folder.

- A scope that grants files and no writable folder has no command tool. A command needs a folder to run in. If
  the task needs one, the coordinator can add a Read+Write folder to the scope.
- Listing, searching and deleting a folder work on folders only. A file entry opens none of them.
- If a link on the granted path is changed after the scope was admitted, the file is refused.
- In a writable folder too, UnodeAi's file tools do not write, edit or delete through a symbolic link whose
  target does not exist. Such a write would create a file wherever the link points. If the link points out of
  the writable folder it is in, it is refused as a link that leads out of that folder. Any other such link
  fails with `is a link whose
  target does not exist`. Remove the link, or have the agent name the real path.
- In an untrusted workspace, a file entry is read-only, just as a folder entry is.
- A path that does not exist is refused when the task is dispatched: `Path does not exist`.
- Exact-file entries are enforced by UnodeAi's own file tools, which OpenAI-compatible agents use. A Claude CLI
  or Codex CLI agent works in whole folders with its CLI's tools. A file entry in its Folder Access is therefore
  not given to it. An agent whose Folder Access names files only is not started and says why.

A coordinator can attach a temporary folder scope to one `dispatch_task` assignment. The scope applies to that assignment only and does not change the agent's saved configuration. The host intersects the scope with the agent's configured Folder Access. The scope therefore only narrows the grant and never widens it. A read-only assignment removes the write and shell tools. The delegation card shows the temporary scope while it is active, and marks it as ended afterwards. A backend that cannot enforce this turn-local boundary refuses the scoped assignment. It returns a reason rather than pretending that the scope was applied. A requested file may be inside the configured folders but outside this temporary assignment. In that case the host returns a bounded task-scope refusal. The agent can then continue with another granted action, or report the gap in its context. A path outside the configured folders remains terminal and requires the user to open the correct project.

**The boundary has not relaxed.** No path that was refused before is now readable or writable. Only a typed
`WorkspaceEscapeError` from a real configured-workspace path proof ends the turn. A shell command whose text
*looks* as if it goes outside the root is still blocked and never runs. That detector is a heuristic, not a proof
from the filesystem, so the agent can try another safe action. An expired, unsupported, or unforwarded temporary
asset is also still refused as unavailable. It cannot be recovered or sent, but it does not end useful work.

### Activity export truncation

An Activity export keeps a display window of 300 items over the coordination stream. When events older than that window are left out, the export says so and gives the number left out. It does not silently look complete.

### Reviewing delivered work (a human verdict)

A coordinator's `accepted` is an agent's opinion about a teammate's result. It has never meant that a person
looked at the work. `UnodeAi: Review Delivered Work` is where a person says so.

Pick a finished run (or open it from the run itself). UnodeAi shows that run's evidence: what was
dispatched, what settled, and what the framework observed. It then asks for one of three answers:

| Verdict | What it records |
| --- | --- |
| **Accept delivered work** | A human acceptance of this run |
| **Accept with exceptions** | Acceptance, plus the items you name as still open. At least one is required |
| **Reject delivered work** | A human rejection. This is a real measured outcome, not a failure of the tool |

**A run nobody judged reports `unjudged`, never `accepted`.** Nothing in the product turns any of these into a
human verdict: a coordinator's disposition, a green `verified` framework outcome, a closed run, or your silence.
If you dismiss the picker, the run stays unjudged. That is a truthful state, not a missing one.

A run whose delegated work is still active cannot be judged. UnodeAi says so and leaves the run unjudged until
the work settles. Verdicts are append-only. If you judge a run again, UnodeAi records the new answer and the run
reports the latest one. The earlier verdict stays readable. Runs from before 0.9.59 load as unjudged.

A verdict requires a contemporaneous approver, that is, a person who answers at the time. UnodeAi already applies
the same rule to command and write approvals. An exercised grant or an expired prompt cannot stand in for a
person.

In an exported **portable** evidence artifact, the verdict is carried as three things: the verdict itself, a
**count** of unresolved items, and a document-local approver ordinal. The text you typed for those items does
not leave, and neither does any approver identity.

### Run evidence packs

The Activity window is not a work boundary. A run begins at a coordinator's first real delegation. It closes
only after every delegation has settled and that coordinator then gives a closing summary on the run's own
host-observed correlation. A coordinator that has not finished therefore leaves an explicitly open run across
extension-host restarts.

Messages, context receipts, and permission events without that correlation are deliberately left out. This can
leave out coordinator narration that is not threaded to the run, but it prevents a reused PM or worker from being
attributed to the wrong run.

Use **UnodeAi: Export… → Run evidence pack** to choose one run and write a standalone Markdown artifact. It
records mechanically observed dispatches/refusals, framework verdicts, append-only coordinator dispositions,
exercised approvals and grants, and context-source labels. It also derives dispatch, settlement, refusal, and
disposition counts from those records, without reconstructing chat history. That proves the product can supply
Job B's numbers for a run. It does not replace the later real-round reading of which numbers people still needed
to obtain by hand.

The pack says whether any of that run's activity was omitted. It keeps coordinator acceptance apart from
human/customer acceptance, and it never asks a model to judge correctness. Raw approved commands, context
contents, and credential values are excluded.

**UnodeAi: Export… → Portable run evidence** writes the same run as JSON, built for a reader outside your
organisation. The evidence pack above is an internal record. It keeps your objective and every task instruction,
and the only redaction is by credential pattern-matching. The portable artifact inverts the rule — **no
prose: nothing you or a model composed as text.** It has no objective, no instruction, no permission label, no
verification command line, no agent reference a model typed, and no file contents. **Agents appear as `agent-1`,
`agent-2`**, never under the names you gave them, because a name can identify a client or a deal. A role is
carried only when it is one of the shipped role names.

The current schema is **`portable-run-evidence/5`** (0.9.93). It adds two fields to a delegation that is a host
retry of an earlier attempt: `retryOfHandle`, which names the attempt it retries, and `retryStage`. A link that
failed a rule is not carried, and the file's `omitted` section says that a link was left out. Like `/4`, the
schema:

- distinguishes a run that closed as complete from one that closed as partial
- carries each delegation's independent completion state
- counts terminal interrupted work separately
- names the sensor-bounded input field `readReceipt: observed | not-observed`

Software that reads `/4` must treat `/5` as a schema upgrade. It must not assume that the added fields exist
under the old version.

**Identifying content it does keep is stated too.** The workspace-relative paths of changed files are the
evidence. A count with a file extension is not something a reviewer can review. Timestamps disclose when the work
was done. Every one of them is in UTC, and since 0.9.93 the `retained` section says so. Complete change sets also
carry the hashes described below. All of these are listed in the file's own `retained` section. They are listed
because "no prose" is a strong claim, strong enough to stop you from checking the file before you attach it.

**Approver and route identity are bounded at export.** A contemporaneous human command, write, tool,
or web decision is kept exactly in the internal ledger. In portable JSON, it becomes a document-local
`approver-1`. An exercised MCP grant is not a new decision, and it carries no approver. An expired
prompt does not invent one. Built-in destinations are kept only when their route kind and canonical endpoint
match the builder's closed table. A custom connection becomes `custom-gateway`, and its private hostname is
withheld. Only its bounded privacy state (`known`, `unknown`, or `unresolved-user-selected`) leaves.

**A complete change set can carry a write-time digest, never a diff.** For each file change that was observed
successfully, the ledger immediately hashes the first before-state and the latest after-state. It then computes a
deterministic SHA-256 root over those relative paths and hashes. It never keeps the source bytes. The portable
builder checks the path set, checks every hash, and recomputes the root. Historical runs, unrecorded writes,
recursive directory deletion, and writes whose content could not be fully observed get no guessed value. They
keep an accurate declaration that `delegation.diffDigest` is unavailable. Hashes reveal whether two pieces of content
are identical, and they let someone confirm a guess. The artifact therefore lists them in `retained` too.

A path is kept only when every segment of it is plainly relative. Any other path is dropped and *counted*. The
artifact tells the reader how many paths it could not carry, rather than inventing a rewritten one. What it
withheld is listed too, separately from what was simply never recorded. An absence you cannot see is an absence
you cannot audit.

**UnodeAi: Export… → Evidence report**, **UnodeAi: Generate Evidence Report** and **Open evidence** on a
[Job outcome](#job-outcome) card all write the same document (0.9.93). It holds the outcome of one finished job,
with the facts that its card shows. You choose the job. If there is no finished job, the command says so and
writes nothing. Writing the report runs no check and reads no file in the workspace. Before 0.9.93, this command
ran the workspace's verify command and listed recently changed files. It no longer does either.

**Every exported document says that its times are UTC (0.9.93).** UnodeAi records every time in UTC. The evidence
report, the run evidence pack and the worker progress report say so before their first timestamp. They also mark
their own times `(UTC)`. A report written on the evening of 4 October in California is dated 5 October. That is
the UTC date, not an error. Chat shows local time, with the time zone.

Use **UnodeAi: Export… → Worker progress distribution** for the Phase A cross-run report. It splits long worker
tasks by framework-observed evidence. It then shows no-material-progress quantiles and buckets, rather than a
mean. It does not judge whether worker prose is useful, and it does not enforce a timeout.

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

Conditional workflow branches use a closed set of labels that the step declares. The agent that completes the
step selects one exact label through the structured `select_workflow_branch` action. UnodeAi does not search the
agent's reply for a matching phrase. If no label is selected, the workflow continues linearly.

Workflows saved before 0.9.70 are migrated when the team file loads, and the file still loads. A branch whose
old condition was a substring becomes that exact label. The agent must now select it by name. A branch that had
**no** condition used to mean "always". It is kept as a **fallback**, taken only when no declared label matched.
A fallback is never offered to the agent as a choice, so it cannot be picked over a real outcome. Each migration
is reported in the team file's validation warnings, and re-saving from the Workflow Editor preserves it.

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
built yourself. A template-based agent says which template it came from and whether its instructions still match.
An older Agent without origin metadata says *origin not recorded*. **Open in Agent Builder** edits that Agent.

An active Integration states its authoritative source, maintenance state, exact package/image/endpoint identity,
verification date, transport, prerequisites and credential-variable names. The host derives the approval label
from what the configuration actually does. The catalog cannot weaken it. `listed`, `configured`, `approved`,
`mounted`, `exercised`, and `succeeded` are separate states. **Check setup** reports the current states without
configuring, approving, mounting, exercising, or granting the Integration. By default, its answer is a modal
dialog with the editor's single **OK**, like other notices that directly answer a command or a click. To keep
those results in the corner instead, enable **Show results as quiet corner notifications** under Settings → More.
This user-only choice never changes approval, consent, or action-button dialogs. Background notices remain toasts.

Adding a Role Template or importing a team never configures or grants an Integration. Suggested Integrations
are labels only. To give an Agent an MCP server, grant it explicitly in Agent Builder.

**Members come equipped.** Default software roles carry mapped skill **playbooks**. For example, Security carries OWASP Top 10, secrets scanning, and authorization review. The backend loads skills progressively. When a skill is needed, the backend loads it only if it is authorized. Full procedures are not copied into the standing prompt.

Skill descriptions may be written in any language. The host checks structural facts such as length and
reserved names, but does not require English keywords or a particular whitespace/token shape.

Every role also starts with the **Using Superpowers** meta-skill. It prompts the agent to check its authorized skills and load the most relevant one before acting. It is guidance only. It does not change any agent's tool permissions.

The active Integration catalog lives in `marketplace/mcp.json`. Role cards are built directly from
`ROLE_TEMPLATES`. `marketplace/agents.json` remains only as a compatibility-reconciliation fixture for its former
13 listings. Catalog validation rejects any active entry that is archived, deprecated, stale, without provenance,
or mismatched in identity.

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

- **Built-in protections** are host enforcement that the panel only displays. They have no toggles.
- **Team policy** is host enforcement that a person selects. The first policy is off by default. It requires a
  different **reported model identity** for an explicitly marked artifact review. This comparison does not prove
  that different underlying models answered, or that a review was good.
- **Guidance** is advisory Markdown in `.unode/rules.md`. Agents interpret it. It cannot grant permissions, and
  it cannot change built-in protections or team policy.

For compatibility with other coding agents, UnodeAi reads the root-level `AGENTS.md` and `CLAUDE.md` along with
`.unode/rules.md`, in that fixed order. The most specific source stays last. Each turn gets a compact index of
headings and excerpts, not those files in full. When a source is relevant, the agent loads the full source with
the existing `read_file` tool, which is confined to the root, before relying on it. The authority and precedence
have not changed. Identical content is indexed once. The index also says when a file would have reached the
12,000-byte per-file cap under the original full-prompt admission.

Structured Markdown under `docs/` is handled the same way. The turn gets a deterministic index of files and
headings, not the full text of every document. A relevant document is still available on demand through
`read_file`. This can mean that an agent makes an extra read. Do not assume that a smaller standing prompt lowers
the total cost of a task. Repository instructions and docs can guide behaviour, but they cannot grant commands,
MCP servers, network destinations, or a write scope.

When you create, switch, add, remove, or reconfigure a role, UnodeAi maintains one generated roster block
inside this file. The block names each active role with one short responsibility. This gives every agent a
current picture of the team, without paying for biographies on each turn. The block has visible
`unode:team-roster` markers, and UnodeAi rewrites only a complete marked block. If the markers are missing or
incomplete, UnodeAi appends a new block rather than guessing which of your text it owns. Keep your own rules
outside that block.

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
The confirmation is stored in UnodeAi's workspace state. It binds the declaration's digest and its settings
origin. Editing the declaration, or moving it to another origin, makes it inert again. Hooks can only block an
action already available to an agent. They never grant file, shell, network, MCP, or model authority. Agents
have no tool to edit either the setting or its approval record.

### Provider settings

Use the Providers tab to see which provider keys are set. Secret values are never displayed.

Each available connection card shows its runtime, its billing path, its endpoint or CLI setup, and a summary of egress and privacy. An available card has a **Set as default** action, which is how you switch to **Claude CLI** or **Codex CLI** after the setup wizard. The current default is marked **★ Default for new agents**.

**Test connection** is on every API-key gateway card, not just the custom ones: **Roam, Unode, OpenRouter, OpenAI Compatible API**, and every named custom gateway. It looks up that connection's endpoint and key in the registry, never in the panel. It asks for metadata consent for that host. Then it makes one `/models` request and reports either success or a failure you can act on. It sends no prompt and no workspace content. Neither the key nor any part of it appears in the result or the error. Claude CLI and Codex CLI have no Test connection, because they authenticate through their own CLI, not with a stored key.

Built-in API-key cards use **Set key**, **Edit**, **Clear key**, **Test connection**, **Set as default**, and
**Check pricing** where that provider publishes pricing. The key itself is never displayed in the card.

The **Unode** and **Roam** cards also have **Update reference prices** (0.9.89). This action takes a fresh,
anonymous snapshot of that gateway's public price list, dated today. It sends no key. The snapshot is used for the
spend estimates described in [Spend: what a request cost, and reminders](#spend-what-a-request-cost-and-reminders).
The action's tooltip shows when the current snapshot was taken.

#### Which CLI program UnodeAi starts

**The Claude CLI and Codex CLI cards show the program UnodeAi starts (0.9.96).** Each card names the program, where it
comes from (your setting, npm, the native installer, an editor extension), the version UnodeAi last measured and
when, and a status. Opening Settings starts nothing, so a version appears only after it was checked. A checked
version says which program runs; whether your account can use a model is known only after a turn.

- **Check / choose CLI…** lists the programs installed on this computer without starting any of them. Choose one,
  and UnodeAi starts that one program once, with `--version`, to read its version. For Codex it also runs
  `login status`, as before. Checks start in UnodeAi's own folder; if that folder cannot be prepared, nothing is
  started and a notice says why. If you chose a different program, UnodeAi shows the current and the new program
  with their versions and asks **Use this CLI** or **Keep current CLI**. Only **Use this CLI** changes your User
  setting, and only if the path you chose still starts the program that was checked; otherwise check it again.
  Agents that are already running keep the program they were started with until you restart them; nothing is
  stopped or resent.
- **Update instructions** says how to update the installation UnodeAi starts: for an npm installation, the npm
  command; for the native installer, that program's own `update` command; for a copy that comes with an editor
  extension, to update the extension. **Update in terminal** opens a terminal in UnodeAi's own folder and types the
  command for your default shell, without pressing Enter. Read it, and press Enter to run it. **Copy the update
  command** copies the same command. Stop the agents that use the CLI first, or the update may not be able to
  replace the program. The command updates the npm your terminal finds, which is not necessarily the one that
  installed the program UnodeAi starts, so use **Check / choose CLI…** again afterwards to see what UnodeAi starts.
  When a program file is replaced, the card says it changed since its last check until you check it again. Running `claude update` in a terminal may update
  another installation than the one UnodeAi starts.
- **The latest published version.** Check / choose CLI and Update instructions ask npm (`registry.npmjs.org`) for
  the CLI's latest published version. The first time, the metadata consent prompt asks whether UnodeAi may contact
  that host; nothing is contacted unless you tick it, and you can revoke it in the Security panel. The list marks a
  checked program that is older than that version, the card shows it with the time it was looked up, and a check
  that finds an older program offers **Update instructions**. Nothing is looked up when VS Code starts or Settings
  opens, and the latest version never chooses a program for you.

**Claude CLI.** With `unode.claudeCliPath` empty, UnodeAi starts `claude.cmd` (Windows) or `claude` from PATH, as
before 0.9.96. A chosen native program (`claude.exe` on Windows) starts without `cmd.exe`. npm's `claude.cmd` only
starts the native program inside the npm package, so UnodeAi starts that program directly, also without `cmd.exe`,
when it is there; both are listed, and either works. A program that comes
with the VS Code Claude Code extension moves to a new folder when the extension updates, so choose it again then.
Claude CLI writes its own files as it starts: measured with 2.1.306, every start rewrote `~/.claude.json` and saved
a backup of it under `~/.claude/backups/`, removing the oldest backup there. UnodeAi does not open those
files; the CLI does this itself, as it does when you start it in a terminal.

**Codex CLI.** Codex keeps its own rules: an exact program, never started through `cmd.exe`, version 0.155.0 or
newer, and no prerelease. A preview build that comes with an editor extension is listed but refused. Account models
are kept per program and version. A list from another program, or from before 0.9.96, is not offered; refresh it.
A list is also not offered after the program file was replaced, until the program is checked again, for example
by starting an agent. If the selection changes while a refresh runs, up to the moment App Server would start, it stops without starting App Server and
saves nothing. UnodeAi saves the program a Codex launcher or link points to, not the link: after a version manager
points a link elsewhere, choose the program again.
A conversation thread is not resumed in another Codex program: the agent starts a new thread, and its earlier
messages stay in the chat.

**Every start checks the program's files.** Each time an agent's CLI starts, UnodeAi reads the program's files and
hashes them; there is no shortcut by file date or size. For Codex that is the whole package beside the program (its
`bin`, `codex-resources` and `codex-path` folders); for Claude it is the program file, and for npm's `claude.cmd`
also the program it starts. The agent's row in the Team view and its output say "Checking the Codex program…" (or
the Claude program) while this runs, and the row shows the adoption question while it waits for your answer. The bundled compatibility
list names the exact files of the versions this UnodeAi was tested with; those start at once. This release's list
names Codex CLI 0.163.0 (OpenAI's Windows x64 package, for managed Codex) and Claude CLI 2.1.306 (the Windows x64
program, from the native installer or npm), each run through UnodeAi's release checks on Windows 11 on 2026-10-21.
Any other version, newer ones included, asks once.

**A program UnodeAi has not tested asks once.** For any other program, nothing of it starts until you answer. The
question names the program, how it was installed, the number and size of its files and, for Codex on Windows, which
of them carry an OpenAI or Microsoft publisher signature and which carry none. **Check and use this program** starts
it once in UnodeAi's own folder, with no model request and no workspace, to read its version and check that it
loads UnodeAi's safety settings (for Codex its `--version`, `login status` and the App Server handshake; for Claude
its `--version` and its start-up hook). Agents then use that exact set of files. When an update changes any of its
files, the next start asks again. **Not now** starts nothing. Check / choose CLI asks the same way, and reads the
program's files before anything of it starts. On Windows x64, **Forget chosen external programs…** on the Codex CLI
card makes UnodeAi ask again for every program. A version the bundled list marks bad does not start, and no answer changes that.

**An agent keeps the program it started with.** Only your own **Start**, **Restart** or a change to the agent's
settings chooses the program again. Every other start uses the exact program the agent started with, or does not
start: an App Server restart, the restart after the CLI exited, a start for a message to a stopped agent, a start
another agent asks for, and the first start after a window reload. If that program changed, the start is refused
with "The program changed while this agent was running. Start the agent again to use it."; nothing else is started
instead.

#### Managed Codex (Windows x64)

UnodeAi can keep its own copy of Codex up to date: it downloads and checks new supported versions, and each new
version runs only after your OK once. The copy lives in `%LOCALAPPDATA%\UnodeAi\cli-store\`, outside your Codex
installation and outside every workspace. UnodeAi does not change your own Codex CLI, an npm install included, and
never reads or copies its login files. Managed Codex is not a separate profile: it uses your Codex login and your
`CODEX_HOME` (`~/.codex` unless you set it), and like any Codex program it writes there itself: its conversation
history and state databases, its sandbox helpers and sandbox state (`.sandbox-bin\`, `.sandbox\`) and its built-in
skills. On Windows it also runs Codex's own sandbox set-up program, which manages the sandbox's Windows accounts and
their access. The helper copy in `.sandbox-bin\` is shared by every Codex program of your Windows account, so the
program that last ran a sandboxed command leaves its own copy there.

- **Set up managed Codex…** on the Codex CLI card names the folder, the download hosts and the sizes, and asks
  whether to keep it updated automatically or only when you choose **Update now**. Before you set it up, UnodeAi
  makes no update request.
- **Download and checks.** UnodeAi downloads a supported version only from the hosts the bundled list names and you
  approved, and checks the archive's size and SHA-256, every file's SHA-256, that only the expected program files are
  present, and every program file's publisher signature (Windows PowerShell checks them). A version that fails any of
  this is not kept, and one whose files do not match is not downloaded again automatically. With automatic updates
  on, UnodeAi looks at most once a day, starting two minutes after a window opens; a download that fails for a
  network reason is tried again after one hour and after six hours, then not automatically.
- **Your OK for each version.** A downloaded and checked version runs only after **Review** → **Allow and use for new
  sessions**. The question lists what was checked and what was not, for example that `codex-path/rg.exe` has no
  publisher signature. UnodeAi then starts it once in its own folder, with no model request, to check it; if that
  passes, new sessions use it. Agents already running keep their version until you restart them.
- **While a task runs**, the card says what it does: looking for a supported version, downloading, with the host
  and the percentage received, checking file hashes and publisher signatures, and checking the version after your
  OK. A download you started that fails says why on the card.
- **Every start of managed Codex** checks its files against the ones you allowed, and refuses a version whose files
  changed, marking it bad on this computer. If managed Codex fails to start an agent by itself (it does not run,
  exits, reports another version, or never answers), UnodeAi checks that version once more in its own folder; if
  that check fails too, the version is marked bad on this computer and a notice says so. If the check passes, the
  failure came from your login, settings or workspace, and the version is not marked. The failed start is not
  started again. If UnodeAi could not confirm that a check's process stopped, the card
  offers **Check again**, which first warns that the earlier process may still be running. A version marked bad
  offers **Try again**, which removes its files, downloads and checks it again, and runs its check once more;
  nothing retries it by itself.
- **Use external CLI** makes new sessions use the Codex CLI you chose with Check / choose CLI. Managed Codex stays set
  up with its versions and your approvals, and **Use managed Codex** uses it again with no download and no new
  question. Agents that are running managed Codex keep running, but UnodeAi does not start managed Codex again for
  them, not even after a restart or a reload; start them again to use the external CLI.
- **Go back to …** makes new sessions use the earlier version. UnodeAi keeps the newest three downloaded versions,
  plus any version an agent still uses, and at most 3 GiB; older ones are removed in the background. To tell whether
  a version is in use, UnodeAi asks Windows which processes run. Each request waits at most 5 seconds, and a check
  of many processes makes several requests, one after another. On a computer that answers more slowly, UnodeAi
  treats the version as in use, and nothing is removed while that is uncertain:
  - the version is kept, even beyond the newest three, and kept versions can fill the 3 GiB so that a later
    download is refused;
  - **Try again** says the version is in use;
  - a download of a version that another window started is skipped until that window is known to have stopped or
    ten minutes have passed since it started;
  - the first managed Codex start or card action in a window waits for its own request;
  - a version used by a window that closed abnormally before its request answered can stay kept with no time limit.
- **Reset managed Codex…** retires managed Codex's versions, settings and approvals. Running agents keep running
  until they stop; UnodeAi does not start them again by itself, even after you set up managed Codex again. Their
  files are removed later. A new set-up starts from a new, empty folder and asks again for every version.
- **Paused.** If UnodeAi cannot read its record of your managed Codex choices, or cannot confirm your last change
  after an unexpected shutdown, managed Codex is paused: no managed Codex starts, downloads or checks, and the card
  says why. If the managed Codex store folder is missing or damaged, the card says so and no managed Codex starts;
  **Use external CLI** makes new sessions use your own Codex. **Reset managed Codex…** is not offered then, because
  UnodeAi cannot be sure that another window is not starting managed Codex from that folder, and UnodeAi never resets
  it by itself. After an unexpected shutdown, **Review managed Codex settings…** asks you to confirm the settings it
  could read. When the record cannot be read at all, **Use external CLI** pauses managed Codex in every window, and
  **Use managed Codex again** lifts the pause once the record can be read. If nothing else helps: close every VS Code
  window, check in Task Manager that no process runs from `cli-store`, restart Windows if the card ever said that a
  check's process might still be running, and delete `%LOCALAPPDATA%\UnodeAi\cli-store\`.
- **Load / Refresh models from Codex** uses managed Codex while it is selected. The version it used is kept
  protected from removal until UnodeAi has seen the model-list process stop.

**When a model needs a newer CLI.** If the provider answers that the CLI is too old for the model, for example
`Claude Code 2.1.209 does not support this model; version 2.1.280 or newer is required`, the chat adds a line that
names the program UnodeAi started, and a notice offers **Check / choose CLI** and **Update instructions**. The
failed turn stays failed. After updating, restart the agent and send your message again.

### Capability profile

Each configured agent's **Model Tuning** card includes a closed **Capability profile** section for its
connection × model pair. It lists the tool protocol, sampling-parameter compatibility, context-window policy, and
recovery behaviour. Every row names its effective source and the facts available beneath it. A **user override**
wins over an **observed this session** fact, and an observed fact wins over the cold-start **declared** fact.
Observed entries include their timestamp.

UnodeAi deliberately does not save observations automatically. If a gateway rejects `temperature` or a model leaks
a native tool call, only that running session's overlay changes. UnodeAi may show a proposal that needs your
approval. It never changes the saved connection, model, or agent configuration unless you apply it.

### Named Custom gateways

Use **Add custom gateway** at the top of the Providers tab to create a local OpenAI-compatible profile. The host asks for a display name, a canonical HTTPS endpoint, and an API key in a masked field. The key value never enters the Settings webview. The final confirmation names the gateway's background-request policy. Custom gateways currently make no scheduled requests, so saving one does not authorize background traffic. Each card shows its name, its endpoint, whether a key is set, and its default/in-use state. It also has the same flat action row as the Roam / Unode / OpenRouter cards:

**Test connection · Edit · Set as default · Load models · Remove**

- **Edit** is one flow for the whole profile: display name → endpoint → what to do with the stored key (**Keep current API key**, **Replace API key**, or **Clear API key**). A confirmation then names the old and new values and any known local references. If you cancel at any prompt, nothing changes.
  - Changing only the **name** is always allowed. Existing agents, Smart Mode mappings, and the default keep the same opaque connection identity, so a rename never re-points anything.
  - Changing the **endpoint or key** is blocked only while an agent on that gateway is actually **running** (starting/running/stopping). An **idle** agent does not block the edit.
  - After the change, a backend built from the old profile is denied on its next request and asks to restart. Clearing a key leaves the profile visible but non-runnable. The profile never borrows another provider's key.
- **Test connection** and **Load models** are explicit network actions. They ask for metadata consent for that gateway's host and contact only its own `/models` endpoint. They send no prompt, no workspace file, and no key to any other gateway.
- **Remove** is blocked while a current local agent, the new-agent default, or a Smart Mode tier still points at the profile. The message lists exactly what to rebind, and hovering over the button states the rule first. After removal, the immutable ID becomes a tombstone. An old route that points at it shows as a repair record. It is not silently re-pointed at another gateway.

Custom model prices and account balances remain unknown unless that exact custom gateway publishes trusted per-connection data. UnodeAi does not borrow a built-in gateway's price, catalog, endpoint, or balance for a custom profile.

When you create a **team** on a custom gateway, UnodeAi asks once for the model to use and applies it to every role. This is because a custom gateway ships no built-in model catalog to resolve per-role tiers from. If you cancel that picker, no agents are created. You never get a crew set up with a model the gateway does not serve.

### Migrating the old Custom connection

Older rosters may contain the retired singleton `custom`, `CUSTOM_API_KEY`, `unode.customBaseUrl`, or a per-agent `baseUrl`. In a **trusted** workspace, UnodeAi shows a host-authored preview before it changes anything. It prefers an agent's valid HTTPS endpoint to the old global setting. It keeps different legacy credential identities separate and creates fresh opaque profile IDs. It copies an old key only after you confirm, and only inside the extension host. Cancelling changes nothing and sends no network request.

**There is no command or button for this.** The preview is not something you go and find. It appears by itself when UnodeAi activates in a trusted workspace whose roster still contains pre-0.9.31 `custom` agents. If you never had such a roster, you will never see it, and that is correct. Migration is entirely local. It contacts no network and tests no key, so endpoints that do not resolve still migrate fine.

**Declining is a real answer, and it sticks.** If you choose not to migrate, nothing is written. Those agents stay visible as non-runnable repairs, and reloading the window does not ask you again for the same roster. Your team file keeps working normally. After a decline, adding, editing, and deleting agents all save correctly.

An invalid endpoint, missing key, unknown profile, or archived profile stays visible as a non-runnable repair. It does not fall back to Unode, Roam, OpenAI, or any other gateway. The old setting and key are kept for a compatibility period, so a later workspace can migrate independently.

**Codex CLI uses your local Codex login.** Install Codex and log in yourself. Then choose the executable from its provider card in Settings. (The official npm `.cmd` wrapper is resolved to the native executable next to it.) UnodeAi first runs bounded local checks of the version and login status. Before App Server or a model request starts, it asks for separate consent that names OpenAI and the model provider configured in Codex. UnodeAi does not control the CLI's network behaviour. If you decline, no App Server or model request starts. Revoking the Codex consent in the Security panel kills the running Codex process tree.

Codex keeps its own base instructions, hooks, plugins, native tools, and model-provider configuration. UnodeAi adds
the agent role as developer guidance. It also loads selected instruction-only Playbooks from a private temporary
Skill root. Either Claude or Codex may be the team coordinator that the host selects. Only that agent receives team
tools. Codex supports steering while a turn is active. Agent Builder MCP grants also stay owned by the host. Codex
sees only the approved dynamic tools. The external server and its secrets never enter the global Codex
configuration.

In Act mode Codex defaults to **Ask for approval**: `workspace-write`, `on-request`, with eligible requests
reviewed by the user. **Approve for me** keeps workspace-write/network-off but sends escalation decisions to
Codex `auto_review`. No UnodeAi card appears, and the review action and its result are written into chat. **Full
access (unsafe)** uses no sandbox and enables network access. It has no approval prompts. It may read or change any
file the account can reach, and it may run any command. It creates no UnodeAi checkpoints. It requires
confirmation each time it is enabled. Routine local commands and edits inside the granted workspace boundary run
without a card. An approval appears only when Codex **requests** an escalation — to cross that sandbox boundary,
use blocked network access, request additional permissions, or invoke a prompted MCP effect. Whether to request one
is Codex's decision, not UnodeAi's. When Codex does not request one, the blocked action simply fails. In
measurements of the Windows 0.155.1 binary, a blocked network command or out-of-workspace write under Ask for
approval produced a card. In the release checks of 0.163.0, Codex let a blocked network command and an
out-of-workspace shell write simply fail, without asking; when it did ask to run a command outside the sandbox, the
request reached a card. Under Approve for me, the same request went to Codex's reviewer instead. These are Codex
escalation approvals, not “ask before every command” or “ask before every write.” The Workbench therefore replaces
**Commands** and **Writes** with the active Codex permission profile. Plan mode and the Workspace Trust,
write-folder and tool ceilings resolve the effective profile to read-only. **In Plan mode a Codex agent reads files
with UnodeAi's `read_file`**, since Codex reads files only by running commands and Plan runs none. It reads what the
agent's folders allow, and changes nothing. A Codex agent that may read gets it in Act mode too; for one that did not
have it, the first turn of an existing conversation after this update starts a fresh Codex thread, and the earlier
messages stay in the chat. An agent limited by explicit Folder
Access grants can use Ask for approval or Approve for me. Both keep writes inside the granted folders. Such an
agent can never use Full access. Full access has no sandbox and cannot honour a folder grant, so for that agent it
resolves to Ask for approval. **A Plan/Act switch or a Folder Access change restarts App Server** for a running Codex
agent. Measured with 0.163.0, Codex applies a changed sandbox to a conversation only when a new App Server process
resumes it, so UnodeAi restarts App Server once, resumes the same conversation there and checks the sandbox again.
The message then runs with the new access, or is refused if the check still fails; UnodeAi never gives a removed
folder back by itself. The new App Server starts only after UnodeAi saw every process of the old one stop, which also
ends any command Codex still had running. If that stop cannot be confirmed, nothing new starts: the message fails
with the reason, and so does every later one until you stop the agent and start it again.
Routine Codex edits are not UnodeAi checkpoints and cannot be restored from UnodeAi's
checkpoint list.

Codex's reads are **not** a workspace-confinement claim. Measurements showed that native Codex reads can reach files
outside the workspace. Treat Codex as able to read files available to your Windows account and to send selected
content to its configured provider. UnodeAi does not open your user configuration. Codex loads it natively after
consent. UnodeAi pins the native approval/sandbox profile and disables sandbox network access. It also disables
Codex analytics and OTel export.

**Sandbox network access off does not cover this computer.** On Windows, measured with Codex 0.163.0, the sandbox
refuses a command's connections to other machines, but not its connections to this computer (`127.0.0.1`): a
sandboxed command reached a local server, and through a local proxy it fetched a public web page. If a proxy, a
database or another service listens on this computer, treat a sandboxed Codex command as able to use it, and,
through a proxy, to reach the internet. UnodeAi cannot close this gap; it is in Codex's sandbox.

**Repository CLI configuration asks before it can run.** This applies when the agent's working directory, or an ancestor that the native CLI searches, contains `.claude`, `.mcp.json`, or `.codex` project configuration. In that case UnodeAi shows a redacted summary before either CLI starts. The check includes a repository root when VS Code opened only one subfolder. For declared hooks, the dialog shows the executable's basename without exposing its arguments. HOME `.claude` and `.codex` stay native user configuration, and UnodeAi does not inspect them. **Trust and load** keeps native project and user features. **Continue without project automation** runs Claude with only its user settings and starts Codex with a process-local `untrusted` project override. Trust and load uses the corresponding `trusted` override, so the dialog controls Codex's project layer without editing your config file. In untrusted mode, Codex skills may still load as instructions. Any effect they request is still subject to the active Codex sandbox and approval profile. The grant is bound to the containing workspace folder, the CLI working directory, the CLI kind, and the exact configuration digest. If any of these changes, UnodeAi asks again. You can revoke the grant in the Security panel.

**Automatic refresh is user-controlled.** The only scheduled network task is the daily price refresh. The Roam and Unode provider cards each have an **Automatic daily price refresh** toggle. It is on by default, to keep the existing behaviour. Unbound `unode.pricingSources` entries have a separate **Global pricing sources** toggle under Settings > More. Both settings live in user storage, not in repository settings. A scheduled refresh never runs at activation and never prompts. It contacts only a host that already has metadata consent. Concurrent triggers are merged, and failures back off. Balance checks, model catalogs, Marketplace catalogs, and custom-gateway model loading still run only when you trigger them. They are not scheduled.

Because Anthropic stores no key here, its card offers **Set up Claude CLI** instead of *Set key*. That opens a terminal with `claude login` typed but **not** run, so press Enter yourself. If the CLI isn't installed, run `npm install -g @anthropic-ai/claude-code` there first.

**↻ Run Setup Wizard again** reopens the first-run wizard from here, so you can change the gateway or key without reinstalling. It keeps your current default provider. Running it again will not quietly move a Roam setup onto Unode.

Important provider settings:

| Setting | Default | Purpose |
|---|---|---|
| `unode.defaultProvider` | `unode` | Provider used for new agents |
| `unode.unodeBaseUrl` | `https://www.unodetech.xyz/v1` | Deprecated compatibility setting. Unode uses its registered endpoint |
| `unode.baseUrl` | _(partner gateway)_ | Deprecated compatibility setting. Roam uses its registered endpoint |
| `unode.customBaseUrl` | empty | Deprecated endpoint, used only to migrate the retired singleton Custom connection. Never used for normal routing |
| `unode.modelCatalogUrl` | empty | Optional hosted model catalog |
| `unode.extraModels` | `{}` | Add model ids to the pickers without waiting for an update |
| `unode.modelPrices` | `{}` | Manual price overrides |
| `unode.pricingSources` | `[]` | Extra pricing sources |
| `unode.claudeCliPath` | empty | Absolute path of the Claude CLI program UnodeAi starts. Empty keeps the PATH lookup used before 0.9.96. Set it with **Check / choose CLI…** on the Claude CLI card |
| `unode.codexCliPath` | empty | Absolute path to the user-installed, logged-in executable that Codex CLI uses. Set it with **Check / choose CLI…** on the Codex CLI card |
| `unode.priceGroup` | empty | Billing group for displayed prices |
| `unode.workbench.autoOpen` | `true` | Open the Workbench for chat actions. Set it to `false` to keep the compact Chat sidebar as your default |

### Choosing a model (and naming one the picker has not heard of)

The model field is a combobox, not a fixed list. The suggestions are a convenience, and **you can always
type an id the extension does not know**. UnodeAi passes it to the provider as you typed it.

The suggestions come from up to four layers, best first:

1. **`unode.extraModels`** — your own ids, keyed by connection id. Takes effect when you save, without a reload.
2. **`unode.modelCatalogUrl`** — a hosted catalog, if configured. Changing this URL needs a window reload.
3. **The gateway's live `/v1/models`** — OpenAI-compatible connections only, subject to metadata consent.
4. **The built-in defaults** for that connection.

```jsonc
"unode.extraModels": {
  "claude-cli": ["claude-opus-5", { "id": "claude-sonnet-5", "name": "Sonnet 5", "vision": true }]
}
```

**Claude CLI is the case that needs this**, because you cannot ask a CLI what it serves. There is no
`claude models` command, and an unknown `--model` prints a warning and still exits 0. As a result, the extension
can neither discover nor verify an id. Its picker therefore leads with the CLI's **always-latest family
aliases**: `opus`, `sonnet`, `haiku`, `fable`. Each time an agent starts, the CLI resolves the alias to the newest
model in that family. Pick an alias to stay current without touching settings. Pick a pinned id such as
`claude-opus-5-5` when a run has to be reproducible later. An alias shows no price in the picker, because it can
name a newer model with a different price. An agent that uses an alias is costed from the CLI's own reported total.

### Building an agent

**The Agent Builder opens on five things, not eleven.** These are the decisions that are genuinely yours: name
and role, connection and model, instructions, skill playbooks, and tools. Model fine-tuning, Smart Mode tier, folder
and command access, and MCP grants sit behind one collapsible **Advanced** section. They are there because each of them exists
for the case where a working default is wrong.

**Advanced opens by itself when something inside it needs you** — a folder rule that fails validation, or a
parameter this connection rejects. A message shown inside a closed section is a message that was not delivered.

### Why a displayed price can differ from the website

**A billing group belongs to your key, not to your account.** Two keys on the same account can be in different
groups, with different prices *and* different callable models. The gateway's pricing endpoint says which groups a
key *may* use. It does not say which one is actually used for billing. The endpoint that would say so needs a
browser login, not an API key.

For this reason, when a gateway offers several groups, **UnodeAi shows the undiscounted rate rather than guessing a
cheaper one.** An over-estimate is visible, and the first invoice corrects it. An under-estimate takes money
without warning and looks right while doing it. The Output channel states the basis on every refresh.

**Often the gateway does not report your rate at all.** The pricing endpoint publishes what a model costs. What
*your key* is charged is settled internally, and naming a group cannot recover a number that nobody sent. That is
why UnodeAi asks you for it when you store a key:

> **Price coefficient for this unode key** — what fraction of the published price does this key pay?
> `1` = list price. Leave it at 1 if you do not know; the gateway does not report this, so UnodeAi cannot
> check it.

**Every newly stored connection carries a value.** If you dismiss the prompt with Esc, UnodeAi stores `1` instead of
leaving the value unset. "This key pays list price" is a fact, and "nobody has said" is not. Only one of the two can
be read back. UnodeAi never changes a legacy stored key during activation. When you open **Settings** or explicitly
run **Refresh Model Prices**, UnodeAi may add a missing `1` for that key. If it does, it explains why and links to
the setting. If it cannot safely identify a missing legacy value, it leaves the value unstated.

**That repair never blocks what you asked for (0.9.78).** The repair writes to your *User* Settings JSON. An editor
refuses that write while the file has an error or a warning in it. Until 0.9.78 the repair ran *first*. As a
result, a single stray comma in `settings.json` could make **Open Settings** and **Refresh Model
Prices** appear to do nothing at all. Now the panel opens, and a price refresh completes and reports its result,
before the repair is attempted. If the repair then fails, you get a warning that the coefficient could not be
updated, with an **Open User Settings (JSON)** button. By then, the thing you asked for has already happened. Fix
the file and run the command again to let the repair through.

**An empty box means list price, and so does Esc.** The box opens empty on purpose. With `1` pre-filled, an Enter
press carried over from the preceding key prompt could accept list price before you had read the question. Because
the box opens empty, empty has to mean something, and it means the same as `1`. **It does not mean
"free"** — that was a real defect in 0.9.56. Because `Number('')` is `0`, every model then showed a cost of zero.
If a key really is free, type `0` and say so.

**`0` is allowed.** A free or internally-settled key costs nothing, and that is a fact worth being able to state.
The prompt refuses a negative number. A connection hand-edited in `settings.json` to a negative number or a
non-number reads as **unset**, not as `1`. The gateway's own answer then applies, instead of a number nobody meant.

The setting for this is `unode.priceMultiplier`. Like the group, it belongs to the key:

```json
"unode.priceMultiplier": { "unode": 0.33, "roam": 1 }
```

**Exactly one discount is applied.** A stated coefficient and a gateway-reported group ratio answer the same
question — *what does this key pay* — so applying both would answer it twice. When a coefficient is set, it is
the one that counts. The gateway's ratio is not multiplied on top. A stated `1` therefore means "list price", and
it suppresses a discount the gateway would otherwise have applied. Leaving a connection unset lets the gateway
answer.

If your gateway *does* report a ratio for a named group and you have set no coefficient for that connection,
`unode.priceGroup` still works:

```json
"unode.priceGroup": { "roam": "vip", "unode": "default" }
```

On every refresh, the Output channel states which of the two produced the number.

**A price with no live or user source is a dated reference (0.9.89).** Previously, a model the gateway had not
priced yet showed a figure from an undated built-in table. The figure was matched by name, so a newer model could
borrow an older model's price. That table is gone. A picker label now shows a live price, your own
`unode.modelPrices` entry (labelled *your price*), or the dated Unode or Roam reference for that exact model id
(for example *Unode reference 2026-09-27*). A model that none of those name shows no price, and never another
model's.

### Model tuning

Each agent's card opens **collapsed**. It shows only what you need to decide: whether anything has been changed
from the defaults, and the context window this agent compacts against. Two controls stay outside the collapsed
part, so you can reach them without expanding the card. One is **Reasoning Effort**, which is adjusted often. The
other is **Context window**. It is the one value here that produces a visible failure, rather than a subtle one,
when it is wrong. The remaining twelve sampling and protocol parameters sit behind **Advanced model parameters**.
Every one already has a sensible default, and none of them needs changing before you start working.

Each agent can have its own model parameters:

| Parameter | Notes |
|---|---|
| Temperature | Lower for code/review, higher for writing/brainstorming |
| Top P | Nucleus sampling control |
| Max tokens | Output budget |
| Reasoning effort | Optional. Leave it blank unless the model supports it |
| Response format | `Text (provider default)`, `Text`, or `JSON object (structured output)` |
| Stop sequences | Optional custom stopping strings |
| Context window | Per-agent context budget. Your number always wins, both over a gateway's advertised value and over a ceiling that a rejection proved. If you leave it blank, an agent uses a measured or provider-refused value if it has one. Otherwise it uses **1,048,576** tokens (raised from 524,288 in 0.9.33) |

Some parameters are not available for all backends. The UI disables fields that do not apply.

The UI labels the complete tuning set as **Temperature (0–2)**, **Top P (0–1)**, **Max output tokens**,
**Reasoning effort**, **Presence penalty (-2–2)**, **Frequency penalty (-2–2)**, **Response format**,
**Thinking**, **Thinking budget (tokens)**, **Tool choice**, **Stream**, **Context window (tokens)**,
**Stop sequences (one per line, max 4)**, and **Tier for this agent**. Response format choices are
**Text (provider default)**, **Text**, and **JSON object (structured output)**.

**"Provider default" means the field is omitted, not disabled.** Every model parameter here follows the same rule. If you leave it on its default, UnodeAi does not put that field in the request at all, so the model applies its own default. This matters because gateways differ. Some reject `response_format` outright. Some reject `"type": "text"` but accept a request with no field at all. That is why `Text (provider default)` sends nothing, and you get normal prose. The separate `Text` option explicitly sends `response_format: {"type":"text"}`. It is worth choosing only when a gateway needs the format stated. Pick `JSON object` only when a program consumes the output. It constrains the model to emit JSON and may not combine with tool use.

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
| `unode.modelTiers` | Connection/model matrix for tiers. Named gateway columns use their opaque connection IDs |
| `unode.modelTierParams` | Tier-level model parameters |

## 11. Safety and Approvals

UnodeAi is designed to keep powerful agents observable and governed by permissions.

### Network consent — two different questions

UnodeAi asks two separate questions before it touches the network. They never blur into each other:

- **Model egress** (per host, before the first agent turn): *may UnodeAi send this host your prompt and the
  workspace files the agent includes?* This is the grant that lets an agent actually run.
- **Metadata** (per host, only when you open a model picker or run **UnodeAi: Refresh Model Prices**): *may
  UnodeAi fetch this host's price list, available models, and — if you stored a key for it — your account's
  discount tier and balance?* **No prompts, code, or workspace content are ever sent under this grant**.
  Approving it does not approve running an agent.

What you'll actually experience:

- A fresh install shows **no prompts and contacts no host you haven't approved**. The consent gate refuses an
  unapproved host before a packet moves. Whether *zero* traffic of any kind leaves is `UNVERIFIED`, pending a
  packet capture (see SECURITY.md). Background price refreshes silently skip unapproved hosts. You get built-in
  prices until you approve a gateway.
- The first time you open a provider's model picker, one dialog lists the host(s) **that provider** will
  contact. Each host is listed with exactly what it will be asked for. Untick anything you don't want. Escape
  declines everything. The picker still opens immediately with the built-in model list, and you won't be asked
  again this session.
- Opening one provider's picker never contacts another provider's gateway, even if you approved that gateway
  before.
- Approving a host for **model egress** automatically covers metadata for the same host (your code is strictly
  more sensitive than a price list). The reverse is never true.
- The **UnodeAi: Security** panel lists every grant on its own row, as either `prompts + workspace files` or
  `prices, balance & model list only — no code is sent`. Each row has its own **revoke**.
- If a **Claude CLI** agent is waiting on its first model-egress decision, its Team card shows
  **Consent required**. The card tells you to respond to the native dialog that is already open. The same start
  stays pending while you read the dialog. **Allow** resumes the agent, and **Cancel** reports an error. If you
  stop the agent first, a later Allow cannot launch it.

### Public-web access

`fetch_url` on gateway routes and Claude CLI `WebSearch` / `WebFetch` are a third, separate egress
decision. They are not model-egress or metadata grants. A requested URL or search query can itself disclose
information.

`unode.webAccess` defaults to `ask`:

| Mode | Behavior |
|---|---|
| `ask` | A chat approval card names the agent and the requested web action. You can allow that request, deny it, or allow public-web access for the whole crew for this extension session. You have 15 minutes to answer, so you can send work and come back. An unanswered request is visibly denied. |
| `allow` | Allows public web search and URL fetches for agents that have the `read` capability. |
| `off` | Removes gateway `fetch_url` and Claude `WebSearch` / `WebFetch` from the agent's advertised tools, then denies any stale direct request at the host gate. |

When the host denies a web request, its tool card is shown as **refused**, never as a completed fetch. The
status comes from the host decision made at the gate. UnodeAi does not try to work it out from the wording of
the result. Output written by an external MCP server or subprocess remains explicitly external. It is not
treated as a host-authored permission decision.

A refusal may add a reviewed, host-authored explanation of the safe next step. If it does, it still keeps the same bounded refusal
reason. It never forwards a path, credential, command, destination, or your own free-form reason for denying a
request. On OpenAI-compatible connections, task-only artifact and context-gap tools are offered only while a live
contracted attempt exists. A stale direct call still reaches the host handler and receives its accurate refusal.
Claude's connection-time tool schema is unchanged.

The session choice is not stored in the workspace or in VS Code settings. It resets when the extension host
restarts. Web reads stay available to a read-only-folder agent only when that agent has `read`. Folder write
scope is not a network permission.

An agent without the `read` capability gets the same no-web set of tools. This stops a model from planning around
an action that the host can only deny. The policy gate is still the final fail-closed check.

### Command approval

Setting:

```text
unode.commandApproval
```

Modes:

| Mode | Behavior |
|---|---|
| `none` | Agents cannot run shell commands |
| `ask` | Asks before unapproved commands. The default in current builds |
| `allowlist` | Only commands matching `unode.allowedCommands` can run |
| `all` | Runs most commands except recognised dangerous deletes. Use only in a sandbox — it gives no protection against a mistaken delete |

A bounded guard reads each command under the shell that runs it and sorts it into three cases. A **recognised dangerous delete** — a recursive delete of the working folder (`.`), the folder above it (`..`), a drive or home root, or `.git`/`.unode` — is refused in every mode, and no approval lifts it; for a command UnodeAi runs itself the guard also resolves each target on disk, so a short name, a link or an absolute path to one of them is refused too. A **simple literal command** the guard can read is handled by the mode above. Anything the guard will **not** decode — a wrapper or inline script (`cmd /c …`, `bash -c …`, `node -e …`), an escape or expansion, an unidentified shell, or a delete target whose real path cannot be confirmed — is *opaque*: it is never run silently. Opaque is a single-use prompt in `ask` (you approve it each time; it is never remembered), is refused in `allowlist` and `none`, and runs only in `all (unsafe)`. The command check is a limited heuristic, not a sandbox: it does not check every equivalent spelling of a command, says nothing about what an allowed program does once it runs, and an approval is your decision to run a command, not a guarantee that it is safe. Claude's and Codex's own commands get the same classification but not the on-disk delete check.

Allowed command prefixes are configured with:

```text
unode.allowedCommands
```

The default list is empty. When a normal approval card is for a command that exactly matches an entry on
UnodeAi's reviewed safe list, the card offers **Enable safe commands**. Choosing it adds the reviewed list to
this project's approvals, kept in UnodeAi's own storage. You can inspect or revoke them with
`Manage Project Command Approvals`. Instead, you can use **Allow once**, **Allow this session**, or
**Allow for project** for the exact command you want. The reviewed safe commands are narrow templates for building,
linting, testing, and inspection. They do not include commands that run arbitrary code, or Git commands that
change history.

**An approval belongs to one kind of shell.** Since 0.9.96, *Allow this session* and *Allow for project*
remember a command together with the shell grammar it was approved in: `cmd.exe`, PowerShell, or POSIX shell.
An approval of `copy-item` in PowerShell does not let `copy-item` run silently in `cmd.exe`. **Enable safe
commands** adds the reviewed list for all three grammars. It leaves out a command that a grammar cannot run.
Some commands come from a shell that UnodeAi could not identify. This can happen with a Codex CLI agent. Such a
command can be allowed once, but it is never remembered. `Manage Project Command Approvals` lists each approval
as `<grammar> · <command>`. An entry in `unode.allowedCommands` still applies in every shell that can run it.

**After an upgrade from 0.9.95 or earlier, some commands ask again.** A project approval saved before 0.9.96 did
not record its shell. As a result, each such command may ask once more. A safe list enabled before 0.9.96 is
not carried over. Choose **Enable safe commands** again to restore it. If you had turned command execution on
for the project, it stays on.

**Each command runs in one identified shell.** This applies to `run_command` on an OpenAI-compatible or
custom-gateway agent. A foreground command runs in that agent's own terminal, under your default terminal
profile. The check, the approval, and the run all use one shell. The approval card names it, for example
`Shell: Windows PowerShell`.

**Nothing is started for a command before you approve it.** The shell on the card comes from your terminal
settings, or from what the agent's terminal proved for its last command. UnodeAi reads the settings only: it
does not open a terminal or type anything to learn the shell. After the approval, UnodeAi opens the agent's
terminal if it is not open yet. Then it proves three facts about the terminal: which shell it runs, that it
starts in the agent's folder, and that UnodeAi can read its output. It proves the shell again before every
command, because an earlier command may have changed it. If the terminal turns out to run another shell than
the one on the card, the command is not run. The agent is told to try again, and its next command is checked
for the shell the terminal proved.

**If the terminal cannot be used, a named fallback runs the next command.** The fallback is the declared direct
shell: `cmd.exe` on Windows, `/bin/sh` on macOS and Linux. Some terminal settings name a shell that UnodeAi
cannot check commands for, for example Command Prompt, a WSL profile or a shell it does not know. Then the
fallback is used at once, and the approval card names it. If the terminal cannot prove its facts after an
approval, that command is not run, and the agent's next command uses the fallback, named on its card. The
agent's result names the fallback too. UnodeAi never switches shells after you approve a command. If the
terminal changes after the approval, the command is not run, and the agent is told to try again. The same holds
when the terminal settings change, or Workspace Trust is withdrawn, after the approval: UnodeAi checks both again
before it opens a terminal and immediately before the command starts. A command that was not run this way runs
only through a new request and a new approval. A terminal
profile that failed for an agent is remembered for that agent. Its later commands then use the fallback without
another five-second wait. Other agents are not affected. The terminal is tried again after you change a terminal
profile setting or restart the agent. A terminal opened under earlier terminal settings is closed before a
command runs under new ones.

**The starting folder is checked, but the shell is not a sandbox.** A command runs only when the terminal
reports the agent's folder as its current folder. UnodeAi compares physical folders, so a link to the same
folder counts as the same folder. If the folder has changed, UnodeAi replaces the terminal once. It never types
`cd` to repair it. If the new terminal cannot prove the folder either, the command is not run, and the agent's
next command uses the fallback. Once a command runs, it
can change folders or touch other files. The approval gate and the agent's folder grants decide what runs. They
do not confine what a running program does.

**Syntax that cannot run in the shell is refused before any approval card.** In `cmd.exe` or a POSIX shell, a
PowerShell cmdlet such as `Copy-Item`, `Get-ChildItem`, or `Start-Sleep` is refused. The agent is given an
equivalent. In `cmd.exe`, that is `copy` / `xcopy`, `dir`, `type`, or `ping -n <seconds+1> 127.0.0.1 >nul`. In a
POSIX shell, it is `cp`, `ls`, `cat`, or `sleep`. In Windows PowerShell 5.1, `&&` and `||` are refused, because
that shell cannot parse them. The agent is told to use `;` or to make two calls. PowerShell 7 accepts both. Each
refusal names the shell. The refusal is about shell compatibility. It never claims that you withheld consent.

**A quiet command is a normal result.** A command that prints nothing still succeeds or fails by its exit code.
The agent reads `No output was captured.` A quiet command no longer causes the terminal to be marked as broken
for later commands, or for other agents.

**One agent's foreground commands run one at a time.** A second foreground command from the same agent waits until the
first has ended. That includes the cleanup after a timeout. Commands from different agents run in parallel.

**Long output keeps its start and its end.** The agent receives at most 16,000 characters of output: the start
and the end, with a line in between that says how many characters were left out.

**How long a command may run.** On an OpenAI-compatible or custom-gateway agent, a foreground command is stopped
after 120 seconds, unless the agent states a longer limit, up to 10 minutes. A longer job runs in the background. The
agent starts it and then waits for it in one step, up to 5 minutes per wait, instead of checking on it again and
again. Each check sends the agent's whole context to the model, so one wait costs far less than a series of
checks. **Stop** ends a wait at once. The background command itself keeps running until the agent stops it or
the agent's session ends.

**A timed-out command is stopped with everything it started.** UnodeAi sends Ctrl-C and waits two seconds. Then
it stops the command's whole process tree and closes the terminal. It does this even when the prompt came back,
because a returned prompt does not prove that child processes stopped. Checking that everything stopped usually
takes about a second, and up to a minute on a very busy computer. The agent's next command gets a new terminal.
If UnodeAi cannot confirm the stop, that agent runs no further commands until you restart the agent or
reload the window. The result says so. A command whose end UnodeAi did not see is reported as
`outcome unknown`. UnodeAi never runs it again on its own. If the terminal closes while a command runs, UnodeAi
cannot confirm that what the command started has stopped. That agent then runs no further commands either, until
you restart the agent or reload the window.

**Background commands run alongside other work.** A background command uses the declared direct shell:
`cmd.exe` on Windows, `/bin/sh` on macOS and Linux. Several can run at once, next to foreground commands. Each
keeps its ID, and the agent uses `check_command` and `kill_command` with it. `kill_command` reports a command as
killed only after UnodeAi has seen its whole process tree end and the command's output close. A program the
command started can keep that output open after the command's own shell has ended; UnodeAi waits up to five
seconds for it. Otherwise it says the stop was not confirmed and that the command may still be running. While
an agent runs no further commands because a stop was not confirmed, no background command of it starts either,
even one that you approved before. When an agent's
session ends, UnodeAi stops its background commands. A stop it cannot confirm, also one it tried before, is shown
in a warning and named in the UnodeAi output channel.

**When the window closes or reloads**, VS Code gives UnodeAi only a few seconds before it ends the extension.
So UnodeAi stops every command it started at once, without checking first which processes belong to it, and waits
for those stops while it can. From then on no command starts, not even one you approved before. UnodeAi does not
wait to watch the stops finish, so it does not say that they were confirmed.
The UnodeAi output channel names each background command stopped this way, and no warning is shown. If a stop
cannot finish in that time, programs that the command started may keep running after the window has closed.

Claude CLI agents send both `Bash` **and** `PowerShell` through this same approval. This includes calls that
Claude makes inside a native subagent. A fail-closed `PreToolUse` hook runs before Claude's own allow rules. As
a result, a matching rule in `~/.claude/settings.json` or a project Claude settings file cannot silently
pre-approve a command and bypass UnodeAi. While it runs, each Claude agent keeps its own hook and connection
files in its own folder under `.unode/claude/`. Agents that share a working folder therefore never use each
other's files. For approvals, a `Bash` command counts as a POSIX shell command and a `PowerShell` command as a
PowerShell command. Claude still runs both tools itself. They do not use the agent terminal.

**Agent commands that name a path outside your folder always ask.** If an agent's `run_command` refers to an absolute path outside the agent's writable folder, the approval card says so and you are asked. This happens even if you already chose *Allow this session* or *Allow for project* for that command. The approval was granted to the command (`git`), not to the new path. UnodeAi does not refuse such a command on its own. A rule can only spot an escape that is written in the obvious way, so the decision is yours. Real containment comes from this gate plus the folder the agent runs in, not from matching patterns in the command text.

**A runner call is rewritten to the project's own script, chosen by what the script runs.** When an agent
types `npx vitest`, UnodeAi looks for a package script that invokes the same runner, and runs that script
instead. **The script's name is not evidence** — a script called `device-test` that runs `vitest run` is a
perfectly good one-shot script. A script called `test` that runs a bare `vitest` starts watch mode and never
returns. Only the command that each script actually runs decides. For a runner that watches by default, **every
invocation in the body must be explicitly one-shot** — `vitest && vitest run` is not eligible, because the
first half never ends. If no eligible script exists, UnodeAi runs the direct call with `run` added. It does not
choose a watching script for you.

### Per-agent command narrowing

The command approval described above is a **workspace-wide** policy. From 0.9.48, you can also narrow an
individual agent in the Agent Builder, under the same Commands area:

| Choice | Effect |
|---|---|
| **Inherit global** | The default. The agent uses the workspace command policy unchanged |
| **Restrict to selected** | The agent may run only the templates you tick, drawn from the commands this workspace already allows |

The editor offers a checklist, not a text box. It lists the commands this workspace already allows: every entry
of `unode.allowedCommands` and every command approved for the project. Beside each one, it names the shells that
command is allowed in. This is deliberate. A per-agent setting can only ever **narrow**, never widen. As a result,
you cannot grant a command that the workspace does not allow by typing it into an agent. At the moment of each
check, every saved selection is intersected with what the workspace currently allows in the shell of that
command. This happens after the global policy has applied its hard denials. Since 0.9.96, a command approved for
the project only in PowerShell counts for the agent only in PowerShell. If you later shrink the global list or
revoke a project approval, a stale agent entry therefore cannot stay behind as a grant.

An empty **Restrict to selected** list means *this agent runs no commands*. That is a different statement from
**Inherit global**, and the two are kept apart rather than merged. The narrowing is a ceiling on authority. It
does not assert that the agent asked for a sensible command. The approval gate, the folder the agent runs in,
and your own review still do that work.

### Optional local approval frequency table

For a debugging or review period, deliberately enable the **User** setting
`unode.debug.promptedCommandLog`. It is off by default, and a workspace cannot enable it. UnodeAi then counts
only the command templates that actually reached an approval prompt, including a prompt you deny. It keeps
these totals in local VS Code extension storage. It does not count allowlisted commands, or commands already
approved for the session.

Run `UnodeAi: Show Prompted Command Frequencies` to open a ranked local Output table. The table stores and
shows `CommandPolicy` templates such as `git status` or `npm run build`. It never stores or shows the raw
command, its arguments, URLs, or secrets. Nothing is sent from the machine.

### Claude native subagents

Claude can start its own subagents (`Agent` / `Workflow`). UnodeAi does **not** disable them. Instead, an
inherited, fail-closed `PreToolUse` hook mediates each child tool call before it runs. This covers `Bash`,
`PowerShell`, native writes, external effects, and newly introduced Claude tools. When an agent uses a
subagent, UnodeAi still shows a notice. The notice says that disabling native subagents affects this agent
only, and it offers three controls:

| Action | Effect |
|---|---|
| **Stop agent** | Interrupts the current turn right away |
| **Disable subagents** | Saves a per-agent setting. From the agent's next run, `Agent`/`Workflow` are disabled for that agent only |
| **Learn more** | Opens the relevant section of `SECURITY.md` |

UnodeAi never sets that opt-out for you. Read-only Folder Access keeps its CLI-level denials as an extra layer
of defense. For a normal agent, tools with external effects (for example Artifact, schedules, notifications, or
messages) show an approval card before they run, and so does a new or unknown Claude tool. "Always allow this
tool" lasts only for the running agent session. If `unode.writeApproval = ask`, native Write/Edit calls show the
same write-approval preview before they run. If the local gate is unreachable, slow, or malformed, the tool
is blocked rather than run.

Delegation through the PM (`dispatch_task`) is not affected. It runs over UnodeAi's own authenticated bridge and keeps every approval, folder-scope, and verification gate.

### Write approval

Setting:

```text
unode.writeApproval
```

Modes:

| Mode | Behavior |
|---|---|
| `none` | Guarded file tools write with checkpoints. Claude native writes are still mediated but do not prompt |
| `ask` | Prompts with a diff before guarded writes. Native Claude Write/Edit gets a before/after preview |

### Work that is not the agent's

Before an agent changes or deletes a file, UnodeAi looks at that one file. This applies to UnodeAi's own file tools
(`write_file`, `apply_edit`, `apply_patch`, `delete_file`, `delete_dir`), to Claude's native Write, Edit and
NotebookEdit before Claude may run them, and to a Codex file change before UnodeAi approves it. Nothing is looked
at when you send a message: no listing, no hashing and no Git status of the project, only the file a change
names, when it names it.

| What UnodeAi finds | What happens |
|---|---|
| The file has unsaved changes in an editor | The change is refused. UnodeAi never saves your editor for you; save or discard it, or let the agent write another file |
| The file is larger than 32 MiB | The change is refused before you are asked: UnodeAi can neither compare the file with what it saw nor keep its bytes as a restore point. The agent is told so, and to write a new file instead |
| The file changed after the agent read or wrote it in this request, or another request that is still running wrote it | You are asked once |
| Git shows the file modified, staged or untracked, and UnodeAi has no record of making those changes | You are asked once |
| Git shows the file committed and unchanged | The change goes ahead under the agent's usual permissions and your write-approval setting |
| The file is outside Git (or ignored by it) | The change goes ahead when the agent read it in this request, or when UnodeAi itself wrote exactly these bytes before; otherwise you are asked once |
| The file does not exist yet | The change goes ahead; the folders it needs are created with it, and the result names them |

The question is a write card that says why it asks. **Approve** covers this one change to the file as it is now:
"Approve all", `unode.writeApproval = none` and a remembered tool approval do not answer it, and when nobody can be
asked the change is refused. For Codex, the reason is shown on Codex's own file-change card, and that card's answer
is the decision. If the file changes, appears, or gets unsaved editor changes while the card is open, nothing is
written and the agent is told to try again on the file as it now is.

UnodeAi's record of its own changes lets the next request continue a file without asking again. It holds, for at
most 1,000 files per workspace and for 30 days each, the path, size, SHA-256 and file identity of what UnodeAi left
there and which request did it; never file contents. For Claude and Codex, only a result that reads back exactly as
the change said it would counts. A file changed since, an expired record, or a lost one means you are asked again.

Other limits:

- A file with more than one name on disk (a hard link) is not overwritten, because the change would also reach the
  other path. Deleting one of its names is allowed.
- UnodeAi's own file tools change one file at a time in this window. Another VS Code window or another program is
  noticed only through what it did to the file before UnodeAi's last look; nothing locks a file across windows or
  programs.
- Between UnodeAi's allow and Claude's or Codex's own write, nothing holds the file. A change made in that moment is
  seen when the result is read back, and then nothing of it counts as UnodeAi's own.
- Codex applies some changes without asking UnodeAi first: under Ask for approval and Approve for me, edits its own
  sandbox allows, and everything under Full access. Those are not checked. Shell commands of any route are not
  covered by these checks either.
- Codex reads files itself, so UnodeAi sees none of its reads. Outside Git, a Codex change to an existing file that
  UnodeAi did not write carries the question on Codex's card. Claude's reads count when they go through its Read tool
  or UnodeAi's read-only file tools.
- Claude's Write, Edit or NotebookEdit is refused when it does not name exactly one file, when the file lies outside
  the agent's writable folder (by its path or through a link), or, on Windows, when its name is one Windows treats
  specially. A Codex change that moves a file is refused; ask for an add and a delete instead.
- Before UnodeAi's own file tools replace or delete an existing file, they keep its exact bytes as a restore point
  (see [Restoring a file](#restoring-a-file)); when they cannot, the change is not made.
- UnodeAi's own file tools replace an existing file in a writable folder by writing the new content beside it first
  and then renaming it into place; a file granted on its own outside the writable folders is written in place. The
  file is read back afterwards, and the change is reported as made only when the file holds what was written. A
  replaced file keeps its permission bits on macOS and Linux. On Windows it takes the permissions its folder gives
  new files, so permission entries set on that one file are not kept. A read-only file is not replaced.

### File sandbox

OpenAI-compatible and Claude CLI agents can work only inside the configured workspace or agent worktree. Path traversal and access outside the root are blocked. Codex CLI is different: Act mode uses Codex's workspace-write/on-request sandbox and Plan mode is read-only. UnodeAi does not claim that Codex reads are confined to the workspace.

### Local project discovery (`unode.localReadScope`)

This host-owned setting controls an optional **read-only** discovery root outside the workspace. It has three
values:

- `workspace` keeps the long-standing reach, limited to the workspace.
- `parent` (the default) makes the immediate parent folder available.
- `volume` makes the current filesystem volume available.

The setting is ignored in an untrusted workspace. It never widens writes, edits, deletes, generic shell
commands, or Claude native file access. Per-agent Folder Access and a temporary task scope remain stricter
ceilings.

The first time the crew tries to access the local-scope root in a top-level user request, UnodeAi opens a modal
dialog. The dialog names the resolved absolute path. It says that agents may **read and search** there. It also
says that a `search_files` call without a path can walk the whole root, and that returned filenames and contents
may be sent to that agent's configured model provider. For `volume`, it adds a warning that the volume can
include other users' profiles. Choose **Allow** to cover that root for the current extension session.

**Deny**, or closing the dialog, blocks the root for this request, for the coordinator and its delegates alike.
Immediate retries do not ask again, but a later direct user request may. If the UI fails or is unavailable,
retries for this request are blocked too. That is not recorded as your decision. The refusal notice offers **Grant
folder access**. The Security panel lists session-only grants and declines, with grant and revoke actions. Each
admitted access has a tool-card and run-evidence receipt. The receipt holds only an opaque root id, the
operation kind, and a count — never a path, query, or file contents.

**Agents are told the root exists (0.9.89).** On every route, each turn's project context now names the
`parent` or `volume` root and says that it is not granted. When the agent needs something there, it calls
`read_file` or a search tool, and the dialog above decides. Before this change, agents often did not know they
could ask. The note grants nothing. It is absent for `workspace` and in an untrusted workspace. The context
receipt lists it as **Local read reach guidance**.

In Agent Builder, use **Folder Access (advanced)** to restrict an agent to specific folders. A project file may
also narrow access to a path that is physically inside that workspace, for example
`{ "path": "docs", "permission": "read" }`. Outside paths and symlink escapes are ignored. When present, this
replaces the workspace default instead of adding to it. Claude CLI supports at most one writable folder.
Read-only Claude agents deny native write and shell tools. The extension-owned Playbook plugin for Claude CLI
contains instruction-only files. Protected agents can therefore still load the full assigned procedure without
gaining Bash or write authority. The Security panel shows folder grants next to each agent's MCP grants. This
setting does not sandbox MCP servers, because they run as separate processes.

Codex CLI does not claim Folder Access confines reads. A read-only grant uses Codex's read-only profile.
A writable grant uses the native Ask for approval profile, where routine commands and in-boundary edits can run
without a card. Eligible permission escalations remain individually approval-gated. On Windows, the CLI may read
files available to the user's account. Choose this route only if you understand that boundary.

### MCP approval

UnodeAi-managed MCP servers are denied by default. Servers that touch files, credentials, networks, browsers, or external systems should require approval before mounting. MCP servers you configure directly in Claude or Codex stay under that CLI's own controls.

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

The PM's `run_checks` tool uses this command to verify the whole project. It is the main safety net against cross-file breakage caused by parallel work.

The verify command runs in the declared direct shell: `cmd.exe` on Windows, `/bin/sh` on macOS and Linux. Its
approval belongs to that shell's grammar. It passes only when UnodeAi observes exit code 0. A run whose end
UnodeAi did not see counts as failed.

The command still obeys `unode.commandApproval`. It comes from your trusted configuration, not from the model. UnodeAi therefore does not block automatic verification just because the command mentions an outside absolute path. Instead, if the command is otherwise allowed, UnodeAi runs it and shows a warning once for that distinct command string.

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

Worktree mode requires a git repository with a clean tree. Each eligible agent works in its own worktree. When its turn finishes, its work is committed and merged into a Unode **integration branch** (`unode/integration`). Review it with:

```text
UnodeAi: Crew Worktrees (Review)
```

A successful merge command is not, by itself, evidence that a lane changed the integration branch. UnodeAi compares
the integration branch's `HEAD` before and after the merge. An unchanged `HEAD` is reported as **nothing to
merge**, while a moved `HEAD` is reported as **merged**. This works whatever display language Git uses.

Land accumulated integration work onto your branch with:

```text
UnodeAi: Finalize Worktree Merges to Branch
```

### Verifier-as-gate (0.7.0)

In worktree mode, before an agent's work merges into the integration branch, UnodeAi runs your **verify command** (`unode.verifyCommand` — e.g. `npm test`, `npx tsc --noEmit`) **inside that agent's worktree**:

- **Pass →** the work merges to the integration branch.
- **Fail →** the work is **held on the agent's own branch (not merged)**. The failing output is handed back to the agent so that it can fix the work and finish again. Only verified work lands.

A crew therefore lands only work that passes your project's own checks. The **Crew Worktrees (Review)** board shows each lane's status — **✓ verified / ✗ failing / ⚠ unverified**. It also **flags any lane that passed by editing the test files**. A weak model can make checks green by weakening a test instead of fixing the code. The flag lets you review those lanes before finalizing.

The gate requires `unode.verifyCommand` to be set **and** approved to run. Enable the reviewed safe list, or
approve the exact verifier through the normal command card. A command that is not approved is skipped rather
than run automatically. With no verify command, there is nothing to gate on, so merges proceed unchanged.

Additional worktree settings:

| Setting | Default | Purpose |
|---|---|---|
| `unode.worktree.verifyBeforeMerge` | `true` | Gate merges on `unode.verifyCommand` passing in the agent's worktree (the verifier-as-gate) |
| `unode.worktree.verifyTimeoutSeconds` | `300` | Hard timeout for the verify command (10–3600). On timeout, it is killed and treated as a failure |
| `unode.worktree.autoMerge` | `false` | Automatically land clean integration work into the base branch |
| `unode.worktree.maxParallel` | `4` | Maximum number of isolated worktrees at once |

## 14. Dashboard and Activity

Open the dashboard with:

```text
UnodeAi: Show Dashboard
```

The dashboard summarizes agents, message activity, workflow state, token use, and estimated cost where usage data is available. A plain `$...` is a cost that the provider reported as billed. `~$...` is an estimate. It can be an account estimate from your key's coefficient or group, a dated reference estimate, or an API-equivalent figure for subscription CLI usage. If no completed turn established a cost basis, the dashboard says **cost unknown**, never `$0`. The **Spend** section keeps each of these in its own row.

### Spend: what a request cost, and reminders

**Reminders, never a brake (0.9.89).** UnodeAi records the tokens each request used, and the best-sourced cost it
can honestly show. It can remind you when a target is crossed. Crossing a target never stops, pauses, refuses or
shortens work. You decide whether to stop. Open it with **UnodeAi: Open Spend**, which opens the Dashboard with its
**Spend** section first.

**What is counted.** Every model turn is recorded once, with the tokens the provider reported:

- On an OpenAI-compatible route, each completed model response that reports its usage is counted when it
  finishes. A long tool loop can therefore remind you while it runs. The turn's final total then adds only what
  those responses did not already count.
- Claude CLI is counted from its final result. Codex CLI is counted from the change in its running total for that
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
selected reference. It is never a bill, and it never triggers a dollar reminder. Having a key stored, or a gateway
listing the groups a key *may* use, never counts as knowing what that key pays.

**The first-run choice.** The first time a gateway turn ends with no billed or account price, UnodeAi asks
once whether dollar reminders may use a dated estimate: **Use token reminders only**, **Use Unode estimate for
dollar reminders**, or **Use Roam estimate for dollar reminders**. The turn has already ended. Nothing waits on
the answer, and the question makes no sound. Closing it records nothing, and it is offered again at most once a
week. You can change your choice at any time in **Settings → Spend**. Until you choose, the Unode estimate is
shown for comparison only.

- **Your choice is for later turns (0.9.94).** A turn keeps the price it started with. The turn that just
  ended, and any turn already running, stay as they were recorded. The dialog says so.
- **An estimate is offered only where it exists (0.9.94).** A reference appears in the dialog only when its
  current price list has a price for the exact model the turn used. When neither reference has one, nothing is
  asked, and the week's one offer is not used up.

**A gateway's own name for a model (0.9.94).** A gateway can name a model with a prefix. For example, OpenRouter
calls `deepseek-v4.1-flash` `deepseek/deepseek-v4.1-flash`. A reference prices such a name only where its price
list declares it as another name for one model. The shipped lists declare that one name. UnodeAi never strips a
prefix, and it never matches a name that only looks similar. Any other prefixed name gets no estimate. Its cost
reads `Price unavailable`, and its tokens are still counted. If you set a price for the model under the
gateway's own name in `unode.modelPrices`, that price is used as before.

**Reference prices are dated.** UnodeAi ships a Unode and a Roam reference captured on 2026-09-27. Each figure
names its capture date and is marked **stale** after 30 days. One quiet reminder then offers
**Update reference prices**. Later reminders come at most once every 30 days. An update contacts only that
gateway's public price list, over HTTPS. It sends no key and refuses redirects. If anything is wrong, it keeps
the previous snapshot. Earlier receipts keep the prices they were recorded with.

**Targets.** In **Settings → Spend** (or **UnodeAi: Change Spend Reminder Target**), you can set any of these:

- A per-request token and/or dollar target.
- A project total per day or per month, in a time zone you choose.
- Per-agent shares of that project total.

All are off by default. They are read only from your User Settings (`unode.spend.targets`,
`unode.spend.referencePriceMode`), so a workspace cannot set them. The page also lists, for each agent, what a
dollar target covers on its route right now.

**The reminder ladder.** For each counter:

- at **80%** a quiet line in the request's coordinator chat and one non-modal warning;
- at **100%, 150%, 200%**, then every further whole multiple (300%, 400%, …) a line saying **Over target — work is
  continuing**, a status-bar item and a Team badge, the attention chime, and a dialog with **Keep going**, **Stop
  this request**, **View spend**, **Change target** and **Reset counter**. Closing it is **Keep going**.
- The usage that crosses a threshold can arrive as the work ends, for example with the final report of a turn
  you just stopped. In that case, the line and the dialog do not say "work is continuing". They say
  **Over target** and **Nothing in this request is running right now**. For a project or agent-share target, the
  second message reads **No agent is working right now**. The buttons stay the same.

Each threshold appears once across all windows. If usage jumps past several thresholds at once, only the highest
one is shown. For example, a jump from 50% straight to 450% shows 400%. The multiples go on without limit. A
request that resumes after 30 days without usage can remind you again at its current level. There is no timer. A
reminder comes only from new spend.

**Stop this request** acts once. It stops only the still-running turns of the request that crossed the target
(its coordinator and its delegates). If that request has already finished, it says **Already finished** and stops
nothing. Only reported tokens, billed costs, account estimates and a reference you chose can trigger a reminder.
Partial, reconstructed and API-equivalent figures are shown, but they never trigger one.

**Reset.** **Reset counter…** (Dashboard, Settings or **UnodeAi: Reset Spend Counter…**) resets the current
request, the current project period (with its agent shares), one agent, or every counter for the project. The
counter starts again from zero, and the whole ladder can remind you again. Nothing is deleted. History, charts
and receipts stay, and running work is not touched.

**A project can only suggest lower targets.** A repository may include `.unode/budget.json`:

```json
{ "schemaVersion": 1, "max": { "request": { "tokens": 1000000, "usd": "5.00" }, "project": { "tokens": 10000000 } } }
```

UnodeAi reads it strictly (no comments, no duplicate keys, 64 KiB at most, inside the project folder). It shows one
quiet notice per version, *This project proposes lower spend-reminder targets*, with **Review** and **Ignore this
project**. It has no effect until you choose **Use this version**. Even then, it only lowers reminders you already
enabled. A changed file is a new proposal. The file can never turn a reminder on, choose a reference, reset a
counter or make a sound.

**Across windows and machines.** Usage is recorded per project, in the extension's own storage on this machine.
Two windows on one project add up without overwriting each other. Another window's usage appears within about 15
seconds. A window with no folder open keeps per-request totals in memory only. Sometimes a usage record cannot be
saved at once, for example because the disk is full or busy. The Spend section then says **Usage updating**, and
UnodeAi keeps retrying. Totals and reminders include that usage once it is saved, and work is never held up. If
the reminder state's control file is ever damaged, **Repair spend tracking…** rebuilds that state from the
recorded usage. Usage records are never edited.

**Savings.** The "Mixed-model routing saved about $X" banner prices both your routing and the all-premium baseline
from the same dated reference, and names that reference. If any turn's model is missing from that reference, the
banner makes no claim.

Status colours use VS Code theme tokens rather than fixed colours. Every one of them has a fallback. If a theme
leaves a token undefined, the dot shows a different colour instead of disappearing. **Done is blue, not green**.
When measured against the four bundled themes, the green it used before fell below the contrast floor on the
default light theme. In both dark themes, it was nearly indistinguishable from the green *working* dot.
`Verified / mergeable` uses the same blue. The verification chips are outlined rather than filled. A fill in the
text's own colour makes the pill more visible but the text less readable. The outline therefore carries the
shape, and the text keeps its contrast. The word is always beside the dot, so nothing here depends on telling
two colours apart.

The **Latest tasks** panel sits at the top of the dashboard. It shows your most recent tasks, newest first. Each task is broken down by the agents that worked on it, with a token bar per agent, plus the task's total tokens and cost. This lets you see exactly where the tokens went across a PM-led, multi-agent run. Use the **Show last: 3 · 5 · 10 · 20** control in the panel header to choose how many tasks to display. Below the panel comes **Team activity**: one card per agent (status, current task, files, cost, context and actions), as many per row as fit. The totals, savings banner and cost charts come after that, for reference.

The dashboard updates live while the crew works — you don't need to close and reopen it.

Use the Activity panel for the live team event stream. You can export, import, clear, or compact message history from the Activity view toolbar. Each message carries the turn's raw usage. The Activity panel is therefore the most precise place to see one agent's tokens and cache hits for one turn.

### Request limits

**An optional stop that you decide (0.9.94).** A spend reminder tells you, but it never stops anything. A
request limit holds the request and asks. There are two settings, both unset by default. They are in User
Settings only, and a workspace can neither raise nor remove them:

| Setting | What it counts, for one request |
|---|---|
| `unode.requestLimits.providerTurns` | Model requests made by the agent you asked and by every teammate it delegated to |
| `unode.requestLimits.tokens` | Raw tokens: input plus output, with cached input counted once. Not a cost |

**At the limit.** Nothing is cut off. The response under way finishes. UnodeAi then holds the next step it
controls and puts one decision card in Chat, above the message box. Nothing blocks the editor while it waits.
The card shows the observed totals, what is held, who is working on the request, and which conversation it
belongs to. It has two actions: **Stop request** and **Continue request**. The Team panel marks the agent you
asked as `Decision needed`, and the status bar counts one more waiting decision. If no chat is on screen, a
notice with an **Open Chat** action takes you to the card.

- **Continue request** grants one more allowance of the same size. The counts are never reset, so the next
  crossing asks again.
- **Stop request** ends every running turn of the request, the same way Stop does. A request you stopped stays
  stopped. A teammate's result that arrives later does not start a new turn of it.
- **No answer within 15 minutes** stops the request too. The card then reads `Request limit: stopped, no answer
  in time` and offers no action.
- **If the step that was waiting ends by itself**, for example because you stopped that agent, nothing was
  decided. The card reads `Request limit: decision no longer needed`. If the request reaches a limit again, you
  are asked about it again.
- A card you answered shows your answer. A settled card stays in the conversation of the agent you asked until
  you send that agent its next message.
- While the card is open, the wait is yours. It is not counted as the agent's time.

**A request is counted as it is allowed to go.** Two teammates that ask at the same moment cannot both take the
last allowed model request. After Continue, the held requests go ahead only while the new allowance lasts. The
rest wait for the next decision.

**What UnodeAi can count and hold depends on the route.**

| Route | Counted | Held until you decide | Not held |
|---|---|---|---|
| OpenAI-compatible | Every model request, including retries and the summary requests of a compaction | Every model request. Every action that writes, deletes, runs a command, reaches the web or dispatches work | Nothing |
| Claude CLI | Each turn UnodeAi starts, as one host-counted turn | The start of a turn. Every tool call that acts, including Claude's own tools | The model requests Claude makes inside a turn. They are not counted either, and the turn's tokens are known when it ends |
| Codex | Each turn UnodeAi starts, as one host-counted turn | The start of a turn. Every tool call UnodeAi serves that acts | The model requests Codex makes inside a turn, counted the same way, and its own commands and file changes |

Reads, listings and searches are never held, so a request at its limit can still look at what it did. On the
Claude CLI and Codex routes, a model-request limit is in effect a limit on turns. The card says "host-counted
turns" for such a count. Usage that a route does not report is never counted as zero. The total is then a lower
bound, and the card says so.

**On the card.** The request's **Request summary** shows the totals against the limit under **Usage & timing**.
It also shows how often the limit was reached and continued, and whether the request was stopped there. A turn shows
one card. The turn that closes a team job shows that job's **Job outcome**. There, the same rows are in a **Request
limit** section, read from the request's own record and marked as facts of the request, not of the run. **Open
evidence**, the evidence report and the run evidence pack of that job carry the same section. The rows follow
the request even after the turn has ended. When a teammate reaches the limit later and you stop the request,
the card of the turn that dispatched the work reads `Limit reached: 2 times; continued 1 time; then stopped`.
When the job closes, the totals are the request's final totals, even when no limit was reached. When a later
turn ran on a route where UnodeAi cannot count the model requests, the card says from then on that the totals
may be a lower bound. While a job is running, the totals on an earlier turn's card are not counted up request
by request. A question that is still open is not written onto a card. The open question is the decision card.
Limit facts are held in memory. After a window reload, a card keeps the facts it was last given. A limit applies
from the next request. A running request keeps what was configured when it began. A request ends when the window
reloads.

### An agent's own conversation log

Two bounded tools let an agent look back at its own Activity log instead of guessing what was decided
earlier. `search_conversation_log` finds entries. `read_conversation_log` reads at most 20 of them, using the
range that the search returned. Every read states which range it covers out of the total, so a partial read is
never presented as the whole conversation. Every read also appears as a receipt in the run record.

**An agent reads only its own log.** It cannot read another agent's conversation or any attachment bytes. A
refusal says that the log is not available to *this agent*, not that the log does not exist. Those are
different facts. Where the log really cannot be reached, the agent must say that it is unreadable, not
unrecoverable. The data may well still be in your Activity panel.

This exists because, before 0.9.59, the conversation kept for a restart was the copy trimmed to fit the
model's context window. As a result, a long session quietly lost its middle. The durable record is now kept
apart from what is sent to the model, and it has its own limit. What the model receives is unchanged.

**A teammate on a delegated task may use what you told it directly.** A delegated task carries only the sources
the coordinator forwarded. If you told or attached something only to the coordinator, the teammate does not
have it. The teammate says so and stops, instead of guessing or searching the web. What you told the teammate
itself, in its own chat, counts. A Codex teammate gets each forwarded source in its turn, or is told it was not
delivered (see [Attachments on a Codex agent](#attachments-on-a-codex-agent)).

### Prompt caching — the `cached` number, and why it matters

The Tokens card reads `in / out / cached (N%)`. Cached input is the part of the prompt that your provider
served from its own cache, and **it is billed at roughly one tenth the price**. On a long conversation, cached input is therefore most of what determines your bill.

Caching works on a **prefix**. Everything before the first byte that changes can be reused. Everything from
that byte on is re-read at full price. UnodeAi therefore keeps the stable part of a request byte-identical for
the life of a session. That part is the model, the tool definitions and the system prompt. UnodeAi attaches
state that changes (project rules, shared-memory notes, your open file) at the *end* of the request. A change
there cannot invalidate anything before it.

Two things are worth knowing:

- **Claude caches nothing unless it is asked to.** Every other provider we reach caches automatically.
  Anthropic does not. The request must carry explicit cache markers. UnodeAi sends them, and then *checks
  whether they landed*. This matters because a missing cache does not make a request fail. It only makes the
  request cost more. If a route turns out not to cache, the agent's Output channel says so plainly, instead of
  leaving you to find out from an invoice.
- **`cached: not reported` is not the same as `cached: 0`.** Some gateways don't pass the cache counter back.
  UnodeAi then says "not reported" instead of showing you a healthy-looking zero. Where it can reconstruct the
  real number, it labels that number an estimate.

If you want to know what a specific agent's caching is doing, open its Output channel (`View → Output`, then
pick `UnodeAi · <agent>`). It stays quiet while caching works and speaks up when it doesn't.

## 15. Import, Export, and Reset

You can export or import chat and message histories from their view toolbars.

Useful commands:

| Command | Purpose |
|---|---|
| `UnodeAi: Export…` | Pick **Message log**, **Run evidence pack**, **Portable run evidence**, **Evidence report**, or another export from the visible list |
| `UnodeAi: Export Chat` | Export selected agent chat |
| `UnodeAi: Import Chat` | Import selected agent chat |
| `UnodeAi: Archive Chat` | Hide the selected chat without deleting it (recoverable) |
| `UnodeAi: View Archived Chats` | Browse and restore an archived chat |
| `UnodeAi: Export Messages` | Hidden implementation command. Use **UnodeAi: Export… → Message log** |
| `UnodeAi: Export Run Evidence Pack` | Hidden implementation command. Use **UnodeAi: Export… → Run evidence pack** |
| `UnodeAi: Export Portable Run Evidence` | Hidden implementation command. Use **UnodeAi: Export… → Portable run evidence** |
| `UnodeAi: Import Messages` | Import message log |
| `UnodeAi: Reset Workspace State` | Clear roster, chats, message log, saved conversations, workflows, and approved MCP servers for this workspace |

**Clear vs. Archive.** Both are in the Chat sidebar's title bar and in the Workbench session menu. **Clear** (`$(clear-all)`) permanently deletes the selected agent's transcript. **Archive** (`$(archive)`) saves it first, then hides it from the live view. The conversation disappears from view but isn't deleted. You can restore it at any time with **View Archived Chats** (in the title-bar `…` overflow menu or the Command Palette). Archives survive reloads.

`Reset Workspace State` is destructive. Use it only when you want a clean UnodeAi workspace.

## 16. Command Reference

| Command | Purpose |
|---|---|
| `UnodeAi: Run Setup Wizard` | First-run setup |
| `UnodeAi: Set Provider API Key` | Store provider credentials |
| `UnodeAi: Show Team Panel` | Reveal the Team panel |
| `UnodeAi: Create Default Team (PM + Architect + Developer + Reviewer)` | Create the default software crew |
| `UnodeAi: Create/Save/Load a Team…` | Create, save, load, or delete a named team |
| `UnodeAi: Save Team…` | Kept for existing keybindings. Opens the save flow but is hidden from the Command Palette |
| `UnodeAi: Open Saved Team…` | Kept for existing keybindings. Opens Create/Save/Load a Team but is hidden from the Command Palette |
| `UnodeAi: Add Agent` | Add one agent |
| `UnodeAi: Solo Agent (toggle)` | Toggle Solo mode |
| `UnodeAi: Start All Agents` | Start all team agents |
| `UnodeAi: Stop All Agents` | Stop all team agents |
| `UnodeAi: Open Workbench` | Start work in or reveal the editor Workbench |
| `UnodeAi: Close Workbench` | Close the Workbench editor tab |
| `UnodeAi: Toggle Workbench Composer Focus` | Toggle focus between the Workbench composer and its editor surface |
| `UnodeAi: Show Pending Approval` | Open the relevant inline approval from the status-bar signal |
| `UnodeAi: Open Chat` | Start work in the Workbench by default. Focus the sidebar when `unode.workbench.autoOpen` is off |
| `UnodeAi: Open Chat with Agent` | Select a specific agent in the Workbench by default, or in the sidebar when auto-open is off |
| `UnodeAi: Send Message to Agent` | Send a one-off task |
| `UnodeAi: Run Workflow` | Run a workflow template |
| `UnodeAi: Edit Workflow` | Edit custom workflows |
| `UnodeAi: Run Demo Task` | Send a demo task to the PM |
| `UnodeAi: Show Dashboard` | Open dashboard |
| `UnodeAi: Open Spend` | Open the Dashboard with its Spend section first |
| `UnodeAi: Change Spend Reminder Target` | Open Settings → Spend to set or change reminder targets |
| `UnodeAi: Reset Spend Counter…` | Reset a spend counter to zero (history is kept, and work is not touched) |
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
| `Manage Project Command Approvals` | Inspect or revoke this project's host-owned command approvals |
| `UnodeAi: Open Marketplace` | Open marketplace |
| `UnodeAi: Edit Team Rules` | Edit `.unode/rules.md` |
| `UnodeAi: Restore File Checkpoint` | Restore a checkpointed file |
| `UnodeAi: Crew Worktrees (Review)` | Review worktree integration state |
| `UnodeAi: Finalize Worktree Merges to Branch` | Land worktree integration branch |

**In a workspace you have not trusted, agents are read-only.** Writing, editing, deleting and running a
command are all refused. Since 0.9.70 they are refused in one place, with one reason. The message therefore
names Workspace Trust. It does not suggest that you grant a folder, which would not have helped. **There is
no per-command exception.** Trusting the workspace is the decision. You make it once, in VS Code's own prompt,
and an agent cannot ask you to make it command by command. Reading and analysing files still work.

When an untrusted folder opens, UnodeAi shows this read-only scope in a modal dialog, once for that activation.
Agents can chat, plan, read and search. Shell commands, file writes/edits/deletes, MCP servers and the verify
command are off. Run **Workspaces: Manage Workspace Trust** to enable them. Trusted and folderless windows do
not show the dialog. Granting trust does not produce a later warning.

Cursor does not currently expose that untrusted state. A 3.20.10 probe confirmed that repository settings take
effect. UnodeAi therefore reads all 45 authority-bearing settings only from User Settings (then the shipped
default), in every editor. These include Smart Mode, model-tier routing, pricing inputs and the skill-library
link. VS Code greys out project copies of these application-scoped keys and explains that they belong in the
Default profile. It removes the folder value before extensions can inspect it, so no UnodeAi notice is expected
there. UnodeAi's one-time ignored-values notice is a backstop for editors that do expose a project value.

*Allow for project* command approvals live in UnodeAi-owned workspace storage, not `.vscode/settings.json`. Use
`Manage Project Command Approvals` to inspect or revoke them. With no folder open, project writers have no
target. If the first folder changes during the session, running agents and Integrations stop, Team Rules closes, and later turns and saves are refused until you reload. They never continue in the old folder or fall back
to the editor program folder. UnodeAi-created terminals carry a marker that survives an extension-host restart.
As a result, activation and invalidation also close inherited terminals and their process trees. Terminals you
created yourself are not touched.

### Complete registered-command list

The following source-registered command titles are also available. Some are contextual actions that appear only
when the related view or agent is active.

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
| `UnodeAi: Generate Evidence Report` | Write the evidence report of a finished job. Nothing is run again |
| `UnodeAi: Start All Agents` | Start all team agents |
| `UnodeAi: Stop All Agents` | Stop all team agents |
| `UnodeAi: Add Agent` | Add an agent |
| `UnodeAi: Team Actions…` | Open the Team title-bar menu: build an agent, create/switch team, start/stop all, team rules, checkpoints, concurrency mode, Security, Settings, Account/Profile, Marketplace, evidence report |
| `UnodeAi: Build an Agent` | Open Agent Builder |
| `UnodeAi: Create Default Team (PM + Architect + Developer + Reviewer)` | Create the default team |
| `UnodeAi: Create/Save/Load a Team…` | Create, save, load, or switch a team |
| `UnodeAi: Save Team…` | Kept for existing keybindings. Hidden from the Command Palette |
| `UnodeAi: Open Saved Team…` | Kept for existing keybindings. Hidden from the Command Palette |
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
| `UnodeAi: Clear Chat` | Delete the messages shown in the active chat. The model's conversation is not reset, so the model may still remember them |
| `UnodeAi: Compact Context` | Compact the selected agent's context now. UnodeAi summarises older turns (OpenAI-compatible), or asks Claude or Codex to compact their own conversation. A receipt reports the result |
| `UnodeAi: Archive Chat` | Archive the active chat |
| `UnodeAi: View Archived Chats` | View archived chats |
| `UnodeAi: Export…` | Pick **Message log**, **Run evidence pack**, **Portable run evidence**, **Worker progress distribution**, or another export from the visible list |
| `UnodeAi: Export Chat` | Export the active chat |
| `UnodeAi: Import Chat` | Import a chat |
| `UnodeAi: Compress Chat View` | Toggle compact chat view |
| `UnodeAi: Clear Messages` | Clear messages |
| `UnodeAi: Export Messages` | Hidden implementation command. Use **UnodeAi: Export… → Message log** |
| `UnodeAi: Export Run Evidence Pack` | Hidden implementation command. Use **UnodeAi: Export… → Run evidence pack** |
| `UnodeAi: Export Portable Run Evidence` | Hidden implementation command. Use **UnodeAi: Export… → Portable run evidence** |
| `UnodeAi: Export Worker Progress Distribution` | Hidden implementation command. Use **UnodeAi: Export… → Worker progress distribution** |
| `UnodeAi: Import Messages` | Import messages |
| `UnodeAi: Compress Activity View` | Toggle compact Activity view |
| `UnodeAi: Collapse Team to Icons` | Collapse Team to icons |
| `UnodeAi: Expand Team Cards` | Expand Team cards |
| `UnodeAi: Set Provider API Key` | Store provider credentials |
| `UnodeAi: Show Agent Output` | Show selected-agent output |
| `UnodeAi: Show Prompted Command Frequencies` | Show the local, opt-in frequency table of command templates that reached approval prompts |
| `UnodeAi: Show Agent Terminal` | Show selected-agent terminal output |
| `UnodeAi: Restore File Checkpoint…` | Restore a file checkpoint |
| `UnodeAi: Saved Task Batches…` | Open or delete the saved batches of a task delivered in batches |
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

### Known issues retained in 0.9.94

- **The Team row of a stopped agent says `cost unknown`.** The row counts turns that completed. An agent whose
  only turn you stopped shows `0 turns` and `cost unknown`. The Job outcome card, however, shows what that
  turn used.
- **Tests can fail to start for an agent on the Claude CLI or Codex CLI route on Windows.** These agents run commands inside their own CLI, in the working folder that UnodeAi gives the CLI. That path can carry a lower-case drive letter (`c:\...`). When Vitest 4.1 is started from such a folder, it fails every file before
  any test runs, with `Cannot read properties of undefined (reading 'config')`. 0.9.92 corrects this only for
  agents on OpenAI-compatible and custom-gateway routes. Nothing is written or sent. The test run simply fails.

**Fixed in 0.9.96:**

- **After an extension host restart the Workbench looked live but did not answer.** VS Code keeps the tab, but
  never connects it to the new host. UnodeAi now offers to reopen it, restoring the unsent text from its saved
  copy. See [After an extension host restart](#after-an-extension-host-restart).
- **A reload could drop unsent chat text.** VS Code restores the Workbench before UnodeAi has loaded the team, and
  a chat page that saw no team yet dropped its drafts as belonging to removed agents. No chat page drops a draft
  now until the team is loaded.
- **A removed agent's draft could reappear under a new agent with the same name**, if a chat view was hidden
  while the agent was removed and created again. It no longer does, in either chat view.
- **Text typed while a message was being sent was cleared when the send was confirmed**, and so were attachments
  added meanwhile. Now only what was sent is cleared.

**Fixed in 0.9.94:**

- **A job whose coordinator you stopped before its first reply got its card late.** The job closed, and its
  card appeared, only after the coordinator's next reply to anything. Now, when no part of the job is still running, the job ends at the moment you stop the coordinator, and its card appears under the stopped turn. See
  [Job outcome](#job-outcome).
- **A reference price was not applied to a model the gateway names with a prefix.**
  `deepseek/deepseek-v4.1-flash`, OpenRouter's name for `deepseek-v4.1-flash`, got no estimate. The shipped price
  lists now include that name. No prefix is stripped, so another prefixed name still reads `Price unavailable`.
  See [Spend](#spend-what-a-request-cost-and-reminders).
- **Reasoning collapsed into an ordinary item when a turn ended without an answer.** It read as an answer that
  had been written and then removed. It now stays open, labelled **Work shown; no conclusion recorded**. See
  [Request summary](#request-summary).
- **An agent changed from Codex CLI to an OpenAI-compatible connection failed every request.** The provider
  answered HTTP 400, for example `text content parts must carry a string "text"`. Retrying, reloading and
  **Clear Chat** did not help. UnodeAi had sent the Codex backend's saved thread reference as if it were a chat
  message. A saved model conversation is now given only to the kind of backend that wrote it. An agent in that
  state repairs itself the next time it starts. See [Build your own agent](#build-your-own-agent).
- **The Workbench's message box was narrow in a short Workbench.** When the Workbench was under 560 px tall at
  100% zoom, the box shrank to the width of its own buttons and sat in the middle. This happened, for example,
  while the bottom panel was open. The box now keeps the width of the conversation.

**Fixed in 0.9.93:**

- **A coordinator on the Claude CLI route had to search for its team tools.** Its first request could not
  dispatch or close. It first had to spend a request finding the tool. The team tools are now part of the first
  request.
- **A coordinator that never started left you waiting.** A request that never reached a dispatch, a close or a
  reply simply kept running. It now ends after 60 seconds of silence, with a card that offers a retry, another
  route or a stop. See [A coordinator's first action](#a-coordinators-first-action).
- **A dispatch to a name that matched nobody made the coordinator do the task itself.** On a team with
  teammates, a target that matched none of them was treated as if no teammate could take the work. It is now
  refused with the current references.
- **Generate Evidence Report ran the verify command again.** It now writes what was recorded when the job ran.

**Fixed in 0.9.92:**

- **A team agent could not run Vitest on Windows.** A command that UnodeAi started for an agent on an
  OpenAI-compatible or custom-gateway route inherited the workspace path with a lower-case drive letter.
  Vitest 4.1 fails from such a folder before any test runs. An agent that had to see its tests pass kept
  retrying. Commands and agent terminals now start in the folder as a terminal spells it.
- **An agent could only wait for a background command by asking again.** Each `check_command` returned at
  once and re-sent the agent's whole context to the model. The agent can now wait in one step, for up to five
  minutes. It can also give a foreground command up to ten minutes, instead of the fixed two.
- **Consent dialogs were counted as the agent's time.** Turn time left out command, write and tool approvals.
  It did not leave out the dialogs for a network destination, a media upload, a read outside the workspace, a
  coordinator's brief, a repository's CLI configuration or an MCP mount. All of them are left out now.
- **The live line said `Thinking` while nothing was known.** Silence after a request is now shown as
  `Waiting for <provider>`. `Reasoning` appears only when the provider sends reasoning.

**Fixed in 0.9.91:**

- **Two Claude CLI agents in one folder shared a tool gate (security).** Since 0.9.28, every Claude agent wrote its
  hook file to the same place in the working folder. The agent started last decided the other agents' tool
  approvals. After it stopped, the other agents' tools ran without that check. Each agent now writes its own
  files. If you ran two or more Claude CLI agents in the same folder, update.
- **A failed delegation looked like a successful call.** A teammate's task could fail, time out, be cancelled or
  be refused by team policy. In each case, the coordinator's blocking `assign_task` still counted as a success.
  Also, a reply that merely began with the word "Error" was flagged as a failed task. The coordinator is now told
  how the task actually ended. A timeout is reported as an unknown outcome, because the teammate may still
  finish. A team-policy refusal that arrives after an async dispatch now reaches the coordinator instead of being
  dropped.
- **A result could finish the wrong tool card.** A result was attached to the latest open card with the same tool
  name. Each call now has its own id, on every runtime.
- **A refused team tool or cross-folder read reached Claude as a success.** Claude now receives it as an error.

**Fixed in 0.9.90:**

- **Claude spend was overstated.** The Claude CLI reports a running cost total for its process. Since 0.9.89,
  every turn after a process's first turn recorded that total as its own cost. Each turn is now charged only its
  own increase. Request and agent totals, and dollar reminders on an API key, are therefore right again. Token
  counts and token reminders were never affected. Turns recorded before this release keep their old figures.

**Fixed in 0.9.89:**

- **An agent could not wait on a long background command.** Repeated `check_command` polls of the same job were
  blocked as repeated identical calls. The agent could therefore stop early. A poll now counts as new only when
  UnodeAi itself saw the command make progress (new output, an exit or an error). A job that produces nothing new
  is still stopped by the usual repeat limit. Nothing the model writes can change that.

**Fixed in 0.9.88** (they had been listed here since 0.9.82):

- **Chat stuck at Sending… after the extension host restarts** (for example after **Don't Trust**). Within about
  10 seconds, the composer gives your draft back with its attachments. It says the send was not confirmed.
  Nothing is resent for you. Send again. If that send is also not confirmed, run **Developer: Reload Window**.
- **Delegation cards bunched together with raw agent ids after a reload.** Cards now return to their places, one
  per request, with names. See [Delegation cards](#delegation-cards).
- **A run stayed open after its interrupted task was replaced from a later message.** It now closes once, as
  partial. See [Stopping work a coordinator started](#stopping-work-a-coordinator-started).

### A team finished but the task didn't — **fixed in 0.9.34**

In 0.9.33, a teammate that finished after the Project Manager's bounded wait still reported back. Its work
was real and on disk. The PM, however, never woke up to use it. Later steps of a multi-step plan — running
checks, committing — silently never started. Meanwhile, the panel showed every agent as complete.

**Both halves of that are fixed in 0.9.34.** A result that arrives after the wait expires now reaches the
coordinator with its evidence verdict intact. A result that lands while the PM is mid-turn is no longer
dropped. It is held and offered again the moment that turn ends. A message you send still takes priority
over an automatic wake.

If you are on 0.9.33, the workaround still works: send the PM *"continue from the returned results"*.
On 0.9.34 you should not need it — **if you do, that is worth reporting**. It means that a third path exists
that neither fix covers.

### Open Settings or Refresh Model Prices seems to do nothing — **fixed in 0.9.78**

**First, check your editor's User Settings JSON for an error or a warning.** That is the cause. It is not
obvious, because nothing about the symptom points to that file.

Before 0.9.78, both commands ran a legacy price-coefficient repair *before* doing what you asked. The repair
writes to User Settings JSON, and an editor refuses that write while the file has a problem in it. The command
therefore failed at its first step, and the panel never opened. No error appeared. **This was never specific
to one editor.** It was first reported in Cursor, but the refusal is stock VS Code behaviour. VS Code's own
message for it is *"Unable to write into user settings. Please open the user settings to correct
errors/warnings in it and try again."*

**On 0.9.78 the order is reversed.** The Settings panel opens, and a price refresh completes and reports
its result, before the repair is attempted at all. A repair that then fails shows a warning with an **Open
User Settings (JSON)** button, instead of swallowing your command.

**If you are still on 0.9.77 or earlier**, the workaround is the fix. Open User Settings JSON
(`Ctrl+Shift+P` → *Preferences: Open User Settings (JSON)*) and clear every error and warning. The commands
then work again.

### The UnodeAi icon is gone from the Activity Bar

Run **`View: Reset View Locations`** from the Command Palette.

VS Code lets you drag a view container out of the Activity Bar into the bottom panel or the secondary
side bar. It remembers that placement in its own settings. As a result, **reinstalling the extension,
restarting VS Code, and updating to a new version all leave the icon missing**. Reset View Locations puts
every container back where it belongs.

You can tell this apart from a truly broken install in two seconds. If `Ctrl+Shift+P` → `UnodeAi` still
lists the commands, the extension is installed and running, and only its placement is wrong. (While the icon is
missing, you can still reach every surface by command, for example `UnodeAi: Show Team Panel` and
`UnodeAi: Open Workbench`.)

### Agent says no API key is configured

Run `UnodeAi: Set Provider API Key` and store the right secret for the provider.

### A command was blocked

Check `unode.commandApproval`. If it is set to `allowlist`, add the command prefix to `unode.allowedCommands`. If it is set to `ask`, approve the command from the Workbench approval card.

### A write is waiting for approval

If `unode.writeApproval` is `ask`, approve or deny the diff in the Workbench transcript.

### PM cannot run checks

Set `unode.verifyCommand` and make sure `unode.commandApproval` allows that command.

### A model rejects `reasoning_effort` or `response_format`

Set that field back to its default, so that it is left out of the request. The default is `Text (provider default)` for response format, and blank for reasoning effort. Many gateways reject optional model parameters that they do not support. This includes an explicit `"type": "text"`, which they would have applied anyway.

### "The gateway at … returned HTML, not JSON"

The Base URL points to a web page, not an OpenAI-compatible API. The cause is almost always a missing `/v1`.
Use `https://host/v1`, not `https://host`. Fix it with **Edit** on that gateway's Providers card, then run
**Test connection**. UnodeAi reports this as a plain diagnosis. It never shows you the returned page, because a
login or proxy page can carry account information.

### Test connection fails

Read the message. Each cause has its own message:

| Message | What to do |
|---|---|
| *Set an API key for `<name>` before testing* | No key stored. Card → **Edit** → **Replace API key**. |
| *`<name>` returned HTTP 401/403 while listing models* | The key is wrong, expired, or not valid for this endpoint. |
| *`<name>` returned HTTP 503 …* | The gateway is up but has no capacity right now. This is the gateway's own answer, not a UnodeAi failure. Retry later. |
| *returned HTML, not JSON* | Wrong Base URL — see above. |
| *The model catalog for `<name>` could not be reached* | DNS/network/host down, or an endpoint that isn't serving `/models`. |
| *Network access could not be confirmed* | You declined metadata consent for that host. Approve it in the Security panel, or run the test again and accept. |

### Removing a gateway is blocked

Remove is refused while anything still points to the gateway. The message lists each reference. Rebind those
agents in Agent Builder, move the new-agent default elsewhere, and clear the gateway from any Smart Mode tier.
Remove then succeeds, and the gateway's stored key is cleaned up.

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
5. Require an independent Reviewer PASS before you consider the work done.

For sensitive codebases:

1. Use Plan mode for initial review.
2. Set `unode.commandApproval = ask`.
3. Set `unode.writeApproval = ask`.
4. Keep MCP servers default-deny.
5. Store project constraints in `.unode/rules.md`.
