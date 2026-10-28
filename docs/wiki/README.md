# UnodeAi Web Wiki

Version covered: UnodeAi 0.9.99

## New in 0.9.99

**Fewer limits, fewer questions.** When something is slow, large or new, work goes on and UnodeAi says what happened
in a plain sentence, instead of stopping or opening another card. A long contract or report becomes one Word or PDF
file. A long tool or web result is kept whole for the agent to read on. Attachments have no fixed size limit; a
warning says when the files of one message together are more than the window can safely hold. `fetch_url`, `@url`
mentions, MCP tool calls and Codex requests have no time limit, and **Stop** ends them; a slow `@url` read offers
**Send without it** or **Keep waiting**. OpenAI-compatible agents have no step limit, and every 100 steps the chat says
the agent is still working.

**Your own setup is the consent.** A model connection or Codex program you set up is used after one notice, and
**UnodeAi: Security** revokes it. An MCP server you add yourself mounts without another question. Web access is on by
default, and each search or fetch shows as a tool card. A team file UnodeAi saved loads without a question, and
**Always allow this tool** on a Claude agent survives a restart. An unsaved editor buffer, a large file or a restore
point that cannot be kept no longer stops a change; **Restore anyway** restores over newer work. Chat works with no
folder open.

**What stays.** Two automatic rework rounds per task, now with a one-click **Continue rework**; **Stop**; the explicit
Off, Ask and Plan settings; the dangerous-delete confirmations; and the approval card before a Claude agent's own
external-effect tools. UnodeAi itself does not ask before a command that pushes or publishes; several built-in roles are
instructed to ask you first.

**Faster, clearer PM turns.** On OpenAI-compatible agents, older file reads go to the model as short references, and a
due compaction is prepared in the background instead of holding up the turn. The compact button is a ring that fills
toward automatic compaction. A PM status under every coordinator reply says what is running, why the turn ended and
what comes next, and a returned result left without a decision gets one automatic review turn. The live line names
the file a tool call is writing and how much has arrived.

**Stop means not sent.** A message still waiting for its `@url` or its files is ended by every **Stop**, by clearing
the conversation and by removing the agent. Nothing is sent, even if the page or the files arrive later, and the chat
says so. Only your next **Send** sends it again.

**Accountable AI teams, under your direction.**

**From vibe coding to vibe engineering.** Vibe coding: you ask, the AI says “done”, and you hope. Vibe engineering: every agent has a role, enforced limits, and a record you can check.

UnodeAi organizes AI agents into a team for engineering, design, marketing, sales, compliance, finance, operations and more. A project manager agent delegates the work. You can follow every task, approve or refuse what an agent asks to do, stop it, and export the record from request to result.

An agent saying “done” is never evidence. UnodeAi keeps what an agent claims apart from what UnodeAi saw happen. It records whether an objective check ran and passed. Where judgment is needed, a person can record the verdict. You can put different models and providers on one team and have one review another's work, under roles and permissions you set.

Delegate with confidence: your direction, a record you can audit, and no result called verified until it has passed a check.

UnodeAi runs in VS Code, Cursor and Devin with your own providers and keys. It sends no telemetry and makes no network call at activation. A SHA-256 is published for the exact bytes you install.

## Governed Integrations

The Marketplace's **Integrations** tab uses MCP as its protocol, but it does not treat the breadth of its catalog
as a sign of trust. Every active bundled entry names an authoritative source, a maintenance state, an exact install
identity and a recent verification date. The card and the mount gate share one approval answer for local processes,
network endpoints and credentials. The host derives that answer. `listed`, `configured`, `approved`, `mounted`,
`exercised`, and `succeeded` are separate facts. **Check setup** reports them, but it changes nothing and grants
nothing. By default, the check's result is shown in a modal dialog whose only button is the editor's **OK**. Other
notices that directly answer a command or click are shown the same way. Settings → More can turn those same results
into quiet corner notifications. This is a user-only setting. It never affects approvals, consent, or dialogs with
action buttons. Background notices remain toasts.

An MCP protocol error is shown as an integration failure, even when the server returned text. In that case,
UnodeAi does not reconnect a server that is still responding. When a stdio connection fails, the error includes
the end of the server's stderr output as size-limited plain text. Only values resolved from SecretStorage placeholders are
redacted, so ordinary diagnostics such as `DEBUG=1` stay readable.

Only the reply that ends a turn is styled as the turn's conclusion. Its footer shows each of these once:

- why UnodeAi started the turn when it did (for example `Triggered by Frontend Engineer's rework reply`)
- a coordinator's `Delegations this turn`
- `Finished <local time> · Turn time: …`

For a turn from an earlier day, the footer also includes the local date. Time spent waiting for approval is still
shown separately and is left out of the duration. This includes time in the consent dialogs that pause an agent's
work. It also includes time that a request spent queued while you decided.

A second footer line, `Observed: waiting for provider … · reasoning … · responding … · tools … · host …`, shows
where the turn time went, as the extension observed it. The parts add up to the turn time. A turn recorded before
0.9.92 has no such line. The live line of a running turn uses the same observations. It reads
`Waiting for <provider>` while nothing has come back yet, and `Reasoning` only when the provider has sent
reasoning. Its `turn` clock pauses while you have a decision open.

When a coordinator publishes file content from a content receipt, the content appears in an **Exact content**
block. The extension marks it as exact only when it knows that the model received it. On OpenAI-compatible routes,
the extension does the sending itself. Claude CLI must report that exactly this text reached the model. Codex CLI
does not report what its model saw. On that route, only the first and last lines of the read are confirmed, not
the middle.

Each approval is decided once: by a click, by the end of its 15-minute window, or by Stop. A later answer grants
nothing and saves nothing. Approval cards and consent dialogs play one short chime when they appear. The chime
plays only after you have typed or clicked in a visible chat view since that view opened. `unode.attentionSound`
(user settings only) turns it off.

