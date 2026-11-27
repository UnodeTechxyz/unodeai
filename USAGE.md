<p align="center">
  <img src="images/unode.png" alt="UnodeAi" width="96" height="96">
</p>

# UnodeAi User Manual

Version covered: UnodeAi 0.9.110

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

### Start your first task

There is no setup wizard. First use happens in the **Workbench**, the UnodeAi tab in the editor area.
`UnodeAi: Get Started` opens it. The sidebar **Chat** (`UnodeAi: Open Chat`) shows the same screen. While you have
no agents, the Chat shows only this:

- **What do you want to get done?** and one line that says what happens next;
- up to three suggestions. Clicking one only puts it in the message box, where you can change it;
- the message box and **Send**. A long goal grows the box to part of the Chat's height, then scrolls inside the
  box, so **Send** stays in view also in a narrow or short Chat.

Write your goal and press **Send**. Send does not start the task yet. UnodeAi first checks the connection the task
will use, without sending anything to a model, and then shows one of two things, never both:

- **A connection card**, when something is really missing. It names what is missing and offers one action, plus
  **Use a different connection**:
  - an API-key connection without its key: **Set the API key** opens VS Code's secure key box. A stored key shows
    the connection is set up; the first task shows the account can run it;
  - the Codex CLI: not found (**Choose the Codex CLI…**), a version UnodeAi does not support, or not signed in;
  - the Claude CLI: not found (**Choose the Claude CLI…**) or not signed in. UnodeAi asks the CLI with
    `claude auth status`, which sends no model request. A CLI that cannot answer that is checked by the first task.
    When VS Code's environment holds `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN`, the
    task's Claude CLI signs in with it: UnodeAi then only notes that it is there (it does not read, show or try the
    value) and the first task confirms it;
  - a custom gateway: its key (in **Settings → Providers**) or the model to use (**Choose a model**). Cancelling
    the model choice keeps your goal and starts nothing.

  For a CLI that is not signed in, **Open a terminal** opens a terminal with the login command typed in
  (`codex login`, or `claude auth login`). It does not run it, and opening it does not sign you in: run it there,
  finish signing in, then press **Check again**. After any repair you still choose how to start; nothing starts on
  its own.
- **The two start buttons**, when the connection is ready. Each says what it costs before you choose:
  - **Start this task with the three-person team** (recommended): a project manager organises the work, a
    generalist does it and a reviewer checks it independently. It can take several model calls, billed through
    your connection. A Solo agent is added too, for small everyday tasks, so four agents appear.
  - **Start this task with Solo**: one agent does the work directly. Checking its own work is not an independent
    review.

  The button is the start: it creates the agents on the connection shown and sends your goal, with no further
  question. Below them, **Use a different connection** changes the connection for this task only (the default
  for new agents stays as it is), and **Custom team…** opens the full team picker.

Pressing a start button twice starts the task once. Your goal is kept in the workspace until it is sent: closing
the Chat, closing the Workbench tab or reloading the window keeps it. If the window closes while the agents are
being created, the goal comes back unsent and nothing is sent again by itself. If you create a team another way
first (**Custom team…**, a saved team, or one agent), the goal moves into the message box of its project manager,
or of the first agent, still unsent. If that agent already has text in its message box, the goal stays aside as
**Unsent goal from your first task**, with **Move to message box**.

The first task runs as any task does. Creating the agents from the Chat asks nothing afterwards: no key prompt, no
"send the PM a task" notice, and no question about Run commands. If you turned Run commands off, it stays off. In a
folder you have not trusted, you can still write the goal, choose a connection and create the agents; VS Code's
Workspace Trust decides what the agents may do.

The Team panel with no agents shows one button, **Start your first task**, and one link, **Custom team…**. Its
**Status key** appears with the first agent. The button opens the Workbench on the first-task screen, as
`UnodeAi: Get Started` and **Settings → Providers → Start a task** do. If the Workbench is already open, it
comes to the front; a second one never opens. With agents, Get Started opens the Workbench as **Open Workbench**
does, and the Chat is exactly as before.

**When UnodeAi first appears.** After a fresh installation, UnodeAi opens the Workbench once, in the editor area,
without taking the focus from what you are doing. It does this only when nothing shows UnodeAi was installed before
in this VS Code profile (its stored state, its storage folder, a `unode.*` user setting or a stored key) and the
workspace has no team. If it cannot tell, it shows nothing. After an upgrade or a reinstall nothing appears on its
own.

**Coming back.** A workspace that has a team opens with that team, as before. If it has none but you have saved
teams, the Chat offers **Load your team: <name>** at the top: the saved team you opened last, or, when UnodeAi has no
record of that, your most recently saved team (the line under the button says which). **Other saved teams…** opens
the team picker. Loading a team works exactly as opening it from the picker, permission review included, and never
sends your goal.

### Setup guide

The setup guide goes through the basic setup in one editor tab. Open it with `UnodeAi: Setup Guide`, **Team
Actions… → Setup guide…**, **Settings → Providers → Setup guide**, or the line under the first-task screen: "Want to
set everything up first? Open the setup guide". It never opens by itself, and closing it records nothing.

It has six steps. Each shows what is set now and opens the place where it is changed. Open any step from the list on
the left, or with **Back** and **Next**:

1. **Connections**: each connection with what is known without starting anything: whether a key is stored, which
   CLI program UnodeAi starts and the version last checked. **Set API key**, **Check / choose CLI**, **Open a terminal
   to sign in**, **Add custom gateway**, **Test connection** and **Set as default** do what they do in Settings. The
   sign-in command is typed into the terminal, not run. Only **Set as default** changes the default for new agents.
2. **Team**: with no agents, **Create the starter team** or **Create Solo** on the connection chosen here. For a
   custom gateway you can also choose its model; left empty, the model picker asks when you create. This choice is
   for that team only. Creating adds the agents and nothing else: no task is sent and nothing asks afterwards. A goal
   already written on the first-task screen moves into the new team's message box, unsent, as with any team. With
   agents, each one is listed with **Edit**.
3. **Permissions and safety**: commands, file writes, Autonomy, web access, MCP, Workspace Trust and keys, as they
   are in effect now, each with the place to change it. An Off stays Off. **Enable commands for this project**
   appears only while commands are Off, and asks you to confirm.
4. **Folders**: each agent's Folder Access, with **Edit**.
5. **Skills and MCP** (optional): the mounted MCP servers, and each agent's grants, skills and playbooks.
6. **Continue in Workbench**: opens the Workbench on your project manager's conversation, or Solo's, or the agent
   you selected. Nothing is sent; you write the task there. With no agents it opens the first-task screen.

**Check readiness** checks the connection chosen for a new team. For a CLI it runs the program to check its version
and sign-in; for an API key it only looks for the stored key. It runs only when you press it. If something is
missing, one card says what and offers the fix. A cancelled fix is shown as cancelled. When a CLI is ready, its row
shows the version it reported, "checked by Check readiness here". The guide only shows it: Settings → Providers keeps
its own record of CLI checks, which this does not change.

The guide never sends a task, never loosens a permission and never shows a key.

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

**Claude CLI and Codex CLI need no key stored here.** Claude drives the logged-in `claude` CLI. Codex drives the logged-in Codex CLI through `codex app-server --stdio`. To see or change which program UnodeAi starts, use **Settings → Providers → Claude CLI** or **Codex CLI → Check / choose CLI…** (or the `unode.claudeCliPath` and `unode.codexCliPath` User settings). See [Which CLI program UnodeAi starts](#which-cli-program-unodeai-starts). UnodeAi never reads or copies `~/.codex/auth.json`, `~/.codex/config.toml`, or `CODEX_HOME`, and never injects an OpenAI API key. You can use Codex CLI 0.155.0 or newer. Windows validation records 0.155.1, and every newer build must still pass the live App Server handshake and the effective-policy checks. Codex consent is bound to that executable: choosing a program is your consent, and switching to another binary records a new grant with a new notice. If a new editor has no cache of account models, choose **Load models from Codex** in the Agent Builder. After the executable and login are verified, a short-lived App Server runs from extension storage—not the workspace. It requests only the list of models your account can see, stops, and caches that list for that program and version. After you approve startup, your native Codex hooks, notification command, MCP servers, plugins and configured model provider remain available. MCP grants that UnodeAi manages are separate. The extension host exposes only that agent's approved tools, without adding them to the global CLI configuration. MCP tool calls that Codex routes for approval get a UnodeAi card. But an MCP tool that Codex calls from inside its own `exec` code tool (measured with the bundled `node_repl` plugin) runs with no approval request.

**A slow Codex start is not failed.** Until Codex answers, the agent's row shows `Codex is still starting (N s). Press
Stop to cancel.` every 10 seconds. A Codex restart under a waiting turn says once: `Codex is restarting and has not
answered yet (N s). Your turn waits for it; press Stop to cancel.` If Codex has not answered after 30 seconds, UnodeAi
reports that Codex CLI version as bad, and says so in the chat and in a notification with **Open Codex CLI
settings**: `Codex has not answered for 30 s, so this Codex CLI version looks bad, and UnodeAi has reported it.
Update the Codex CLI: open Settings → Providers → Codex CLI → Check / choose CLI…. This start keeps waiting; press
Stop to cancel.` For a managed Codex version, the report runs UnodeAi's check of it once; if that check fails too,
new sessions stop using the version. An error reply or an exit still fails the start.

With cached Codex account models, Agent Builder still offers **Refresh models from Codex**. Click it to request
the list again through the same checks and consent; opening the picker does not request it. Refreshing does not
update your CLI or give access to a model that it does not return. The line under the model field then says how
many models that Codex version returned, or why none were loaded, until the next load. Version-check failures show
which executable was checked, its exit status or signal, and its output. On a Codex command approval card, the final Shell line
comes from UnodeAi, not the model's explanation. The Team waiting summary shows the command alone. These cards
still offer only **Allow once** and **Deny**.

Claude Code subscription logins report API-equivalent usage, not an invoice. UnodeAi shows that as `Subscription (API-equivalent ~$...)` with a tooltip in the Team panel (see [how an amount reads](#spend-what-a-request-cost-and-reminders)). A plain `$...` means billed API or key usage. Before a completed turn establishes a billing basis, the UI says **cost unknown** instead of showing a made-up `$0`.

**Every way of storing a key asks what that key pays.** You may store a key from any of these places:

- this command
- the Settings › Providers **Set key** / **Edit** buttons
- **Set the API key** on the Chat's first-task screen
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

**What a team is made of.** UnodeAi ships 54 role templates and 27 team presets, among them the three-person
Starter Team, Hardware Procurement, Software Engineering, Marketing, Sales, Contract & Compliance, Security &
Governance, Business Operations, Revenue Operations, Customer Experience, Data Intelligence and Product Discovery.
Each part of a team has a company equivalent:

| Part | The company equivalent |
|---|---|
| **Role** | a job title with a mandate |
| **Skills** | the procedures that job runs on, loaded when they are relevant |
| **Manager** | a project manager agent that assigns work and collects results |
| **Workflow** | a repeatable handoff between roles |
| **Authority** | what this position may reach, and what needs approval first |
| **Evidence** | the record that outlives the conversation |

**Team order in 0.9.107.** Drag a member's name/body up or down to move their row. Buttons keep their normal actions;
a short click still opens the member, and Escape cancels a drag. For the keyboard, focus the member's name/body and
press **Alt+Up** or **Alt+Down**; the new position is announced. There is no separate reorder control. Normal and compact mode use the same order.
The preference stays in this workspace across reloads. New members go last and removed members leave the list.
Visual order does not change the coordinator, delegation, Start All or the order in saved teams. Running members can
be moved without stopping their work.

**Permissions.** Open **UnodeAi Settings → Team → Permissions**, then choose **Commands**, **File writes**, **Network access**, or **Autonomy** to open that existing VS Code User setting. These settings apply to all profiles. Opening a link changes nothing. In Commands, `none` is Off, `ask` asks each time, `allowlist` uses your allowed prefixes, and `all` is Automatic.

**One member's instructions in 0.9.107.** When you add one member, the existing result offers **Edit X's
instructions**. In Agent Builder, the result and action stay in that panel. The action opens that member's Builder
and focuses **Instructions**; it does not change anything until you edit and save. Ignoring it keeps the role's
default instructions. Team-wide rules belong in **Team Rules**; rules for one member belong in that member's
**Instructions**. Creating or loading a whole team does not ask you to edit every member.

Open the UnodeAi sidebar from the Activity Bar. It is the compact view for navigation and status. In it,
**the roster** is the main entry point, followed by compact session rows. Each row shows one agent's current
responsibility and lifecycle.

The Team title bar shows the version beside the title. It pins at most four icons: **Open
Workbench** (New Task), **Add Agent**, **⋯ Team Actions** and **Settings**. A title bar is a fixed-width row; if
something does not fit, VS Code hides it in an unlabelled `...` overflow, so the row stays short. **⋯ Team Actions**
lists every other team action by name: Solo Agent (toggle), Send Message to Agent, collapse/expand the roster, Build
an Agent, Create/Save/Load a Team, Start/Stop All Agents, Team Rules, Run Workflow, Edit Workflow, Saved Task
Batches, Restore/Delete File Checkpoint, concurrency mode, Dashboard, Marketplace, Unode Account / Profile, Security
and Generate Evidence Report. Solo, Message and Collapse/Expand were title-bar icons in earlier versions. A member's own
Stop button and pending approvals stay on its row.

**While the team is empty**, the sidebar stays quiet: the Team title bar shows only **Settings**, the Chat title bar
shows no icons, and the Activity view is hidden. If you used UnodeAi before (for example after reinstalling it), the
Team title bar also keeps **Add Agent** and **⋯ Team Actions**. As soon as the first agent exists, every icon and the
Activity view come back. **UnodeAi: Team Actions…** is also in the Command Palette, so every entry above stays
reachable in every state.

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
Replace prepares and validates every new agent before stopping the old team. Cancelling the connection
or model picker changes nothing. It then uses the same guarded snapshot, stop-confirmation and roster/check-policy
transaction as loading a saved team; new agents remain stopped. An absent incoming policy does not inherit the
outgoing team's explicit check. A preset's recommended command is saved only to the new team's settings if
you explicitly accept it, not to `unode.verifyCommand`. Add never changes the current team's check policy.

### Additional built-in roles

You can add individual agents with:

```text
UnodeAi: Add Agent
```

Common roles include Product Manager, QA Engineer, DevOps Engineer, Technical Writer, Security Engineer, Data Engineer, Reviewer, and Solo.

In Agent Builder, a known built-in role has **Run commands**: **Follow role template**, **On**, or **Off**.
It is independent of capability checkboxes and never approves a command. Existing explicit choices survive
ordinary name/model/prompt/skill edits. Old built-in agents without a choice adopt **Follow role template**
when loaded, with no confirmation. Explicit Off and custom/unknown role tools remain unchanged.
The preview names command additions from the template and points to **Off**, not to unticking an unrelated skill.

An explicit **On** takes effect only after storage succeeds. Saving **Off** narrows the live configuration and
detaches the existing runtime before waiting for storage; no task is replayed. If saving fails, Off stays in
effect in this window, and other work and team switching remain available. UnodeAi retries on the next roster
write and at shutdown; a reminder never claims an unsaved choice will survive reload. An already Off agent
is not stopped merely because its name or other settings are saved. A team switch force-stops an outgoing
process that did not confirm Stop and continues with a notice. If rollback fails, the current team file is reloaded.
Snapshot failure also shows a reminder and continues switching; that switch has no recoverable snapshot.
The current Codex connection cannot independently disable native commands, so saving **Off** on that route
is refused without changing the agent. Choose a connection that can enforce it.

When an old built-in record has no command choice, loading it adds only the template command tool and records
Follow role template in the current roster. One output line names how many agents gained commands and points
to Agent Builder to turn them Off. No task is started or replayed; saved archives are not rewritten on load.
There is no legacy-choice dialog or review button. An explicit Off always stays Off.
This includes a saved project file carrying an explicit Off marker; parsing cannot drop it and re-enable commands
during migration. A native Codex agent with Off cannot start, since that connection cannot enforce independent
command disabling. Choose another connection for that agent; other agents remain available.

**What a built-in role can do.** A new agent made from any of the 53 built-in roles, by a team preset, **Add
Agent**, **Build an Agent** or the Marketplace, can read, search, write files, request commands and message its
teammates. A connection that cannot write files or run commands leaves those out, and the UnodeAi output names them. Only the
Project Manager also assigns work. A role's title sets what it focuses on, not which tools it has: an analyst can run a calculation, a designer can build a working prototype, and a Reviewer can run the checks
its verdict depends on. These are what the agent may ask for, not approvals. Workspace Trust, the command policy,
your **Autonomy** choice, Plan mode, Folder Access, task limits and an explicit **Off** still decide each call, and
an action that leaves this computer (a push, a publish, a message sent, a purchase) still needs your go-ahead for
that exact action.

- **Engineering roles and the System Architect** read, write and run commands.
- **Roles that review or assess** (Reviewer, Application Security Engineer, Privacy & Data Protection Officer,
  GRC Analyst) can write their review, quality report or assessment to a file, reproduce a problem, add a test or
  fixture that shows it, and run the project's checks. What they add is their own contribution, and they say so.
  If one changes the work it reviews, its verdict no longer covers that change: it delivers the change with its
  checks and its review of the earlier version, and says the changed version is not yet independently reviewed.
  Nothing in the tool list stops such a change. For mediated write and command review,
  use **Ask for approval** in the selected agent's chat **Autonomy** menu; remembered decisions still apply. To disable
  writes, untick the capability that grants Write files for that agent in Agent Builder. Native Codex review
  concerns escalation; see [Autonomy](#autonomy) for its differences.
- **Drafting roles** (for example Product Manager, Business Analyst, Brand Strategist, Customer Support) can also
  request commands when their work needs them; the same command policy and approval apply.
- **Sales and customer-success roles** produce drafts and plans for a person to send or run. UnodeAi has no tool
  that sends a message, books a meeting or changes an account record.
- **Research roles** can search the web on the Claude CLI route. On a gateway route they can fetch a page they
  are given but cannot search.

Every command still goes through Workspace Trust, the command policy and your approval. A team saved by an earlier
version keeps the tools it was saved with. An agent that lacks Run commands says so instead of working around it.
Agent Builder shows, beside **Save**, what a save would add.

**How every agent is told to work.** Each built-in role's instructions say what it delivers, how it checks that
work and what it hands over. After the instructions, every agent, built-in or your own, gets one short shared
section, **How to work**:

- start from the usable result you want, and use enough method to deliver it;
- go on with routine work it is already allowed to do, and when something is missing, say what it is and how to
  get it;
- fit the checking and coordination to the impact, and to how easily a mistake can be undone, without skipping a
  check the work needs or a review the project requires;
- report effects and checks from what UnodeAi observed, and never call something passed that was not checked;
- keep your limits and the project's review and release rules.

The Project Manager is also told to do a small task itself and to divide work only where dividing helps. A Reviewer
is told to confirm what actually triggers a problem, and what it does to you, before calling it a blocker. Every
other agent is told not to turn work down because of its role's title. The section grants no tool and lifts no
limit. Instructions you wrote yourself are kept word for word; the section follows them.

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

**Create/Save/Load a Team is the one home for named saved teams.** **Save current team...**, with a green icon, is
always first. **Restore a previous team...** follows when an automatic snapshot exists. Below them, **Load system
defaults** lists the built-in teams and **Load saved teams** lists named project and personal saves. A trash button appears only on a named
save, never on a system default. Automatic snapshots keep their separate delete control inside
**Restore a previous team...**. `unode.saveTeam` and `unode.openSavedTeam` are still available for existing
keybindings, but they are hidden from the Command Palette.

**A saved team file never grants execution authority by itself.** A **This project** save also records a
fingerprint of the file's exact bytes and path. The fingerprint is kept in UnodeAi's own storage, which the
repository cannot write to. When you open that exact save, it loads with its saved permissions and no question,
because UnodeAi recognises the file it saved. An agent saved with **Run commands** set to **Off** stays Off. A Codex
agent keeps its saved native Codex choice, **Ask for approval** or **Full access** (see [Autonomy](#autonomy)); an
edited or copied file loads it as **Approve for me**. A project save made by an earlier version recorded no native
Codex choice, so its Codex agents load with **Approve for me** until you save the team again. If you
change even one byte, copy the file elsewhere, or open it from a clone, the team first loads read-only. UnodeAi
then opens an unticked review for each affected agent. Nothing is granted until you tick it. Restored tools stay capped at the saved `allowedTools` ceiling,
with one explicit exception: a recognised source's saved **Follow role template** or **On** command preference
can restore **Run commands**, and no other tool. A saved **Off** cannot be overridden by skills. A built-in agent
that loaded with **Run commands** keeps it when its permissions are restored or reviewed. These preferences
travel in the host-owned global library or a fingerprint-recognised project save, not ordinary `team.json`.
Copied/changed files cannot supply this exception. A source changed while switching or restoring permissions
is refused, with an un-published grant compensated in host storage. Loading read-only does not restore an On
choice; a trusted Off remains Off. Old archives are not rewritten by loading them.
After an unticked review, the completion notice reports how many agents regained selected permissions. It calls
the team read-only only when no agent regained any.

Opening a saved team or automatic snapshot copies that team's raw completion-check policy into this
workspace's `.unode/team.json` along with its roster. If the save has no explicit policy, the outgoing team's
explicit command is removed; the incoming team's normal compatibility rules apply. Workspace workflow
definitions, integration definitions and Smart work-profile overrides are not replaced by library contents.

During this saved-team switch, new tasks wait outside admission. Running workflows are cancelled and the old
agents are stopped, not automatically restarted. If an old process cannot be confirmed stopped, the switch is
refused and the previous roster remains stopped. Storage failures restore the previous roster and original
team-file bytes where recovery is provable. If an external edit or failed recovery makes that unsafe, tasks
remain blocked: repair the configuration and reload the window. Old settings cards and permission-review
answers do not carry over to the replacement team.

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
- **`env` and the legacy agent `autoApprove` field are never imported or written.** Approval choices live in
  the chat input's **Autonomy** menu for the selected agent. See [Autonomy](#autonomy) for native Codex
  differences.
  UnodeAi has no supported project-file setting for the environment of a provider process. MCP secret
  placeholders belong in SecretStorage.

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

For a hardware buying project, choose **UnodeAi: Create/Save/Load a Team… → Load system defaults → Hardware
Procurement**. It creates a Project Manager, Procurement Analyst, Hardware Technical Analyst, Financial Analyst and
Contract Analyst, plus the standalone Solo agent included with every team. The technical analyst checks exact models,
compatibility, capacity, power and cooling against sourced specifications and proposes acceptance checks. The other
specialists compare supplier quotes, total cost and commercial terms; the PM combines their findings into a purchase
recommendation. Supply the workload, quantities, budget, delivery requirements and any existing quotes. The Hardware
Technical Analyst is also available separately through **Add Agent** and Marketplace **Role Templates**.

| Preset | Roster (PM +) | Use it for |
|---|---|---|
| Business Planning | Strategy Lead, Market Researcher, Financial Analyst | Plan a business direction with strategy, market, and finance input |
| Business Analysis | Business Analyst, Market Researcher | Clarify requirements and market context for a business problem |
| Financial Analysis | Financial Analyst, Business Analyst | Model financial trade-offs and explain the assumptions |
| **Hardware Procurement** | Procurement Analyst, Hardware Technical Analyst, Financial Analyst, Contract Analyst | Compare hardware suitability, supplier quotes, total cost, delivery, warranty and contract terms |
| **Marketing** | Content Strategist, Growth Marketer, Market Researcher, SEO & Analytics Specialist | Run marketing with content, growth, research, and analytics specialists |
| **Sales** | SDR, Account Executive, Sales Engineer, Customer Success Manager | Run a B2B sales motion from outbound through close to renewal and expansion |
| **Contract & Compliance** | Contract Analyst, Privacy & Data Protection Officer, GRC Analyst, Procurement Analyst, Technical Writer | Read agreements, review DPAs and vendor packages against a named framework, and draft playbook-traced redlines |

**The Contract & Compliance team stops where a person with authority has to decide.** That is a property of
the roles, not a caution in the prompt:

- The **Contract Analyst** extracts every field with a quoted source span. It writes `not found` instead of
  inferring a value. Its redlines cite the playbook rule behind each change. They are addressed to your own
  side, and they are never text ready to send to the counterparty.
- The **Privacy & Data Protection Officer** and **GRC Analyst** do not assign work. Like every built-in role, they
  can write files and request commands. They put their assessment in a report file, and if one changes an artifact
  it assesses, it says that its assessment no longer covers that change. They produce
  `present / absent / ambiguous` results against a framework that they must name before they start.
- For sanctions, export-control and licensing questions, the bundled skill can research and analyse with sources,
  gather the facts and state the question for a named human owner. It **never clears a party or transaction,
  gives a final item classification, or says a transaction is permitted;** that decision belongs to the human
  owner. A wrong determination there creates exposure to criminal liability, and a screening result from an agent
  would be relied on as a clearance.
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
- **Skill playbooks** — attach authorized Agent Skills. Native discovery entries contain host-authored names, descriptions and instructions to use the host skill reader. `load_skill` returns the original body, installed resource root and inventory; `read_skill_file` reads source text or binary metadata. Bundled skills may include scripts, schemas and other resources. Loading them executes no helper or installation. Helpers run only as ordinary commands under the current Commands and file permissions. A separate compiled Skill action still requires Workspace Trust and a fresh digest-bound **Allow once** decision through `run_skill_action`; source resources cannot select an arbitrary executable action.

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
- **MCP grants** — give the agent access to registered MCP servers, or add a new one. For both Claude and Codex, the extension host remains the external MCP client. It publishes only the approved tools and rechecks the live grant when a tool is called. A granted managed integration never holds up or fails the agent's start. The start waits up to 45 seconds for integrations that are still connecting, then goes ahead without the ones that are not ready. The chat says so: `Started without this integration: NAME (reason). Its tools are not available to this agent yet.` A notification offers **Retry**; nothing waits for your answer. An integration that was still connecting keeps connecting in the background. When it connects, the chat says `NAME is connected; its tools are offered from this agent's next request.` On a Claude or Codex agent it says `NAME is connected; restart the agent to give it its tools.`, because those CLIs take their tool list at start. The user's native CLI MCP remains separate. Claude's native calls stay behind Claude's UnodeAi tool gate, while Codex applies its own native approval behavior. UnodeAi's own Claude bridges get unpredictable per-session names, and only their exact tool names are allowed automatically. A native server named like a UnodeAi bridge therefore receives no special treatment.

Agents running at the same time wait independently on one shared managed-integration mount. One agent's
deadline therefore cannot cancel another agent's valid wait. A missing or empty SecretStorage value fails before
the server starts, and it is reported by variable name only. Marketplace → **Integrations** →
**Your integrations** lists every configured custom or catalog integration with its connection and grant status.
Choose **Grant to…**, select the members who should have direct access, and press Enter to save. Clear the
selection to revoke all direct grants, or press Escape to leave them as they are. Skill grants and their tool
filters stay in effect and are managed in **Agent Builder**. A revocation applies to the next tool call.
For new API assignments, the picker shows whether access starts on the next request or the next member start.
Changing a Codex member's assignment starts a fresh
model conversation on that member's next start. The earlier chat stays visible.
Use **Edit** on the same card to change the display name, transport, command, arguments, endpoint or environment
placeholders. A name change keeps the connection running. A launch change disconnects the old configuration.
The next start of a member with access uses the saved configuration and asks for startup approval if needed.
**Reconfigure** on a configured catalog entry opens the same editor.
If a previous save could not verify the configuration, the card shows it as paused, including after reload.
Open **Edit** on that card and save the intended configuration to resume it.
Choose **Test** to connect briefly and list the tools without calling one. A first test asks for startup approval
for the saved configuration. A later member start can use the same approval. The card shows the result and the
number of tools found. **Stop** ends the test, while members already using the integration keep working.
**Remove** names the affected agents, revokes saved and live grants, and cancels active calls. It removes the
configuration and approval record without deleting shared secrets.

**A slow MCP tool call is not cut off.** UnodeAi sets no time limit on a tool call; the call runs until the server
answers or you press **Stop**. A timeout you configured for the server still applies. When that timeout ends a call
after it was sent, the server stays in use, the outcome is unknown, and the call is not run again. The result says:
`MCP tool "X" reached its configured time limit of N ms after it was sent; its outcome is unknown. It was not run
again. Check whether it took effect before you repeat it.` A call cancelled before dispatch is `cancelled`. A call
cancelled after dispatch is `outcome unknown`. In that case, the late result is discarded, and the connection is
taken out of use while UnodeAi reconnects automatically through the same approved mount path. Calls made during
recovery wait for that attempt or report the integration as temporarily unavailable. They are never misreported as
a revoked grant.

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

**A save never widens an agent without saying so.** Saving a saved agent again, for example after a new name or
model, keeps the tools it holds. A capability it already has does not add a tool it lacks, even when that
capability has gained a tool in a newer version. A capability you tick in this save brings its tools: before you
save, the form shows, for example, `Saving adds to this agent: Write files` beside **Save**. Untick that capability
to keep the agent as it is. Unticking a capability takes away only the tools no remaining capability gives; a tool
the agent holds on its own stays.

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

**You can chat without opening a folder.** In a window with no folder open, an OpenAI-compatible agent starts and
takes turns for chat and planning. It has no file or command tools, no Folder Access, no MCP integrations and no
skills. The team and its conversations are kept in memory for this window only; nothing is written to project
state. The first time, a notice says: `No folder is open, so agents chat without file or command tools, and this
team and its conversations are kept only in this window. Open a folder to give agents their tools and keep the
team.` A Claude CLI or Codex CLI agent still needs a folder, because its own tools reach the file system. It does
not start, and the reason says: `Open a workspace folder before running this agent. Without a folder,
OpenAI-compatible agents can still chat, without file or command tools.` To give agents their tools, open a
folder with **File → Open Folder…**.

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
  folder.
- **It never discards newer work silently.** The file should still hold what UnodeAi last recorded for it. If you,
  another program, or anything UnodeAi did not record changed it since, or the file has unsaved changes in an
  editor, the confirmation says so and offers **Keep current file** or **Restore anyway**. Restore anyway first
  keeps the current contents as a new restore point, listed in the Edit history under **You**, so **⟲** on it brings
  them back; unsaved text stays in your editor. If the current contents cannot be kept, the confirmation says they
  cannot be brought back. If the file changes again after you choose, the restore is refused.
- **It says what it undoes.** Restoring an older edit also undoes every later recorded edit of the same file, by
  any agent. The confirmation counts them and names whose they are, for example `3 edits (2 by Dev, 1 by QA)`. If
  the file changes while the confirmation is open, the restore is refused.
- **It puts back the exact bytes when UnodeAi kept them.** Before UnodeAi's own file tools (`write_file`,
  `apply_edit`, `apply_patch`, `delete_file`) replace or delete an existing file, they keep its exact bytes, and only
  then make the change. The same holds for a Claude or Codex member's own file tools, when the change
  passes through UnodeAi before it is made: Claude's file edits through UnodeAi's hook, and Codex's file changes when
  Codex asks UnodeAi to approve them. A change that did not pass through UnodeAi first is listed as changed by the
  provider's own file tool, with no exact restore point. A restore of a change with exact bytes puts those bytes back,
  so a file that is not UTF-8 text, or a binary file, comes back byte for byte. The confirmation says which kind of
  restore point it uses: **exact bytes kept before the edit**, or **text copy kept by UnodeAi** for a restore point
  that holds only the text, such as one recorded by an earlier version or for a Claude or Codex change that did not
  pass through UnodeAi first. When the exact bytes can no longer be read, or
  no longer match what was kept, the restore is refused; the text copy is never used in their place.