**Job outcome (0.9.93).** When a coordinator's job closes, Chat shows one **Job outcome · Host-observed** card after the coordinator's final reply, in the sidebar and in the Workbench. The card shows how the job closed, what the declared checks showed, how many files changed, what the job cost and how long it took. Open it to see eight sections. Every figure is something UnodeAi recorded while the job ran. Nothing is taken from what an agent wrote, and `Verified` appears only when a declared check was seen to pass. When something was not recorded, the card says so: a missing price shows as `cost unavailable`, never `$0`. A job with a stopped or interrupted task is `Partial`. If you stop the last running task of a job while its coordinator is idle, the job ends there, and its card appears at once. **Continue unfinished work** drafts a new request and shows it to you first. Nothing resumes by itself. The card is never sent to a model. Its times are local and include the time zone. The evidence report, the run evidence pack and the worker progress report state that their times are UTC.

**Request summary (0.9.94).** Every turn that hands control back to you gets one **Request summary · Observed by UnodeAi** card, in the sidebar and in the Workbench. The card appears after the item that ended the turn. It shows how the turn ended, what UnodeAi saw it do, what changed, whether UnodeAi ran the verification command, what the turn cost and how long it took. Open it to see nine sections. The first word comes from what UnodeAi observed, never from the reply. `Answered` means that a reply was delivered, not that it is right. `Verified` appears only when UnodeAi itself ran the configured verification command in that turn and the command exited 0. Where UnodeAi cannot see, the card says so (`more possible`, `not observed on this route`, `coverage limited`). A missing price shows tokens only, never `$0`. A turn shows one card. The turn that closes a team job shows that job's Job outcome instead. A turn that ends with no final reply keeps the reasoning it showed, labelled **Work shown; no conclusion recorded**, and its card reads `No conclusion recorded`. If you stop a coordinator in a job before it has replied, the job ends there once nothing in it is still running.

**Request limits (0.9.94).** Two optional User Settings, `unode.requestLimits.providerTurns` and `unode.requestLimits.tokens`, set limits for a single request, teammates included. The first limits the request's model requests. The second limits its raw tokens (input plus output, not a cost). Reaching a limit cuts nothing off. UnodeAi holds the next step it controls, and one card in Chat asks **Stop request** or **Continue request**. Continue gives one more allowance of the same size. If there is no answer within 15 minutes, the request stops and the card is settled. A model request is counted at the moment it is allowed to leave, so two teammates cannot both take the last one. On the Claude CLI and Codex routes, UnodeAi can neither count nor hold the model requests that the CLI makes inside a turn. Instead, it counts each turn it starts as one host-counted turn. On those routes, the limit therefore takes effect at the next tool call that UnodeAi mediates, or at the start of the next turn. In that case, the card also says that the totals may be a lower bound.

**One meaning, from the permission to the card (0.9.95).** A scope entry may name one existing file, and it then grants exactly that file. Before, such an entry was accepted, but every write was refused. If a request never got an answer, because the window closed or the provider failed, it is not sent again after a restart. Instead, you see a line such as `Your earlier request was interrupted and was not resumed. Send it again if you still want it.` Only your new request runs. A coordinator can mark a review of one workspace file. UnodeAi then lets the review close only if the file has not changed since dispatch. A delegation card counts each task once. A superseded or retried attempt shows as `in history`. An attempt whose file changes were all refused is blocked, not complete. After a coordinator's turn, the line that UnodeAi adds says which decisions are owed. It leaves checks and completion to the Job outcome, which now says `Task checks passed` for the checks a task declared. The Request summary now says `Finished — not verified` where it used to say `Completed — not verified`.

**Progress during silence.** PM and worker turns on all routes continue through silence. The transcript shows the current activity; after 20 seconds without an observed event it shows how long it has been quiet and a host-written summary of recorded operations, files, dispatches and pending work. A running tool, compaction or approval retains its specific status. The summary updates in place without requesting a model summary, freezing later records or replaying work. Use **Stop** to end the task; normal completion and real provider errors still settle normally. Old deadline cards remain readable, but silence no longer creates one. The team candidate list, Claude first-request team tools and **Generate Evidence Report** remain unchanged.

Claude's old idle observation no longer stops its turn. Default OpenAI header, buffered-body and streaming
waits also have no UnodeAi time ceiling; only a deliberate embedding time limit retains one. Stop still cancels
a pending read, and real provider/connection errors still report normally. Retry attempts remain bounded.

**Tool results as they happened (0.9.91).** Every tool card records what UnodeAi or the runtime reported for that
call: succeeded, refused or failed. A refusal comes with its reason, such as your declined approval, Workspace
Trust, folder scope or policy. Nothing is guessed from the wording of the output. This holds on OpenAI-compatible
routes, Claude CLI and Codex CLI alike. Each result appears on its own card, even when one tool runs several times
at once. A coordinator is told how a delegated task really ended: failed, cancelled, refused by team policy, or of
unknown outcome after a timeout. Each Claude CLI agent keeps its own tool-gate files, so agents that share a folder
never use each other's.

**Smart compaction (0.9.90).** Each agent compacts its earlier conversation just before a request would grow past
the agent's trigger. The trigger is the smaller of a share of the context window and a practical ceiling. In the
Agent Builder, you choose **Smart** (a work profile supplies the numbers), **Custom** (your own numbers), or
**Off** (never compact automatically). OpenAI-compatible routes keep the newest turns and every record of work word
for word. Claude CLI and Codex CLI compact with their own mechanism. Compaction never blocks the task, and each
compaction leaves a receipt. **⤓** compacts on request. A model reply with no text and no tool call is retried once
when that is safe. Otherwise it is reported as an **empty reply**, with its input size. It never counts as
completed work.

**Spend reminders (0.9.89).** Every request records the tokens it used and the best-sourced cost that UnodeAi can
honestly show. The cost carries one of these labels:

- billed
- an account estimate for your key's stated coefficient or group
- the gateway's published price (shown only)
- a dated Unode or Roam reference (captured 2026-09-27, marked stale after 30 days, and updated from the provider
  card without sending any key)