- **A binary file can be replaced as a whole.** `read_file` does not show a binary file, but the refused read still
  counts as a read. So an agent can replace the file with `write_file`, with its exact bytes kept first, and the write
  is refused if the file changed after that read.
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
storage, in a folder of their own for each workspace that every window of the workspace shares; never in the project
and never sent anywhere. A workspace keeps at most 256 MiB of them, each for at most 30 days, and at most 200
restore points of both kinds together; the oldest go first to make room. (A file over 32 MiB gets one too: see below.) A
copy in use is never removed to make room or for its age:
- the one a change is being made with;
- the first one a request kept of a file, until that request ends;
- a favourite task's (see **Task history** below);
- those a Revert keeps so that **Undo revert** and **Redo revert** can work, until neither can use them any more.

When a copy cannot be kept, because every restore point that could make room is still in use or because the
storage cannot be used or written, the change is still made, and a transcript line says so: *No restore point for
this change to "…": UnodeAi could not keep a copy of the file (…). ⟲ cannot undo this change.* When only the text
could be kept, the line says ⟲ can still put back the earlier text. A file larger than 32 MiB is replaced or deleted
like any other: UnodeAi compares it by reading it as a stream and keeps its copy on disk, within the 256 MiB room.
When UnodeAi starts, it removes what an interrupted copy left in its own folder; it never writes a
project file then. A restore point whose copy is gone is removed from the Edit history.

Worktree lane diffs open in the same native editor. A lane-level **View diff** asks which changed file to open
when there is more than one, instead of printing every file into one buffer. The base side is **pinned
to the commit it was opened against**, and the tab title names that commit (`base a1b2c3d ↔ …`). A diff you
left open therefore does not quietly switch to a new base when the base branch moves on.

### Revert to before a request

**What it does.** It puts back every file that one member's request, and every later request of that member,
changed. Afterwards the files are as they were before that request began. It does not run anything again, and it does
not touch Git.

**Where to start it.**
- **Revert to here…** under the person's message that began the request.
- **Revert to before this request…** on that request's result.
- **UnodeAi: Revert to Before a Request…**, which lists the selected member's requests.

The buttons appear only on requests of the current line of work (see below) whose file changes can still be put back.
All three open the same preview first.

**The preview and its confirmation.** It lists each file it would restore or remove. Each file it leaves as it is comes
with the reason. **Not reversed** counts what commands or provider tools did, which a revert cannot undo. Choose
**Revert** or **Keep files as they are**. Then each file is checked again just before it is written. A file is left as
it is, and the rest are still reverted, when:
- another member or request changed it after the preview, even back to the same bytes;
- it has unsaved changes in an editor;
- another UnodeAi window is writing it;
- the request that changed it is still running, in this window or another.

A file that controls security settings asks once more (**Keep current file** or **Allow this change**).

**After it.**
- The chat shows what was put back.
- Results and checks from before it show **Not verified after restore**. Their original outcome stays as it was
  recorded, but it describes the files as they were.
- Each member's next request carries one short note from UnodeAi: which files were put back, naming only files that
  member may read now. It is told once, and only when the request was really sent.
- New requests continue from the reverted files. The reverted requests stay in Task history as an earlier line of
  work and no longer offer Revert.

#### Undo revert and Redo revert

**UnodeAi: Undo Revert…** puts back what a revert replaced. **UnodeAi: Redo Revert…** applies the revert again. Both
work per file:
- The choice lists each file's position, **reverted** or **undone**.
- A file that cannot be changed now (unsaved changes, a newer change, another window writing it) stays where it is,
  with the reason. The others move.
- Undo stays available for whatever still stands reverted.
- Redo becomes history once a new request starts while any file of the revert stands undone. That request built on
  the undone files, so Redo is no longer offered and is refused.
- A revert whose restore points were deleted in Task history can be neither undone nor redone.

If UnodeAi could not record how a revert ended, for example because its storage was briefly unavailable, the next
**Revert**, **Undo revert** or **Redo revert** completes the record from the files as they are. It writes no file to do
so.

### Task history

**Opening it.** Open it from the Workbench, from **Task history** in the chat's menu, or with **UnodeAi: Task history**.

**Finding tasks.** Search goals and results, and filter by member, state, verification, dates and favourites. A
completed task is not shown as verified unless a check verified it.

**A task's details.**
- Its conversation, result, checks and what of its file changes can be put back.
- **Resume…** puts the task's goal into the message box. Nothing is sent until you send it.
- **Mark as favourite** keeps the task and its restore points from being cleared to make room.
- Deletion buttons, one per scope:
  - **Remove conversation view…** removes the conversation and keeps the restore points;
  - **Delete restore points…** removes the restore points and keeps the conversation;
  - **Delete both…** removes both.
  - Each one says what it removes and asks first.

**Manage storage** shows what this workspace keeps. **Delete all history and restore points…** removes every task's
conversation and every restore point of this workspace, favourites included, after one confirmation. It also removes
the Edit history of this workspace, with the text it kept of each changed file, and its archived chats. Its report says
three things:
- what was deleted, the Edit history records and archived chats included;
- what was kept because running work still uses it, with the files (deleting again removes it later);
- what is not history and so not deleted: your workspace files, Spend records, approvals, and the file-effect and
  outcome records of past requests.

**How long it is kept.**
- The history clears the conversations of its oldest ended tasks once it holds more than 30 days, 1,000 ended tasks or
  16 MiB.
- It keeps running tasks, favourites and tasks a revert can still undo or redo. If those alone fill it, UnodeAi tells
  you once, with a way to open Task history.
- Restore points follow the limits under **Where the exact bytes are kept** above.
- Both stay on this computer, in UnodeAi's extension storage, never in the project, and are never sent anywhere.
- See SECURITY.md §5 for what exactly they hold.

### Context meter and Compact

The compact button below the message box is a **ring** with the **⤓** glyph inside it.

- **The filled part** is the conversation the agent holds now, measured against the point where automatic
  compaction runs. A full ring means automatic compaction is due, and the next turn checks it. After a failed
  automatic compaction, it is not retried automatically in that session while the request fits. A full ring
  does not mean the summary has already been applied.
- **The point is the model's.** Smart Mode may serve a turn with another model, whose point can differ. The ring
  uses the model that served the agent's latest turn; before the first turn, it uses the configured model and its
  hover text says so.
- **When automatic compaction is off,** the ring fills toward the model's window instead, and its hover text says
  "Automatic compaction is off".
- **Colour:** past 70% the ring turns to the warning colour; full, to the error colour.
- **A size UnodeAi does not have** shows as a dashed ring, never as an empty 0% ring.

Hover over the ring for the reading. The sentence with the ring's own number comes first, for example `Summarise
older turns now. This conversation is 82% of the way to automatic compaction at 250,000 tokens. The conversation holds
41% of an assumed 1,048,576-token window.` The hover text also says
when a background summary is being prepared, is ready, was applied, was not applied, failed or was cancelled.

In the Chat sidebar the ring is the only context control. The Workbench keeps the text reading at the right end
of its header bar, beside the **…** menu, and also has the ring below the message box. Click the ring to compact.
**The denominator matters as much as the percentage**, so the reading always says where the number came from:

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

**When there is no number, the reading says why** instead of staying blank. In the Workbench header it is the
text below; in the Chat sidebar it is the ring's hover text, and the ring is dashed:

| Reading | Meaning |
|---|---|
| `41% of an assumed 1,048,576 tokens` | Live. Click the ring to compact. |
| `Context — start the agent` | The agent is not running yet. The ring is greyed out. |
| `Context — measured after the next reply` | A Claude or Codex agent that has not reported a size since it started or last compacted. A Codex agent keeps its last size across a restart, because it resumes the same conversation. The ring still works. |

`UnodeAi: Compact Context` performs the same action from the Command Palette, so it can be bound to a key.

**Click the ring to compact now.** The ring is a square button beside the paperclip; Enter and Space press it
too. Its hover text and screen-reader name are a full sentence. It compacts whether or not the automatic trigger has
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
| **Off** | Never compacts automatically. The ring still compacts by hand. |

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

**It schedules maintenance; it never blocks a task.** A compaction has up to three minutes. On an
OpenAI-compatible agent it is prepared beside the work while the request still fits, and only a request that no
longer fits waits for it (see below). If it fails or runs out of time, the chat says so once and the task is sent
unchanged. **From 0.9.98, a
failed automatic compaction is not retried automatically for the rest of the session** on that model and setting,
while the request still fits the model window, so later turns are not delayed again. To try again yourself, click
the ring (Compact this conversation now) below the message box, or press Ctrl+Shift+P and run
**UnodeAi: Compact Context**. The ring always tries.

**It waits until a compaction is worth it.** On an OpenAI-compatible agent, an automatic compaction that could
remove less than a tenth of the trigger is skipped at no cost. Such a compaction would land just under the
trigger and run again on the next turn. Instead, it runs a turn or two later, once more has accumulated. The
conversation can therefore run up to about 10% past the trigger. The ring always compacts. When the instructions,
tools, kept records and newest turns alone keep a compaction above its working target, the receipt says so and
suggests a higher ceiling.

**A due compaction does not hold up a turn that still fits.** On an OpenAI-compatible agent, when automatic
compaction is due and the request still fits what the model can take, the turn is sent at once and the summary is
prepared beside it. It is applied at the next pause between turns, and the ring's hover text shows how far it has
got. Only a request that no longer fits waits: for the summary already being prepared, or else for a compaction
before it is sent, as before. **Stop**, removing the agent, starting a new model conversation and **Compact** cancel
a summary still being prepared.

**Older file reads are sent as references.** On an OpenAI-compatible agent, a successful `read_file`, `list_dir` or
`search_files` result from before the previous turn is sent to the model as a short reference instead of its full
text: what was read, its first 600 characters and the call that reads it again. This happens only once it saves
more than about 40,000 tokens. The conversation UnodeAi keeps still holds the full text.

**What each runtime does:**

- **OpenAI-compatible:** UnodeAi writes the summary. It keeps the recent tail word for word and aims for the
  profile's post-compact target. Each summary request is charged to the task that triggered it, or to the
  Compact itself when you click the ring.
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

### Closing a reminder (0.9.98)

Reminders in the Workbench and sidebar chat have a **×** button at the top right. Click it, or Tab to **Close this
notice** and press Enter or Space, to hide that reminder for this agent. Closing is remembered after a window
reload; the last 500 closed reminders are kept per agent. It does not delete history, change exports or model
context, answer an approval, or run Retry. Consecutive reminders with the same title and text share one card with a
count such as **×3**, and one close hides the group; a new repetition is shown again. A confirmation still waiting
for your answer cannot be closed this way: choose its answer, or use Stop.

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
| Context ring | Context use against the automatic compaction point (or the window when it is off), with the reading and its denominator's source in the hover text; clicking it compacts now — see [Context meter and Compact](#context-meter-and-compact) |
| Todo panel | Shows only agent-reported `update_todos` plans. Its collapsed header states real progress (for example, `4 of 7 done · Wire the command`); expand it for the full checklist |
| Command/write approvals | Shows the approval inline with the command, URL, or diff that caused it. It is never a detached second approval queue |
| Per-agent drafts | Keeps unsent text with the selected agent (up to 20 recent drafts). Sending, or removing that agent, drops its draft. The Workbench also keeps a saved copy, so it can be rebuilt after an extension host restart. See [After an extension host restart](#after-an-extension-host-restart) |
| Export/import | Saves or restores a selected agent's chat transcript |
| Compact mode | Compresses the chat view for dense workflows |

**Tool-card labels in 0.9.100.** A call whose turn ended without a result shows **No result** when collapsed.
A reported cancellation shows **Cancelled**; an actual failure still shows **Error**. Expand the card to read
its explanation. These labels do not retry the call or require a decision.

**Duplicate-send handling in 0.9.100.** Within one running extension host, another delivery of the same chat
click is ignored, including after that click finished. Each new click is a separate request, even with identical
text. This is not deduplication across extension-host restarts.

### Autonomy

Since 0.9.100, the **Autonomy** menu in the chat input is the only Autonomy control. It changes only the selected
agent: **Approve for me**, **Ask for approval** or **Full access**. Point at a position, or move to it with the
keyboard, to read what it allows. The selected position also lists any other choice that still limits this agent;
nothing is removed silently. For native Codex, the button shows the agent's saved native setting, and the
description says what Codex runs with now. Choosing a position sets that agent's own choice; the menu has no way
back to following the User default. Plan is read only for that request, including under Full access; permitted outside
sources can still be read.

An agent you have not changed follows `unode.autonomy` in your User settings.json, **Approve for me** unless you
edit it. A default of Full access still needs its one-time confirmation before it applies.

Approve for me keeps file tools within the workspace, granted paths and task scope. Ask for approval requests ordinary mediated
write and command review, honoring remembered decisions. Full access lets host file tools and Claude's mediated
writes reach outside the workspace as your OS account permits, and each of the agent's turns says it is on. It elevates no OS privilege. Enabling starts no
task, scan, model request, download or program. It warns that personal and credential files may be read and that
what an agent reads goes to its configured provider. File contents are not credential-redacted.

The default enable confirmation names current inheriting agents and states that future agents from any trusted
project team file inherit it unless independently restricted. An old Codex Approve for me record has unknown
default-versus-explicit origin; migration does not widen it. The explicit default preview includes those agents.
Saved native Ask and Full access choices remain separate until deliberately edited through the agent's Autonomy
control. An unchanged accepted default does not ask again at each start. Team files cannot supply the new override.

Independent Commands Off, Ask, write review, tool capabilities and Folder Access remain binding. To edit a separate
command/write choice, open VS Code **Settings**, select **User**, then search for `commandApproval` or
`writeApproval`. Folder Access stays in Agent Builder. Opening a
settings screen grants no permission by itself.

Host and Claude commands start in their working folder and follow command policy, but have no OS filesystem
sandbox. Approve for me therefore does not confine shell effects to the project. Codex uses its own native sandbox
and reviewer: native Ask concerns escalation, not review of every ordinary edit.
Native Codex **Full access (unsafe)** runs without a sandbox, enables network access and has no approval prompts.
Native Full access bypasses UnodeAi's command, deletion, outward-action and checkpoint checks; native reads are
not confined by host read roots. A running native Codex turn keeps the policy it started with; the menu says so. **Stop** ends
that turn; the next request uses the new native policy. Changing Autonomy alone never restarts an agent.

Delegated Codex **Act** tasks can write inside their assigned task folders under **Workspace** and **Review**
as well as Full access. Codex's workspace-write sandbox receives only those writable task roots, not the
whole project or additional read roots. **Plan**, read-only tasks and exact-file-only tasks stay native read-only;
an exact file is not promoted to a writable directory. Native Ask still concerns escalation, not every edit.

Outside restore points retain original bytes in extension storage. Restoring checks the absolute physical target,
its current authority and its current contents again after the confirmation. A revoke and reenable does not
revive an old pending restore. Read or edit outside the workspace with an exact grant instead if broad Full access
is unnecessary. See [SECURITY.md](SECURITY.md) for storage and native-route limitations.

### Exact outward and security-setting approvals

Since 0.9.100, a recognized push, publish, deploy or post asks once. The card shows destination and content when
known; otherwise it states “Destination and content could not be determined before running” and gives the reason.
It also shows the command, working folder and shell. Choose
**Allow once** or **Deny** in the agent's approval card. It grants no remembered permission for later outward
actions. Ordinary command review and a dangerous-delete warning share this decision. Other work continues
while you answer. A changed proposal shown as known, Stop or a revoked permission makes the old approval unusable.
If you decline, **Optional note to the agent (used if you deny)** sends your words to the agent, quoted as yours.
It does not grant permission or approve a retry. An expired or withdrawn question sends no invented user note.

Before a recognized foreground outward action, UnodeAi selects a direct executor whose environment it can
verify; the card names that shell. Claude uses the host `run_command` bridge for these actions because its
native shell environment cannot be verified. Commands Off, Plan, task and Folder Access restrictions still
apply. Codex's native execution retains its own permission profile and is not covered by this host guarantee.

An actual change to a protected security setting or credential/control file also gets one exact card,
replacing ordinary write review. Normal theme/font edits and unchanged contents add no question. A restore
shows its protected proposal in the existing restore confirmation, independent of agent Stop. Editing the
Autonomy setting as text does not accept the separate Full access confirmation.

The command list is finite, and some recognized forms cannot yet have their destination/content verified;
these still ask once, with the uncertainty disclosed. Git pushes (including `-u`/`--set-upstream`), publication
that builds first, GH actions, deployment commands and command chains retain a way to approve them. Scripts,
aliases, interpreter wrappers, arbitrary shell writes to settings and native Codex actions have explicit
coverage gaps. See [the exact command/file lists and preparation limits](SECURITY.md#closed-outward-command-list-and-preparation-limits).

### Installs outside the project

An agent's command that installs something for the whole machine or downloads a large tool outside
the project asks once, in the ordinary command approval card, even when commands otherwise run automatically. The
card names the command, where it installs and the approximate size where it is known (otherwise "size unknown").
Choose **Allow once** or **Deny**; no remembered permission is offered, so the next such install asks again. If you
deny it, or no approval card can be shown, nothing is installed and the agent reports what is missing and the exact
command, and continues with the work that does not need it. A command that already asks for another reason (Ask
each, an outward action, a destructive command, a path outside the agent's folders) gets that one card with the
install named on it. Commands Off, Allowlist, Plan, Folder Access and Workspace Trust work as before: an approval
here never runs a command they refuse.

Permission you already gave is not asked again. When every part of the command matches an entry of
`unode.allowedCommands` or a command you approved with **Allow for project**, the way Allowlist and Ask each
read them, it runs as before, with no card. For example, an `npm install` entry also covers `npm install -g …`. The
card is for installs that would otherwise run only because commands run automatically.

Recognised forms:

- `npm install|i|add -g` (or `--global`), `pnpm add|install -g`, `yarn global add`, and a project install that
  `npm --prefix`, `pnpm --dir`/`-C`/`--modules-dir` or `yarn --cwd`/`--modules-folder` sends to a folder outside the
  project;
- `playwright install` and `playwright install-deps`, run directly or through `npx`, `npm exec`, `pnpm exec` or
  `python -m playwright` (browsers go to the Playwright browser cache, several hundred MB for all browsers);
- `winget install`, `choco install`, `scoop install`;
- `pip install`, `pip3 install` and `python -m pip install`. A destination the command names decides first:
  `--target`/`-t`, `--prefix`, `--root` or `--home` inside the project does not ask and outside it asks, also for a
  project virtual environment's pip; `--user` always asks. Without a destination, the pip or python of a project
  virtual environment (for example `.venv/bin/pip`, `venv\Scripts\python`, or one activated earlier in the same
  command) does not ask, and the system pip asks;
- `npx` and `npm exec` of a package the project does not declare in the `dependencies` or `devDependencies` of a
  `package.json` from the command's folder up to the agent's folder, or whose command no installed declared package
  provides. A package named with a version (`npx eslint@8`), a remote specifier, `npx -c`, or a package.json that
  cannot be read also asks.

These forms are found in chains, pipes and `bash -c` / `cmd /c` / `pwsh -Command` strings too. Installing inside
the project (`npm install`, `npm install -D …`, a project virtual environment) does not ask. Other forms are not
guaranteed to ask: other package managers (`pnpm dlx`, `yarn dlx`, `bunx`, `uv`, `pipx`, `cargo install`, `brew`,
`apt`), scripts, aliases and renamed executables. The person's own configured verify command is not checked, and
Codex's native commands keep Codex's own sandbox, which already asks before writing outside the workspace.

### File access grants

Since 0.9.100, an existing narrower grant takes precedence over a broader discovery root. When a host file tool
cannot reach an outside path, its refusal can offer access without stopping unrelated work:

1. In the notification, choose **Grant access**.
2. Choose **Read** or **Read + Write**, with **For this request** or **For this session**. The picker names the
   physical file or folder. A file choice covers only that exact file; a folder choice covers its tree.

**A request that names an outside path asks at once.** When your message names a path outside the workspace by its
full spelling, for example `C:\Contracts\lease.docx` or `C:\Reports\out`, the agent's notification offers **Grant
access** for it as the request starts, before any work. A path a current grant already covers is not offered again,
and at most eight paths of one message are. Grant the folder an agent is to write in **Read + Write**. Without this the
notice came only when a file tool was refused: not at all when the agent gave up without trying, and only after minutes
of work when a save was its first call.

- The path must exist, or be a file still to be made (a name with an extension, such as `report.docx`) in a folder that
  exists. A path written without quotes may hold spaces: the longest such reading is the one offered. When the words
  could mean two different paths, or name a new folder, nothing is offered at the start; put the path in quotes, or the
  notice comes when the agent tries it.
- A network share (`\\server\share\...`) or a `/net/<host>/...` path is not offered at the start, quoted or not:
  checking it would make Windows contact that server, or macOS mount from that host. The notice comes when the agent
  tries it. A file tool refuses such a path at once, without contacting that server, until a grant, Full access or one
  of the agent's own folders covers it by that spelling; after that it is used as any other path. The same holds for
  Claude's and Codex's own Write and Edit, and for such a path in a delegated task's folder scope: the task's dispatch
  result names it and **Grant access** is offered for it.
- If you choose **Read** at the start and the agent then needs to write there, the refused write offers
  **Read + Write** once more in the same request.

**One notice per path.** Each notice starts with what the path is and its name, for example
`File lease.docx — ...` or `Folder out — ...`, and ends with the full path; two paths with the same name also show
their folder. Each path of a request also has one item in the chat that says what it needs or holds now, for example
`Folder out — not granted yet` or `File lease.docx — Read + Write access granted`, with its own **Grant access**. The
notice's **Grant access** and the item's do the same thing. Once a path is granted, a later refusal or mention of it
shows no other notice, and **Grant access** on an older notice says the access is already there and changes nothing.
VS Code cannot close a notice it has shown, so dismiss it yourself.

A Word or PDF save outside the workspace is refused and offered access the same way as any other file write. Since
0.9.100 the agent is also told, as for other writes, that the notice's **Grant access** can admit it; before, it was
told only that the save was refused. A refused outside write blocks only the steps that need that path: the agent goes
on with the rest of the work, a Word or PDF draft keeps every part it has prepared, and the reply says what was done and
which path still needs access. No refusal or reply asks you to open another window or to send the request again: choose
**Grant access** in this request. Once the folder can be written, the agent saves the prepared draft without sending
its parts again, and the same save repeated, even twice at once, writes the file once. A **Read** grant does not admit a
save: choose **Read + Write** for the output folder. If the notification does not pop up, for example while VS Code's Do Not Disturb is on, it waits in the
notification center: select the bell in the status bar.

**A task waits for the access it needs (0.9.101).** When the PM dispatches a task whose only obstacle is outside
files or folders you have not granted yet, the task is not refused: it waits until you have granted everything the task
declares, **Read** for each file it reads and **Read + Write** for each folder or file it writes. The PM's turn ends, and
its status says `Waiting for access` with each one. The request has one item per file or folder, the same item in the
PM's chat and in the teammate's, so it does not matter whose item you choose. When your grants let the task start, the
PM is woken once, in that request, and the teammate does the whole task, the save included; a grant that leaves the
task still waiting starts nothing and costs no turn. If you choose **Read** for a folder or file the task writes, that Read is kept, and the
item still says saving needs **Read + Write**: choose **Grant access** on it again for that. A file the work needs
inside a folder you named is shown on that folder's item, so you grant the folder once; if the file's item was shown
first, that item becomes the folder's when you name the folder. An item says **granted** only for what you granted:
if the agent can already read the path without a grant, for example because the workspace's parent folder is
readable by default (`unode.localReadScope`), the item says that access is already available and that nothing was
granted. The `Waiting for access` status
lists only what is still missing and is updated in place as you grant, and the job outcome names only what was still
missing when the wait ended. If a path the task uses now leads, through a link, outside the folder you granted, it gets
an item of its own, naming where it leads.

If an output still cannot be written once the work has started, for example a path the task did not declare beforehand
or a grant you took back, the teammate keeps the tools its task needs: it reads the source, prepares the Word or PDF
draft, and only the save waits for **Read + Write**. If you grant it while the teammate still works, it
saves at once. If the teammate has finished meanwhile, the draft is kept and the request waits for the save: your grant
wakes the PM once, and the same teammate saves the kept draft without writing it again. Before it saves, UnodeAi checks
that the source file still holds the bytes the draft was made from. If the source changed, the draft is set aside and
the work is done again; if the source only cannot be read right now, the draft is kept and nothing is said to have
changed. A limit a grant cannot open, such as the teammate's own Folder Access, is named as such.

A message you send meanwhile is a request of its own: the waiting one stays, its **For this request** grants stay with
it only, and its wake comes after the turn in progress, never beside it. Stop on the PM, asking the PM to drop the task,
or changing the PM's model or connection ends the wait; that job closes as Partial and says what was still needed, and
a later grant starts nothing. A window reload ends a wait too: the job says what it waited for, and the reload does not
resume that work or repeat any save. Send the request again to go on.

If the requested file's parent folders do not exist, the picker explicitly names the nearest existing folder
tree instead: that is the scope needed to create those folders. It does not present that choice as an exact-file grant.

The notification still works after the agent's turn has ended. Once the request is over, the picker offers
**For this session** only. When the agent had answered without a task still waiting for that access, the path's item
in the chat then offers **Continue**: it sends your original request again, as a new request to the same agent and in
the same mode (Plan stays Plan), so you need not copy it. Nothing starts until you choose it; it works once; Stop or
clearing the conversation withdraws it. Otherwise send your request again to use the grant. If you choose **For this request** while
the picker is open and the request ends first, nothing is granted, and the chat says so and what to do next.

**Your place is kept (0.9.103).** Pressing **Grant access** or **Continue** in a conversation no longer moves it to
its top. The conversation stays where you were reading, and keyboard focus stays on the card: when **Grant access**
becomes **Continue**, focus is on **Continue**, so Tab goes on from there. A card button that goes away when you press
it, such as **Continue**, leaves focus on what takes its place on the card, or on the card itself. This also holds when
you went to another part of the window while the answer came. When the **Grant access** picker closes, whether you chose or pressed
Escape, focus returns to the chat you opened it from, if that chat is still visible. Nothing is opened or brought
forward for it.

The grant reaches a running agent's next matching file call. It changes no command working directory, restarts
no process and does not replay the refused call. The notice to the agent is not a message from you: it starts no
request and resumes nothing. The chat says what became of each grant:

- **A turn that can take it now**, such as an OpenAI-compatible or Codex route, reads it in that turn, and the chat
  says the agent was told.
- **A route that cannot**, such as Claude, shows at once that access is granted and the agent has not been told yet.
  When the turn ends, UnodeAi continues the same request in one more turn, so access chosen **For this request** still
  applies. That extra turn is paid and may turn out not to be needed. Its cost counts in the same task.
- **The turn ends in an error, your next message is already waiting, or another request's result or extra turn is
  due:** no extra turn runs for this grant, and the chat says the agent was not told. A later message from you takes a
  moment longer if it arrives just after UnodeAi decided to continue: it usually runs after that one turn. If it goes
  first, the extra turn still runs afterwards.
- **A delegated teammate** is not continued, because its result has already gone back. The coordinator can use the
  access when it next assigns that work.

A reload during the extra turn ends the task as partial. The reply it followed stays; send another message to go on.

The crew shares the grant within its chosen lifetime. A request grant follows the logical request through its turns and delegates;
a session grant ends when the extension host ends. Stop, Clear or agent removal invalidates a pending choice.
Stop, Clear and Archive also take back a notice not told yet, so no extra turn follows; Clear and Archive leave a running turn running.
A notice never goes into a different request's turn.
An explicit Folder Access restriction, a read-only capability, Plan and an Ask setting still apply. These grants
do not widen Codex's native CLI sandbox; the host tools and Claude's mediated file path use them.

To revoke a grant:

1. Open the Command Palette and run **UnodeAi: Security**.
2. Under **File access grants**, choose **revoke** beside that grant.

The next matching call loses that authority, and an old approval cannot finish a pending write under a regrant.
Returned file contents and search results retain credential-shaped text so agents can edit the original source.
What an agent reads goes to its configured provider, including personal and credential files you grant. Logs,
diagnostics and notices keep their existing redaction. Outside-file writes also keep undo
copies in extension storage when available; see [SECURITY.md](SECURITY.md).

**A file tool card is a bounded receipt, not the document.** A `read_file` title says whether the card holds
Markdown or other file content. Markdown previews use the same structured renderer as replies. A truncated
preview states how much was left out, beside **Open full file in editor**. That button sends only the
receipt's host-issued ids. The extension resolves the recorded path and re-checks the agent's physical read
roots before VS Code opens the file. It opens only a regular file; when it cannot open one, a notice says why. A
card you expand also stays expanded when a later tool call regroups it, when the transcript refreshes, and when the
Workbench reloads.

**A line longer than one read is read in parts.** A minified JSON or JavaScript file, or a long CSV row, no longer
loses the rest of its line. The agent sees which characters of the line it got, that this is part of the line and
not something to cite as the whole line, and the exact call for the rest:
`read_file({ path, offset: N, char_offset: T })`. A part never splits a character.

#### File links in a reply

**A Markdown link to a file in an agent's reply opens that file.** A text file opens in an editor tab of this window.
A `.docx`, `.xlsx`, `.pptx` or `.pdf` file opens in its own application, such as Word or your PDF reader (0.9.98).
On Windows UnodeAi gives the file's path to File Explorer, which opens it as a double click does, so a file name in
Chinese or another script opens too. Any other file that cannot open as text is never launched: the reason
beside the link offers **Reveal in File Explorer**, and only that button opens File Explorer at the file. This covers a
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
- **A link that does not open says why, beside the link.** A missing or renamed file, a directory, a file
  outside the agent's read folders, a reply that is no longer in the kept conversation, a file VS Code cannot open
  as text, a remote window and a virtual workspace folder each show the reason right after the link you clicked, in
  the sidebar or Workbench you clicked it in (file links in remote windows are not supported yet). **Copy path**
  copies the link as written, when UnodeAi found the link in the reply. The reason stays until you click the link
  again or dismiss it with **×**, also while the reply is still being written and after it ends. If that sidebar or
  Workbench closed or could not take the answer, or the conversation shown changed while you chose a folder, the
  reason is a notification instead, with **Copy reference path**; its **Reveal in File Explorer** checks the file
  again when you click it. A
  location that is not a line (`#install`) opens the file at its start and says so beside the link.