You can set optional targets per request, per project day or month, and per agent (Settings → Spend, User Settings
only). At 80% of a target, you get a quiet note. At 100%, 150%, 200% and every further whole multiple, you get
**Over target — work is continuing**, with a chime and a dialog. If the usage arrives after the work ended, the same
alert reads **Over target** instead and notes that nothing is running. The dialog offers **Stop this request**,
**View spend**, **Change target** and **Reset counter**. Nothing ever stops work on its own. A project's
`.unode/budget.json` can only propose lower targets. A proposal has no effect until you accept that exact version.

An agent can now wait on a long background command. A poll counts as new only when UnodeAi saw the command make
progress. An interrupted task adds one line to its coordinator's chat. Agents are told which extra local folder
they may ask to read. Whether they may read it is still decided when they ask.

If the extension does not acknowledge a send within about 10 seconds, you get your draft back with a notice.
Nothing is resent. Since 0.9.96, a confirmed send clears only what was sent: text you changed after Send stays. There is one delegation card per request. It sits where the request started, in every chat and
after a reload. If you stopped a task in a run, or if the run's interrupted work was replaced or abandoned, the
run closes once as partial after the coordinator moves on. Its card says so at once. The run is never recorded as complete.

**Since 0.9.96, a Workbench that lost its connection is offered for reopening.** After an extension host restart
(**Developer: Restart Extension Host**, **Restart Extensions** after an update, or **Don't Trust**), VS Code keeps
the Workbench tab but never connects it to the new host. Once such a tab has been in view for two seconds without
connecting, UnodeAi asks. **Reopen Workbench** opens a new Workbench in the same editor group, closes the old tab
and restores the unsent text from a saved copy. Text typed in the last seconds before the restart, or after it, is
not in that copy, and the composer says it restored the last saved copy. **Keep Old Tab** changes nothing, so you
can copy text from it first. Nothing is sent either way. The saved copy is text only, kept in this workspace's
UnodeAi state on this computer and never synced. It holds up to 20 drafts and 2,000,000 characters, and none for a
draft over 1,000,000 characters. Sending a draft, deleting its text, removing its agent, closing the Workbench
and Reset Workspace State remove it. The sidebar Chat reconnects by itself, and Reload Window restores the
Workbench in place, as before, with the agent you last chose selected if it is still in the team. After a reload,
no chat page drops a draft while the team is still loading, or when it does not load. A removed agent's draft
never returns under a new agent with the same name. When the extension host restarts or the window reloads,
UnodeAi ends each agent terminal's shell with any command still running in it. VS Code may then report that the
shell, for example `powershell.exe`, terminated with exit code 1. Your own terminals are not closed.

## Project files cannot grant execution authority

Update to 0.9.81 before you run agents from an untrusted repository. In earlier releases, `.unode/team.json` could
supply an agent's process environment and the legacy automatic-approval flag. On Windows, a Claude or Git command
started by the host could also resolve to a planted program in the working folder. VS Code and Devin required trust
first. Cursor does not provide that trust step.

Team files now keep inert data: identity, prompt, and registered route and model. They may only narrow tool, folder
and command scope. UnodeAi ignores the following, shows one notice about them, and does not write them back:

- the process environment
- automatic approval
- backend, base-URL, restart and cwd choices
- executable Skills and Playbooks
- MCP process and grant configuration

Reapply trusted capabilities and integrations through **Build an Agent**. Use the Workbench **Commands** and
**Writes** selectors for UnodeAi-hosted and Claude approvals. Codex shows its native permission profile instead.
UnodeAi does not support setting a provider process environment from a project file.

**Create/Save/Load a Team is the single saved-team home.** Its Saved teams section begins with **Save current
team...** and lists named project and personal saves. Saving opens **Save to This project**, **Save to All
projects**, and **Cancel**. The resulting notice names the same scope and location. Only named saves have a
trash button. Its confirmation says which of these will happen. **This project** will delete the shared
`.unode/teams/<name>.json` file (and its fingerprint). **All projects** will delete only the personal library entry.
The running team is unaffected. System defaults never have a delete button. Automatic snapshots can still be
deleted, but only in **Restore a previous team...**.

**Saved-team permissions require a host decision.** A **This project** save writes the team file. It also stores
the file's exact byte-and-path fingerprint in storage that UnodeAi owns. When you open that file and it is
unchanged, one confirmation lists every agent and offers **Restore saved permissions** or **Load read-only**. An edited, copied,
or cloned file loads read-only. UnodeAi then opens a per-agent review with every extra permission unticked. Teams saved
before 0.9.87 have no fingerprint. For these teams, the surviving primary skill and the role template's skills are
offered unticked, capped at the old saved ceiling. Such teams should be saved once again in 0.9.87.
**Restore a previous team…** opens the automatic snapshot taken before a roster replacement.

When an unticked review restores selected permissions, the completion notice says how many agents regained them. It
calls the team read-only only when none did.

Programs that UnodeAi starts resolve to absolute host paths outside workspaces and worktrees. This includes
approved stdio MCP programs used by either backend route. Literal commands that you approve keep their normal
project-relative behavior.

On the first 0.9.81 activation, only `env` and `autoApprove` are removed from saved agents whose source is unknown.
Existing Skills, Playbooks, MCP grants, routes, backend choices and other user configuration stay intact. A legacy
project integration is imported only if its exact launch configuration was already approved in this workspace. The
notice names the integrations it imported and the unapproved project entries it ignored. MCP state moves to
`unode.approvedMcpServers` / `unode.hostMcpServers.v1`. If you downgrade to 0.9.80, you must approve integrations
again.

In 0.9.82, all project-sensitive editor workspace state is bound to the canonical root of the first workspace
folder. Rosters, transcripts, checkpoints, runs, policy, integration evidence, and MCP approvals and configuration
cannot carry into another project when an editor reuses its storage bucket. A change of root also clears live
selection and presentation state. Existing VS Code and Cursor state is imported only for the same proven root. Old
Devin history is deliberately not imported. Reset Workspace State affects only the current root.

If you decline model-network consent on an OpenAI-compatible route, that request now ends after one dialog, before
any network request. The decline skips transport retry, request-body recovery, and streaming fallback.

**Since 0.9.96, each command runs in one identified shell.** On an OpenAI-compatible or custom-gateway agent, a
foreground `run_command` runs in that agent's own terminal, under your default terminal profile. The approval
card names the shell, from your terminal settings or from what the terminal proved last. Nothing is started for a
command before you approve it. After the approval, UnodeAi opens the terminal if needed and proves its shell, its
starting folder, and that it can read the output, before every command. If the shell is not the one on the card,
the command is not run, and the agent's retry is checked for the shell the terminal proved. If the terminal
cannot be used, the agent's next command runs in a named fallback: `cmd.exe` on Windows, `/bin/sh` on macOS and
Linux. Its approval card names the fallback, and UnodeAi never switches shells after an approval. A profile that
failed is remembered for that agent until you change a terminal profile setting or restart the agent.

The starting folder is checked, but the shell is not a sandbox. A changed folder gets a new terminal; UnodeAi never
types `cd`. Syntax that cannot run in the shell is refused before any approval prompt: a PowerShell cmdlet in
`cmd.exe` or a POSIX shell, and `&&` or `||` in Windows PowerShell 5.1. The refusal names the shell and gives an
equivalent. It is not reported as missing consent. A command that prints nothing is a normal result. The agent
receives at most 16,000 characters of output, from its start and its end.

One agent's foreground commands run one at a time. Different agents run in parallel. A foreground waiting budget
(default 120 seconds, requested up to 10 minutes) is not a process deadline: the same command moves to the background
without being killed or replayed. check_command sees later output/exit; kill_command or session teardown stops it.
Another foreground command can use a fresh terminal. Explicit verification-check deadlines stay unchanged.

An unconfirmed agent Stop or crash no longer locks later starts: UnodeAi requests old-process cleanup and continues,
without calling that old stop verified. Configured crash restart works. Updated external CLI files are re-pinned;
unqualified external versions get a notice and background check, not an adoption modal. Explicit Off stays Off.

For a longer job, the agent starts it in the background. It then waits for the job in one step, up to 5 minutes per
wait, instead of checking repeatedly. **Stop** ends a wait at once. Background commands use the direct shell and
can run at the same time. `kill_command` reports a command as killed only after UnodeAi saw its process tree end
and its output close.
No background command starts while its agent runs no further commands, even one approved before. A background
stop that cannot be confirmed when a session ends is shown in a warning. When the window closes or reloads, UnodeAi
stops every command it started at once and waits for those stops while VS Code lets it; no command starts after
that, even one approved before. It does not watch the stops finish, and the output channel names each background
command stopped this way.

Command approvals now belong to one shell grammar: `cmd.exe`, PowerShell, or POSIX shell. **Enable safe commands**
adds the reviewed list for all three. After an upgrade, a command approved for the project before 0.9.96 may ask
once more, and a safe list enabled before 0.9.96 must be enabled again. `unode.allowedCommands` still applies in
every shell that can run each entry.

Terminals that UnodeAi creates stay marked across extension-host restarts. Activation, workspace-root invalidation,
and deactivation close those terminals and their process trees. Unmarked user terminals are never touched.

**An untrusted folder announces its read-only scope once per activation.** Agents can chat, plan, read and search.
Shell commands, file writes, edits and deletes, MCP servers and the verify command stay off. Run **Workspaces:
Manage Workspace Trust** to enable them. Trusted and folderless windows do not show the dialog. The dialog's
detailed scope text is the same manifest text that the editor reads for limited untrusted-workspace support.

**Role Templates** is the same 52-role catalog that *Create a team* uses. **Your Agents** also includes agents
built by hand. It shows each agent's recorded origin, or *origin not recorded*. Role integration suggestions are
for display only. Adding an Agent or team never installs, approves, mounts, or grants an integration.

When a roster already exists, choosing a preset offers **Keep current team**, **Add to current team**, or
**Replace current team**. Add keeps the current roster and appends the preset. Replace takes the normal pre-switch
snapshot first.

## OpenAI Codex CLI

OpenAI Codex CLI runs the user's logged-in Codex CLI through App Server. First, UnodeAi runs bounded local checks
of the version and login status. Then a consent dialog appears, before App Server or a model request starts. It
names OpenAI and the model provider configured in Codex. UnodeAi does not control the CLI's network destinations.

In Act mode, each Codex agent offers **Ask for approval** (default), **Approve for me**, and
**Full access (unsafe)**, which removes the sandbox. Ask uses workspace-write, on-request, user review, and network
off. Routine commands and workspace edits then run without a card. Approve for me uses Codex `auto_review`. It
writes every review action and decision into chat, without a UnodeAi card. Full access removes the sandbox, enables
network access, shows no approval prompts, and creates no UnodeAi checkpoints. It needs confirmation every time it
is turned on, and it keeps showing a visible warning. Plan mode and host ceilings use read-only. In Plan mode a Codex
agent reads files with UnodeAi's `read_file`, because Codex reads files only by running commands. A Plan/Act switch
or a Folder Access change restarts a running agent's App Server once, because Codex 0.163.0 applies a changed
sandbox only in a new process. Network off covers other machines, not this computer: measured with 0.163.0 on
Windows, a sandboxed command can reach a service on `127.0.0.1`, and the internet through a local proxy. The Workbench
shows this profile instead of **Commands** and **Writes**. Routine Codex edits are not UnodeAi checkpoints. Unknown
requests, timeouts, a closed approval surface, insufficient Folder Access, or an untrusted workspace fail closed.

Install Codex and log in yourself first. Then choose the native executable under
**Settings → Providers → OpenAI Codex CLI → Check / choose CLI…**. It lists the installed programs without starting
them, checks only the one you pick, and saves it only when you choose **Use this CLI**. `unode.codexCliPath` remains
the equivalent User setting.

**Since 0.9.96, both CLI cards show the program UnodeAi starts.** The Claude CLI and Codex CLI cards name the
program, where it comes from, and the version UnodeAi last measured and when; opening Settings starts nothing.
**Check / choose CLI…** works the same way for Claude, whose program is now set by `unode.claudeCliPath`; empty keeps
the PATH lookup of `claude.cmd` or `claude` used before. A native `claude.exe` starts without `cmd.exe`, and so does
the program inside the npm package that npm's `claude.cmd` names.
**Update instructions** says how to update exactly that installation. **Update in terminal** types the command in a
terminal in UnodeAi's own folder, and it runs only when you press Enter; check the program again afterwards. Check / choose CLI and Update instructions
also show the latest version published on npm, once you allow `registry.npmjs.org` in the metadata consent prompt.
If the provider answers that a model needs a newer CLI, the chat names the program it started
and offers both actions; the turn stays failed, and nothing is resent. Codex model lists are kept per program and
version, and a Codex thread is not resumed in another program. UnodeAi never reads or copies
`auth.json`, `config.toml` or `CODEX_HOME`. It never injects an OpenAI API key, and it never installs or updates your
Codex installation. You may use Codex CLI 0.155.0 or newer. Windows validation records 0.155.1, and newer builds must
still pass live protocol and policy checks.

**Every start checks the program's files**, and a program UnodeAi has not tested asks once before anything of it
runs: **Check and use this program** starts it once in UnodeAi's own folder, with no model request, and agents then
use exactly those files; a change to any of them asks again. An agent keeps the program it started with: only your
own Start, Restart or a settings change chooses again, and every other start uses that program or is refused.
While a start checks the files or waits for that answer, the agent's Team row says so.

**Managed Codex (Windows x64)** is optional: **Set up managed Codex…** on the Codex CLI card lets UnodeAi download
supported Codex versions into `%LOCALAPPDATA%\UnodeAi\cli-store\`, check every file's hash and publisher signature,
and run each new version only after your OK once. **Use external CLI**, **Use managed Codex**, **Go back**, **Check
again**, **Try again** and **Reset managed Codex…** are on the same card, which also shows a running download's
step and percentage. A managed version that fails to start an agent is checked once more and marked bad when that
check fails too. Managed Codex uses your Codex login and your `CODEX_HOME`, where Codex itself writes its history,
sandbox helpers and built-in skills, as any Codex program does. See the manual for the details.

In a new editor, **Load models from Codex** verifies the executable and the login, and asks for consent. It then
runs an App Server that only lists models. That server runs from extension storage, not from the workspace.
Finally, it stops that server and caches the models that the account can see, for that exact CLI version.

With cached account models, the same button says **Refresh models from Codex** and stays available. Only a click
requests the account list, through the same executable/login checks and consent; opening the picker does not.
Refreshing does not update the CLI or grant access to a model it does not return. The line under the model field
then says how many models that Codex version returned, or why none were loaded, until the next load. Local version
checks wait for the CLI's output to close; failures show the executable, exit status/signal and output. Codex command approval
cards append UnodeAi's shell identity after the command and offer only single-use approval. Model-written
justifications are not used for that identity or the Team waiting summary.

The Codex grant is separate from ordinary OpenAI API consent. It is bound to the canonical executable path. If you
change binaries, UnodeAi asks again. Codex loads the user's native features after consent. An MCP tool call that
Codex routes for approval gets a single-use card. But a call that Codex makes from inside its own `exec` code tool
is not routed for approval at all. Folder Access controls effects, but it is not presented as a limit on reading.
Codex may read files that the user's account can access, and send selected content to its configured provider.

Codex keeps its native base instructions. It receives the UnodeAi role as an additional developer instruction.
Selected instruction-only Playbooks are written to a private Skill root for each agent. They are discovered through
App Server and removed when the agent stops. They grant no tools and never change the global Codex configuration. A
bounded Codex agent with `write` uses workspace-write. One without `write` is read-only. `execute` is not a
separate Codex switch, because commands always run inside the selected native sandbox.

Claude and Codex can each be the team coordinator that the host selects. Only that coordinator receives UnodeAi
team tools. Codex can steer an active App Server turn. MCP grants managed by UnodeAi work on both routes. The
extension host remains the external MCP client. It exposes only the agent's approved tools, through a local bridge
or dynamic tools, and it rechecks the grant at call time. Neither route writes these grants to the user's global
CLI configuration. Executable actions can select only handlers compiled into the installed VSIX. Skill folders and
remote catalogs remain instruction-only and cannot contribute code. Every run requires Workspace Trust and a fresh
digest-bound approval.

Repository `.claude`, `.mcp.json`, and `.codex` configuration may sit in the agent cwd or in an ancestor folder
that the native CLI discovers. Before either CLI starts, such configuration gets its own trust dialog. The dialog
is redacted and bound to the content. Opening only a subfolder of the repository cannot bypass it. `.claude` and
`.codex` in HOME are user configuration, and they stay uninspected. If the content changes, the dialog asks again.
Trust and load enables the project layer with a process-local trusted override. Continue without project automation
disables that layer with an untrusted override. Neither choice edits the user's Codex config.

The only scheduled network task is a daily price refresh. Roam and Unode have automatic-refresh toggles for each
provider. Unbound `unode.pricingSources` has a separate global toggle. They are user-owned and on by default. The
refreshes are coalesced, back off after failures, never run at activation, and can contact only a previously approved
metadata host. Balance checks, model and Marketplace catalog loading, and custom-gateway model loading still run only
when the user triggers them.

## How the team reports results and boundaries

**Shared team memory is context, not authority.** `memory_note` appends to `.unode/memory/notes.md` in the first
workspace folder. It writes the routing tier that the host selected, plus a semantic kind that the agent selected:
`pitfall`, `contract`, or `decision`. The file can be changed. Once it is reloaded, all of those fields are
recorded claims rather than lasting proof. Every prompt row is structurally encoded and labelled `untrusted` by
default. Limits on count and bytes still apply. A `contract` gets no special trust and no special retention.

Run **UnodeAi: Review Shared Memory** to inspect an exact row. Then, as a separate step, you can confirm or revoke
a local `human-attested` label. The host owns that record. It changes only prompt admission and display. It does
not verify that the row is true, and it does not identify who clicked. It does not grant tools, folders, commands,
network, MCP, delegation, hooks, completion, or evidence authority. Editing one byte invalidates the match. New
attestations are refused in an untrusted workspace. Path resolution fails closed if the memory file or a parent
link escapes the primary folder. Memory is never promoted to a rule or a skill automatically. UnodeAi does not
claim that recalled notes are current or correct.

**One coordinator dispatches.** The first PM in a team roster is the only coordinator. Only it can dispatch,
collect, or inspect delegation handles. A worker can send the coordinator a normal message that proposes work. The
host does not parse that message. It only validates the structured action that the coordinator later chooses. This
removes worker fan-out for now. A future hierarchy must make every sub-coordinator's handles visible to its lead.

**Coordinator briefs get their own destination consent.** A coordinator may attach a short orientation, with
sources, to one assignment. It reaches the worker as a claim by the coordinator, never as host evidence. Its
`basisRefs` must be declared in the contract and also granted to that attempt. Otherwise the dispatch is refused
before the worker starts. A brief can paraphrase your documents. It goes into the worker's prompt rather than
through a read tool. If the brief's resolved model destination differs from the coordinator's, it is sent without a
pop-up by default. To get a modal that names that destination before each such dispatch, turn off
**Allow cross-provider dispatch without approval** (Settings → More). Declining in that modal refuses the dispatch.
When the destination is the same, there is never a prompt. A destination that cannot be resolved is refused. The
setting is user-level only, so a workspace cannot change it. Briefs are kept only in the internal run record. They
are excluded from portable evidence and from activity and conversation exports.

**The input-substitution rule follows the contract.** If a task declares at least one required input, it still
tells its worker to report a context gap rather than substitute web content. A task that declares no required input
carries no substitution rule. This includes a task that declares only optional inputs, because `optional` means the
work can be completed without that input. If a source must be consulted, declare it required. The card neither
grants nor removes web access.

**A denied request stays denied on its tool card.** Host tools carry `success`, `refused`, or `failed` from the
point where the decision was made. A refusal carries a reason from a closed set: capability, scope, trust, or
consent. The UI does not re-read English result text to guess whether permission was granted. Text from MCP and
subprocesses is marked as external. It is not treated as a decision made by the host.

**A refusal can explain the safe next step without widening it.** A reviewed literal message written by the host
may follow the same bounded refusal reason. But no path, credential, command or destination reaches the model, and
neither does a free-form reason that a person gave for denying web access. On OpenAI-compatible connections, the
task-only artifact and context-gap tools are offered only for a live attempt under a contract. A stale direct
request still reaches the handler, so that it gets an accurate refusal. Claude's connection-time tool schema stays
unchanged.

**The dashboard and stream keep their meaning while they update.** Dashboard status colours use VS Code theme
tokens, and every one has a fallback. As a result, a theme that does not define a token changes a dot's colour
instead of erasing it. **Done is blue rather than green**. In measurements across all four bundled themes, the
previous green fell below the contrast floor on the default light theme. In both dark themes, it sat almost on top
of the green *working* dot. Verification chips are outlined instead of filled. This keeps their text readable. It
also gives the two neutral states a visible shape, which they lacked in three of the four themes. A growing
streamed paragraph keeps its DOM node across paced paints, so a selection in that paragraph is preserved. This
includes a paragraph with bold, inline code or a link. Its already-rendered parts stay untouched as the text grows.
A paragraph whose tail really is re-parsed is still rebuilt. Three authority boundaries that change no product
surface now have the tests they were missing. The release runner requires all 12 targeted mutations to be killed.

**A worktree lane is merged only when integration moves.** After a successful Git merge, UnodeAi compares the
integration branch's `HEAD` with the value observed before the command. An unchanged `HEAD` is shown as
`nothing to merge`. A changed `HEAD` is shown as `merged`. This does not depend on the language of Git's output.

**A collected batch containing a failed subtask is a failed step.** While collecting, `await_tasks` and
`collect_ready_tasks` record the failure as the tool call's status. As a result, the step cannot appear as a
completed call that happens to mention a failure in its text.

**An unfinished turn settles as partial.** The complete report stays visible, and the unfinished structured
activity is carried separately. Partial stops the waiting cards and wakes the coordinator. But it does not become a
completed delivery, a green evidence verdict, or a pass at a workflow gate. A workflow pauses before it dispatches
its next step.

**A safety-stopped worker continues instead of restarting.** OpenAI-compatible agents share an emergency backstop
of 100 iterations. Anti-spin still stops repeated identical calls earlier. Either stop gets one final model request
with no tools. It is followed by a `Stopped:` line written by the host and a typed partial result. The PM uses
`continue_task` to resume the same worker conversation, and it may narrow the remaining focus. The new turn
receives a fresh allowance and a new grant bound to the new attempt. Authority from the stopped attempt is not
revived.

**Task status combines durable history with live handle facts.** Worker state, wait-window state, result state, and
read-receipt state are separate. A timeout may therefore have an open late-result window and a pending result at
the same time. Only a ready result names `collect_ready_tasks`. For pending work, the coordinator is asked to end
its turn and wait for the host to wake it. It is not asked to poll or to call the hidden compatibility alias.

A teammate's "Done" text is never the verdict on its own. The framework attaches its own evidence label to every delegated result. A green status means that something verifiable happened: a write was recorded, and a passing check on it was observed. It never means only that the agent said so.

- **Verified (green)** — a recorded file write AND an observed passing `run_checks` / completion gate. An agent that only read files never reaches it.
- **Tool activity recorded; delivery not checked** — read or search activity ran, but no write was recorded. It tells you that the mechanism ran, not that the requested result arrived.
- **Replied, not verified** — file changes were recorded, but checks did not run or did not pass (or a claimed pass does not match the framework's record). The PM should run checks or send the work to review.
- **No evidence** — the reply had no tool activity that the framework could see. It is not a completed task.
- **Interrupted — no active worker** — worker continuity ended before a terminal reply. Activity keeps the
  `worker-lost` or `host-restarted` reason, the separate last-observed and detected times, and any later
  disposition. The task is terminal and is excluded from active work.

**Coordinator dispositions.** Once the coordinator has actually decided whether to rely on a settled result, it may
record one of these: `accepted`, `accepted-with-caveat`, `accepted-after-rework`,
`accepted-despite-framework-no-evidence`, `rejected`, `needs-rework`, `superseded`, `deferred`, or `needs-human`.
v0.9.80 adds `abandoned`, for interrupted work only. An interrupted handle accepts only `abandoned` or
`superseded`, and both need a concrete reason. A replacement dispatch supplies `replaces_handle` and
`replacement_reason`. On admission, the new handle and the original task's durable link are written atomically. The
Interrupted state stays visible. A rejection forwards its reason to the delegate. The earlier verdict is then
*visibly amended* in the Workbench transcript, Activity, and Team card. It is never silently rewritten. No LLM
judges whether prose "really delivered". Coordinator acceptance is **not** enterprise or customer acceptance.

**A refused dispatch is a receipt, not a disposition.** When a coordinator declines to send work at all, there is no result to assess. The refusal is therefore kept as a separate `rejected-at-dispatch` record, with its reason. Metrics report dispatch attempts, work actually dispatched, and refusals separately.

**Under-crediting is now counted too.** The framework already reported how often a green verdict was later rejected. 0.9.48 adds the other direction: how often a `no-evidence` or `replied-not-verified` result was accepted anyway. A correct answer built from context already on screen leaves the same empty trace as a worker that guessed. UnodeAi does not pretend to tell them apart. Doing so would mean reading the prose, and that is the self-grading this design excludes. Instead, it counts how often the distinction mattered.

**Per-agent command narrowing.** Command approval is a workspace-wide policy. In the Agent Builder, you can narrow it further for an individual agent: *Inherit global* (the default) or *Restrict to selected*. The editor shows a checklist, not a text box. It lists the commands this workspace already allows: the entries of `unode.allowedCommands` and the commands approved for the project, each with the shells it is allowed in. This means a per-agent setting can only narrow, never widen. At check time, every saved selection is intersected again with what the workspace currently allows in the shell of that command. Since 0.9.96, a command approved for the project only in PowerShell counts for that agent only in PowerShell. An empty restricted list means that the agent runs no commands. This is deliberately different from inheriting.

**What each context source says about itself.** The per-turn context receipt now shows two filesystem facts for each source that is backed by a file. The first is how long ago the file was modified, with a visible note at 90 days or older. The second is whether a mechanical signal suggests that the file may be sensitive. Neither is a judgement. An old file is not a wrong file. The sensitivity signal is a check of patterns, path, file mode and `.gitignore`, not a classifier. No model reads the file, and no matched content is copied into the panel. Both facts are report-only. In this release, nothing is blocked or redacted because of them.

**Activity export truncation.** An exported message log keeps a retained window of 300 items. When that window has dropped older activity, the export *declares the omission and the omitted count*. It does not silently appear complete. This way, an export that looks short tells you what it is missing, instead of looking broken.

**Run evidence packs.** A coordinator's first real delegation opens a run. The run closes only when that coordinator gives the user a closing summary after all delegated work has settled. If the coordinator does not finish, the run stays explicitly open across restarts. Later dispatches stay in that visibly open run until it closes. Use **UnodeAi: Export… → Run evidence pack** to export one run as standalone Markdown that can be read without installing the extension. The pack carries dispatches, refusals, observed framework evidence, append-only coordinator dispositions, context-source labels, and receipts for exercised approvals, scopes and grants. Its completeness statement is about that run, not the rolling Activity window. Coordinator acceptance is not human or customer acceptance, and no model judges whether the work was correct. Raw approved commands, context contents, and credential values are excluded.

**Portable Run Evidence.** The current `portable-run-evidence/5` schema (0.9.93) links a host retry to the attempt
it retries (`retryOfHandle`, `retryStage`). Its `retained` section says that every timestamp is UTC. As `/4` did,
it distinguishes runs that closed completely from runs that closed partially, and it counts terminal interrupted
work separately. Also as in `/4`, it carries delegation completion independently from the evidence verdict, and
it exports `readReceipt: observed | not-observed`, rather than asserting that a missing receipt means no read occurred.

The portable JSON maps the exact internal actor identity behind a human decision to a document-local `approver-1`.
An exercised MCP grant has no approver, because no decision was made at that moment. Exact built-in routes are kept
only when the builder validates their connection and endpoint. A private custom route becomes `custom-gateway`, and
its hostname stays internal. Complete file changes carry validated SHA-256 hashes of the file before and after the change, and a
deterministic root computed at write time. They never carry source or diff bytes. A consulted PDF contributes only
a document-local content ordinal, its class, extraction outcome, page coverage, truncation, and OCR state. It never
contributes its URL or query, attachment name, temporary path, raw bytes or extracted text. Relative changed paths,
timestamps, and hashes are deliberately retained and declared inside the artifact. Fields that are historical or
were not fully observed stay explicitly unavailable.

**Stopping work.** While anything is running, the status bar shows `⏹ Stop N`. One click ends every running turn. The status bar item appears only while agents are working, so its presence answers "is the crew still going". An ended turn is not yet a stopped process: the Team panel shows **Stopping** until UnodeAi sees the agent's processes end, and **Stop unconfirmed** when it cannot, but later starts request old-process cleanup and continue. A crash keeps its truthful historical stop result; configured crash restart can start a new process. A coordinator can stop its own team too. `broadcast` and `send_message` only deliver a message, and a teammate already mid-turn finishes regardless. That is why `cancel_task` ends the turn instead: one assignment by handle, one teammate by name, or the whole team. A handle stops only its own task, never a later turn of the same teammate. Two limits are structural. First, a coordinator cannot stop itself, because that would end the turn that is making the call. Second, a solo agent belongs to no team.

**Long tasks can arrive in batches.** A coordinator can dispatch a long task with `delivery` set to `incremental` and its expected sections. The worker saves each completed section with `save_task_checkpoint`, on every connection, and UnodeAi writes it to disk before it confirms it. A saved batch is partial work: it grants nothing and extends no wait, budget or deadline. `inspect_task_status` and the Team panel show what is saved and when a batch is due; a connection without a live token count shows the count as unavailable. A Stop wins: batches after it are refused, and the ones saved before it are a draft that only you open, with `UnodeAi: Saved Task Batches…`. They stay on this machine, in this workspace's extension storage, for 30 days after the task ended.

**Approval waits stay live.** While a delegated worker waits for a decision on a command, a write, or public-web
access, its activity reads **Waiting on your approval** rather than **Stalled**. This holds on Claude, Codex, and
OpenAI-compatible routes. The waiting state closes when the approval surface resolves.

**What your key actually pays.** A gateway publishes what a model costs. What *your key* is charged is settled internally and is often not reported. Both settings that cover this belong to the key, not the account. That is because two keys on one account can sit in different billing groups, with different prices and different models they can call. `unode.priceGroup` names the group for each connection. Where several groups exist and none is named, UnodeAi shows the **undiscounted** rate rather than guessing the cheapest, because an under-estimate takes money without warning. `unode.priceMultiplier` states what fraction of the published price the key pays. UnodeAi asks for it when you store a key. **Exactly one discount is applied**. A stated coefficient and a gateway-reported group ratio answer the same question. This is why a stated `1` deliberately suppresses a discount that the gateway would have applied. On a connection where no coefficient is set, the gateway answers. `0` is allowed and means that the key is free. An empty box and Esc both mean list price, never free.

**Temporary task scope.** A coordinator can narrow a teammate's folder access for one assignment. The narrowed scope is intersected with the agent's configured Folder Access, so it can only be narrower, never wider. A read-only assignment also removes write and shell tools. The delegation card shows the temporary scope while it is active, and marks it as ended afterwards. This way, an agent that can normally write can be sent on a read-only audit without changing its saved configuration. A request inside the saved Folder Access but outside that assignment gets a bounded task-scope refusal. The agent may then continue with a granted action or report the gap. A request outside the saved Folder Access is still terminal. **The boundary has not relaxed:** no refused path is newly readable or writable. A real path escape still ends the turn. A command-line heuristic for out-of-root paths still blocks execution, but it lets the turn continue. An expired, unsupported, or unforwarded temporary asset stays unavailable, but useful work does not end.

**Local project discovery is explicit, not a pre-registered Agent Builder folder.** `unode.localReadScope` has three values: `workspace`, `parent` (the default for a trusted workspace), and `volume`. `parent` makes the workspace's parent folder available. `volume` is deliberately wider. The first time a top-level request reads, lists a directory, inspects Git tags, or walks with `search_files` through that root, UnodeAi shows the resolved absolute path. The confirmation says that agents may search the entire tree, and that returned names and contents may reach the configured model provider. For volume, it adds a warning about other users' profiles. If you deny or dismiss it, the root is blocked for that request across the crew. If you make a later direct request, UnodeAi may ask again. A failed dialog also blocks retries within the request, but it is not recorded as your decision. The refusal offers **Grant folder access**. The Security panel lists the grant and revoke state, which lasts only for the session. Writes, deletes, generic shell access, and Claude native access stay in the working folder. Folder Access can still narrow the root. Tool cards and run evidence record only an opaque root id, the action and a count. They record no path, query, filename or content.

**Directory listings are listings.** The activity card now says **List** / **Listed N folders** for directory operations rather than calling them reads.

This folder contains a static, website-ready wiki for UnodeAi.

## Media: what is local, and what needs a second approval

**Downloading a file and uploading it to a provider are two different acts, and UnodeAi asks separately.**

- **PDFs are read locally, by page.** A PDF may be fetched with approval or attached from your machine. Either way,
  it is checked by its signature and held in a temporary asset store under an opaque id. It is read through
  page-scoped tools, which always state the range they covered out of the document's total page count. Its filename, bytes,
  source URL and temporary path never reach the model, the chat history, or exported evidence.
- **Sending a stored image to a vision model needs its own approval.** An image that an agent downloaded is not
  uploaded anywhere by default. It is sent only when the exact route is known to support vision, never when support
  is unknown. It is also sent only after a prompt that names the provider, host, byte count and estimated input
  cost. Your earlier download approval does not cover it, and neither does ordinary model-egress approval. The
  grant is per host *and* per purpose. Allowing vision never allows transcription.
- **An approved image is used once.** It is dropped after that request, even when the request fails or you cancel.
  A later turn therefore cannot resend it without asking again. A route that rejects it is recorded as unsupported
  for that route alone, and the model is told that the image was omitted. A text-only answer is never presented as
  analysis.
- **Video is unsupported and says so.** The extension ships no decoder, native module, WASM, or downloaded runtime.
  Metadata inspection is not offered as video understanding.

## Known issues retained in 0.9.82 (scheduled for later releases)

Each one fails safe. Nothing runs, is sent, or is written unless you approved it.

- **Chat stays at Sending… after you choose Don't Trust while Chat is open.** Revoking Workspace Trust restarts only the extension host. The open chat keeps a stale connection. Your draft is kept and nothing runs. Run **Developer: Reload Window**.
- **After a reload, recent delegation cards appear together at one point in the chat, with raw agent ids.** Their display order and names are not restored across a reload. No transcript content is removed. This is cosmetic, and no action is needed.
- **An agent cannot wait on a long background command.** Repeated `check_command` polls of the same background job are blocked as repeated identical calls. The agent may therefore stop early. Ask the agent to run the command in the foreground.
- **A run whose interrupted task was replaced from a later message stays open.** The replacement belongs to a new run, so the original run never gets its own closing summary. The evidence pack says the run is open and must not be read as complete. This is for information only. Both task attempts are recorded as terminal.

## Files

- `index.html` - self-contained HTML page with embedded CSS and JavaScript.

## Website Integration

The page is intentionally static. It can be:

- linked directly from `www.weroam.xyz` or `www.unodetech.xyz`;
- copied into an existing site route such as `/unodeai/wiki`;
- embedded in an iframe;
- converted into a CMS page by copying the `<main>` content and the CSS variables.

Recommended route:

```text
/unodeai/wiki
```

The page links to:

- `https://www.weroam.xyz`
- `https://www.unodetech.xyz`
- `https://www.unodetech.xyz/pricing?lang=en`

No build step is required.