- **Other links are never followed.** `file:`, `command:`, `javascript:`, `data:` and `vscode:` links, network
  shares, device paths, a path that depends on a current drive (`C:notes.md`), a path with `..`, and a path encoded
  to hide a character are shown as text, with the reason beside them. Web links (`http`, `https`) work as before. A
  file link in an Analysis card or a file preview is shown as text.
- **A link shows where a file is, not that the agent saved it.** Only a file tool card says what a tool wrote.
- **Each file link has an actions button (⋯) (0.9.108).** It offers **Open with default app** for a `.docx`,
  `.xlsx`, `.pptx` or `.pdf` file and **Open in editor** for other files, then **Reveal in File Explorer** (on macOS
  **Reveal in Finder**, on Linux **Open Containing Folder**). On Windows a `.docx` or `.pptx` link also offers
  **Export PDF**, described under [Request summary](#request-summary). Each action checks the
  link and the file again, as a click on the link does.

**The composer is two rows (0.9.34):** the message box gets a full-width row of its own. Everything else
shares one control row beneath it, with **Autonomy** on the left, then Insert, Send and
Stop on the right. Those three are **icons, not words**: **↑** sends, **⚡** steers a running agent, **↓**
queues a follow-up behind one, **■** stops. Hover over any of them to see the word. Each one also uses that
wording as its accessible name, so nothing is lost to a screen reader. The same **Autonomy** menu serves every
connection: **Approve for me**, **Ask for approval** or **Full access**. Its button shows the current position;
each position's description, on hover or keyboard focus, names independent limits, including Plan's read-only
effects. Enabling Full access asks for confirmation; an unchanged accepted choice does not ask again at startup.
For Codex the description explains its native policy and a pending change during a running turn; native review
concerns escalation, not every ordinary edit. In Workbench,
the transcript uses the full height beneath the transparent floating composer. After a resize, a revealed
approval is re-anchored instead of reserving a permanent empty band. Only while a decision is pending does its
card reserve the dock's measured height. This lets the card scroll completely above the composer, even in a
narrow or zoomed editor. On a short viewport, the composer returns to normal flow so that it cannot cover the
conversation, and nothing is reserved for it there any more. In the Chat, and in a Workbench whose composer is in
the flow, a long message grows the box only into the room the conversation leaves (at most 200 px); then the box
scrolls inside itself and **Send** stays in view without the page scrolling. In a very short view the conversation
gives way first. A pending decision is never shrunk: if it still does not fit, the page scrolls.

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

### Reply suggestions

**After an answer, the message box can offer one suggested reply.** It appears under the box as **Suggestion:** with
the text. Press **Tab** or **Accept suggestion (Tab)** to put it in the box. Nothing is sent until you press **Send**,
and you can change the text first.

- **Off by default.** Turn it on in **UnodeAi Settings → Providers → UnodeAI Reply Suggestion Model**:
  - **Choose model…** picks an API connection and an exact model. A connection without a text API this feature can
    use is named *This connection cannot provide reply suggestions*. UnodeAi does not switch to another connection
    for you.
  - **Set API key…** appears when the chosen connection has no key yet.
  - **Turn off** sets it back to None: no suggestion and no request.
  - The setting is `unode.replySuggestions.model`, in User settings only.
- **What it sends, and what it costs.** After each answer, the visible text of the chat is sent to the chosen model.
  That text can include code and file content you or a member quoted. It is one request, with no tools and no retry.
  - The request goes through the connection's usual destination consent. If you declined or revoked that
    connection, a suggestion asks at most once, in a dialog that says it is for a reply suggestion. After **Do not
    allow** it does not ask again in that window until you change the reply suggestion model, and no suggestion is
    sent. This is counted in each window, so a reload can ask once more. Allowing the
    connection when one of your agents next uses it ends the decline too.
  - It is billed to that connection, and Spend shows it as **Reply suggestion**, under the request it follows.
  - It uses what is left of that request's limit, and never asks you to raise it. When nothing is left, or the
    request is waiting for a decision or was stopped, there is no suggestion and nothing is sent.
- **When it is offered.** Only once the answer is final and the message box is empty, at most one suggestion at a
  time, in the view that asked for it. A suggestion is one line of at most 300 characters.
- **When it goes away.** Typing, pasting, an attachment, **Escape**, **Send**, **Stop**, switching member or
  conversation, a new turn, or a change of the setting, the connection, its key or its consent ends the suggestion.
  A request still running is cancelled; what it already used stays in Spend. A reload brings no suggestion back.
- **When none comes.** The Providers row says why the last attempt for the current setting gave nothing, for example
  no key, a declined destination, a provider failure, or a connection without a text API. It never adds a chat
  message.

### Sending a message while an agent works

**A message you send while an agent works goes into its running turn** where the connection can take it: on Codex,
on OpenAI-compatible agents, and since 0.9.103 on Claude CLI agents. The Send button shows **⚡** when your message
will go into the running turn, and **↓** when it will run as a follow-up after the turn. On a Claude CLI agent the
button shows **⚡** only after UnodeAi has seen that agent's CLI take such a message; until then, and after a
restart, it shows **↓**.

- **When a message cannot go into the turn,** the chat says *Your message will run after this turn.* It is queued,
  and runs as your next request when the turn ends.
- **When the agent's reply is ready before it has read your message,** the turn goes on with your message. It stays
  one turn: both replies are in the chat, and its cost is the two added together.
- **When the agent stops before reading it,** for example because you pressed **Stop**, the chat says *Your message
  was not delivered: the agent stopped before reading it. "…" Send it again if you still need it.* The message stays
  in the conversation; nothing resends it.

Mid-turn messages on Claude CLI were validated on Claude CLI 2.1.318 with Haiku.

### When a Claude agent's background work finishes later

A Claude CLI agent can start something in the background, such as a long command. When it finishes after your
request ended, the CLI starts a turn of its own. In that turn the agent can read files, but it cannot run commands
or change files, because your request has ended. UnodeAi shows one notification for it: *Dev: something it started
in the background finished after your request ended. It can read files in that turn but cannot run commands or
change files. To let it act on the result, press Continue.*

- **Continue** sends the agent an ordinary message, as if you had typed it: *Continue: something you started in the
  background finished after my last request ended. Check its result and finish what that request needs.* It is a new
  request under your usual approvals, Autonomy and limits. Nothing from the background turn carries over.
- If the agent has since been restarted, removed or stopped, **Continue** sends nothing and says *That agent session
  has ended; nothing was sent.* If the agent is working on another request, it sends nothing and says so.
- Dismissing the notification does nothing. A second background result while the notification is open adds no
  second one.
- **Cost.** The background turn's cost is a receipt of its own, tied to the request before it. It is not added to
  your next request. If the CLI process exits before that turn's result, no cost receipt is recorded for it.

### A sound when something waits for you

**A prompt that stops work until you decide plays one short chime when it appears (0.9.88)**. The prompt can be
an approval card, an approval dialog, or a consent dialog. A consent dialog asks, for example, about a
model-network destination, Codex's network access or a media upload that you revoked or declined earlier, a
repository's CLI configuration, a whole volume outside the workspace, a coordinator brief to another provider, or
an MCP server from a file that needs your go-ahead. The chime does not sound again when you answer or when a second agent joins the same approval. It
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

**A long chat keeps its order and its context lines (0.9.103).** Each message keeps its place in the order things
happened, also across **Developer: Reload Window**, and the **Attached context** line of each turn is kept with the
chat and comes back after a reload. Clearing the conversation removes them. Before, a message saved by an older
version could move below newer ones, a new reply could appear above older history, a reload dropped every
**Attached context** line, and after a reload a new turn's line could sit beside an older question. A message you
send after importing a conversation now appears after the imported messages.

**A chat keeps its newest 50 messages.** When a message arrives in a full chat, the oldest one is dropped. The
tool cards, analysis, delegation cards and context cards of that time are not deleted by this, but the chat no
longer shows them above its oldest kept message, unless that work is still running or waiting. Chat keeps the delegation card of every run whose task is still running, however many newer runs there are, and the cards of the newest 12 finished runs of all coordinators. An older finished run's card leaves the chat; its results stay with the PM. Once messages were dropped, one
line at the top says so: *Older messages are not shown here. UnodeAi: Export Messages saves the team's most recent messages.* The
command **UnodeAi: Export Messages** saves the team's message log. That log keeps its own newest 300 items and says
how many older ones it dropped. A result whose reply was dropped stays under **Earlier results**, just below that
line, and **Export → Evidence report** still offers the evidence of each finished job. Neither export is a
complete archive of the chat's cards or analysis.

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
- **The file is parsed in a separate worker with its own memory**, so a corrupt or hostile document makes the
  read fail instead of affecting the editor. The worker gets more memory for a larger file. A slow parse is not
  ended while it keeps making progress; a parse that stalls is ended, and Stop ends it at once. In a Word or
  PowerPoint file, only the parts that hold text are opened. A file built to expand far beyond its size when
  unpacked is still refused.
- **There is no fixed file size.** Only a file larger than this VS Code window can hold in memory at once (an
  eighth of the extension host's memory) is refused, and the message names that file alone.
- **Permission is unchanged.** A document outside the folders an agent may read is refused, exactly like any
  other file. Being a PDF grants nothing.
- **A scanned page says it needs OCR** rather than returning empty text. UnodeAi does not perform OCR.
- A plain `.zip`, and any other binary, is still refused with the same message as before.

### Word and PDF documents (0.9.98)

**Ask an agent for a Word or PDF file and give its destination**, for example `out/agreement.docx` or
`out/agreement.pdf`. Agents with write permission use **write_document** on OpenAI-compatible, Claude CLI and Codex
routes. There is no document server to install and no command permission to enable. The tool uses the existing
write approvals and restore points, and writes only inside the agent's allowed write folders; Plan and read-only
modes do not write. The two templates are `contract-v1` and `report-v1`: headings, paragraphs, numbered clauses,
tables and signature blocks, not arbitrary HTML or macros.

**There is no length limit.** A long contract or report becomes one Word or PDF file, not several. No limit on
text, blocks, table rows, distinct characters or pages refuses a document, and a PDF keeps paginating past 120
pages, with page numbers taken from the real page count. Two limits remain because the formats have them: a Word
table can have at most 63 columns, and a PDF still has limits on the font files it loads (`font-budget`). Making
a document has no time limit; **Stop** ends it. For scale, a document of 126,490 characters took about 3.5
seconds, and one of 1,000,000 characters about 24 seconds. If this computer runs out of memory while making it, the result says
`out-of-memory`, nothing is written, and you can close other programs and ask again.

**A long document is sent in parts.** You do not need to do anything for this. The agent sends the document in
several `write_document` calls with the same `draft` name. A call without `final: true` only adds its part to the
draft on this computer; nothing is written to your workspace, and no approval is asked. The call with `final: true`
writes one file from all parts in order, through the normal write approval, using that call's path, format,
template, title, header and footer. The draft is removed when the file is written, when Stop ends a call that added
to it, or when the agent stops. If the final call fails for a real reason, such as a font, the draft is kept, so the
retry needs only `final: true` and no new parts. A final call whose earlier parts are gone is refused with
`draft-not-found`; a shorter document is never written in its place. `draft-storage-failed` means the draft's
temporary file on this computer could not be written or read back; the draft is removed and the agent starts it
again.

**What the receipt says.** The tool card reports the file's format, relative path, bytes and SHA-256 read back from
the disk. A PDF receipt gives its page count; a Word page count depends on the reader and is not invented. A saved
file is not a visual check: a Word file can carry a **reader layout unverified** warning, which stays on the tool
card and the request result. To check a document: 1. open it from the chat link or in Word or your PDF reader;
2. check fonts, tables and pagination.

**PDF needs Windows system fonts in this version.** PDF supports English, Simplified and Traditional Chinese,
Japanese, Korean, Spanish and French, common contract symbols, and Greek and Cyrillic letters. Text copied out of a
PDF reader may be in Unicode composed form. Decomposed Korean letters are written as whole syllables in both Word and
PDF.

**When a PDF cannot be made, you get a Word file instead.** If the PDF fails for a PDF-specific reason (a font, a
character, content that no page can hold, or a renderer that exited), the agent is asked to save the same document
as Word, at the same path with `.docx`, through the normal write path. Length is never such a reason. When the PDF
was built from a draft, the draft is kept, so the Word file needs no parts sent again. The chat shows one closable
reminder:
`The PDF could not be made (<reason>). UnodeAi asked the agent to save it as Word instead. To get a PDF:` followed by
the steps. To turn the Word file into a PDF:

1. Open the Word file in Microsoft Word, click **File → Save As**, choose **PDF**, and click **Save**.
2. Or open it in LibreOffice and click **File → Export as PDF**.

UnodeAi does not write the Word file by itself; the agent does, and its receipt is the proof. There is no fallback
after a permission or Plan refusal, a Stop, or a write you declined. These cases are not sent to Word either:

- **Chinese, Japanese or Korean text with the wrong language tag**, for example plain `zh`, or Chinese names inside
  an English document. The agent is told to set that text's language to `zh-Hans`, `zh-Hant`, `ja` or `ko` and try
  the PDF again.
- **Input, memory, draft and saving errors.** The agent gets the repair or retry advice for that error. If a result says
  `effect-uncertain`, look at the destination before retrying. `render-stop-unconfirmed` means an earlier worker
  stop was not confirmed; nothing was saved, and the next document uses a fresh worker without a window reload.

When one unsupported character is the only obstacle, the result also suggests replacing it and trying the PDF again
if it is only decorative.

**Codex agents started before 0.9.98 keep their conversation.** Word/PDF tools cannot be added to a Codex thread that
has already started; they arrive with the next new model conversation. To get them:

1. Select the agent in UnodeAi Chat.
2. Open the Chat menu and click **New Model Conversation (keep chat)**, or press Ctrl+Shift+P and run
   **UnodeAi: New Model Conversation (keep chat)**.
3. Send the document request again, with the context the new model needs. Earlier messages stay visible, but the
   new model conversation does not inherit them. **Clear Chat is not a model-context reset.**

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
`Finished 17:41:16 · Turn time: 21s`; a turn you stopped reads `Stopped 17:41:16 · Turn time: 21s`. Older turns
also include the local date. The total is not just the tool
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

`Observed: waiting for provider 15s (2 waits, longest 13s) · reasoning 2s · responding 2s · of which writing tool calls 9s · running tools 1s · host 1s`

These parts add up to the turn time exactly, except *of which writing tool calls*, which is a part of the provider time before it. Each part is what the extension observed, not what the model
reports about itself:

| Part | What it measures |
|---|---|
| waiting for provider | Time after the extension sent a request, or returned a tool result, during which nothing came back. The extension cannot see why. The provider may have been queueing the request, reading the context, or reasoning without sending anything. With more than one wait, the line gives the count and the longest one |
| reasoning | Time from the moment the provider sent reasoning until it sent reply text, called a tool or ended the turn |
| responding | Time from the moment the provider sent reply text until it sent reasoning, called a tool or ended the turn |
| of which writing tool calls | Of the three provider parts before it, the time the model spent writing tool-call arguments. For a file write or a Word/PDF document, those arguments are the content itself, so a long write shows up here, not under running tools. Not added to the total |
| running tools | Time while at least one tool call was open. Calls that run in parallel are counted once |
| host | Time the extension spent preparing the turn before its first request |
| queued | Time the request waited before the turn began, either behind the agent's earlier work or for the agent to start |

A part that took no time is left out, except `waiting for provider`. A turn recorded before 0.9.92 has no
such line. Its breakdown was not recorded, and the extension does not show zeroes in its place. The same is
true of a saved breakdown that does not add up to its turn.

### What the live line says

While a turn runs, the line at the end of the transcript names what the extension last observed:

| Line | Meaning |
|---|---|
| `Working: preparing the request` | The turn has begun and no request has been sent yet |
| `Working: waiting for Claude`, `Working: waiting for Codex`, `Working: waiting for <route>` | A request or a tool result has been sent and nothing has come back yet |
| `Working: thinking` | The provider sent reasoning. This line appears only then. Silence is never shown as thinking |
| `Working: writing a reply` | The provider is sending reply text |
| `Working: writing contract_v2.docx · 12 KB so far`, `Working: preparing write_document · 900 B so far`, `Working: preparing a tool call` | The model is writing a tool call's arguments; no tool execution is inferred. For a file write those arguments are the file itself. The line names the target file once its name has arrived, and the amount received so far, refreshed once a second |
| `… · this route does not show progress while the model writes a tool call` | Added on the Codex route to the waiting and *No response* lines: Codex sends a tool call only once it is complete, so a long write there looks quiet until it arrives. Nothing is wrong, and nothing ends the turn |
| `Working: running npm test`, `Working: running a tool` | One tool call is open. The timer beside it is that call's own time |
| `Working: tool work, 2 calls open` | Tool calls overlapped. The timer is how long the turn has had tool calls open. It is not the time of any single call, so no tool is named |
| `Working: compacting the conversation` | The provider reported context compaction |
| `Working: waiting for your approval` | A decision of yours is open. It is shown ahead of the tool that asked for it. The time you take is not counted in the turn time |
| `No response for N s` | No recent event and no known running tool, compaction or approval. A progress summary appears underneath; the task keeps running |
| `Working` | The turn is running and the extension has not reported a phase for it yet |

The first timer is the time the turn has spent in the state that the line names. It starts from zero when that
state begins. The second timer, after `turn`, is the turn time so far. Both are counted the same way as the time
in the finished turn's footer. Neither includes the time you spend on a decision. While a decision is open, the
line reads, for example, `Working: waiting for your approval – 20s · turn 31s (paused)`. Here the first timer is how long
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

All of these come from the extension, never from the agent's own text. A reply records only its own turn: what the
team is doing now is in the strip above the message box (below).

**What the PM's team is doing now (0.9.102).** When a coordinator is selected, a strip above the message box says
what its team is doing at this moment, in the sidebar and in the Workbench alike. It is hidden when there is nothing
to say. One line per fact:

- *Running: Dev (12 min).* A task a teammate is working on, and for how long. *Starting: 1 task.* Work the PM
  handed out that its teammate has not started yet.
- *The PM reports here when results come back.* Shown while a result can wake the PM.
- *Dev finished. The PM is about to review it.* · *… The PM is reviewing it now.* · *… The PM gets the result when
  its current turn ends.* · *… The PM gets one automatic turn to review it.* What happens next to a finished result.
- *Dev finished, but the PM has not reported on it.* with **Continue**. A result reached the PM, and the PM has not
  ended a turn with a reply since: it stopped, its turn failed, or nothing will wake it. **Continue** puts a message
  asking the PM to review and report into the message box; nothing is sent until you press **Send**. A decision the
  PM recorded does not count as a report; a reply after the result does.
- *Rework requested from Dev, but none is running.* with **Continue rework**.
- *No activity: Dev (3 min, running a tool)* with **Ask the PM** (0.9.103). A teammate that is running a task this
  window started, and has shown no activity for two minutes, is named here with how long and, when UnodeAi knows,
  what it is waiting on: *waiting on the model provider*, or *running* and the tool's name. **Ask the PM** puts a
  message asking the PM to check whether these teammates are still making progress into the message box; nothing is
  sent until you press **Send**. The minutes count up in place. A teammate waiting for your approval, for access or
  for the PM's answer is not named here, and neither is a PM you stopped. It says only what UnodeAi saw: a model can
  be thinking without sending anything.
- *Dev asked the PM a question on … To answer, press Ask the PM, then Send.* (0.9.103). A teammate's question about
  its task is still open. **Ask the PM** puts a message asking the PM to answer it into the message box. Once the PM
  has answered and the answer has not reached the teammate yet, the line reads *Dev is waiting for the PM's answer to
  be delivered*. See [Teammates' messages and questions to the PM](#teammates-messages-and-questions-to-the-pm).
- *Needs your decision: Dev's task "…" — …* with **Review Delivered Work**. · *Waiting for your access: Read + Write
  for Folder out (…).* What only you can do; the item that grants access is in the chat.
- *Stopped. The PM does not continue until you send a message.* After **Stop**. Your message resumes the PM; it does
  not count as the PM's report, so a result the PM received stays owed until the PM replies.
- *Dev's task "…" is being handled in another UnodeAi window.* Another window of this workspace runs it.
- *UnodeAi cannot read its task records now …* when the extension cannot tell; it then promises nothing.
- **Reminder**, with **Ask the PM**: a task that still needs a decision that nothing will record by itself. The line
  names the teammate, the start of the task's instruction and its date, says only what UnodeAi knows, and what clears
  it, for example: *Reminder: Contract Analyst's task "Review the MetaBlox B300 v2.2 contract…" (finished 2026-11-10
  08:28): its saved result text is not available in this window, and it has not been handed to the PM yet. To clear
  this, press Ask the PM, then Send: the PM inspects it and records what to do with it.* A reminder comes for:
  - a finished result whose saved text is not in this window, or whose hand-over to the PM UnodeAi cannot confirm.
    The PM redoes it, or records it *rejected* or *deferred*.
  - a result whose stored copies conflict, or whose decision UnodeAi cannot place. Only a real redo (recorded
    *superseded*) or *rejected* clears it; UnodeAi refuses any other decision on it and says which two work.
  - a task interrupted when its window closed or reloaded, or when its teammate's session ended. The PM redoes it or
    records it *abandoned*.
  - a task UnodeAi cannot confirm is still running, or one this window did not start and cannot observe. The PM
    inspects it and stops it with *cancel_task* if it should not continue.
  - a result the PM received and replied about without recording a decision, once no automatic review turn is left
    for it. A reply reports a result; it does not decide it. The PM records its decision.

  A decision the PM records does not report a result either: a result the PM received after its last reply stays
  *… the PM has not reported on it* until the PM replies, even after it rejected or redid it.

  **Ask the PM** puts a message naming the task, its handle and the decisions it takes into the message box; nothing
  is sent until you press **Send**. The PM then takes a turn, a paid model turn, and records its decision or redoes
  the work, which is a paid task. The reminder goes once that decision is recorded, and stays gone after a reload.
  Two reminders are shown, newest first; more are counted on one line, *N more tasks need a decision.*, with **Show
  all** (each one, with its own **Ask the PM**) and **Ask the PM about all** (one message about all of them).

  The message **Ask the PM** prepares includes two identifiers. You do not need to type or copy them.
  - **A handle** (*handle …*) names one delegated task. The PM uses it to answer, decide or redo that task, so you and
    the PM mean the same task.
  - **An exchange id** (*exchange-…*) names one question or blocker a teammate asked its PM about a running task. The
    PM answers it with that id, and the answer goes back into the same task. A task can have several exchanges; the
    prepared message lists the ones still waiting for an answer.

After VS Code or Cursor reloads, the strip starts again from what this window does: work it did not start is never
shown as *Running*, and a task that was running when the window closed is a reminder that it was interrupted.

In the Workbench the strip floats above the conversation. Since 0.9.103 only its buttons catch clicks: a message
behind the strip's text can be clicked and selected.

Before 0.9.102 each coordinator reply carried a *PM status* block, and the latest one was redrawn as the work moved
on. A reply now keeps only what happened in its turn, and a status saved by an earlier version is no longer shown.

**One automatic review turn for a result left without a decision.** When a delegated result reached the PM and
the PM's turn ended without recording a decision on it (accept, rework, ask you), the PM gets one more turn on
its own to review it. That turn starts with the steps: read the result, decide, record the decision, run the
required check, report. The strip says so (*The PM gets one automatic turn to review it*). It happens once per
returned result: if the PM still records no decision, no further turn starts, and the team continues when you send
a message. There is no such turn after you press Stop,
while a message of yours is waiting, for a result that needs your decision or a rework, or for a result from an
earlier VS Code session. A reload does not repeat a turn that already ran.

### Request summary

**One host-observed card for every turn that hands control back to you (0.9.94).** When a turn you started
ends, Chat shows a **Request summary · Observed by UnodeAi** card. It appears right after the item that ended the
turn. That item is the reply or, for a turn that ended without one, UnodeAi's own line saying so. A coordinator
turn that UnodeAi started to hand over a teammate's result also gets a card. A teammate's delegated turn does
not, because the coordinator's turn and the job's own card account for it; the files it changed are in the
coordinator's card for the request. The card is not a message. It is
never sent to a model, summarized, compacted or counted as tokens. It is not in an exported chat either.

**One card per request (0.9.103).** A request can report more than once: the PM's turn that handed out the work,
a later turn woken by a result, the turn that closed the job. Chat shows one card for the request, after the reply
that ended its latest turn. The card is the request's latest report: the **Job outcome** once its team job closed,
otherwise its **Request summary**. When there was more than one report, the collapsed line says
`Latest of N reports`, and the card's details end with **Earlier reports**, oldest first. Each one reads
*Report 1*, *Report 2* and so on, with its time; a report that has changed since then is marked
*as it read earlier* and shows what it said then. Two requests that overlap keep a card each. Before 0.9.103 a
delegated request showed a Request summary under the reply that handed out the work and a Job outcome under the
closing reply.

**One main button.** A card has at most one main button; every other button is secondary. On a Job outcome it is
**Review changes**, or **Open evidence** when there is no change to review. A Request summary offers **Open**
followed by the file name for up to five files the request wrote, and the first of them is its main button. The
file opens only if it is still within the agent's read folders, as for a file link in a reply. Since 0.9.108 a Word,
Excel, PowerPoint or PDF file opens with its default app, and other files open in the editor. Beside each file there
is a Reveal button (**Reveal in File Explorer** on Windows, **Reveal in Finder** on macOS, **Open Containing Folder**
on Linux), and on Windows a `.docx` or `.pptx` file also has **Export PDF**.

**Export PDF (0.9.108)** saves a PDF of a delivered Word or PowerPoint file next to it, with the same name: `report.docx`
gives `report.pdf` in the same folder. It is your own action, not something the agent does, but it uses that agent's
access as it is now: it needs the agent's Read, Write and Run commands permissions and access to the file and its
folder. It goes through the ordinary command approval and then the usual write approval, as the agent's own
`export_pdf` does; if a PDF of that name already exists, the write approval covers replacing it and a restore point
is kept. It runs on its own, so it works while the agent is busy with another request, and that request is not
paused or charged. It does not run when the chat is in Plan mode, in an untrusted workspace, or on a platform other
than Windows. The result says where the PDF was saved, how many pages it has and which application made it, and
whether it was made from a filtered copy. The Word or PowerPoint file is not changed.

**Earlier results.** A card whose reply is no longer shown in the chat is not lost. It goes into one entry at the
top of the chat, **Earlier results**, which counts the results whose replies are no longer shown. Open it to see
each card, with the reason: *Its reply is older than the 50 messages this chat keeps.* or *Its reply is not in
this chat.* The card's buttons work there as they do under the reply.

**The line.** The closed card is one line, for example `Answered · no verified file change observed · $0.18 · 18s`
or `Verified · 2 files changed · 1 check run passed · 46s`. Open it to see the nine sections below.

**What the first word means.** It comes from what UnodeAi observed, never from what the reply says.

| Word | Meaning |
|---|---|
| `Answered` | A reply was delivered. UnodeAi recorded no change and ran no check. It does not say that the reply is right |
| `Finished — not verified` | The turn ended and UnodeAi recorded a change. UnodeAi did not run the verification command. Until 0.9.95 this read `Completed — not verified` |
| `Verified` | UnodeAi itself ran the configured verification command in this turn, and it exited 0 |
| `Finished — checks failed` | A run of that command by UnodeAi failed. Until 0.9.95 this read `Completed — checks failed` |
| `In progress` | A coordinator's turn ended and delegated tasks of its job were running or waiting for a busy teammate, or a teammate waited for the PM's answer. Since 0.9.103 this also holds when the turn ended without a reply |
| `Needs you` | An approval was not granted or a request limit waits for your decision. Older records may show a first-action deadline; silence no longer ends turns |
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

**Each turn still has one report.** The turn that closes a team job reports that job's **Job outcome** and no
Request summary of its own. An earlier turn of the same request reports its Request summary: while the job runs it
reads `In progress`, and once the job has closed it reads `Job closed` and points to the Job outcome. Since 0.9.103
these reports are one card for the request (above), and the earlier one is in its **Earlier reports**.

**A task handed out counts from the moment it is sent.** A coordinator's turn can end before its teammate takes the
task up, for example while the teammate is still busy with other work. Since 0.9.103 the card reads `In progress`
for that time too. Before, it read `Answered` until the task was taken up. A task cancelled before its teammate
took it up no longer counts.

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
- **A change Codex makes without asking.** UnodeAi sees it only after it happened and has nothing to compare it with,
  so it looks at the file. The entry is **CLI native observed** when an added file holds the bytes Codex named, a
  deleted file is gone, or an edited file holds the lines Codex's change says it now has. It is **Effect uncertain**
  otherwise, including a file at the new name of a move, a removal the file gives no way to see, and an edited file
  over 8 MiB. The look covers those lines only: it does not prove the rest of the file, or who wrote it.
  If Codex reports a change that did not take effect, the entry can still say **CLI native observed** in two cases: a
  removed line followed by an identical line, and an added line that starts with `++ `. Open the file to be sure.
- **What is not covered.** A shell command is not seen file by file; the card then says that other file effects are
  not fully covered. A file outside the agent's folder is counted and not shown. At most 50 files are listed; the
  counts include the rest.
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
  want that work done, ask the agent again. It will raise a fresh approval with a fresh window. The chat line says
  the same: *Approval denied — timed out. … If you still want it done, ask the agent in this chat to try again.*

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
- **`go_to_definition`** and **`find_references`** ask this editor's language service where a symbol is declared and
  used. The agent names the file, the line and the symbol, and gets the locations it may read, in pages of 100.
  Locations outside its read access are counted as withheld and never named. Nothing else is searched to fill a gap.
  - An empty answer says only that the language service gave no location. It does not prove there are none.
  - A result says `complete` only when it holds every location the language service gave. If every location is in
    the queried file and one is the file's import of the symbol, the import was not followed to another file. That is
    usually because the language service is still loading the project. The result then says `complete: false`, with
    that reason, and the agent can ask again shortly.
  - Known limit on Windows (0.9.110): when the folder was opened through a short 8.3 name, such as
    `C:\PROGRA~1\…`, a location can be shown as its full absolute path instead of a path inside the folder. It is
    still the right file, and read access is checked the same way. Opening the folder by its full name avoids it.
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

1. Do a small task itself, when dividing it would not help.
2. Create a task plan.
3. Ask the Architect for public contracts and file ownership.
4. Assign work to specialists, choosing each for fit with the work and for what UnodeAi reports it can do now.
5. Run independent tasks in parallel when files do not overlap.
6. Run `run_checks` when the team has a configured check. A configured check is required; on a team without one, such
   as a knowledge team, the PM says that no check ran.
7. Route failures back to the right teammate.
8. Ask the Reviewer for a final PASS or FAIL. A task counts as done when the PM records its result accepted, not when
   the result arrives.
9. Summarize the outcome for you.

A preset's suggested verify command, such as `npm test`, is only a suggestion. It is saved for the new team only
if you accept it, and your project's own checks and review rules come first.

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

**Delegated work has no wait timer (0.9.103).** A task the PM hands out is never timed out, however long it
takes. The PM does not wait for it inside its turn: it ends the turn with a progress report to you (what is
delivered, what is still running and what blocks it), and that report is not the end of your request. When the
task's result comes, it wakes the PM in a later turn of the same request, once. Until then the task keeps the
access it was granted, and the request reads **In progress**, also while the task still waits for a busy teammate
and after a PM turn that ended without a reply. **Stop**, `cancel_task` with the task's handle, and the task's budget
still end it. The PM's tools have no blocking wait. Before 0.9.103 a wait ran out after a few minutes, and the PM's
chat could show a task as **Timed out waiting for teammate** while it was still running.

`inspect_task_status` keeps the facts apart: the task's own execution state, the teammate's activity, the
wait state, the result state and the read-receipt state. The execution state belongs to that one handle:
`running`, `queued`, `waiting-for-answer`, `stopping`, `stopped`, `stop-unconfirmed`, `ended`, `not running` or
`unknown`. It says `stopped` only when UnodeAi saw the task's process tree stop. A task that waits for its teammate
to finish other work reads `queued` and starts by itself (before 0.9.103 it could read `unknown`); one whose
teammate failed to start reads as ended before it started. `waiting-for-answer` means the teammate ended its turn
waiting for the PM's answer to its question: the PM answers it, and does not dispatch the task again. A teammate
that is busy with a later turn is shown as `busy, not with this task`, never as this task running. Only a `ready`
result comes with a `collect_ready_tasks` action. For pending work, the PM is told to end its turn and wait for the
host to wake it, rather than poll.

If a directed teammate or coordinator turn ends while its structured todo list still has unfinished work, the
host settles that turn as **partial**. The full report stays visible, and the unfinished activity is shown
separately. Partial is a final state for that turn, so waiting cards stop. It is never counted or shown as a
completed delivery, and a workflow pauses before its gate or next step.

OpenAI-compatible agents have no step limit, Solo agents included. There is no 12-step working limit and no
100-step emergency backstop. A turn ends when the model gives its answer, when you press **Stop**, or at a
[request limit](#request-limits) you set. Every 100 steps the chat says so: `This agent has taken 100 steps in this
turn and is still working. UnodeAi has not stopped it; press Stop if you want to end the turn.` Nothing waits for
your answer. A model that keeps repeating itself does not end the turn either. A call
that already failed twice with the same arguments, or that was repeated too often, is not run again; the model gets
a firm instruction to change course instead. After two rounds in a row in which every call was such a repeat,
UnodeAi tells the model to change approach, and the chat shows: `This agent keeps repeating calls that were already
refused. UnodeAi told it to change approach and is spacing out its next steps. Press Stop if you want to end the
turn.` The pause before its next request starts at 1 second and doubles up to 16 seconds. Any call that runs ends
the pauses.

A worker result that starts with a `Stopped:` line written by the host stopped at a host boundary. It is typed as
partial, never as completed, and it is never blamed on the worker. A coordinator should call `continue_task` with
that handle, optionally with a narrower focus. The exact same worker conversation then resumes, with everything it
already read, a fresh allowance and a newly admitted attempt grant. The expired attempt's permissions are never
revived.

### Teammates' messages and questions to the PM

**A teammate can message the PM while it works on a task (0.9.103).** It sends a *note*, a *question* or a
*blocker*. This works on OpenAI-compatible, Claude CLI and Codex CLI teammates whose role includes messaging, as the
built-in roles do. The message is filed under its task, never under whatever the PM is doing at that moment. The
PM's chat shows it under the task, for example *Dev asked a question on its task "Draft the release notes": Which
version do I cover?*, and the PM wakes once to read it. A PM you stopped is not woken by it. A note asks nothing
back. Teammates are told to send only real content, never an acknowledgement such as "got it".

**A question gets its answer inside the same task.** The PM answers it with `reply_to_task`. If the teammate's turn
is still running and can take the answer, it arrives in that turn. Otherwise the teammate ends its turn waiting: the
task stays open, keeps its access, and continues with the answer as soon as it is given. It is the same task, not a
new one, and its result goes to the PM as usual. While a question is open, the PM strip says *Dev asked the PM a
question on … To answer, press Ask the PM, then Send.*, and the request reads **In progress**. After three questions
on one task, the strip says how many the teammate and the PM have exchanged; nothing is limited.

- **A question in a rework turn.** When the PM sends finished work back for rework, a question asked in that turn
  reaches the PM, but its answer does not come back into the turn. The teammate is told so when it asks: it finishes
  what it can and ends its turn saying exactly what it needs, and the PM can send the task back with the answer.
- **Stop.** **Stop** on the teammate's Team row cancels a task that waits for an answer.
  Stopping the PM closes the questions it was asked. If the teammate's process ends while it waits, its task ends as
  interrupted. A window reload keeps no open question: the task reads as interrupted, and nothing is replayed.
- **Each request is charged for its own work.** A teammate's message, a result and an automatic review each go to the
  request their task belongs to. When two of your requests are open on one PM, each gets its own PM turns.
- **An older Codex conversation.** A Codex teammate whose conversation started before 0.9.103 cannot message the
  PM in that conversation; it is told to end its turn saying what it needs instead. The chat says so once per
  conversation: *…'s Codex conversation started before teammates could ask the PM mid-task …* To give the agent
  the tool, select it in UnodeAi Chat, open the Chat menu and click **New Model Conversation (keep chat)**, or run
  **UnodeAi: New Model Conversation (keep chat)** from the Command Palette. The visible chat stays; the model's
  earlier context does not carry over.

**A Codex teammate's own question (0.9.104).** Codex CLI has a question tool of its own. When a Codex teammate uses
it during a delegated task, UnodeAi sends the question to the task's coordinator as that teammate's question on the
task, the same way as `send_message`: the same checks, and the request limits you set hold it as they hold a
`send_message` call. The teammate's chat shows *Dev asked the coordinator of this task with Codex's own question tool:
…*, and the PM's chat shows it under the task like any teammate question: *Dev asked a question on its task …*. The
answer comes back into the same task. Codex does not pause for it; it keeps working. A Codex agent you talk to
directly shows its question in the chat: *… asked with Codex's own question tool: … Answer it in this chat.* A question
that cannot be sent says why in the teammate's chat: *That question did not reach the coordinator: …*

Teammates are told whom to ask. A teammate working on a task asks the coordinator that assigned it; an agent you talk
to directly asks you. Solo is never told to ask a coordinator.

**CLI teammates run assigned commands in the foreground (0.9.103).** Claude CLI and Codex CLI teammates that can
run commands are told to run an assigned task's commands in the foreground and wait for them, even when they take
minutes. A task ends with the teammate's turn, so the result of a command left running in the background would
reach neither the task nor the PM.

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

**A coordinator may do a small, ready action itself.** A coordinator with teammates no longer has to file a
`coordinator-only` contract before it writes a file, saves an attachment or runs a command itself. With no contract
in force, the action runs under the coordinator's own permissions: its folders, your write approval setting,
Commands, Workspace Trust and Plan mode all still decide. The tool result reminds it to delegate larger or parallel
work with `dispatch_task`. A contract the coordinator did file still governs: an action it does not cover is
refused. This holds on OpenAI-compatible, Claude CLI and Codex routes.

**A dispatch whose files overlap work in flight is queued, not refused.** When the only obstacle is a file claim
held by work still running, the coordinator gets a handle at once: `Queued contract <id>: its files overlap work in
flight (…). It starts automatically when that work settles.` The queued task counts as live work, so the
coordinator cannot close as `complete` while it waits. When the overlapping work settles, the task starts through
the same filters, claims and grants as any dispatch. If it then cannot start, the reason comes back as the task's
result. Any other failed check still refuses the dispatch at once. `inspect_task_status` shows a queued task as
`queued`. Cancelling it with `cancel_task`, or pressing **Stop**, cancels it before it starts: `Cancelled <handle>
before it started: it was queued behind overlapping work and never ran, so nothing was stopped and no result will be
delivered. Other queued and running work was not affected.` A cancellation also wins while the task is being
started.

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
- A review does not start when the file is missing, is a folder, lies outside the workspace or is larger than
  this VS Code window can hold in memory at once (an eighth of the extension host's memory). There is no other
  size limit.

If your team has the rule that a reviewer must run on a different model from the author, a review of a
workspace file is not started. A workspace file has no recorded author to compare with.

The `line_numbers` option of `read_file` now tells an agent to cite receipts in `close_assignment` only where
that agent's tool list offers `close_assignment`. Before, every agent was told to, including agents that have
no such tool. On Claude CLI, the tool list is fixed when the agent starts. It offers the reviewer's close to
every agent except a coordinator, so those agents still see the sentence.

**A required output a command made counts (0.9.103).** A task can name the files or folders it must produce. When
a teammate makes one with a command, for example a script that saves the report, UnodeAi's file tools did not write
it, and before 0.9.103 the result said *required output not written* while the file was there. Now UnodeAi looks at
the output's place when the task ends. If it is there and was created or changed after the task was handed out, the
result tells the PM it is *observed on disk*: it is at its place, and who wrote it is not recorded. The task's
finished-work check counts it, also after a reload. UnodeAi looks only:

- where the teammate may write it at that moment, for example the task's folder or a place you granted
  **Read + Write**, also when you granted it while the task ran;
- for the kind the task names: a folder at a required file's place does not count;
- on this computer: a place on another computer, such as a network share, is never looked at.

A file that was not changed since the task was handed out does not count.

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
- If UnodeAi cannot save the record that a request is starting, it still sends the request, and one line says:
  `Crash recovery is off for this request: UnodeAi could not save its record on this computer. If VS Code closes
  before the reply, send the request again.` Nothing claims the request was recorded, and nothing replays it after
  a restart.
- The note telling the model that restored file contents may be out of date is no longer stored as one of your
  messages. It travels with your requests until the model has answered once.

### Results after a reload (0.9.98)

**A saved delegated result is offered to its coordinator after a reload.** A result that was still pending when
the window reloaded goes to the coordinator that asked for it, without restarting the worker. A delivery already
recorded is not offered again. If UnodeAi cannot tell whether an interrupted handoff completed, the result is marked
unknown instead of being repeated. Stop suspends delivery until you start the coordinator or send it another request;
removing the coordinator closes its results. Archived and decided results are cleaned up automatically, so the store
does not fill up for good.

Storage problems do not stop work. One closable reminder says `Work is continuing. Result recovery is unavailable or
still saving; a reload may lose or repeat an unsaved result.` No action is needed to keep working; avoid reloading
the window until the current work finishes. This is not a power-loss guarantee. The **UnodeAi** log channel has one
`[result-recovery]` line for each cause, naming only a fixed category.

**A finished result with no body after a reload (0.9.100).** Its save failed, or its file could not be read. The task
stays open and the chat says so once; this may appear only when you next message that coordinator. A later reload that
reads the file brings the result back. To go on without it, ask the coordinator to run that work again or to abandon it.
Pressing **Stop** while the coordinator is running closes the result for good, and the task ends as partial if no other
work or usable result is left. There is no timeout and no automatic turn for it.

If a reload cuts a handoff short and nothing confirms it arrived, the result is not repeated. A later reply can end the
task, as partial.

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
  the same way. That made a slow task look like an idle one. A result that arrives after the wait is classified
  like any other result, so a complete late result counts as finished in the Job outcome; the timeout stays
  recorded. Since 0.9.102 there is no late window: however late the teammate finishes, its result wakes the PM, and
  until then the task keeps its access. Before, a result that came more than ten minutes after the wait ended stayed
  **Timed out** and reached no one. Since 0.9.103 a task the PM hands out has no wait timer, so it is never
  **Timed out**; the label stays on tasks recorded by earlier versions.

The changed-file list comes from recorded checkpoints. The verification line comes from the commands and gates
that actually ran. Neither comes from the teammate's prose. This works for both OpenAI-compatible and Claude PM
delegation.

**A Reviewer's own work stays its own.** When a Reviewer's result arrives, the files it wrote (a report, a
reproduction, a test) and the commands it ran are shown to the PM as the Reviewer's own work. The PM is told to
decide on the findings without running the Reviewer's checks again; only a change the Reviewer made to the work it
reviewed needs another reviewer. A review task that names the file under review covers that file only as it was
when the task was assigned. If the file changed afterwards, the result says **review target changed**. It also says
whether the change is among the Reviewer's own recorded changes, or came from another teammate, a command or an
edit outside UnodeAi. The PM is asked to check only that file again: send it to a teammate who did not change it,
or deliver the result and say the changed version is not independently reviewed. Nothing waits for a second
reviewer, and a file a Reviewer changed with a command is reported as a change UnodeAi did not record, never as no
change.

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
| **Review** | When the request had a review: each finding, its state and the coordinator's reason, and files the coordinator wrote that no review covered |
| **Remaining** | Tasks that did not finish, and dispatches team policy refused |
| **Usage** | Tokens, and cost per basis. Amounts on different bases are listed separately and never added |
| **Approvals** | Counts of approvals by kind. What was approved is not on the card |
| **Timing** | Elapsed time, the times of the request, the first dispatch and the close, and where the agents' time went |

**What the words mean.**

- `Complete` and `Partial` say how the job was closed. A job with a task that was stopped or interrupted is
  `Partial`, whoever closed it. Since 0.9.100 the same holds for any other task that did not finish, for example
  one left waiting for your decision, rejected, sent back for rework or without a recorded result: a job never
  reads `Complete` beside `1 task unfinished`. A dispatch refused by team policy is also listed under **Remaining**,
  and so, since 0.9.106, is a dispatch whose teammate did not start (no Codex CLI chosen, for example). Neither
  became a task. A job in which some task ran closes as it would without them; a job none of whose dispatches was
  taken is `Partial`.
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

**Actions.** A card offers only what applies to its job. Since 0.9.103 one of them is the main button:
**Review changes** when the job changed files, otherwise **Open evidence**.

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

**Silence now reports progress instead of stopping work.** The PM and workers on all three routes keep
running through quiet periods, including native context compaction. The live line stays with the running turn in
the transcript and updates about once a second. Recent output says what is happening: writing a reply, thinking,
preparing a tool call, running a tool, compacting, or waiting for your approval.

After 20 seconds without observed activity, the line shows **No response for N s** and a host-written progress
summary: recorded operations, files read or changed, dispatch counts, and work still awaiting a result. This is
a display threshold, not a deadline. A known running tool, compaction or approval keeps its more specific status,
with the progress summary underneath. CLI observations may be partial; missing observations do not mean no work.

The summary is a read-only copy of the current turn's existing records, not a new model request or a completion
claim. It updates in place without repeating cards. New activity restores the active status, and later tool
results continue to be recorded. UnodeAi does not stop, replay, restart or dispatch anything because of silence.
Use **Stop** if you want to end the task. Normal provider completion and actual transport/provider errors retain
their usual handling. Compaction time remains visible in timing records.

The former Claude idle watchdog is also a progress observation, not a reason to stop. OpenAI-compatible
response headers, buffered replies, stream gaps and post-tool waits have no implicit UnodeAi deadline by default.
An actual connection failure or provider error still reports an interruption. A deliberately supplied embedding
time limit is still honoured; retry attempts remain bounded even when waiting has no time ceiling.

Older saved first-action/compaction-deadline outcomes remain readable; silence no longer creates one.
Settled outcome cards scroll with their turns. Only pending approvals and consent remain above the input.

After reload/import the results remain readable, but their old retry actions are unavailable: the original live
host request cannot safely be reconstructed from saved text. Start a new request instead.

An interrupted OpenAI-compatible response may be sent again only when its source-typed connection failure or
provider timeout is eligible and the host knows no operation from that response started. It sends the identical
admitted input, rechecks the host's gates and route, and shares the retry limit and any explicitly configured time limit. Tools
from earlier responses are not run again. An abandoned visible reply remains labelled **Incomplete reply fragment
(automatically retried)** in the conversation; it is not a conclusion and is never added to model history.
Only usage actually observed is retained for the interrupted attempt, not an invented full cost. Stop cancels
backoff. Claude/Codex may have executed native work unseen, so this behavior never restarts or resends their
interrupted turns. Existing successful empty-reply handling is separate.

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
decision (Codex Reviewer: "Review add.js").` It names a decision that is waiting, with the teammate and the start of
its task (0.9.106; up to three, then a count), a result the coordinator rejected or deferred, or a rework that
stopped. **It says nothing about checks or completion (0.9.95).** Until then, it could add "no observed passing
check" directly above a Job outcome that said the task's checks had passed. This happened because the two counted
different attempts. The line is written before the job closes and cannot see that card. The Job outcome alone
therefore now reports checks and completion. When every result that stands has been accepted, UnodeAi adds no line.

A superseded result and an attempt UnodeAi retried owe no decision, so neither holds back `complete`.
A task whose teammate never started, because its start was refused, owes no decision either (0.9.106). The refusal
ends that dispatch as refused, with its reason, as a team policy refusal before the start does. The coordinator's
next turn lists it under its previous turn. Nothing is decided for the coordinator. Before, the refusal reached only
the teammate's chat, and the task added "1 delegation result still needs a decision" to every later reply.

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
shows **Stop unconfirmed** with the reason. A later message or start requests a best-effort stop of that old
process tree and starts a new process, with a notice. This does not claim the old stop was verified; the old task's
effects remain cancelled.

**A crash is an unconfirmed stop too.** When an agent's Claude CLI or Codex App Server ends by itself, nothing watched
the processes it had started end. The agent shows **Stop unconfirmed** (`it ended by itself, and the processes it had
started were not seen to end`), and so does the task it was running in `inspect_task_status`. Configured crash
restart requests cleanup and continues automatically. A later new message can also start it; it is not locked.

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
result. To go on, ask the PM in this chat to run the task again, or to record it as abandoned.* The line
appears once per task. It
is also shown after a reload, and it is not sent to the model. A task you stopped with **Stop** is cancelled, not
interrupted, and gets no such line.

**A stop UnodeAi makes interrupts; your Stop cancels (0.9.103).** UnodeAi itself stops an agent when the window
restarts or closes, when a settings change needs a new process, or when the agent's process ends. The delegated tasks
it was running, or that were queued for it, then end as *interrupted*, never *cancelled*, and the PM can redo each one
as its replacement, also after a reload. The coordinator's line says why: *… its session was stopped by UnodeAi (a
restart, a settings change, closing the window, or its process ending) while it was running.* Your own **Stop**, on
the coordinator or on a teammate, still cancels.

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
is revised only by saving it again with the next revision and the id of the batch it replaces. A batch, a task
and a delivery plan have no size or section limit.

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
sent anywhere, resumed or run again. A task whose wait timed out keeps saving until it ends. A task from before
0.9.102 may show **result windows closed**: its late window had closed while it still ran, so it could save no
further batch; what it saved before stays readable for the coordinator.

**Using partial work in a later task.** The coordinator reads its own task's batches with `read_saved_batches`.
A section longer than one read (60,000 characters) is shown with its span, and the read names the exact call for
the rest: `read_saved_batches({ handle, sections, revision, offset })`. If the section was saved again since, the
read says so and continues the newer revision only when asked again without an offset.
With `as_task_input: true` it publishes them as an artifact that a later contract can declare. That artifact keeps
the source task's input provenance, can be declared only by the same coordinator, and is shown on the next task's
card as partial work, marked incomplete when the final check is. It grants the next task nothing else.

**Where saved batches are kept.** On this machine only, in this workspace's own extension storage: not in the
project, not synced, not sent anywhere. They contain the task's text, so treat them as work product. No batch is
refused for size. When this workspace's batches pass 16 MiB, a save first removes history no task can still use:
batches past their 30 days, then those of finished tasks that nothing refers to, oldest first. Those tasks are
listed as **removed automatically**. A stopped, interrupted or running task's batches are not removed this way.
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
requests per task after your last message**. A third request is recorded but not sent. UnodeAi tells you in a
notification at the bottom right of the window, with a **Continue rework** button, and the PM's reply ends with:
"The PM has asked 〈agent〉 to rework this task 3 times. Automatic rework stopped after two rounds. To send this
round, click Continue rework in the notification at the bottom right of the window, or ask the PM for another round
in this chat. Otherwise the result stands as it is." Nothing waits for your answer. **Continue rework** sends the
request that was held and starts the count again, as your next message to the PM does. It sends nothing, and the
PM's chat says why, when you stopped the PM since, the PM recorded another decision, the delegate delivered a newer
result, or a rework of that task is still running.

Where a reason is required, it must be concrete. A rejection forwards that reason to the delegate. The earlier
framework verdict is also visibly amended in the Workbench transcript, Activity, and the Team card. It is never
silently rewritten. This records an explicit decision by the coordinator. It does not ask an LLM to judge whether
prose "really delivered" the work, and it never infers a disposition from the reply.

The cards show the decision as **Coordinator accepted**, **Coordinator rejected — amended** (the earlier verdict and
the reason stay visible) or **Human intervention required**. Coordinator acceptance is an agent coordinator's
explicit decision, not customer, enterprise or human acceptance.

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

When an async dispatch overlaps work that is already in progress, the framework names that work's handle, owner, and task at the moment of the dispatch decision. When the overlap is a file claim, the dispatch is queued and starts by itself once that work settles; see [Task contracts and input resolution](#task-contracts-and-input-resolution). Cancelling a stopped worker frees a live dispatch slot, so the next dispatch can go ahead.

### PDF links and temporary content

When an agent uses `fetch_url` on a public PDF, the download still goes through the same public-web approval
and SSRF checks as any other URL. A PDF is accepted only after its `%PDF-` magic bytes match. It is stored in a
temporary directory that the extension owns, under an opaque id such as `content-1`. It is not added to chat
history or to saved workspace state. The fetch result is a receipt. Use `read_extracted_content` to read a stated
page range, or `search_extracted_content` to search a stated range. Both report the pages requested or searched
and the document's total page count. A result for pages 1–5 of 42 is therefore never a claim that the document
was read.

**Any page of any source can be read.** There is no page limit, no limit on characters per page and no limit on
a source's total text. One result shows up to 20,000 characters. A result that stops early ends with the exact call
that reads on, for example: `More follows: page 7 continues at character 12,000. To read the rest, call
read_extracted_content({...})`. `search_extracted_content` likewise continues from the page where it stopped. A
source stays whole on disk; only a file larger than this VS Code window can hold in memory at once is refused, and
the message names that file alone. Files you attach and sources a coordinator hands on are read the same way.

**You can also attach a local PDF.** It goes through the same steps: the same `%PDF-` signature check, the same
size rule (none but this window's memory for one file), the same opaque id, and the same page-scoped read and search tools. Its filename is shown to you, but
the filename is never sent to the model, written to chat history, or exported in evidence. An OpenAI-compatible
agent reads it directly. **A CLI agent that cannot take the PDF no longer fails the turn.** The turn is sent without
it, the model is told it did not get the file and must not claim it read it, and the chat says so:

- **Claude CLI** reads an attached PDF through UnodeAi's file tools (`read_extracted_content`) when the agent has
  them. Otherwise the chat shows: `The agent did not receive <file>: this Claude agent has no PDF reader here. The
  turn continues without it. To have a PDF read, save it in the workspace folder and ask the agent to read it.`
- **Codex CLI** does not receive PDFs. The chat shows `The agent did not receive <file>: … The turn continues
  without it. To have a PDF read, ask the agent to save it into the workspace and read it, or use an
  OpenAI-compatible agent.` A Codex agent that may write is told how: save the file with `save_attachment`, then
  read the saved file with `read_file`, which returns the PDF's text. In Plan mode it cannot save, so it asks you.

Native text PDFs are supported. A scanned page is reported as **OCR required / unavailable**, not as read.
Encrypted, corrupt and expired assets fail closed, and so does a PDF this window cannot hold in memory. A long PDF
is not refused for its length.

**A long text file you attach is never cut off.** Up to 120,000 characters of it go into the turn itself. For the
rest, the turn tells the model the exact `read_extracted_content` call that continues it, and asks it to read to
the end before relying on the file. There is no limit on how many files one message carries, and no fixed
size limit on a file. The composer hands each file to UnodeAi in pieces as soon as you add it; its chip shows
`· attaching…` until then, and **Send** waits for it: `Attaching NAME… Your message is sent as soon as they are
attached.` What goes is what you sent at the click, to the agent you chose then: switching agent or typing a new
draft while it waits changes only the draft, and a file you remove meanwhile is not sent. A second **Send** while
the first still waits says `Your previous message is still being attached. Send this one after it has gone.`
A **Stop** of that agent (on its Team row, or **Stop All Agents**) ends a message that is still waiting:
nothing is sent when its files arrive, the composer says `You stopped this message before it was sent. Its text and
files are still here; send it again when you want it.`, and pressing **Send** again sends it. Clearing the
conversation also ends it. A message whose Send crossed a Stop of its agent, a clear of its conversation or the
agent's removal on the way (you pressed Send before the chat had seen it) is not sent either; the composer says
which and keeps the message. Nothing sends a stopped message again later: only your next Send does. The one limit is the memory this VS Code window can give one file. A larger file is named in the
composer: `NAME was not attached: at X MB it is more than this VS Code window can hold in memory for one file
(about Y MB). Save it in the workspace folder and ask the agent to work on it there.` An image over 10 MB is sent
and kept, but the model cannot see it, because an image goes to the model whole in one request; the chat says so,
and the agent can save it into the workspace. Files you attach to a message for an agent that is already working
are not sent with it, and the chat says so: attach them to your next message. While a file waits to be sent, its
copy is kept in a temporary folder on this machine and deleted when the message takes it or you remove the chip.
Each file you send is held in this window's memory in one piece, so several large files in one message can be too
much at once. When the files of a message together are more than the window can safely hold, a warning under the
chips says so: `These files are X together, more than this VS Code window can safely hold at once (about Y).
Sending them in one message may make UnodeAi run out of memory. To be safe, send them in separate messages, or save
them in the workspace folder and ask the agent to work on them there.` **Send** still goes, and the chat records the
same warning once.

### Attachments on a Codex agent

A Codex agent receives the text files and images you attach in the composer. A text file goes into the turn's
text in the same block as on the other routes: up to 120,000 characters, and the exact read call for the rest. An
image goes to Codex App Server as an image input that carries the image's own bytes. UnodeAi does not resize or
convert it.

**Codex reads long sources in pages.** A Codex agent gets a `read_extracted_content` tool for the files and sources
handed to it with the turn. Each call returns up to 8,000 characters, and a result that stops early names where to
go on. A Codex conversation started before this tool existed does not have it. The model then says that the rest
of a long file was not read. To give the agent the tool:

1. Select the agent in UnodeAi Chat.
2. Open the Chat menu and click **New Model Conversation (keep chat)**.
3. Send the request again, with the file attached again.

**An image is sent only to a model that accepts images.** When the agent starts, UnodeAi reads the model list of
Codex App Server. When that list does not show that the thread's model accepts images, or when App Server names no
model for the thread, the image is left out and the turn is sent without it. The same happens to a PDF and to any
other kind of file Codex cannot take. The model is told which files it did not get and not to claim it read them.
The chat names them and says what to do: `The agent did not receive <files>: <reasons>. The turn continues without
it.`, followed by one of these:

- for a PDF: `To have a PDF read, ask the agent to save it into the workspace and read it, or use an
  OpenAI-compatible agent.`
- for an image: `To send images, choose a Codex model that accepts images.`
- for another kind of file: `To share its content, paste it into your message as text.`

A file that was left out is never listed as sent.

**A teammate gets a forwarded source in its turn.** When a coordinator forwards one of your sources to a Codex
teammate, UnodeAi puts the source into that teammate's turn: text as text, an image as an image input. It applies
the same grant check as the reader tools on the other routes, at the moment the turn is sent. One turn carries up
to 200,000 characters of forwarded text. A longer source goes in up to that point, and the turn names the exact
`read_extracted_content` call that continues it; a source that no longer fits is named with the call that reads it
from the start. A source is not sent, and the turn names it as not delivered, when:

- the assignment does not grant it, or its grant was withdrawn, for example because the coordinator's task
  attempt ended;
- UnodeAi no longer holds it;
- it is a PDF, or an image for a model that does not accept images;
- it does not fit the forwarded text of the turn and the Codex conversation was started before it had
  `read_extracted_content`. The turn then asks for a new model conversation for that agent.

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
2. **The upload grant for that host and purpose exists.** The vision model you set up is your consent: the first
   upload records the grant and shows one notice that names the media class, the provider and the host. After you
   revoked it or answered **Do not allow**, UnodeAi asks first, in a prompt that names the media class, the
   provider, the host, the byte count, and the estimated input cost if the route publishes one.

**Approving a download is not approving an upload**, and neither is the ordinary model-egress grant for that
host. The grant is remembered per host *and* per purpose. Allowing vision on a host therefore never allows
transcription on it. Revoke either one from the Security panel, under **Network egress**.

An approved image is sent with **one** request and then dropped. It is dropped even when that request fails or
you cancel it. A later turn therefore cannot resend the image without calling `send_image_asset_to_model` again. If the provider rejects it,
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
- **While it is in use, then for 30 minutes.** UnodeAi keeps an attachment while something still uses it: the
  request you sent it with (until your next request to that agent), a task working on it, or a save waiting for
  your answer. When the last of these is done, it is kept for 30 more minutes. After that, the agent asks you to
  attach the file again.
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
  UnodeAi's file tools, a Codex agent as a UnodeAi tool. It is refused in Plan mode. A coordinator with teammates may save
  under its own permissions when it has filed no task contract; a contract it filed must cover the save, as for any
  write. A Codex agent does not receive the bytes of a PDF attached to its own message, but it can save that PDF
  with this tool and then read it with `read_file`; it can also save a PDF a coordinator hands it. For a Codex agent that may write,
  the first turn of an existing conversation after this update starts a fresh Codex thread, because Codex cannot
  add a tool to a thread it resumes; the earlier messages stay in the chat.

### Temporary task scope

**A scope may name one file (0.9.95).** An entry in a temporary task scope, or in an agent's Folder Access, may
name one existing file instead of a folder. The entry then grants exactly that file. The agent can read it. With
Read+Write, the agent can also overwrite, edit, patch and delete it. Nothing beside it, above it or below it is
granted. The entry cannot be used to create another file. Until 0.9.95, such an entry was accepted but then
refused every write, because the file was treated as a folder.

- A scope with no writable folder narrows the file tools, not commands. Since 0.9.100, a command under it runs in the
  agent's own folder, under the agent's usual command setting, so a reviewer with read-only access can still run tests
  and read a diff. A command is not contained by the scope: it can change anything the agent's folder and your account
  allow. An agent with no writable folder of its own has no command tool.
- Since 0.9.100, a task scope can name a folder or file outside the workspace by its absolute path. It works only if the
  teammate can already reach that path, through **Full access**, Folder Access or a file grant of that request or
  session. The chat and Activity then say what the task can reach, by its real path; it does not ask. If the teammate
  cannot reach it, the task is not started, the coordinator is told, and a notification offers **Grant access** for
  that path unless a Folder Access limit on that teammate rules a grant out.
- If the teammate can reach only part of what a scope names outside the workspace, for example a folder it may read
  but was asked to write in, the task starts with that part. The coordinator is told what was left out and asked to
  tell you, and a notification offers **Grant access** for each outside path left out. After you grant it, ask for the
  work again.
- A file outside the workspace that a task is told to read joins that task's scope as read, when the task has a scope.
  Before, it stayed out of reach of a task whose scope named only the folder to write in.
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

### Review findings, fixes and rechecks

A review's findings are numbered and followed to the end of the request.

1. A teammate dispatched to review a file closes its review with `close_assignment` and its findings. UnodeAi checks
   each citation against the lines it showed that reviewer. It numbers the findings `F1`, `F2`, ..., keeps them with
   the review's result, and shows them to the coordinator as `<review task>#F1`. The reviewer is told to close this
   way even when its task asks for the conclusion in its reply. A review that ends with a reply only is recorded as
   evidence not submitted: its findings have no numbers, and the coordinator is told to dispatch a new review.
   A finding is a defect or risk to decide. A review that finds no defect closes with no findings; a pass is not a
   finding.
2. The coordinator decides on each finding with `record_task_disposition`. A finding can be sent for a fix, fixed
   by the coordinator itself, not adopted (with a reason), deferred, disputed or left for you. A finding nobody
   names keeps its state. Accepting a review does not close its findings, and a review is accepted only once each of
   its findings has a decision. An acceptance that leaves one undecided is refused; the refusal lists each one and
   says how to decide it in the same call.
3. A fix goes to a teammate with needs-rework, or as a new task that names the findings it fixes. Then a new review
   of the fixed file, which names the findings it rechecks, says for each one whether it is resolved. A resolved
   recheck must cite lines of the file under review.

A finding counts as closed only when a new review covers the fixed version of the same file. That review must be by
someone other than whoever made the fix, and nothing may change the file while it is being rechecked. Sending the old
review back for rework does not count. If the coordinator fixed the file itself, UnodeAi compares the bytes the recheck
saw with the bytes the fix wrote. A recheck of the old version therefore closes nothing.

The **Review** section of the Job outcome lists each finding:

- `not decided yet`, `fix requested`, `fixed, awaiting a recheck`, `closed by an independent recheck`,
  `fixed, not independently rechecked`, `not adopted` (with the reason) or `still unresolved`;
- what UnodeAi could not establish, for example `a recheck reviewed another version`;
- files the coordinator wrote that no review covered, as `not independently reviewed`.

A request without a team job adds one row to its Request summary under **Changes**: `Independent review: none`.

The statements are the reviewers' words, shown as text. UnodeAi checks the relations: which review, which file, which
version, and who did what. It does not check whether a finding is right.

Findings are kept with the run, pattern-redacted and bounded. Only the latest 8 reviews of a run keep their wording;
older ones keep their numbers and cited lines. They are not in portable run evidence. Opening the card or
**Review changes** only shows them: no review is sent, nothing is accepted and nothing runs again.

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

**A gate check that cannot run does not stop the workflow.** When a gate's check passes, the workflow goes on; when
it fails, the step is retried or escalated as before. When the check could not run, or its outcome is unknown, the
workflow continues to the next step with that gate recorded as unverified, never as a pass. The chat says:
`Workflow "<name>" continued after step "<step>" without a verified check: <reason>. Run the project's checks
yourself before you rely on the result.` A check you required still pauses the workflow: that is a verify command
you set yourself (in the team's `completionVerification` or in `unode.verifyCommand`), or a policy UnodeAi cannot
read as valid. A stale or invalid check configuration also still pauses it.

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

**Role Templates** and *Create a team* use the same 53-role source. **Your Agents** also includes agents you
built yourself. A template-based agent says which template it came from and whether its instructions still match.
An older Agent without origin metadata says *origin not recorded*. **Open in Agent Builder** edits that Agent.
Adding a role template from the Marketplace puts the new agent on your default connection (the one set with
**Set as default**), with that connection's model for the role, as *Create a team* does.

An active Integration states its authoritative source, maintenance state, exact package/image/endpoint identity,
verification date, transport, prerequisites and credential-variable names. The host derives the approval label
from what the configuration actually does. The catalog cannot weaken it. `listed`, `configured`, `approved`,
`mounted`, `exercised`, and `succeeded` are separate states. **Check setup** reports the current states without
configuring, approving, mounting, exercising, or granting the Integration. By default, its answer is a quiet
corner notification, like other notices that directly answer a command or a click; it never waits for an OK. To
get a centered dialog with the editor's single **OK** instead, clear **Show results as quiet corner
notifications** under Settings → More, or set `unode.notifications.resultStyle` to `dialog`. A value you set
yourself is kept. This user-only choice never changes approval, consent, or action-button dialogs. Background
notices remain toasts.

Adding a Role Template or importing a team never configures or grants an Integration. Suggested Integrations
are labels only. To give an Agent an MCP server, grant it explicitly in Agent Builder.

**Members come equipped.** Default software roles carry mapped skill **playbooks**. For example, Security carries OWASP Top 10, secrets scanning, and authorization review. The backend loads skills progressively. When a skill is needed, the backend loads it only if it is authorized. Full procedures are not copied into the standing prompt. A long skill or reference file is read in parts, each naming the call for the next (`load_skill` or `read_skill_file` with `offset`); none is refused or cut for its length.

Skill descriptions may be written in any language. The host checks structural facts such as length and
reserved names, but does not require English keywords or a particular whitespace/token shape.

**A save keeps every playbook (0.9.104).** The Agent Builder keeps each playbook it offered the form: the
Marketplace catalog's, every role template's and the agent's own. Before, a save kept only playbooks listed in the
catalog, so an unchanged Contract Analyst lost 4 of its 7. An agent that lost playbooks in an earlier save does not get
them back by itself: open it in the Agent Builder and select them again under **Skill Playbooks**. Choosing its role again also
selects them, but it also resets the agent's tools and model to the role's. The catalog now lists 13 more playbooks
that role templates already used, including the **Legal** and **Marketing** categories.

Every role also starts with the **Using Superpowers** meta-skill. It prompts the agent to check its authorized skills and load the most relevant one before acting. It is guidance only. It does not change any agent's tool permissions.

**Six skills adapted from other publishers.** The library includes six skills adapted from Apache-2.0 skills that
Anthropic and OpenAI publish. Each is a default playbook of the roles listed here:

| Skill | What it is for | Default for |
| --- | --- | --- |
| **frontend-design** | Deliberate visual, type and copy choices for a new or reshaped web interface, inside the project's existing brand and components | Product Designer, Frontend Engineer |
| **internal-comms** | Status reports, leadership and 3P updates, newsletters and FAQs from the sources at hand, with gaps marked; a draft, never sent | Technical Writer, Program Manager, Content Strategist |
| **security-threat-model** | A repository-grounded threat model: boundaries, assets, attacker capabilities, abuse paths, ranking and mitigations | Security Engineer, Application Security Engineer, System Architect |
| **webapp-testing** | A local web app checked in a real browser: interactions, screenshots, console logs | QA Engineer, Frontend Engineer |
| **gh-fix-ci** | Failing GitHub Actions checks read with `gh`, the cause found, and a focused fix when the task asks for one | DevOps Engineer, Site Reliability Engineer, QA Engineer |
| **mcp-builder** | An MCP server designed, built and tested locally (initialize, list tools, call, error), with evaluation questions | Backend & API Engineer, Workflow Automation Specialist |

New agents of those roles start with them. Agents you already saved keep their own playbooks: to give one of them a
new skill, open it in the Agent Builder and select the skill under **Skill Playbooks**. Like every playbook, these
grant no tool.

These six adapted skills ship as instructions and reference text. Their original helpers were converted to reference
text that an agent can write into the workspace and run under its normal **Run commands** permission. Other bundled
Playbooks, including Word and PowerPoint, can contain inventoried source scripts and licensed resources. Loading a
Playbook does not execute its scripts or grant tools; helpers use existing command permissions. Remote catalogs
cannot register executable handlers; compiled Skill actions keep their separate exact-content approval.

- **webapp-testing** uses the Playwright integration when it is granted to the agent, and a Playwright script in the
  workspace only when the integration is missing or cannot do the step.
- **Missing tools.** The skills tell the agent to use what the project already has, to install what the task needs
  inside the project (a pinned dev dependency or a project virtual environment), and to ask you once before a
  machine-wide install or a large download, such as Playwright's browser. If you decline, the agent reports the exact
  command and carries on with the rest of the task. UnodeAi itself does not yet recognise those install commands; the
  ask comes from the skill's instructions and from your command approval setting.
- **gh-fix-ci** follows your task and your project's own rules. `git push`, `gh pr create`, `gh pr comment`,
  `gh pr review` and `gh pr merge` go through the usual outward-action confirmation. `gh run rerun`,
  `gh workflow run`, `gh pr edit` and `gh api` calls that change something are not recognised as outward actions:
  they get only the normal command permission, so the skill runs them only when your task asks for exactly that. It
  never asks you to paste a token; if `gh` is not signed in, it gives you the `gh auth login` command to run yourself.
- **mcp-builder** runs its evaluation questions with the agent's own model and tools. It has no separate evaluation
  runner and needs no API key. It tells the agent not to add the server it builds to your integrations.

Each skill folder holds the upstream license and a `skills/<category>/<skill>/SOURCE.md` with the upstream commit and every change. Automated
tests cover loading these skills and carrying their reference files to Claude and Codex; their results on real tasks
have not been measured yet.

The active Integration catalog lives in `marketplace/mcp.json`. Role cards are built directly from
`ROLE_TEMPLATES`. `marketplace/agents.json` remains only as a compatibility-reconciliation fixture for its former
13 listings. Catalog validation rejects any active entry that is archived, deprecated, stale, without provenance,
or mismatched in identity.

If `unode.marketplace.catalogUrl` is set and `unode.marketplace.fetchCatalog` is enabled, UnodeAi can merge a hosted catalog with the bundled catalog. If the hosted fetch fails, the bundled catalog still works.

Marketplace **Start a new team** prepares the selected role before changing your current team. It uses the
same recovery snapshot, confirmed-stop and rollback process as loading a saved team; an unconfirmed stop
refuses the switch. The new team does not inherit the outgoing team's explicit completion-check command.
Adding a role to the current team keeps that team's policy and saves the roster before publishing the role.

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

### VS Code's own settings: UnodeAi and UnodeAi › Advanced

The top of the settings panel has two links, on every tab:

- **All settings** opens VS Code's Settings editor filtered to UnodeAi (`@ext:unode.unodeai`).
- **Open settings file (JSON)** opens your User `settings.json` with VS Code's own command. UnodeAi does not edit or
  rewrite the file; opening it changes nothing.

In VS Code's Settings editor, UnodeAi's keys are in two sections. **UnodeAi** holds the seventeen everyday keys:
`unode.defaultProvider`, `unode.maxConcurrentAgents`, `unode.verifyCommand`, `unode.gate.enabled`, `unode.autonomy`,
`unode.commandApproval`, `unode.writeApproval`, `unode.webAccess`, `unode.notifications.resultStyle`,
`unode.attentionSound`, `unode.requestLimits.providerTurns`, `unode.requestLimits.tokens`,
`unode.imageGenerationConnection`, `unode.imageGenerationModel`, `unode.transcriptionDefault`,
`unode.office.trackChangesDefault` and `unode.office.authorName` (see
[Word: tracked changes and comments](#word-tracked-changes-and-comments-09108)). **UnodeAi › Advanced**
holds the other 51: model defaults and Smart Mode tiers, connection and CLI paths, pricing and spend, worktree
strategy, Marketplace sources, execution engine options, diagnostics and retention. Only the grouping changed: no key
was renamed or removed, and every default, type and scope is the same as before. A key in Advanced still applies,
exactly as before; moving it there does not switch off a limit you set.

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

Each available connection card shows its runtime, its billing path, its endpoint or CLI setup, and a summary of egress and privacy. An available card has a **Set as default** action, which is how you switch the default for new agents to **Claude CLI** or **Codex CLI**. The current default is marked **★ Default for new agents**.

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

- **Check / choose CLI…** lists the programs installed on this computer without starting any of them. A program
  whose version was already checked is listed by that version, newest first; one not checked yet follows. Choose one,
  and UnodeAi starts that one program once, with `--version`, to read its version. For Codex it also runs
  `login status`, as before. Checks start in UnodeAi's own folder; if that folder cannot be prepared, nothing is
  started and a notice says why. If you chose a different program, UnodeAi shows the current and the new program
  with their versions and asks **Use this CLI** or **Keep current CLI**. Only **Use this CLI** changes your User
  setting, and only if the path you chose still starts the program that was checked; otherwise check it again.
  Agents that are already running keep the program they were started with until you restart them; nothing is
  stopped or resent.
- **An agent that starts with no program chosen (0.9.106).** If no Codex CLI was ever chosen, for example in a new
  VS Code profile, starting a Codex agent opens the same list, titled "An agent needs a Codex CLI to start". It asks
  nothing before it: the latest npm version is looked up only if `registry.npmjs.org` is already allowed, and one
  looked up in the last ten minutes is shown; otherwise the list says it was not looked up. **Check / choose CLI…**
  in Settings still asks, as before. Choose
  and confirm a program there, and that start goes on with it. Close the list, and nothing is started. The chat
  then gives numbered steps: open UnodeAi Settings and its **Providers** tab, choose **Check / choose CLI…** on the
  Codex CLI card, pick a program and confirm **Use this CLI**, then send your message again. A notice offers
  **Open Settings: Providers**, which opens that tab and changes no setting. The agent is not marked Blocked, so the
  next request to it, the PM's included, asks again.
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
the Claude program) while this runs. The bundled compatibility
list names the exact files of the versions this UnodeAi was tested with; those start at once. This release's list
names Codex CLI 0.163.0 (OpenAI's Windows x64 package, for managed Codex) and Claude CLI 2.1.306 (the Windows x64
program, from the native installer or npm), each run through UnodeAi's release checks on Windows 11 on 2026-10-21.
Other external versions, newer ones included, run with a notice and a background check.

**External programs not yet tested with this release run with a notice.** UnodeAi checks the captured installed
program in the background and records a successful check only if its files still match. A failed or unsaved check
is a reminder, not a lock. Explicit Check / choose CLI retains its inspection workflow. Forgetting recorded checks
causes another background check, not another startup modal. Managed CLI enrollment remains unchanged.

**A version that a UnodeAi release marked bad can still be run, by your choice.** Such a version is not started on
its own; the start is refused, and the message gives the steps. To run it anyway:

1. Open UnodeAi Settings and go to the **Providers** tab.
2. On the Claude CLI or Codex CLI row, choose **Check / choose CLI…**.
3. Pick the program. A warning names the reason the release marked it bad.
4. Choose **Run anyway**.

UnodeAi then runs its compatibility check, and uses the program only if the check passes. The choice is kept for
exactly those program files and that bad-list entry; other files, or a new entry, ask again. Every start of that
program shows a warning. Updating the program, or choosing another one, is the better fix.

**External CLI updates do not lock starts.** On a later start, a changed external program is checked and pinned
again automatically. The notice names the recorded old and current versions, or says when they have not been
recorded/checked yet. This applies to messages, delegations, crash restart and window reload. It does not silently
switch a managed Codex installation or grant an explicitly disabled permission.

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
  - Changing the **endpoint or key** is never refused. If an agent on that gateway is in the middle of a turn (starting/running/stopping), the change waits and is saved when that turn ends. A notice says so: `Your change to <gateway> will be saved when <agent> finishes the current turn. To save it now, press Stop on that agent in the Team panel.` An **idle** agent does not hold the edit.
  - After the change, a backend built from the old profile is denied on its next request and asks to restart. Clearing a key leaves the profile visible but non-runnable. The profile never borrows another provider's key.
- **Test connection** and **Load models** are explicit network actions. They ask for metadata consent for that gateway's host and contact only its own `/models` endpoint. They send no prompt, no workspace file, and no key to any other gateway.
- **Remove** is blocked while a current local agent, the new-agent default, or a Smart Mode tier still points at the profile. The message lists exactly what to rebind, and hovering over the button states the rule first. After removal, the immutable ID becomes a tombstone. An old route that points at it shows as a repair record. It is not silently re-pointed at another gateway.

Custom model prices and account balances remain unknown unless that exact custom gateway publishes trusted per-connection data. UnodeAi does not borrow a built-in gateway's price, catalog, endpoint, or balance for a custom profile.

When you create a **team** on a custom gateway, UnodeAi asks once for the model to use and applies it to every role. This is because a custom gateway ships no built-in model catalog to resolve per-role tiers from. If you cancel that picker, no agents are created. You never get a crew set up with a model the gateway does not serve.

### Migrating the old Custom connection

Older rosters may contain the retired singleton `custom`, `CUSTOM_API_KEY`, `unode.customBaseUrl`, or a per-agent `baseUrl`. In a **trusted** workspace, UnodeAi migrates them by itself when it activates, without a question, when the migration only moves your own setup: your old `CUSTOM_API_KEY` to your `unode.customBaseUrl` endpoint. When an old Custom agent names any other stored key or endpoint, UnodeAi asks first, wherever the agent is saved: a project's `.unode/team.json` may have chosen them, and opening a project saves its team into the workspace. The question lists each endpoint and names your stored key it would be used with. **Do not migrate** (the default) copies nothing and is remembered; choose **Migrate custom gateways** only if you trust the project. It prefers an agent's valid HTTPS endpoint to the old global setting. It keeps different legacy credential identities separate and creates fresh opaque profile IDs. It copies an old key only inside the extension host. Then one notice says what moved, for example: `UnodeAi moved your old Custom gateway setting into 2 named gateways (…); the agents that used it now use them. Nothing was sent.` It ends with `To review the gateways, open UnodeAi Settings, Providers tab.` If some agents still need a model or a gateway, the notice says how many; open each in Agent Builder and choose one.

**There is no command or button for this.** The migration runs by itself when UnodeAi activates in a trusted workspace whose roster still contains pre-0.9.31 `custom` agents. If you never had such a roster, you will never see the notice, and that is correct. Migration is entirely local. It contacts no network and tests no key, so endpoints that do not resolve still migrate fine. The old setting and keys stay in place for other workspaces.

**A decline from an earlier version still stands.** If you declined the migration in an earlier version, when it still asked, those agents stay visible as non-runnable repairs, and UnodeAi does not migrate them for the same roster. Your team file keeps working normally.

An invalid endpoint, missing key, unknown profile, or archived profile stays visible as a non-runnable repair. It does not fall back to Unode, Roam, OpenAI, or any other gateway. **One such agent does not stop the team.** When an agent's saved connection is not available on this machine, the other agents load and start, and that agent is held, unchanged, as a repair. A warning names it: `UnodeAi started this team without <agent>: its connection is not available on this machine. Edit the agent to choose a connection, or recreate it.` Its card's repair line says the same. Open it in Agent Builder and choose a connection. The old setting and key are kept for a compatibility period, so a later workspace can migrate independently.

**Codex CLI uses your local Codex login.** Install Codex and log in yourself. Then choose the executable from its provider card in Settings. (The official npm `.cmd` wrapper is resolved to the native executable next to it.) UnodeAi first runs bounded local checks of the version and login status. Choosing a Codex agent and its program is your consent: the first start shows one notice that names the program and says that Codex connects to OpenAI, or to the provider set in your Codex configuration, under your own login. UnodeAi does not control the CLI's network behaviour. To stop it, run **UnodeAi: Security** from the Command Palette and choose **revoke** next to Codex CLI under **Network egress**. Revoking kills the running Codex process tree, and the next start asks first; if you then choose **Do not allow**, no App Server or model request starts, and UnodeAi remembers that answer.

Codex keeps its own base instructions, hooks, plugins, native tools, and model-provider configuration. UnodeAi adds
the agent role as developer guidance. It discovers selected Playbooks through host-authored entries in a private temporary
Skill root and reads their original installed resources through host tools. Either Claude or Codex may be the team coordinator that the host selects. Only that agent receives team
tools. Codex supports steering while a turn is active. Agent Builder MCP grants also stay owned by the host. Codex
sees only the approved dynamic tools. The external server and its secrets never enter the global Codex
configuration.

In Act mode Codex defaults to **Approve for me**: `workspace-write`, `on-request`. Since v0.9.102 Codex's own reviewer
(`auto_review`) decides nothing in any profile: every request to run a command outside the sandbox reaches UnodeAi.
- **Ask for approval** shows your card for every such request.
- **Approve for me** first declines it and asks Codex to try inside its sandbox (one chat line says so). Reads anywhere,
  and writes inside the agent's folders, work there. If Codex asks again, or a command has already failed inside the
  sandbox in that turn, it is your card. A recognised destructive or outward command (push, publish, deploy, post) is
  your card at once.
- **The card** shows the exact command and says it would run once outside the sandbox, with everything it does. It
  may also offer one lasting choice it names exactly: **Grant `<folder>` Read + Write to the crew for this session, then run once** (the same crew-wide grant Grant access makes)
  (when exactly one folder can be named), or **Allow network for `<agent>` for this session, then run once** (after
  the same command failed to connect in the sandbox). Either takes effect inside the sandbox from the agent's next
  turn. Network for a session is kept in memory only and listed under **Codex network for this session** in Security,
  where you can remove it.
- **What is kept:** the card's own record in chat is just the program name and your choice (`run once`,
  `grant folder, then run once`, `allow network, then run once`, `declined` or `expired`), for example
  `Codex command (git): run once at 14:02, outside the sandbox.`. The command's own activity card keeps its text and
  output, as for every command.
- **Reads are not confined.** Codex can read any file this Windows account can read, including credential files.
  Network off is what keeps what it reads from being sent elsewhere by its commands.
- **Your own Codex rules still apply.** A command your Codex settings always allow (rules saved in `~/.codex/rules`,
  for example by choosing not to be asked again in Codex) runs outside the sandbox with no card: Codex does not ask
  UnodeAi, so the network and folder limits above do not reach it. UnodeAi does not read or change those rules.
- **UnodeAi's own Office tools follow Commands, not the Codex profile (0.9.107; the Owner's decision of 2026-11-22).**
  `render_office` (native Word, PowerPoint or LibreOffice page rendering on Windows) is a UnodeAi tool, so your
  **Commands** setting (`unode.commandApproval`) decides it, as for an HTTP or Claude member. It runs UnodeAi's fixed
  render script on a filtered copy of the document, on this computer and outside the Codex sandbox. Under the default
  Commands choice (Automatic) it runs without a card, also when this Codex member is on **Ask for approval**; under
  Ask you get the ordinary command card. It is not run while that Codex session's network is Off, in Plan, or under
  read-only access. `build_office` is decided by Commands too; its program then runs through Codex's own command
  execution under the current profile's sandbox and network policy. To be asked before every render, set Commands to
  **Ask**. Commands **Off** turns native rendering off, together with the commands of HTTP and Claude members; ordinary Word, PDF and PowerPoint generation keeps working.
- **Codex's Computer Use.** When Codex's own Computer Use is installed and turned on in your Codex settings (the Codex
  app's Computer Use plugin), a Codex agent can use it: it sees and operates apps on this computer itself, in Codex's
  own processes. The first time it wants an app, Codex asks, and you get a card named **Computer Use: `<app>`** with
  Codex's own question, for example *Allow Codex to use Notepad?*. Its choices are **Allow once**, **Allow for this
  conversation** and **Always allow `<app>`**, each only when Codex offers it, and **Deny**. Codex keeps a lasting answer
  in its own settings; UnodeAi stores none. On **Deny** the action does not run: the tool shows as failed in the chat,
  the denial is counted under Access & approvals, and Codex's reply says it could not use the app. Before it asks, Codex
  can already list the running apps and their window titles. The card appears under Ask for approval and Approve for
  me; in Plan mode, under a Folder Access ceiling, or with Workspace Trust off, the request is declined without a card.
  After you allow an app, each action shows in the chat as a Codex-native tool row: Codex runs it, and UnodeAi does
  not approve or check each action. While Codex operates an app, it moves the mouse and brings that app to the
  front for each step, so pressing Stop in UnodeAi may take more than one try. Checked in the field with Codex 0.169.0-alpha on Windows: an allowed action;
  a conversation answer asked again in a new conversation; Always allow kept across conversations (Codex saves it
  in `~/.codex/computer-use/config.toml`); Deny; and Stop during an action, after which nothing more was typed.

**Known limits of the sandbox on Windows (measured with Codex 0.165).**
- **npm and npx from PowerShell** may be refused inside the sandbox: the sandbox runs as its own Windows account, whose
  script execution policy does not let PowerShell load `npm.ps1`. Codex may retry through `cmd.exe`.
- **npm reports a refused connection only after about 70 seconds** of retries. Codex may stop waiting and end its turn
  before it asks, so no card with the network choice appears. Node's own `fetch` fails at once (`fetch failed`,
  `EACCES`); measured: when Codex then asked to run that same command outside the sandbox, the card offered network.
- **HTTPS with network allowed** works for programs with their own TLS (Node, npm, git with
  `-c http.sslBackend=openssl`). PowerShell's `Invoke-WebRequest`, `curl.exe` and git with its default settings fail
  inside the sandbox (`SEC_E_NO_CREDENTIALS`).
- **npm's cache** is in `%LOCALAPPDATA%\npm-cache`, outside the sandbox's folders, so npm inside the sandbox may also
  be refused writing it.

A file change Codex asks to make outside the agent's folders is refused before any card; the message names Grant access
on the folder's item, or Security → File access, from the next turn. **Full
access (unsafe)** uses no sandbox and enables network access. It has no approval prompts. It may read or change any
file the account can reach, and it may run any command. It creates no UnodeAi checkpoints. It requires
confirmation each time it is enabled. Routine local commands and edits inside the granted workspace boundary run
without a card. An approval appears only when Codex **requests** an escalation — to cross that sandbox boundary,
use blocked network access, request additional permissions, or invoke a prompted MCP effect. Whether to request one
is Codex's decision, not UnodeAi's. When Codex does not request one, the blocked action simply fails. In
measurements of the Windows 0.155.1 binary, a blocked network command or out-of-workspace write under Ask for
approval produced a card. In the release checks of 0.163.0, Codex let a blocked network command and an
out-of-workspace shell write simply fail, without asking; when it did ask to run a command outside the sandbox, the
request reached a card. Under Approve for me it now goes through the sandbox-first step above. These are Codex
escalation approvals, not “ask before every command” or “ask before every write.” The Workbench therefore replaces
the old permission selectors with the **Autonomy** menu, whose descriptions explain the native profile and any
pending change for the next request. Approve for me, Ask for approval and Full access project to native policies; a separately
saved native choice remains effective until deliberately edited. Plan mode, Workspace Trust, write-folder and
tool ceilings still constrain that policy. **In Plan mode a Codex agent reads files
with UnodeAi's `read_file`**, since Codex reads files only by running commands and Plan runs none. It reads what the
agent's folders allow, and changes nothing. A Codex agent that may read gets it in Act mode too; for one that did not
have it, the first turn of an existing conversation after this update starts a fresh Codex thread, and the earlier
messages stay in the chat. An agent limited by explicit Folder
Access grants can use Ask for approval or Approve for me. Both keep writes inside the granted folders. Such an
agent can never use Full access. Full access has no sandbox and cannot honour a folder grant, so for that agent it
resolves to Approve for me. **A Plan/Act switch or a Folder Access change restarts App Server** for a running Codex
agent. Measured with 0.163.0, Codex applies a changed sandbox to a conversation only when a new App Server process
resumes it, so UnodeAi restarts App Server once, resumes the same conversation there and checks the sandbox again.
The message then runs with the new access, or is refused if the check still fails; UnodeAi never gives a removed
folder back by itself. The new App Server starts only after UnodeAi saw every process of the old one stop, which also
ends any command Codex still had running. If that stop cannot be confirmed, UnodeAi requests a process-tree stop
of the old one and starts the new one anyway, with this notice: `The previous Codex App Server did not confirm it
stopped. UnodeAi requested a process-tree stop and is starting a new one. If an old codex process is still running,
end it in your system's task manager.` The agent's own Stop still reports the unconfirmed stop.

**A file access grant reaches a Codex agent at its next turn (0.9.102).** A folder you grant **Read + Write**
with **Grant access** becomes writable in Codex's own sandbox from the agent's next turn. UnodeAi restarts App Server
once and resumes the same conversation there, as for a Folder Access change, and checks that Codex reports the folder
as writable; if it does not, the turn is refused and names the folder. Before, the grant was used only by UnodeAi's own
file tools, and Codex's sandbox kept the folders it started with. A revoked grant, or a **For this request** grant
whose request ended, leaves the sandbox the same way at the next turn. A Codex turn already running keeps the sandbox it
started with and can still write in that folder until it ends. When you revoke such a folder while the turn runs, the
agent's chat says so once, with no question; **Stop** ends the turn, but does not undo changes already made. A turn
counts as running once UnodeAi has sent it to Codex: a grant revoked while the turn is still being prepared is checked
again just before it is sent and does not reach it, however many times you revoke meanwhile; the turn is still sent.
A grant or a looser Autonomy choice made in that time waits for the next turn, and a stricter one applies to this turn. A grant
that changes nothing Codex can write, such as a **Read** grant or a folder inside one already writable, causes no
restart. An agent that may not write, a Plan turn and an agent whose own Folder Access limits it get no grant in its
sandbox. Your Ask for approval or Approve for me choice stays as it is.

A grant of one exact file is not added to the sandbox, which can only hold folders, and the file's folder is not
granted in its place. The agent writes that file with UnodeAi's `write_file` (or `write_document` for Word or PDF),
which checks the grant at each write, keeps a restore point and cannot write the file's neighbours; each turn names
the granted files. A revoked file grant refuses the next write at once. `write_file` comes with a new model
conversation: an existing conversation is kept, and when a file grant needs it the agent is told how to start one:
select the agent, open the Chat menu and click **New Model Conversation (keep chat)**.

**A slow Codex request is not cut off.** UnodeAi waits for every App Server answer, the first handshake when App
Server starts included, for example while a long conversation resumes. The agent shows that it is working meanwhile,
and **Stop** ends a waiting request at once. A start that has not answered after 30 seconds is reported as a bad
Codex CLI version, as described under the Codex start above, and keeps waiting.
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

**Repository CLI configuration asks before it can run.** This applies when the agent's working directory, or an ancestor that the native CLI searches, contains `.claude`, `.mcp.json`, or `.codex` project configuration. In that case UnodeAi shows a redacted summary before either CLI starts. The check includes a repository root when VS Code opened only one subfolder. For declared hooks, the dialog shows the executable's basename without exposing its arguments. HOME `.claude` and `.codex` stay native user configuration, and UnodeAi does not inspect them. **Trust and load** keeps native project and user features. **Continue without project automation** runs Claude with only its user settings and starts Codex with a process-local `untrusted` project override. Trust and load uses the corresponding `trusted` override, so the dialog controls Codex's project layer without editing your config file. In untrusted mode, Codex skills may still load as instructions. Any effect they request is still subject to the active Codex sandbox and approval profile. The grant is bound to the containing workspace folder, the CLI working directory, the CLI kind, and what the configuration can do. If any of these changes, UnodeAi asks again. It does not ask again when Claude Code itself rewrites the permission lists (`allow`, `deny`, `ask`) in `settings.local.json`, as it does when you answer its prompts, or when a settings file is only reformatted; UnodeAi's own tool gate still decides every tool call. A change to hooks, environment values, MCP servers or helper programs still asks. A start in **Continue without project automation** mode loads none of this configuration, so a change to it does not stop that start. You can revoke the grant in the Security panel.

**Automatic refresh is user-controlled.** The only scheduled network task is the daily price refresh. The Roam and Unode provider cards each have an **Automatic daily price refresh** toggle. It is on by default, to keep the existing behaviour. Unbound `unode.pricingSources` entries have a separate **Global pricing sources** toggle under Settings > More. Both settings live in user storage, not in repository settings. A scheduled refresh never runs at activation and never prompts. It contacts only a host that already has metadata consent. Concurrent triggers are merged, and failures back off. Balance checks, model catalogs, Marketplace catalogs, and custom-gateway model loading still run only when you trigger them. They are not scheduled.

Because Anthropic stores no key here, its card offers **Set up Claude CLI** instead of *Set key*. That opens a terminal with `claude auth login` typed but **not** run, so press Enter yourself (Claude Code 2.1.326 has no `claude login` command). If the CLI isn't installed, run `npm install -g @anthropic-ai/claude-code` there first.

**Start a task** opens the Workbench, the Chat in the editor area. With no agents yet, it shows the first-task screen (see [Start your first task](#start-your-first-task)). Connections and keys are managed here, on the provider cards.

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

Ordinary Builder edits retain a built-in role's recorded command preference; changing capability skills does
not erase its template command default or override an explicit denial. Editing an older agent without a
recorded preference preserves its existing command ceiling, without treating Save as a migration decision.
The Builder saves its candidate before applying it to the live agent. If storage fails, the old configuration
remains active. If the team changes while storage is pending, reopen the agent and review the edit again.

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

UnodeAi keeps two separate network grants. They never blur into each other:

- **Model egress** (per host, at the first agent turn): UnodeAi sends this host your prompt and the workspace files
  the agent includes. This is the grant that lets an agent actually run. Setting up the connection and choosing it
  for an agent is your consent, so UnodeAi does not ask; see
  [Your own setup is the consent](#your-own-setup-is-the-consent) below.
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
- If a **Claude CLI** agent is waiting on a model-egress question (asked only after you revoked or declined that
  destination), its Team card shows **Consent required**. The card tells you to respond to the dialog that is
  already open. The same start stays pending while you read the dialog. **Allow** resumes the agent, and
  **Do not allow** reports an error. If you stop the agent first, a later Allow cannot launch it.

### Your own setup is the consent

**Setting up a connection is your decision to send work there.** So UnodeAi does not ask again before the first
request. This holds for a model connection you set up and chose for an agent, for the Codex program you chose, and
for a vision or transcription model you set up. At the first request, UnodeAi records the grant and shows one
notice, for example: `UnodeAi sends prompts and the workspace files agents read to <destination> for <agent>, the
connection you chose. To stop this, run "UnodeAi: Security" from the Command Palette and choose revoke next to it
under Network egress.` The work goes on; the notice does not wait for you.

To stop sending work to a destination:

1. Press Ctrl+Shift+P and run **UnodeAi: Security**.
2. Under **Network egress**, choose **revoke** next to the destination.

UnodeAi remembers a revoke, and also a **Do not allow** answer. From then on it asks before anything more is sent
there, and only **Allow** in that question sends again.

### Public-web access

`fetch_url`, `web_search`, and native CLI public-web tools use the **Network access** choice. A requested URL or query can disclose information. A paid Unode search also uses the configured Unode connection's model-egress choice.

**A long tool, integration or web result is kept whole.** When a result is longer than one model request can
carry, the agent gets the first part, an opaque id, and the exact `read_extracted_content` call for the rest.
Reading the rest never runs the tool or fetches the page again, and only the agent that received the result can
read it. Parts of long results, attachments and saved sections never split a character such as an emoji. **`fetch_url` has no time limit**: a slow page runs until it ends or you press **Stop**. A site that sends
nothing for a long time is closed by the network layer, and the agent is told so. The download size limit and the
public-only and private-address checks are unchanged. An `@url` you mention in a message is read before the message
is sent, with no time limit. After 10 seconds a reminder says `Still reading <site> for your message (N s). Your
message waits for it. Choose Send without it to send it now without this page, or Keep waiting until the next
reminder.` **Send without it** stops the read and sends the message without that page; **Keep waiting** (or closing
the reminder) brings the next reminder 30 seconds later. **Stop** ends the whole message instead, whether you press
it in the chat, on the agent's row in the Team view, or use **Stop All Agents**: the read stops,
nothing reaches the agent even if the page arrives later, and the chat says `You stopped this message before it was
sent. The agent did not receive it; send it again when you want it.` Removing the agent or clearing or archiving its conversation
also ends such a message. **New Model Conversation (keep chat)** keeps it, and it goes to the new conversation. Stop also ends a fetch that is still looking up the site's address.

`unode.webAccess` defaults to `allow`. A value you set yourself, `ask` or `off`, is kept:

| Mode | Behavior |
|---|---|
| `ask` | A chat approval card names the agent and the requested web action. Paid Unode search has a separate decision from URL reads and shows the query, recipient, unit price and call limit. You can allow the request, deny it, or allow its category for this extension session. An unanswered request expires after 15 minutes. |
| `allow` (default) | Allows public web search and URL fetches for agents that have the `read` capability, without a card. Each search or fetch still shows as a tool card in the agent's chat. |
| `off` | Hides gateway web tools and Claude `WebSearch` / `WebFetch` on new sessions. Stale host calls are refused. Codex disables native search before the next turn and keeps its existing conversation. |

In **Agent Builder > Public search**, choose **Off** to disable search for one member. URL reads still follow the global choice. Turning off native Claude search can cause more command approvals. API members use Unode for `web_search`. Claude CLI uses its native search. When Codex native search is disabled and web policy permits search, a new Codex model conversation uses the host tool. An existing Codex conversation can continue with the tools it started with.

Host search can make at most five upstream searches per call and ten calls per member turn. At the limit, the member can continue next turn. Each call's activity shows the unit price and the call count, such as **1/10**. It usually takes a few seconds and can take about a minute when the gateway is busy. The 120-second deadline starts at send. A timed-out or stopped send can still cost money and counts toward the turn limit. The tool skips automatic retries after an uncertain send.

Host search instructs the service to search before answering; if no search executes, the result says it has no sources, records token usage with a zero search fee, and does not retry automatically. If the gateway supplies matching search results but omits the count, the tool labels its dated list-price fee as an upper-bound estimate from the response.

The dated Unode list rate is **USD $0.01 per search**, separate from token costs. Fifty searches cost up to **$0.50** at list. The 2026-11-23 observed gateway discount brought that search fee to about **$0.30** and can change. The result shows the estimated search fee from reported usage. The Unode bill supplies the final charge. Structured search sources can be cited by title and URL. Use `fetch_url` to retrieve a source's page body.

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
| `ask` | Asks before unapproved commands. Select this to restore the previous default |
| `allowlist` | Only commands matching `unode.allowedCommands` can run |
| `all` (default) | Runs commands automatically; recognised destructive commands ask once |

A bounded guard reads each command under its shell. In Automatic, Ask each and Allowlist, recognised destructive commands ask for an exact, single-use confirmation showing the command and folder. These include recursive deletes of `.`, `..`, a drive or home root, `.git` or `.unode`. Don't run is the default; dismissal or no approval UI means not run. Disabled refuses every command, including dangerous deletes, and shows the command, folder and how to enable commands in the chat. For the selected agent, **Ask for approval** in the chat **Autonomy** menu requests both mediated write and command review. To change only User command review:

1. Run **UnodeAi: Open Settings** from the Command Palette.
2. Open VS Code **Settings** and select **User**.
3. In Settings, select **User**, search for `commandApproval`, and set `unode.commandApproval` to `ask`.

Simple literal commands follow the selected mode. Commands the scanner cannot analyse run automatically in the default `all` mode, ask once in `ask`, and remain refused in explicit `allowlist` or `none`. The check is a limited heuristic, not a sandbox; it does not predict what a program will do. Codex native commands use its own permission profile.

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
first has ended or moved to the background. Commands from different agents run in parallel.

**Long output keeps its start and its end.** The agent receives at most 16,000 characters of output: the start
and the end, with a line in between that says how many characters were left out.

**How long a command waits in the foreground.** On an OpenAI-compatible or custom-gateway agent, the default
waiting budget is 120 seconds, or the requested budget up to 10 minutes. That is not a process deadline: the same
command keeps running in the background, in the same shell, without replay or a timeout kill. The agent gets a
check_command ID and can use kill_command to stop it. It can wait in one step, up to 5 minutes, instead of polling
again. Each check sends the agent's whole context to the model, so one wait costs far less than a series of
checks. **Stop** ends a wait at once. The background command itself keeps running until the agent stops it or
the agent's session ends.

**A timed-out command is stopped with everything it started.** UnodeAi sends Ctrl-C and waits two seconds. Then
it stops the command's whole process tree and closes the terminal. It does this even when the prompt came back,
because a returned prompt does not prove that child processes stopped. Checking that everything stopped usually
takes about a second, and up to a minute on a very busy computer. The agent's next command gets a new terminal.
A command whose end UnodeAi did not see is reported as `outcome unknown`. UnodeAi never runs it again on its own.
If UnodeAi cannot confirm the stop, the agent's commands are not locked: its next command runs in a new terminal
or process. The result says: `Command timed out. UnodeAi requested a stop of its process tree but could not confirm
that it stopped, so it may still be running and may have had effects. It was not run again. This agent's next
command still runs, in a new terminal or process. If an old process is still running, end it before you run
something that depends on it.` If the terminal closes while a command runs, UnodeAi cannot confirm that what the
command started has stopped either. The command is reported as `outcome unknown`, and the agent's next command
opens a new terminal. To end an old process, use your system's task manager.

**Background commands run alongside other work.** A background command uses the declared direct shell:
`cmd.exe` on Windows, `/bin/sh` on macOS and Linux. Several can run at once, next to foreground commands. Each
keeps its ID, and the agent uses `check_command` and `kill_command` with it. `kill_command` reports a command as
killed only after UnodeAi has seen its whole process tree end and the command's output close. A program the
command started can keep that output open after the command's own shell has ended; UnodeAi waits up to five
seconds for it. Otherwise it says the stop was not confirmed and that the command may still be running; the
agent's later commands still run. When an agent's session ends, UnodeAi stops its background commands. A stop it cannot confirm, also one it tried before, is shown
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
individual agent in the Agent Builder, under **Command Access**:

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
messages) show an approval card before they run, and so does a new or unknown Claude tool. For one of your own
MCP tools, or a Claude tool this version does not know, **Always allow this tool** is kept for that agent in this
project only, and survives a restart. It is never machine-wide or crew-wide. The Security panel lists the kept tools under each
agent, with a **revoke** that applies to the next call; removing the agent forgets them. For a write or
external-effect tool, the answer lasts only for the running agent process. If `unode.writeApproval = ask`, native Write/Edit calls show the
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
| The file has unsaved changes in an editor | The change is made on disk and a transcript line says so. UnodeAi never saves, reloads or discards your editor: your unsaved text stays there, and when you save, VS Code lets you compare the two versions and choose |
| The file is larger than 32 MiB | The change goes ahead like any other: UnodeAi compares the file by reading it as a stream, and keeps its restore copy on disk |
| The file changed after an earlier read/write, or another running request wrote it | Continue under the usual permissions and explicit Ask setting; report the observed change, without an extra ownership card |
| Git shows modified, staged or untracked work without a host ownership record | Continue with existing restore-point handling and a transcript notice |
| Git shows the file committed and unchanged | The change goes ahead under the agent's usual permissions and your write-approval setting |
| The file is outside Git (or ignored by it) | Continue under the usual permissions, whether or not it was read in this request; unfamiliar work gets a notice |
| The file does not exist yet | The change goes ahead; the folders it needs are created with it, and the result names them |

There is no extra ownership-decision card. Explicit `unode.writeApproval = ask` and a native Codex Ask profile
still ask normally. If the target changes during that explicit approval, the original plan is not written.
After an observed unfamiliar-file change, one transcript line explains it. Only a confirmed exact pre-change
restore point gets "A restore point was kept; ⟲ undoes this." Other paths say to review the edit's restore option
without promising an undo they did not confirm. File names are quoted on one line, including unusual characters.

UnodeAi's record of its own changes lets the next request continue a file without asking again. It holds, for at
most 1,000 files per workspace and for 30 days each, the path, size, SHA-256 and file identity of what UnodeAi left
there and which request did it; never file contents. For Claude and Codex, only a result that reads back exactly as
the change said it would counts. A changed, expired or lost record produces a notice, not another ownership question.

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

**An ordinary project parent needs no question.** With `parent`, agents read and search an ordinary parent folder after one notice:
`Agents can now read and search <folder>, the folder that contains this workspace (your Local read scope
setting).` The notice says that file names and contents they read may go to the agent's model provider, and that
writes and commands stay in your working folder. To stop it, run **UnodeAi: Security** and choose **revoke** under
**Local folder discovery**, or set `unode.localReadScope` to `workspace` in User Settings. A revoked parent folder is
asked about again, with the dialog below. Your home directory, its ancestors, common profile containers (such as
`/Users`, `/home` or `C:\Users`) and a whole-volume root are never made readable merely because they are the parent.
They use the existing consent question first. Paths are checked after resolving aliases; workspace reads and locations
you already granted remain available. A deeper project parent or an ordinary parent outside home keeps the existing behavior.

**A whole volume still asks.** The first time the crew tries to access a volume root in a top-level user request,
UnodeAi opens a modal dialog. The dialog names the resolved absolute path. It says that agents may **read and
search** there. It also says that a `search_files` call without a path can walk the whole root, and that returned
filenames and contents may be sent to that agent's configured model provider. For a volume, it adds a warning that
the volume can include other users' profiles. Choose **Allow** to cover that root for the current extension
session.

**Deny**, or closing the dialog, blocks the root for this request, for the coordinator and its delegates alike.
Immediate retries do not ask again, but a later direct user request may. If the UI fails or is unavailable,
retries for this request are blocked too. That is not recorded as your decision. The refusal notice offers **Grant
folder access**. The Security panel lists session-only grants and declines, with grant and revoke actions. Each
admitted access has a tool-card and run-evidence receipt. The receipt holds only an opaque root id, the
operation kind, and a count — never a path, query, or file contents.

**Agents are told the root exists (0.9.89).** On every route, each turn's project context now names the
`parent` or `volume` root. For a volume it says that the root is not granted yet. When the agent needs something
there, it calls `read_file` or a search tool, and the notice or the dialog above applies. Before this change, agents often did not know they
could ask. The note grants nothing. It is absent for `workspace` and in an untrusted workspace. The context
receipt lists it as **Local read reach guidance**.

In Agent Builder, use **Folder Access (advanced)** to restrict an agent to specific folders. A project file may
also narrow access to a path that is physically inside that workspace, for example
`{ "path": "docs", "permission": "read" }`. Outside paths and symlink escapes are ignored. When present, this
replaces the workspace default instead of adding to it. Claude CLI supports at most one writable folder.
Read-only Claude agents deny native write and shell tools. The extension-owned Playbook plugin for Claude CLI
contains host-authored discovery entries. Protected agents read the assigned procedure through host tools without
gaining Bash or write authority. The Security panel shows folder grants next to each agent's MCP grants. This
setting does not sandbox MCP servers, because they run as separate processes.

Codex CLI does not claim Folder Access confines reads. A read-only grant uses Codex's read-only profile.
A writable grant uses the native Ask for approval profile, where routine commands and in-boundary edits can run
without a card. Eligible permission escalations remain individually approval-gated. On Windows, the CLI may read
files available to the user's account. Choose this route only if you understand that boundary.

### MCP approval

UnodeAi-managed MCP servers are denied by default. Servers that touch files, credentials, networks, browsers, or external systems should require approval before mounting. **Adding a server yourself is that approval:** a server you add in the Marketplace, or with **UnodeAi: Add MCP Server**, mounts without another question. The approval is bound to this workspace and to the server's exact launch settings (command, arguments, URL and environment names), so a later change to the server asks again. A server that comes from a file still asks before it mounts. MCP servers you configure directly in Claude or Codex stay under that CLI's own controls.

**Images from an MCP tool.** When a UnodeAi-managed MCP tool returns a picture (a screenshot tool, for example), a
Claude CLI or Codex CLI agent now sees it with that one tool result, sent with the rest of the conversation to the
agent's provider. The result's text names each image and says how many were attached. PNG, JPEG, GIF and WebP are
sent, read from the image itself. At most 4 images per result are sent, each at most 5 MB and 10 MB together; any
other is left out, and the text says why. UnodeAi keeps no image bytes: its chat, snapshots, logs and exports record
only the text. Claude and Codex keep their own conversation history as they do for any tool result. Codex calls these
tools from its own code tool, where a result is one piece of text with each image as a line beginning `data:image/`;
each such tool's description and each result with an image tell the agent to pass that line to `image()` to see it. An
OpenAI-compatible agent gets each image kept as one of its temporary assets, named in the tool's result; to look at
one it asks with `send_image_asset_to_model`, which uses the same media-upload decision as any other image (the vision
model you set up counts as consent; one you revoked or declined asks again) and sends it with that one request only.
These assets are files in the system's temporary folder. They are kept while the task or request that produced them
is open, then for 30 minutes unused, and deleted when UnodeAi next cleans up or closes; sending one does not delete it. A model without vision is told it cannot see them, and its other work goes on.

## 12. Verification

PM `run_checks`, the shared-workspace OpenAI-compatible completion gate and workflow objective gates use the
current `.unode/team.json` field `completionVerification`. Choose one of:

```json
{"mode":"disabled"}
{"mode":"auto"}
{"mode":"command","command":"npm test"}
```

Set that field to one object, not the three examples together. This is command selection, not execution approval.
If the field is absent, a knowledge team uses disabled; a software team uses your nonempty User Settings command
or automatic detection. The compatibility setting is:

```text
unode.verifyCommand
```

Examples:

```text
npm test
npm run build
npx tsc --noEmit
```

Only the User Settings value is used for compatibility; a workspace/folder value cannot replace it. Auto mode
checks for an explicit project script in this order: test, typecheck, type-check, check, build, lint. An invalid
policy or unreadable team file blocks the check without a fallback. Commands must be a single line without NUL,
and at most 2,048 UTF-8 bytes after trimming.

The verify command runs in the declared direct shell: `cmd.exe` on Windows, `/bin/sh` on macOS and Linux. Its
approval belongs to that shell's grammar. It passes only when UnodeAi observes exit code 0. A run whose end
UnodeAi did not see has an unknown outcome; it is never evidence that checks passed.

The command still obeys `unode.commandApproval` and the calling agent's restrictions. Team-file configuration does
not grant permission. Interactive `run_checks` can ask for approval; automatic completion and workflow checks do
not prompt, so an unapproved command stays unrun. A workflow that cannot run its objective check pauses without
spending implementation retries or changing model tiers. The PM end-of-turn gate stays opt-in: it is built only
when the team file explicitly sets `completionVerification` (including `auto`), or the User Settings command is
non-empty, and `unode.gate.enabled` is on. An unconfigured software or knowledge team does not acquire this gate.
Disabled/not-applicable checks without a required command sensor stay in the turn evidence and result card, not
the PM reply. Other unrun/unknown checks preserve the delivery and add the obstacle. Only a real observed failure
requests an implementation fix.

The request result card records the last host completion-check result and its configuration source, including
disabled, not applicable and unknown. This receipt contains no command or output text, grants no permission,
and cannot be reused to mark another task as verified.

These commands are not confined by a new shell sandbox. An otherwise allowed configured command that mentions
an outside absolute path runs with a warning under the existing command rules. Approval of an npm command is not
a hash approval of its script contents.

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

You choose the mode with this setting or the Concurrency command. UnodeAi does not infer or enable worktree mode
from the wording of a task. When worktree mode is on and a verify command is configured and approved, the
command's observed result can gate the merge; if any of these is missing, UnodeAi does not claim an automatic quality gate.

Worktree mode requires a git repository with a clean tree. Each eligible agent works in its own worktree. When its turn finishes, its work is committed on its own branch; only work with an observed passing check can automatically enter the Unode **integration branch** (`unode/integration`). Review it with:

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

In worktree mode, the pre-merge check uses the same current team `completionVerification` policy described above,
with the same User Settings compatibility rule. It runs **inside that agent's actual worktree**, under that worker's
current command restrictions and Workspace Trust. This unattended check never opens approval:

- **Pass →** the work merges to the integration branch.
- **Fail →** the work is **held on the agent's own branch (not merged)**. The failing output is handed back to the agent so that it can fix the work and finish again. Only verified work lands.
- **Could not run (disabled, not applicable, not approved, no script) or unknown outcome →** the work merges into
  the integration branch **marked unverified**, bound to its committed version and a clean lane. It is never a pass,
  and it is never finalized to your branch automatically; approving it stays your step. The chat says:
  `<agent>'s work was merged into the integration branch unverified: <reason>. Review it in Crew Worktrees before
  you approve it.` No implementation-repair turn is started, and an unknown check is not run again.
- **A check you required →** when you set a verify command yourself (in the team's `completionVerification` or in
  `unode.verifyCommand`) and `unode.worktree.verifyBeforeMerge` is on, or when UnodeAi cannot read the policy as
  valid, a check that could not run or whose outcome is unknown still holds the lane, as before.
- **Stale request or policy, or invalid configuration →** the work is held, not merged.

A crew therefore lands work automatically only when it passed your project's own checks, or marked unverified on
the integration branch when no check you required could run. The **Crew Worktrees (Review)** board shows each lane's status — **✓ verified / ✗ failing / ⚠ unverified**. It also **flags any lane that passed by editing the test files**. A weak model can make checks green by weakening a test instead of fixing the code. The flag lets you review those lanes before finalizing.

**Turning checks off is never a pass.** With team checks off, or with `unode.worktree.verifyBeforeMerge` set to false,
a lane merges into integration only marked unverified, and missing scripts or commands are not passes either. To
land work as verified, choose an applicable team check and grant the required permission through the existing
command controls. A one-use approval elsewhere does not promise permission for a later unattended check.

The worker's next task stays queued until its completed-task verification/merge settles. Stop invalidates that
original request; a late callback cannot verify or merge the next task. Before Git merges, UnodeAi rechecks the
current policy/permissions and pins the exact verified commit. Unmerged lanes are retained rather than pruned
when their agent is removed, and continue to occupy worktree slots until reviewed and cleaned up. Manual
review/finalize of already integrated work remains a separate user action.

A lane is still held when its check failed, its request or policy went stale, its configuration is invalid, or a
check you required could not run. To land a held lane
yourself, choose **Merge without verification** beside it in Crew Worktrees (Review).
The confirmation names the agent, branch, exact committed version and why it is unverified; **Not now** is the
first ordinary button, so Enter declines. VS Code also supplies Cancel for close/Escape. Only an explicit
confirmation merges that SHA into integration. A worker
currently using the lane, an unfinished post-turn check, uncommitted files, a changed commit, lost trust or a
changed workspace prevents the action. New tasks queue while review/merge owns the lane. Review must finish
before explicitly starting the worker again. This never commits pending edits, runs a check or automatically
finalizes to your branch, even with autoMerge enabled. Use the separate **Finalize** action when ready.
The lane is marked **Merged — unverified**, not Verified; its original check result is not rewritten and no
passing check or verification evidence is created. Once merged, normal non-forced cleanup may remove the lane.

Additional worktree settings:

| Setting | Default | Purpose |
|---|---|---|
| `unode.worktree.verifyBeforeMerge` | `true` | Run the current team check before merging into integration; off merges work there marked unverified, never as verified |
| `unode.worktree.verifyTimeoutSeconds` | `300` | Hard timeout for the verify command (10–3600). On timeout, it is killed and treated as a failure |
| `unode.worktree.autoMerge` | `false` | Automatically land clean integration work into the base branch |
| `unode.worktree.maxParallel` | `4` | Maximum number of isolated worktrees at once |

## 14. Dashboard and Activity

Open the dashboard with:

```text
UnodeAi: Show Dashboard
```

The dashboard summarizes agents, message activity, workflow state, token use, and estimated cost where usage data is available. A plain `$...` is a cost that the provider reported as billed. `~$...` is an estimate. It can be an account estimate from your key's coefficient or group, a dated reference estimate, or an API-equivalent figure for subscription CLI usage, which reads `Subscription (API-equivalent ~$...)`. If no completed turn established a cost basis, the dashboard says **cost unknown**, never `$0`. The **Spend** section keeps each of these in its own row.

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

**How an amount reads (0.9.108).** The chat header, each agent's card in the Team panel and the rows of the Spend
section use the same words, so an unknown amount is never shown as $0 or left blank:

| You see | Meaning |
| --- | --- |
| `$x` | A billed cost. |
| `~$x` | An estimate from a labelled price source, or a total that mixes cost bases. |
| `Partial usage ~$x` | It includes a stopped turn, counted with only the usage reported before it stopped. |
| `Usage recorded, cost unknown` | A stopped turn reported usage, but no price is known for it. |
| `Subscription (API-equivalent ~$x)` | Subscription CLI usage priced from the reference you chose. Not a bill. |
| `Subscription, no per-turn amount` | Subscription usage with no per-turn amount and no reference price for the model. In Spend rows this reads *Subscription (no per-turn amount)*; earlier rows keep *Price unavailable (tokens only)*. |
| `Partial usage, subscription (API-equivalent ~$x)` or `Partial usage, subscription, no per-turn amount` | A stopped turn on a subscription. |
| `+ 1 turn usage unknown` (or `+ N turns`) | Added when a turn made a provider request whose usage was never reported, for example because its process exited mid-turn. |
| `Usage not reported, cost unknown` | No turn's usage was reported at all. |
| `cost unknown` | No cost basis has been seen yet. |

In the Team panel, hovering the amount explains it. Before 0.9.108 the chat header showed a cost only when it was
above zero.

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
**Update reference prices**. Later reminders come at most once every 30 days. A window that opens with no agents
shows no reminder, since nothing is being estimated yet; the next window that opens with an agent does. An update
contacts only that gateway's public price list, over HTTPS. It sends no key and refuses redirects. If anything is
wrong, it keeps the previous snapshot. Earlier receipts keep the prices they were recorded with.

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

The **Latest tasks** panel sits at the top of the dashboard. It shows your most recent tasks, newest first. Each task is broken down by the agents that worked on it, with a token bar per agent, plus the task's total tokens and cost. This lets you see exactly where the tokens went across a PM-led, multi-agent run. A task's record closes when its last turn ends. A turn that runs after that, such as a result wake or a file-access continuation of that request, is not added to the record; the **Spend** section counts it under the request. Use the **Show last: 3 · 5 · 10 · 20** control in the panel header to choose how many tasks to display. Below the panel comes **Team activity**: one card per agent (status, current task, files, cost, context and actions), as many per row as fit. The totals, savings banner and cost charts come after that, for reference.

The dashboard updates live while the crew works — you don't need to close and reopen it.

Use the Activity panel for the live team event stream. You can export, import, clear, or compact message history from the Activity view's title bar; Import Messages and the run exports are under its `...` menu. The Activity view appears once the team has an agent. Each message carries the turn's raw usage. The Activity panel is therefore the most precise place to see one agent's tokens and cache hits for one turn.

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

You can export or import chat and message histories from their views' title bars (Chat's Export and Import are under its `...` menu, and in the Chat session menu), or with **UnodeAi: Export…**.

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

**What the Command Palette lists.** Every command below keeps its id, its handler and its keyboard
shortcut; a hidden one still runs from a keybinding or from another extension. The palette lists the everyday
entries: Show Team Panel, Open Workbench, Add Agent, Build an Agent, Create/Save/Load a Team…, Start All Agents, Stop
All Agents, Review Delivered Work, Run Setup Wizard, Setup Guide, Export…, Open Settings, Security, Open Spend, Open
Marketplace and Add MCP Server. It also lists **Team Actions…**, and the commands that have no other place in the
interface:
Set Provider API Key, Refresh Model Prices, Compact Context, Toggle Workbench Composer Focus, View Archived Chats,
Run Demo Task, Review Shared Memory, Apply Execution Hooks, Show Prompted Command Frequencies, Show Agent Output,
Crew Worktrees (Review) and Manage Project Command Approvals. The rest are reached where you use them:

- **⋯ Team Actions** (Team title bar): Solo Agent, Send Message to Agent, Collapse/Expand, Setup guide, Team Rules,
  Run Workflow, Edit Workflow, Saved Task Batches, Restore/Delete File Checkpoint, concurrency mode, Dashboard, Unode
  Account / Profile and Generate Evidence Report.
- **A member's row** in the Team panel: Start, Stop, Restart, Configure, Terminal, Remove, opening its chat, a
  pending approval and its changed files. These commands need an agent, which the palette cannot supply.
- **Chat**: the session menu (`…`) and the Chat title bar hold Archive, Clear, New Model Conversation, Compress Chat
  View, Export Chat, Import Chat and View Archived Chats. The Workbench title bar holds Show/Hide Changed Files.
- **Activity** title bar: Export Messages, Compress, Clear, and under its `...` menu Export Run Evidence Pack, Export
  Worker Progress Distribution and Import Messages. **Export…** lists every export format.
- **Spend**: the Settings Spend tab and the Dashboard's Spend section hold Change target, Reset counter, Update
  reference prices, Repair spend tracking and Review proposal. **Settings → More** holds Reset workspace state.
- The status bar's `🔐 N waiting` opens a pending approval; the editor title bar's UnodeAi icon opens the Dashboard;
  the Crew Worktrees panel has Finalize.

Deleting a folder containing files UnodeAi did not make asks once, showing the folder and up to ten file names.
Don't delete is the default; closing the dialog, Stop or no approval window leaves the folder intact.
Folders have no restore point. This one confirmation also applies when mediated write review is enabled; there is no second card.

When loading a project team without restoring saved permissions, built-in agents can still run commands.
Turn Run commands off per agent in Agent Builder. The load notice and permission review list only permissions
that were actually removed; old records with no tool list retain their original tool defaults.

| Command | Purpose |
|---|---|
| `UnodeAi: Get Started` | Open the Workbench; with no agents, its first-task screen |
| `UnodeAi: Setup Guide` | Open the setup guide: what is set and where to change it. Sends nothing |
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
| `UnodeAi: Run Demo Task` | Send a demo task to the PM; with no agents, put it in the Chat's goal box |
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
| `UnodeAi: Documents & images` | Open the existing Documents & images settings section; starts no application |
| `UnodeAi: Open Unode Account / Profile` | Open the local Unode key, balance, and account-links page |
| `UnodeAi: Refresh Model Prices` | Fetch live (discounted) model prices from your approved gateways on demand |
| `UnodeAi: Security` | Review Workspace Trust, approvals, and every network grant (each revocable) |
| `Manage Project Command Approvals` | Inspect or revoke this project's host-owned command approvals |
| `UnodeAi: Open Marketplace` | Open marketplace |
| `UnodeAi: Edit Team Rules` | Edit `.unode/rules.md` |
| `UnodeAi: Restore File Checkpoint` | Restore a checkpointed file, or delete a restore point with its trash button |
| `UnodeAi: Delete File Checkpoint` | Delete a restore point; the file does not change |
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
target. **Changing the first folder during the session stops nothing.** Running agents, Integrations and terminals
keep going, and nothing is refused. UnodeAi keeps working in the folder it started with until you reload the
window: agents, team settings, saved project teams, completion verification, execution hooks and the folder the
Save dialogs suggest all stay with that folder. Its project state is never redirected into the new folder, and it
never falls back to the editor program folder. One notice says so: `The first workspace folder changed. UnodeAi keeps working in the folder it started
with, so running work continues. Reload the window to switch UnodeAi to the new first folder.` Choose **Reload
Window** when you are ready to switch. UnodeAi-created terminals carry a marker that survives an extension-host
restart. As a result, activation also closes inherited terminals and their process trees. Terminals you created
yourself are not touched.

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
| `UnodeAi: Team Actions…` | Open the Team title-bar menu: Solo, send a message, collapse/expand, build an agent, create/switch team, start/stop all, team rules, workflows, saved task batches, checkpoints, concurrency mode, Dashboard, Marketplace, Account/Profile, Security, evidence report |
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
| `UnodeAi: Get Started` | Open the Workbench's first-task screen |
| `UnodeAi: Run Demo Task` | Run a demo task |
| `UnodeAi: Start Agent` | Start the selected agent |
| `UnodeAi: Stop Agent` | Stop the selected agent |
| `UnodeAi: Restart Agent` | Restart the selected agent |
| `UnodeAi: Remove Agent` | Remove the selected agent |
| `UnodeAi: Edit Agent` | Edit the selected agent |
| `UnodeAi: Show Activity` | Show the team activity stream |
| `UnodeAi: Clear Chat` | Delete the messages shown in the active chat. The model's conversation is not reset, so the model may still remember them |
| `UnodeAi: New Model Conversation (keep chat)` | Explicitly start fresh model context for the selected agent; keep the visible chat. Send needed context again |
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
| `UnodeAi: Delete File Checkpoint…` | Delete a restore point |
| `UnodeAi: Revert to Before a Request…` | Put back the files a member's request and its later requests changed; a preview comes first |
| `UnodeAi: Undo Revert…` | Put back, file by file, what a revert replaced |
| `UnodeAi: Redo Revert…` | Apply a revert again, file by file, until a newer request starts from the undone files |
| `UnodeAi: Task history` | Search, resume and delete this workspace's past tasks and their restore points |
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

### Request composition diagnostics

The local **UnodeAi** log channel records one `[request-composition]` line at each actual host-observed
send. It contains only sizes, fixed category labels, and host-generated launch/turn/attempt coordinates:
system instructions, tool descriptions, replayed text and tool results, current input, attachments, and
host context. `file_reads` is an evidenced subset of tool-result tokens, not an extra addition. The estimate
uses the existing context heuristic; it is not a tokenizer, provider bill, or request-budget authority.

OpenAI-compatible lines describe the final provider request, including each actual retry or gateway fallback.
The rare merged-user gateway fallback is explicitly `partial`. Older result origins may also be unknown;
the file-read count is then only a lower bound. Claude and Codex lines describe a **host turn submit**, not
each invisible CLI request: CLI-managed history and internal requests say `not-observable`. Codex's known
setup instructions/tools are separate installed estimates, never added to every turn's sent total.

Later `[request-usage]` lines correlate real reported usage by the same host coordinates. OpenAI-compatible
usage is request-scoped; CLI usage is turn-scoped with no invented request attempt. Reconstructed usage is
not presented here as reported usage. A measurement failure has a fixed `measurement-unavailable` label;
it cannot change sending or retries. These diagnostics contain no prompt, file contents/names, tool arguments,
provider identifiers, URLs, keys, or base64, and do not enter chat, snapshots, run records, or portable exports.

### A command refused with `shell-compatibility` in a new window

If `run_command` says the selected terminal profile could not prove shell integration and cwd, the first command did
not run and the next one is checked for `cmd.exe`. One known cause: the window was opened by running `code` in Git Bash
while VS Code was already open, with Windows PowerShell 5.1 as the terminal. The window takes that shell's environment,
which has variables that differ only in case, such as `ComSpec` and `COMSPEC`. Windows PowerShell 5.1 then fails while
reading its environment, and VS Code's shell integration does not start. If this matches, open the folder from a window
you opened from the Start menu instead. A folder that is not trusted also has no shell integration. There may be other
causes.

### Times in Chat look an hour off

Chat shows times in your local time, with the time zone named. Some editors' runtimes do not know Windows' time zone,
or know it with older rules than Windows; UnodeAi then follows Windows' own clock, so Chat and Windows agree.

**The clock report (0.9.103).** When a Chat view loads, the **UnodeAi** output panel (**View → Output**, then
choose **UnodeAi**) gets a line that starts with `clock:`. It names Windows' offset, the time zone, locale and
offset that the extension and the Chat view see, the correction UnodeAi applies, and ends with *Times on screen match
Windows.* or says by how many minutes Chat or the message log is ahead of or behind Windows. A later load, such as a
reload, adds a line only when a clock changed. If you report a wrong time, copy that line.

Chat also reads Windows' clock again when its window regains focus (at most once a minute) and every ten minutes.
After a daylight-saving change, or when Windows' time zone changes, the times in Chat follow Windows from then on,
without a reload.

Known limit: when Chat follows Windows instead of the editor's own clock, it uses Windows' offset of today for every
time. A time from before a daylight-saving change, or before a change of the zone's rules, can then show an hour off.
The stored time is unchanged; only its display is affected.

### Interrupted replies

OpenAI-compatible, Claude and Codex turns use the same host-owned interruption wording. An error is described
as a lost connection, provider failure/timeout or process exit only when the host observed that source; an
unclassified error stays generic. The product's summary uses only bounded tool/file/dispatch observations of
that turn. Native or missing coverage is explicitly partial/unknown, not evidence that nothing ran or that the
assigned work finished. The result card says **Interrupted**, while the underlying turn still failed.

A visible unfinished reply is kept before that summary and is not a conclusion. **Original error details** is
a collapsed, plain-text disclosure on the same transcript reply, not an approval above the input. It shows only
an allowlisted name/code and at most 1,000 mechanically redacted message characters, never a stack or arbitrary
error object. Review logs before sharing: no pattern-based redactor can identify every sensitive value. This
live detail has a bounded in-memory cache only; clearing/importing the conversation removes it. Reloaded/imported
summaries retain their typed interruption and observations, with a pointer to local logs instead of the old detail.
Error detail is not a model input, chat/task record, portable export or verification result. Sending **continue**
is a new explicit instruction using existing records, not permission to repeat earlier tools or dispatches.

### Shared model-response retry limits

An OpenAI-compatible response uses one existing retry allowance across streaming, compatible-request repair,
JSON fallback and an unchanged empty-reply retry: at most `maxRetries + 1` real sends, not that many per path.
This also applies to ordinary gateway compatibility repairs. With no retries allowed there is no second
fallback or blank send. A usable completed response closes that budget; after its tools run once, the next
model response gets its own budget. This does not replay the turn or its earlier tools.

There is no implicit model-response time ceiling: silence produces progress, not an automatic abort or retry.
When an embedding explicitly supplies a time limit, headers, body reads, repairs and retry backoff share it;
human consent and request-limit decisions do not use provider time. Explicit per-stream limits remain honoured.
Stop cancels a pending retry wait. A route/host refusal before a network attempt ends without repair or resend.
These limits do not add any CLI interruption retries. Eligible interrupted OpenAI-compatible responses use
the same remaining budget, not another allowance.

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
- **Quiet requests now explain their progress.** The former silence deadline has been removed. A live summary
  shows recorded work and pending results while execution continues; you can choose Stop.
  See [A coordinator's first action](#a-coordinators-first-action).
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

Check the current team's `completionVerification`, the project's explicit script and `unode.commandApproval`.
For software teams without a team policy, the compatibility command comes only from User Settings
(`unode.verifyCommand`). Disabled, invalid, inapplicable and unapproved checks have different explanations; none
means that implementation tests failed.

When `unode.commandApproval` is `none`, or the command policy refuses the check, the check is not run. The request
says so in one place: the PM's `run_checks` card (expand it for the full refusal), or the note after the PM's reply for
the end-of-turn gate. Under `none` it names the command and folder and gives the steps to `unode.commandApproval`;
under a refusing policy it gives the policy's reason. No notification repeats it, and Commands stay Off until you
change the setting. The request's result card still shows the check as not
run. Each later blocked check, and another agent's blocked command, is reported again.

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

### A gateway edit is waiting

An endpoint or key edit is not refused while an agent on that gateway is **running**. It is saved when that
agent's turn ends, and a notice names the agent. To save it now, press **Stop** on that agent in the Team panel.
An idle agent does not hold the edit, and renaming is never held.

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

### Office documents, spreadsheets and presentations

When `read_file` extracts DOCX body text, deleted and moved-from content (including deleted field instructions)
is omitted; inserted and moved-to content remains. Files with tracked changes or comments include a notice pointing
to `inspect_office`, and a line that counts the changes, their authors and the comments. This plain-text view does
not provide the revision history, authors or comment threads themselves; `inspect_office` does (see
[Word: tracked changes and comments](#word-tracked-changes-and-comments-09108)). An unreadable optional comments part
is reported without blocking the body read.

Built-in Office tools use the agent's existing file access. Reading needs Read; writing needs Write and uses the
normal write approval, restore point and byte readback. **Commands Off still permits ordinary Word/PDF and editable
PowerPoint generation, workbook writing and PDF editing.** Advanced JavaScript, native application rendering,
recalculation, PDF export, PDF-to-Word conversion and PDF page images also need Commands. No Office
application, Python environment or global package is installed automatically.

| Task | What the agent can use | What the result establishes |
| --- | --- | --- |
| Read spreadsheet data | `read_workbook` for XLSX or CSV, with range, sheet and visibility selection | Actual values, formulas and saved formula caches, parse settings and paged delivery coverage; no Excel recalculation |
| Compute a source-bound table | `transform_workbook` with named selection, filter, grouping, aggregate or unit conversion | Host computation and source versions; the agent cannot supply invented totals as verified computation |
| Create a presentation | `write_presentation`, including staged drafts | Editable text, tables, supported native charts and authorized image assets in PPTX; save hash and file effect |
| Read or edit an existing template | `inspect_office`, `edit_office` | Version-bound selectors, continuation and supported edits with changed/preserved package parts; unsupported features remain explicit |
| Render pages | `render_office`, then `inspect_operation` | Captured pages from the selected installed application, with original/copy/page hashes and partial-result facts |
| Send those pages to a reviewer | `view_office_images` | Actual image transport and response facts for the selected connection/model; a separate evidence-based review is still needed |
| Read or decide Word tracked changes and comments | `inspect_office` (`view` current, original or markup), `edit_office` | Changes and comments with authors and dates; edits saved as tracked changes by default |
| Write a workbook | `edit_workbook`, `write_workbook` | Values, formats and formulas read back from the saved file; formulas not calculated |
| Recalculate a workbook | `recalculate_workbook` | Values produced by Excel or LibreOffice on a private copy, per cell; optionally written back as saved results |
| Export, edit or view a PDF | `export_pdf`, `edit_pdf`, `view_pdf_pages` | Saved PDF with page count and what changed or was left out; page images for a model that accepts images |
| Change the text of a PDF | `edit_office` then `export_pdf` with `regenerates_pdf`, or `convert_pdf_to_docx` | A new PDF from an edited Word or PowerPoint file, with the source link confirmed or not; see [Changing the text of a PDF](#changing-the-text-of-a-pdf) |

CSV defaults to strict UTF-8, including its BOM. UTF-16LE, UTF-16BE and GB18030 require explicit selection; a failed
decode does not silently guess another encoding. Empty strings, missing cells, errors and numbers are distinct.
XLSX dates retain the original serial and date system. Source-bound Office tables display dates, percentages and
currency using stored number formats; blank cells stay empty and source string spaces are retained. Repeating
host-computed fractions display at up to 12 decimal places, rounded half away from zero; their exact rational values
remain in computation evidence. Native chart labels and editable embedded data cells retain source display codes,
while numeric chart values still have the separately reported IEEE754 precision limits. This is stored-format
display, not native Excel width/locale verification or formula recalculation. Formula caches are saved workbook values, not newly calculated
answers. A host calculation may cover more source data than the model has received; the result reports those facts
separately. Pagination and long-cell fragments retain their version and coverage rather than pretending truncated
output was complete.

Source-bound Word tables and presentation tables/charts use host-computed values and check the actual saved package.
They report unresolved cells, normalization, precision loss and partial selections. This does not turn arbitrary model
prose into verified source data. Editing an embedded chart keeps its editable workbook and chart cache consistent
where supported. To write a workbook itself, agents use `edit_workbook` and `write_workbook`
([below](#writing-excel-workbooks-09108)). Existing Word fields and complex template
features may be preserved without being refreshed or visually verified.

**HTTP Office field observations (0.9.107, Unode gateway, 2026-11-21).** Installed retests of `b3ac3dd5`, one original
request per model, completed reading data, generating Word/PPT and native rendering with both `gpt-4.1-mini` and
`gpt-4.1`. Each produced a Word report with one title and the correct four-row totals table, plus three PowerPoint
slides with an editable native chart of North 15 and South 20. Word captured one page and PowerPoint three pages;
the passive PPT render copy was partial. These are bounded observations, not model compatibility promises.
`document.title` is optional: a leading level-1 heading supplies it; an explicit title is displayed automatically
as the first line and need not be repeated in a heading.
Models can misjudge formula-cache consistency and table row counts: `gpt-4.1` again failed to flag saved cache 999
as inconsistent with source values totaling 35; its preceding a12a2d4c output also added a table row. The Owner named
those judgment errors as model limitations. For important checks, review the source values and actual output
manually, or use the Claude CLI or Codex CLI route. A saved formula cache does not establish freshness or correct
recalculation. If a connection does not declare image-input support for the selected model, captured render pages
are not submitted to that model and model visual review does not run. In these retests mini did not call image
viewing; 4.1 called it but all four page deliveries were omitted, with zero submitted to the provider.

In **UnodeAi Settings > More > Documents & images**, application detection shows installed candidates and the
operations they might support, now including **Word document PDF export**, **presentation PDF export** and **PDF to
Word conversion (after the user turns off Word's PDF notice)**.
**Refresh application detection** starts no Office application. On Windows, choose **Automatic**, **Prefer
Word/PowerPoint** or **Prefer LibreOffice (Word/PowerPoint when LibreOffice is not available)** for this workspace.
Other platforms show only **Automatic** and **Prefer LibreOffice**, because Word and PowerPoint rendering runs on
Windows only. By default, Automatic selects installed Word
for DOCX or PowerPoint for PPTX, and falls back to LibreOffice when that candidate is unavailable. An explicitly
selected renderer preference is kept. Selecting a preference starts nothing and
changes no file, Commands or network choice. An explicit Word/PowerPoint/LibreOffice request selects that adapter
for the operation. Availability is not proof that a render will succeed; ordinary generation remains available when
there is no eligible renderer.

Windows native rendering opens an owned passive copy, not the original. Removed active/external content is reported;
the copy may differ from the original. Automatic PowerPoint rendering skips an already-running PowerPoint;
an explicit PowerPoint request may share an application. Only newly created identified private Office instances have
alerts disabled. No global settings change. A long render continues as the same background operation after 120
seconds; querying it does not start a second render. Native rendering runs on Windows only and has not been verified
on macOS.

**Stop and the five-minute limit (0.9.108).**
- **Stop ends the render at once.** The request is settled as stopped and nothing it produces afterwards is used. A
  native stage that reaches its five-minute limit fails the same way, without partial pages. The limit now applies to
  LibreOffice too.
- **UnodeAi never force-ends Word or PowerPoint.** Stop leaves a stop request for UnodeAi's helper, which looks for it
  each time an Office call returns. If the helper started the instance itself and a fresh check shows no other open
  document and no visible window, it closes its copy without saving and quits that instance. Otherwise it closes only
  its own copy and leaves the application running, for example when another document has opened in that instance,
  and the result says why. Your own Word and PowerPoint windows are not closed.
- **LibreOffice.** At Stop or at the limit, UnodeAi ends only the conversion processes it started for this operation,
  recognised by this operation's private profile. Another LibreOffice window of yours runs in a different process and
  is not touched. If the processes cannot be confirmed ended within five seconds, the result says so.
- **What the result says.** `native_stop`, in the result of `render_office`, `inspect_operation` and `stop_operation`,
  reports separately whether the application was closed by the helper, ended (LibreOffice), left running (with the
  reason), never started, or unknown, and whether the helper is still closing.

The same Stop and five-minute rules apply to `export_pdf`, `convert_pdf_to_docx` and `recalculate_workbook` (Excel
and LibreOffice). Temporary files are removed only after the processes that use them are gone.

**Known limits.**
- **If VS Code closes, reloads or crashes during a native render, export or conversion,** a Word or PowerPoint
  instance that UnodeAi started can stay running in the background. The next start removes that operation's
  temporary files only after the instance has exited; it does not end the instance. Pressing Stop does not leave this
  behind: the helper closes its own copy as described above.
- After Stop, the helper keeps closing in the background, with no guaranteed time. An Office call that is already
  running, such as an export, finishes first; the helper acts at its next check.
- A render's temporary files are removed only after the helper and the application have exited. If that has not
  happened while this window is open, they are removed on a later start, again only once UnodeAi's window, the helper
  and the application have all exited. UnodeAi does not end the application and does not ask you to.
- When the result says the state is unknown, UnodeAi did not end the application. A windowless `WINWORD.EXE` or
  `POWERPNT.EXE` is not necessarily the one UnodeAi started; another program may be using Word or PowerPoint in the
  background. Signing out of Windows or restarting ends it.
- A LibreOffice render that reaches the five-minute limit fails. For a DOCX you can render with Word instead; for a
  PPTX, with PowerPoint if it is installed; otherwise split the document and try again.

On a Codex CLI member, `render_office` follows your Commands setting, not the Codex permission profile. It runs on
this computer, outside the Codex sandbox, and is not run while that Codex session's network is Off. The Codex
permission list (Ask for approval, Approve for me) explains this too.

LibreOffice uses fixed conversion filters and its own private profile, then Windows PDF page capture. Its profile
does not isolate the OS or network. Hidden presentation slides are included in the export request; if the PDF page
count differs from the inspected slide count, the result is partial and publishes no falsely numbered images.
LibreOffice's native chart engine is enabled only for a verified passive chart copy, after macro, external-content,
embedded-package and OLE filtering. Chartless copies retain the stricter engine setting. Captured chart regions still
need visual review: a completed PDF export does not establish chart fidelity or independent verification.
After a confirmed close, owned temporary compiler files, the private helper directory and LibreOffice profile are
cleaned up. Finished cleanup that could not complete is retried at shutdown and on a later startup using its saved
ownership record. Unknown files, redirected directories, legacy folders without ownership records and operations
whose application outcome is still unknown are retained. App compatibility, fonts and actual page layout still need native qualification.

Image delivery distinguishes prepared, submitted, accepted/rejected and observed states. A data URI in a Codex code
result is not proof of viewing: the code path must actually pass the image to its image viewer, and an unobservable
view remains unknown. Direct dynamic-tool images, joined Claude image results and HTTP image payloads retain their
own transport evidence. Receiving bytes does not prove attention, understanding or a successful independent visual
review. Missing vision support leaves content/structure checks available without silently switching your model.

Successful typed Word/PDF and PPTX saves can include request-level language/layout suggestions. They cite rule/source
ids, count matching locations and show a few location examples. Chinese spacing/punctuation, possible passive wording,
heading/list structure, empty image alternatives and requested boxes outside slides are advice only. Intentional legal
wording, quotations, decorative images and bleed need no mandatory correction. There is no automatic rewrite or new
save approval. Native font substitution, actual glyph fit and line-start/end punctuation are not established by these
checks; they require rendered evidence.

Security's per-agent **Current policy and availability** details, the Setup Guide's existing Permissions step and the
selected Chat Autonomy menu explanation share a read-only summary of the current policy owners. It distinguishes host
tool ceilings, native Codex policy (including a running turn's started profile), next-turn session network choice,
review rule, image adapter and renderer availability. Source/choice provenance and the existing settings locations
are shown. A task or target can still narrow access at the operation boundary; this display grants nothing.

#### Word: tracked changes and comments (0.9.108)

**Reading them.** `inspect_office` on a DOCX lists each tracked change as a record `R1`, `R2` … (`P1-R1` … in a
header or footer). A record gives the kind (insert, delete, move-from, move-to, format-run, format-paragraph or
other), the author, the date, the paragraphs it touches and its text. Neighbouring changes of the same kind, author
and date form one record, as they do in Word. A change made inside someone else's change names the change it sits
in. Comments are records `M1`, `M2` … with author, initials, date, text, the comment they reply to, the anchored text
and whether the thread is resolved. When the file keeps no thread information, `resolved` is empty rather than a
guess.

Paragraph text comes in one of three views, chosen with `view`:

- `current` (the default): every change accepted;
- `original`: every change rejected;
- `markup`: the changes inline, as `[+author: text]` for inserted text, `[-author: text]` for deleted text,
  `[>author: text]` for moved-to and `[<author: text]` for moved-from text, with `[#M1]` after commented text.

In the `current` and `original` views a paragraph whose mark is removed is flagged as joining the next paragraph, and
a paragraph in a removed table row is flagged as omitted. Changes in the body, headers and footers are read.
Footnotes and endnotes are not. A formatting change says where it is and who made it, not what changed. Changes to
table, cell or section properties are listed as `other`. If the comments part is damaged, the comments are left out
and the result says so; the body and its changes are still read.

`read_file` keeps giving the text with all changes accepted. When the body has tracked changes or the file has
comments, it now ends with one count line, for example:

```text
[DOCX notice] Revisions: 3 by 2 authors; comments: 2 (1 unresolved). Use inspect_office for details.
```

**Agents' edits are tracked changes by default.** When an agent changes an existing Word file with `edit_office`,
these edits are written as insertions and deletions with an author and a date, which you can accept or reject in
Word (**Review → Accept / Reject**):

- replaced text (`replace_text`);
- new paragraphs (`insert_paragraphs`);
- new tables, including their rows and the paragraph after them (`insert_table`);
- new text in a content control or bookmark that stays within one paragraph (`set_control_text`,
  `set_bookmark_text`).

All changes from one request carry the same date, in UTC. The document's own Track Changes switch is not turned on
or off. The receipt says *Tracked changes: recorded as Word revisions by "…"*, where the name came from, and which new
`R#` records the saved file has. A direct edit says *Direct edit without tracked changes.*

Two settings control this. Both are read from your VS Code User settings only; a workspace or repository value is
ignored.

| Setting | Default | What it does |
| --- | --- | --- |
| `unode.office.trackChangesDefault` (**Unode › Office: Track Changes Default**) | on | Off makes a direct, untracked edit the default for Word files. |
| `unode.office.authorName` (**Unode › Office: Author Name**) | empty | The name on tracked changes and comments, shown as `name (via team member)`. When empty, UnodeAi uses the Word user name it found on this computer (Windows, when it detects installed applications), shown the same way, and otherwise `team member (UnodeAi)`. |

No program is started during an edit to find the name. The Word user name is read only while UnodeAi detects
installed applications, for example with **Refresh application detection** in **UnodeAi Settings > More > Documents
& images**. Until a detection has run in this window, and if Word was not found, the fallback name is used. To be
sure of the name, set **Author Name**.

**What cannot be tracked is asked about.** Replacing an image (`replace_image`), changing the document theme
(`set_theme_tokens`), text that spans paragraphs, and control or bookmark content that spans paragraphs or still
shows its placeholder cannot be written as tracked changes yet. The edit is refused with `edit-not-trackable`, and
the agent is told to ask you whether to make it as a direct edit. Only if you agree does it send the request again
with `track_changes:false`; it never does that on its own.

**Someone else's changes come first.** An edit that touches a tracked change not made in the same request, including
one from an earlier UnodeAi request, is refused with `overlaps-foreign-revision`. Accept or reject that change first,
in Word or by asking the agent. Agents can decide a change with `accept_revision` or `reject_revision` and its `R#`.
Only changes that `inspect_office` marks `decidable` can be decided this way: insertions and deletions that stay
inside one paragraph or cover whole paragraphs or table rows, with no move and nothing nested in or around them. For
the others, the agent asks you to decide in Word. When a decision removes whole paragraphs, their `D#` references
stop working, and the receipt lists them.

PowerPoint files have no tracked changes; asking for one on a PPTX is refused.

**Comments.** Agents can add a comment to a phrase in one paragraph (`add_comment`; the phrase must occur only once
in that paragraph), in the body or in a header or footer (`P#-D#`). They can reply to a comment (`reply_comment`) and
mark a thread resolved (`resolve_comment`). Resolving marks the whole thread, the first comment and every reply, as
Word does. New comments and replies use the same author name as tracked changes. A comment is not a tracked change,
so the Track Changes setting does not affect it. Agents cannot delete comments or change the text of an existing
comment.

#### Writing Excel workbooks (0.9.108)

Two tools write XLSX files. Both need Write, use the normal write approval, restore point and read-back check, and
work with Commands Off.

- **`edit_workbook`** changes an existing workbook that the agent has inspected with `read_workbook`, which gives it
  the snapshot and the sheet names (`sheet-1`, `sheet-2` …). It can set a rectangle of values (`set_cells`), set
  formulas (`set_formulas`), change number formats only (`set_number_format`), and append rows below the last row
  with content (`append_rows`), with an optional formula per column in which `{row}` stands for the row number.
  Appending directly under a table without a totals row extends the table and fills its calculated columns. A
  template (.xltx) is saved as an ordinary .xlsx.
- **`write_workbook`** creates a new workbook: one or more sheets, each with an optional bold header row, column
  widths and number formats, formulas per column or per cell, and an optional frozen header row.

Values can be text, numbers, true/false, empty (clears the value and any formula, keeps the format), dates such as
`{"date": "2026-11-23"}` (stored in the workbook's own 1900 or 1904 date system and shown as `yyyy-mm-dd` unless a
format is given), or exact values from a `transform_workbook` result, which the receipt records as host data. Text is
written into the cell itself; the workbook's shared text list is not changed. One request writes at most 1,000,000
cells.

In an existing workbook, rows and columns are never inserted or deleted, and sheets are never added, renamed or
removed.

**A relationship is a formula.** When you describe a relationship, such as "A = B + C + D", a total, a difference or
a share, the agent is told to write the formula and not a number it computed, unless you ask for fixed values.
Formula text is written without the leading `=`, up to 8192 characters with balanced parentheses.

**Formulas are saved, not calculated.** UnodeAi stores formulas without results and does not calculate them. The
receipt lists value cells and formula cells separately and says:

```text
Recalculated: no. Formula cells were saved without cached results and UnodeAi did not calculate them, so no formula result is known from this save.
```

Any content change also tells Excel to recalculate the whole workbook when it opens the file; a formula change
removes Excel's calculation chain, which Excel rebuilds. Other saved results in an edited workbook keep their old
values until the workbook is recalculated, and the receipt says they may be out of date. A workbook set to manual
calculation stays manual; the receipt reminds you to press F9 in Excel or ask for a recalculation. A number-format
change alone touches none of this.

**What is refused, and only there.** A refusal names the area and says what can be done instead; the rest of the
workbook stays writable.

| Situation | Code | Instead |
| --- | --- | --- |
| Macro workbook (.xlsm/.xltm or a VBA project) | `workbook-macros-unsupported` | Save a macro-free .xlsx copy in Excel, or make the change in Excel. |
| Digitally signed workbook | `workbook-signed` | Any change would break the signature; remove it in Excel first, or change it in Excel. |
| Protected sheet | `sheet-protected` | Unprotect that sheet in Excel (**Review > Unprotect Sheet**). Other sheets stay writable. Protection is never removed or bypassed. |
| Part of a shared or array formula | `formula-range-partial` | Write the whole range in one request, or change only number formats there. |
| Table header or totals row; appending under a table with a totals row | `table-structure-unsupported` | Write in the table's data rows; change headers and totals in Excel. |
| Pivot table area, what-if data table, a cell that links to another workbook | `workbook-structure-unsupported` | Write elsewhere, or change it in Excel. |
| A cell covered by a merged range | `merged-cell-covered` | Write the merged range's first cell. |
| A cell beyond `XFD1048576` | `invalid-cell-ref` | Use a reference inside the sheet. |

Chart sheets and Excel 4 macro sheets are not edited.

**Formulas with side effects are written as asked.** Formulas that read the web (`WEBSERVICE`, `IMAGE`,
`STOCKHISTORY`), run local code (`CALL`, `REGISTER.ID`, `RTD`, DDE) or refer to another workbook are saved like any
other formula, under the same write approval. The receipt adds a line for each, such as *may access the network when
Excel opens or calculates it*, *may run local code when Excel calculates it* or *refers to another workbook*.

#### Recalculating a workbook (0.9.108)

When you want the results of formulas, an agent can call `recalculate_workbook`. It runs Microsoft Excel (Windows
only) or LibreOffice on a private copy of the workbook and reports the values the application produced, cell by cell.
`auto` uses Excel when it is installed, otherwise LibreOffice, and does not try the other one after a failure. The
cells are either all formula cells of an earlier `edit_workbook` or `write_workbook` receipt of the same agent and
task, or cells the agent names (at most 10,000). If the workbook changed after that receipt, nothing is run.

- **Permissions.** It needs Read and Commands and uses the ordinary command approval, which names the engine and the
  copy. It is not run under Plan or read-only, with Commands Off, in an untrusted workspace, or while a Codex
  session's network is Off. Your Commands, Web access and file choices are checked again after every wait.
- **Excel** opens the copy read-only in its own new hidden instance, with macros disabled, link updates off and alerts
  off, closes it and quits only that instance; it never ends another Excel. If UnodeAi cannot show that the instance
  is new, hidden and empty, nothing is run.
- **LibreOffice** uses a new private profile with macros disabled and link updates off, and has a five-minute limit.
- **Values.** Only cells the application actually produced are marked recalculated. Error values such as `#DIV/0!`
  are reported as they are. A cell that comes out as `#NAME?` (a function the application cannot run) or `#BLOCKED!`
  (a calculation the application blocked) is reported as it came out but not counted as recalculated, with either
  application. Links to other workbooks are not refreshed; their saved values are used, and the result says so.
- **Writing the results back.** Only when the agent asks (`write_cache`), and only through the usual write approval,
  UnodeAi writes the calculated values of those formula cells into the workbook as their saved results. Cells that
  were not recalculated, including `#NAME?` and `#BLOCKED!`, are never written. The formulas and every other part of
  the file stay byte for byte as they were, and the workbook still recalculates when Excel opens it. The file saved by
  Excel or LibreOffice is never used.

**Some workbooks are not recalculated.** Before anything starts, UnodeAi looks at every formula, name, connection and
sheet. The result is `recalc-not-run`, with each reason, its location and where to change it:

- Formulas that would run local code (`CALL`, `REGISTER.ID`, `RTD` or DDE), wherever they are, including on an Excel 4 macro
  sheet: *Not run by UnodeAi in this version. You can open the workbook in Excel yourself; the formulas were saved.*
- Connections to local files or databases that refresh when the workbook opens: *Not run by UnodeAi in this version.
  You can open the workbook in Excel yourself and refresh it there.* UnodeAi never refreshes a local-file or
  database connection.
- Formulas or web connections that read the web follow the agent's Web access setting (**Team panel > Permissions >
  Web access**): **Allow** runs; **Ask** shows the existing web access card with the hosts, or says that the address
  is built by a formula and where; **Off** does not run. Web access is read again right before Excel or LibreOffice
  starts, so turning it Off while the approvals wait still stops the calculation. Once the calculation has run,
  turning Web access Off does not throw away the values it produced, and it does not block saving them into the
  workbook on your computer.

**Excel 4 macro sheets.** A macro sheet on its own does not stop a recalculation. UnodeAi leaves every macro sheet,
and every name that sits on one or points at one, out of the private copy that Excel or LibreOffice opens, so no macro
code runs. The command approval names the sheets that were left out. Any cell that may depend on them, directly,
through a name, or through `INDIRECT`, `OFFSET` or `EVALUATE` while a macro sheet is left out, is reported as not
recalculated (`depends-on-macro-sheet`) and is never written back. Your workbook keeps its macro sheets.

When no engine is installed, the result says that neither Microsoft Excel (Windows) nor LibreOffice was found.

#### PDF: export, page work, forms, signature and page images (0.9.108)

**Export to PDF.** `export_pdf` saves a PDF of a Word or PowerPoint file the agent has inspected with
`inspect_office`, made by installed Word, PowerPoint or LibreOffice from a filtered copy (Windows only). Automatic
follows your renderer preference. It needs Read, Write and Commands, goes through the ordinary command approval and
then the usual write approval, and is not run under Plan. The receipt gives the page count and, when the copy was
filtered, says what was left out: *Exported from a filtered copy: the removed parts and elements are not in this PDF.*
A page count above zero is not proof that the layout matches. The export never saves over the file it was made
from: if the destination turns out to be that file, nothing is exported or saved. A failed export is not retried with
another application; the result suggests another installed application, the built-in PDF output of `write_document`
for documents it made, or **Save As > PDF** in Word. When LibreOffice reaches the five-minute limit, the result names
the next step for that kind of file: Word for a DOCX, PowerPoint for a PPTX if it is installed, otherwise splitting
the file.

**Editing PDFs.** `edit_pdf` needs Read on the inputs and Write on the destination. It does not need Commands or any
installed application. It always writes a new .pdf; an input is never overwritten. Page numbers refer to the document
as it is when each operation runs, and positions are in points from the top-left corner of the page as it is shown.

| Operation | What it does |
| --- | --- |
| `merge` | Joins the inputs in their order (always the first operation when there are several inputs). |
| `extract_pages`, `delete_pages` | Keeps or removes pages, such as `"1-3,5"`. |
| `rotate_pages` | Turns pages by 90, 180 or 270 degrees. |
| `reorder_pages` | Puts every page in a new order. |
| `replace_pages` | Replaces a run of pages with pages from another PDF, for example a new export of the source Word file. |
| `add_watermark`, `add_page_numbers` | Adds a text watermark or page numbers such as `1/12`. |
| `fill_form` | Fills form fields; `flatten` true turns them into fixed content, false keeps them editable. |
| `add_text`, `add_image`, `add_note`, `add_highlight` | Adds text, an image the agent was given, a sticky note, or a highlight over found text or a rectangle. |
| `place_signature` | Places your saved signature (below). |

- Encrypted PDFs, digitally signed PDFs and XFA forms are refused.
- Merging, extracting and replacing pages build a new document, so bookmarks, named destinations, page labels and
  attachments are not carried over, and the receipt says so. A PDF with form fields is refused there unless you agree
  that its fields are flattened first. The other operations change the document in place and keep form fields,
  bookmarks and links; deleting pages also removes the fields, bookmarks and links that pointed only at them.
- Watermarks, numbers and notes on replaced pages go with those pages; the agent adds them again for the new pages.
- A highlight of found text covers whole PDF text items, so it can be wider than the words; the receipt says so.
- Text added to a PDF, including form values, uses an installed Windows font for its language (Arial or Segoe UI,
  Microsoft YaHei, Microsoft JhengHei, Yu Gothic or Meiryo, Malgun Gothic), embedded as a subset. Without a suitable
  font the operation is refused with `font-unavailable`.
- Body text in a PDF is not rewritten, blacked out or covered with a white box. To change body text, see
  [Changing the text of a PDF](#changing-the-text-of-a-pdf) below.

**Your visible signature.** In **UnodeAi Settings > More > My signature**, choose **Choose signature PNG...** and
pick a PNG with a transparent background, up to 2 MB. UnodeAi keeps it in its own storage on this computer.
**Replace signature...** changes it and **Delete signature** removes it at once. Agents never see the saved image;
they only know a signature is saved. A PDF your signature is placed on is a file like any other: an agent that reads
that PDF with its own file reading (Claude, Codex) or a command can see the signature. UnodeAi's own page images of it
cover the signature. It is a visible signature, not a digital (certificate) signature.

When an agent asks `edit_pdf` to place your signature, every other operation runs first, and the page number refers
to the finished document. Each placement then shows its own card in the agent's chat, *wants to use Place signature*,
with the destination, the page, the position, the first words on the page and the hashes of the signature and of the
unsigned document. Neither the image nor this preview is sent to the model. Choose **Allow once** or **Deny**; only a
person's **Allow once** counts, and nothing is remembered for the next placement. A denied placement is skipped and
the rest of the request is saved; the receipt says it was declined. If the signature, an input or the destination
changes while the card waits, or before the file is saved, nothing is saved and the agent has to ask again. The
receipt of a placed signature records who confirmed it, when, the page, the position and the signature's hash.

**Seeing PDF pages.** `view_pdf_pages` turns up to 10 pages of a PDF into page images, which the agent then views with
`view_office_images`; images reach only a connection that accepts images. It runs the fixed Windows.Data.Pdf page
renderer from a private copy, needs Read and Commands, and uses one ordinary command approval. On other platforms it
does not run, and `read_file` still reads the PDF text. Signatures that UnodeAi placed are covered by white boxes in
these images. That covering follows the file through later `edit_pdf` operations, but only for files UnodeAi produced
and that have not been changed outside it since.

##### Changing the text of a PDF

UnodeAi does not edit the text inside a PDF. There are two routes, and agents are told to use the first one when the
source document is known.

1. **Edit the source document and export it again.** The agent edits the Word or PowerPoint file the PDF was made
   from with `edit_office` (Word edits are tracked changes by default), then exports it with `export_pdf`, naming the
   earlier PDF in `regenerates_pdf`. The receipt says whether UnodeAi's own records confirm that this document is the
   one the earlier PDF was exported from (`source_lineage`). When they do not, for example because the PDF was made
   outside UnodeAi, the export still runs and the agent is told to say that the link was not confirmed. This check is
   only reported: it never blocks the export and grants no access. If the earlier PDF had extra pages, a watermark,
   page numbers or a signature added, the agent puts the new pages in with `edit_pdf` (`replace_pages`) and adds those
   again on them. A signature UnodeAi placed on a replaced page goes with that page and has to be placed and confirmed
   again.
2. **Convert the PDF to Word, edit it, and export it again (PDF to Word to PDF).** Without the source document,
   `convert_pdf_to_docx` has installed Word on Windows turn a PDF with a text layer into an editable .docx, from a
   private copy. It needs Read, Write and Commands, goes through the ordinary command approval and then the usual
   write approval, and never saves over the PDF. The agent then edits the .docx and exports it with `export_pdf`.
   Word's conversion can change the layout, so the agent is told to compare the old and new pages with
   `view_pdf_pages` before handing the file over. Like an export, the conversion has the five-minute limit and Word is
   never force-ended.

   When Word opens a PDF it shows a notice (*Word will now convert your PDF to an editable Word document...*), and
   that notice would block a conversion Word runs out of sight. So this route runs only when you have turned the
   notice off yourself. UnodeAi only reads this Word setting and never changes it. Until you turn it off, Word is not
   started and the agent explains how: in Word, choose **File > Open** and open any PDF, tick **Don't show this message
   again** in the notice and choose **OK**, then close the document and ask again. The first route works either way.

   A scanned PDF has no text layer and is not converted (`pdf-no-text-layer`); a model that reads images can rebuild it
   as a Word document from `view_pdf_pages` images. Encrypted PDFs are refused (`pdf-encrypted`). On other platforms
   the tool does not run.

A Word file converted from a PDF that carries signatures UnodeAi placed, and any file later made from it, keeps that
link in UnodeAi's records. A conversion cannot map its pages back to the signed pages, so UnodeAi makes no page images
of such files for a model: `view_pdf_pages` and `render_office` return `derived-from-signed` instead. `read_file` still
reads their text.

A Codex conversation started before an update does not gain new tools. To use them there, open the Chat menu and
choose **New Model Conversation (keep chat)**.

#### PowerPoint chart titles (0.9.108)

`edit_office` can set or delete the stored title of a chart in a PowerPoint file (`set_chart_title`). A new title
reuses the existing title formatting; a line break starts a new paragraph. Deleting the title also turns the automatic
title off. Only the chart part changes and its embedded workbook is not copied. If several slides or frames share the
chart, this frame gets its own copy and the others keep the old title. `inspect_office` reports each chart's type
(for example `barChart`, or `combo`) and its title, with where the title comes from: stored text, a cell reference,
automatic, deleted, or absent. Charts inside Word files are not edited.

### Installed skill resources and Python cache

For richer Word/PowerPoint generation, an agent with Write can prepare JavaScript parts through `build_office` and receive a fixed-hash program reference. Running that reference also requires Commands and a writable command folder. It uses your existing command approval setting, including Off; Ask shows the exact source and declared outputs on the ordinary command card. The fixed runner supplies docx 9.7.1 (with a local embedded-nanoid fix) and PptxGenJS 4.0.1, without a user Node/Python installation. Built-in `write_document` and `write_presentation` remain available with Commands Off.

On HTTP and Claude agents, this JavaScript has ordinary command authority under your account; the runner adds no OS sandbox. Native Codex runs it through its App Server with the current selected sandbox, network and writable-root policy, adding only the private operation staging folder for that command. Full access remains unsandboxed. Unsupported native execution fails without falling back to host execution. Scripts can have effects beyond their declared outputs within their execution authority. UnodeAi checks and saves only the declared staged Office files through its normal write approval, restore and readback path; other script effects do not get verified receipts or restore guarantees. Multiple output saves are sequential: a later refusal does not undo a file already reported saved. The result lists actual saved files, byte hashes, input versions, library identity and package structure coverage. Native rendering, full schema validation and visual review are separate checks. Program stdout is not a delivery receipt. A build holds its agent's command lane until it completes or you stop it; it adds no wall-clock kill deadline. Stop invalidates host commits and requests termination of the owned process tree; an unconfirmed stop is reported honestly.

Granted skills run from their installed resource root. That root is a source read scope, not a document output folder. Codex read-only turns may list it among runtime read roots; writable turns keep runtime roots limited to their document write roots. The owned Python cache is a separate sandbox write location, not a document grant. Source helper arguments are not an OS read/write sandbox; select task-owned outputs and preserve input files. Native CLI read reach remains as described above. Searches may include granted source roots; resulting noise has not been measured.

When no explicit environment override applies, UnodeAi sets PYTHONPYCACHEPREFIX for agent Python processes to its global-storage python-cache folder, including ordinary agent Python commands. Existing process, agent and terminal overrides, including terminal removal, remain effective; a native shell filter may remove the variable. The cache can retain source path names and grow across sessions; size and growth have not been measured. It can be deleted while agent Python processes and terminals are idle. There is no scheduled cleanup job. This setting does not redirect helper output, all temp files or LibreOffice profiles.

A valid modified installed skill stays usable with an identity reminder. Reinstalling the extension restores shipped resources; extension updates may replace installed changes. Existing agent processes can retain old native discovery entries until restarted. Cache files are excluded from identity, which is not a guarantee about what a Python interpreter might execute. Missing or damaged installed resources produce an actionable failure for that skill; an obsolete saved skill name is reported as absent from the installed version.

The bundled Word and PowerPoint skills preserve optional Apache-2.0 upstream helpers and references. Their RUNTIME.md lists dependencies and effects; those runtimes are not automatically installed or required by the built-in Office tools. Helper success text does not prove Office verification or native rendering.

Image generation uses a configured API-key connection independent of chat. In **Agent Builder**, open **Media models** beside the language model and choose **Inherit**, **Off**, or **Specific model** for the member. Inherited choices use **UnodeAi Settings > Providers > Media defaults**. Image generation starts at **None** for a new installation. Previously selected official OpenAI connections keep their model.

Model discovery on a configured API connection uses the existing permission to read its model list. A manually entered ID is a candidate until the corresponding adapter supports it. Generation costs belong to the selected connection.
In **UnodeAi Settings > Providers**:

1. Choose **Use for image generation** on the **Unode** card for `gpt-image-2`, or on a connection at `https://api.openai.com/v1` for `gpt-image-2.6-flare`. To configure a separate OpenAI connection, use **Add custom gateway** and enter the endpoint and API key there.
2. Ask the agent to generate an illustration, save the original or insert it into a presentation. Each operation requests one medium-quality PNG. Unode supports 1024×1024. The official OpenAI adapter defaults to 1536×1024. A task can request multiple images without Commands permission.

The **Media defaults** card keeps a saved choice visible if its connection, key, or model becomes unavailable. **Turn image generation Off** sets the inherited image default to **None**. Use **Off** in **Agent Builder > Media models** to turn image generation off for a member. Existing connection egress choices, Plan/read-only and Write restrictions remain effective.

A successful image opens in a **Generated image** result preview without taking focus or requiring approval. The preview shows the latest original; earlier generated versions remain available to the task. `save_generated_asset` saves exact original PNG bytes through the normal write approval, restore point and readback. A denied save or failed presentation retains the original for a later approved save. `save_attachment` remains specific to files the user attached. Regeneration creates a separate operation linked to the prior version; it does not overwrite it. Image bytes are session-local and follow the existing task/asset-cache lifetime until saved; an unheld asset can expire. Once an image is saved and no task, draft or pending save holds it, its generation record (receipt, raw usage and asset entry) is dropped at the end of the turn, or earlier when there are more than 50 records. Unsaved images, running generations and images still in use are kept. Private operation and artifact history retains allowlisted metadata, including original/copy/preview hashes, actual saved-file effects and visual transport observations. It does not retain image pixels, restore an old grant or permit a paid request to resume after restart. Prompts, credentials and image bytes do not enter that metadata history.

Transport loss or Stop after sending can leave **outcome-unknown** and may have cost money. UnodeAi records the uncertain outcome and skips automatic retry. The receipt shows the actual connection and model. Unode receipts show reported quality when available and retain usage even when the price is unavailable. Official OpenAI receipts use the dated token-price snapshot. Missing token classes remain **partly-unpriced**. Image prompts stay in the private task/model exchange and the generation request. The preview shows the generated asset. Office page verification uses the Office review workflow.

### Transcribe a recording

Choose an Unode audio model in **Agent Builder > Media models** or set the inherited default in **UnodeAi Settings > Providers > Media defaults**. Attach a WAV or MP3 to the task, or give the member the path to a recording it has permission to read. Ask the member to transcribe it and, if desired, write the result to a Word document.

Each recording can be up to **25,000,000 bytes** and **1,500 seconds (25 minutes)**. UnodeAi checks both limits before upload. If your file is over either limit, use an audio editor to split it into parts of 25 minutes or less and keep each part within the byte limit. Submit each part for transcription.

The operation shows the file name, bytes, model and receiver. The receiver uses the existing model and audio egress decisions in **UnodeAi: Security**. Recordings over four minutes are split locally into parts and sent in order with the same permission decision. If a WAV codec cannot be split safely, export the recording as PCM WAV or MP3. Spend tracks each part. If a part fails, transcription stops and reports the missing time range. A completed result contains the joined text and any segments the service reported, placed on the recording's timeline. Unode `gpt-transcribe` reports duration and is priced by seconds. Whisper can report seconds even when its bill uses tokens, so a seconds-only response leaves the estimate unavailable. Transcription operation history records metadata and usage. The audio and transcript stay with the authorised task.

UnodeAi saves a complete transcript verbatim as UTF-8 under the usual Write Approval rules. By default, `Recording.mp3` saves as `Recording.transcript.txt` beside the recording. An attachment saves under `transcripts/` in the workspace folder used for relative writes. If the default name exists, UnodeAi tries `-2` through `-99` before `.txt` to preserve the existing files. Use `save_path` to name a specific destination. Calls made in Plan mode, Codex calls in an untrusted workspace, and calls with an invalid explicit destination are refused before upload. A completed transcription still returns the full text and explains why it was not saved when the member lacks Write, the default destination is unavailable, write approval is declined, the destination changes during transcription, or Plan mode takes effect after the upload was authorised.
