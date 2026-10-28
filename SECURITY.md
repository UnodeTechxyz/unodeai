# UnodeAi — Security Model, Policy & Audit

This document describes exactly what UnodeAi does with your code, your machine, and the network, and the
controls that constrain it. It is intended for security-conscious users and for registry reviewers. Every
claim below is reviewable against the matching source drop in this public repository. A tag gate requires
that allowlisted source drop to match the release candidate before publication; the checker also refuses a
source drop older than the version published on Open VSX. The drop's checked-in `SOURCE` record identifies
the exact private source commit to reviewers who have private-repository access. It does not independently
prove that private commit to an outsider.

**v0.9.99 The person's own setup is the consent; fewer fixed limits.** This release, at the Owner's direction
("give capability, don't add limits; tell the user"), removes most fixed caps and many extra permission questions.
Where a question was removed, a plain non-modal notice says what happened and how to undo it. What changed for
security:

- **Model, Codex and media egress no longer ask first (§2).** Saving a connection with its key and choosing it for
  an agent, choosing a Codex program, or setting up a vision or transcription model is treated as the decision to
  send work there. The first request records the grant, shows one non-modal notice naming the destination and how to
  revoke it, and continues. A revoke in the **UnodeAi: Security** panel, or **Do not allow** on the question, is
  saved, and from then on the existing modal is asked again before anything is sent to that destination. A
  different Codex executable no longer asks separately; a revoke of Codex applies to every Codex executable.
- **Public web access is allowed by default** (`unode.webAccess` = `allow`). A value the user set (Ask or Off) is
  kept; a value that is set but not recognised is read as Ask. Each search or fetch still shows as a tool card. The
  public-address, private-address, redirect and download-size checks of `fetch_url` are unchanged.
- **The workspace's parent folder is read without a question.** With `unode.localReadScope` = `parent` (the default
  in a trusted workspace), the first read there shows a notice naming the resolved path instead of a modal. A whole
  volume, and a folder the user revoked or declined in this session, still ask. Writes and commands stay in the
  working folder.
- **Repository CLI configuration is compared by what it can do.** JSON settings are compared in a canonical form,
  and the `permissions` allow, deny and ask lists in Claude's `settings.local.json`, which Claude Code rewrites
  itself, are left out of the comparison; every Claude tool call still meets UnodeAi's own tool gate. Any other
  change (a hook, an MCP server, an environment value, a helper program) asks again. With project automation off, a
  later change to that configuration no longer stops the start, because none of it is loaded.
- **"Always allow this tool" on a Claude agent's card survives a restart** for the user's own MCP tools and native
  tool names this release does not know. It is kept per agent in the project's extension storage, never
  machine-wide or crew-wide; the Security panel lists the kept tools per agent with revoke, and removing the agent
  forgets them. Write and external-effect tools keep their per-process answer.
- **A team file UnodeAi saved loads its saved permissions without a question.** An agent saved with Run commands
  Off stays Off. A copied or edited team file still loads read-only with the unticked per-agent review. The
  v0.9.87 rule that restoring permissions always needs a person's decision no longer holds for a recognised save.
- **The retired single Custom gateway migrates without a confirmation when it only recreates the person's own
  binding** (trusted workspace only): the legacy `CUSTOM_API_KEY` to the User-level legacy endpoint. One notice
  afterwards names the new gateways. A legacy record that names any other stored key or endpoint still needs the
  confirmation, wherever it is stored, which lists each endpoint and names the stored key it would be used with (§5).
- **An endpoint or key edit of a Custom gateway while one of its agents is mid-turn is saved when that turn ends**,
  instead of being refused.
- **An MCP server the user adds in the Marketplace or with Add MCP Server is approved by that act**, for that
  workspace and its exact launch spec. A server from any other source, such as a file, still asks before it mounts.
- **A CLI version a UnodeAi release marked bad offers Run anyway.** After a warning and a passing compatibility
  check, the choice is recorded for exactly those files and that bad-list entry, and every start of it shows a
  warning. Without that choice the start is refused as before.
- **A Codex start has no deadline.** If Codex has not answered `initialize` after 30 seconds, the chat and a
  notification say the version looks bad and how to update it; for managed Codex this counts as a failed start, so
  that version gets its one check. The start keeps waiting until Codex answers or Stop. Nothing is sent anywhere.
- **An unconfirmed command stop or a closed agent terminal no longer blocks the agent's later commands.** The
  result says the command may still be running and may have had effects; it is not run again, and the next command
  runs in a new terminal or process (§3).
- **File changes go ahead in two cases that used to refuse (§3).** A file with unsaved editor changes is written
  or deleted on disk; the editor's text is not touched, and one transcript line says so. When a restore point
  cannot be kept (storage full or read-only, no room), the change still happens and the result says it has no
  restore point and why. A file over 32 MiB is copied to its restore point on disk as a stream. A restore over newer
  work or unsaved editor changes offers **Restore anyway**; only the person's click does it, and the current bytes
  are kept as a restore point first where they can be.
- **A coordinator with teammates may do a small action itself without a task contract**, under its own configured
  permissions (folders, write approval, Commands, Workspace Trust and Plan mode still apply). A contract it filed
  still limits it.
- **A check that could not run continues as unverified** in worktree lanes and workflows, unless the user required
  that check. It is recorded as unverified, never as a pass, and worktree work is not finalized to the base branch
  automatically. Failed checks still hold.
- **A dispatch whose files overlap work in flight is queued**, and starts later through the same candidate
  filters, claims and grants.
- **A window with no folder can run an OpenAI-compatible agent for chat**, with no file or command tools, no Folder
  Access, no integrations and no skills. Model egress rules are unchanged.
- **A change of the first workspace folder no longer stops work.** The window keeps working in the folder it started
  with until a reload. If that folder is removed from the window, agents keep working in it until the reload.
- **Network and run time limits removed.** `fetch_url` and `@url` mentions have no 10-second deadline; Stop ends
  them, including during the address lookup. A slow `@url` shows reminders with **Send without it** and **Keep
  waiting**. MCP tool calls have no implicit deadline (a server's own `timeoutMs` still applies). OpenAI-compatible
  turns have no 100-step limit; the chat says every 100 steps that the agent is still working. Request limits the
  user sets still stop work.
- **Attachments have no fixed size limit.** The composer hands each file to the host in pieces, and the host keeps
  it in a temporary file until it is sent (§5). Each sent file is still read whole into memory.
- **Long results are kept whole.** A tool result or fetched page longer than the model is given is kept complete in
  the temporary content store for the agent that received it, which reads on from that copy (§5).
- **Documents.** `write_document` has no whole-document size limit and can build a document in parts (drafts kept
  in a temporary folder, §5). The renderer's worker heap is sized from the input, up to half of the machine's
  memory, instead of a fixed 256 MiB.
- **Skill instructions.** The bundled external-actions skill now asks the model to seek approval only for the exact
  outward action (push, deploy, publish, sending to others, purchases, changes in production or third-party systems,
  credentials and security settings). The legal skills research and draft and never state that a party is cleared
  or a transaction permitted. These are instructions to the model, not enforcement; the host's own approvals are
  unchanged.
- **Unchanged floors:** secrets stay in SecretStorage and out of logs; `unode.commandApproval` Disabled, Ask each
  and Plan mode; the dangerous-delete and folder-delete confirmations; approval cards for Claude's native
  external-effect tools; Stop; an approval left unanswered for 15 minutes counts as a denial; at most two automatic
  rework requests per task after the user's last message, with a one-click **Continue rework**; and user-set request
  limits.
- **Dependencies:** a lockfile-only update of `qs` to 6.16.1 (§8).

Statements in earlier summaries and audit-log entries below that these changes replace no longer hold: the v0.9.98
summary's fixed 256 MiB renderer heap and "a policy entry marked bad is still refused"; the earlier rules that an
unconfirmed stop or a closed terminal closes the agent's command lane; the modal-first rules for model, Codex,
media, local-read, user-added MCP, saved-team and legacy-gateway decisions; the 8 MiB composer and 10 MiB host
attachment limits; the 30-minute expiry of content-store items; the OpenAI-compatible anti-spin end and 100-step
limit; the 10-second web fetch deadline; and the rule that a coordinator with teammates needs a task contract for
its own write or command.

**v0.9.98 Capability by default, Word and PDF documents.** This release deliberately loosens several defaults, at
the Owner's direction ("remind, do not block"), and adds a document writer. What changed for security:

- **Commands run automatically by default** (`unode.commandApproval` = `all`, labelled Automatic). Built-in roles
  can request commands, and old built-in records adopt their template's commands on load; an explicit Off is kept.
  The floors that remain: a recognised dangerous delete asks once in Automatic, Ask each and Allowlist, with
  Don't run as the default, and is refused under Disabled; a folder delete that holds files UnodeAi did not make
  asks once, with Don't delete as the default; closing either dialog, Stop, or no approval UI means not run. Ask
  each, Allowlist and Disabled remain one menu away (the Commands menu at the bottom of the chat panel).
- **Codex defaults to Approve for me** (workspace-write with Codex's own `auto_review`), not Ask for approval.
  Plan, Workspace Trust, writable-folder and tool-ceiling limits still resolve downward to Read only.
- **Fewer decisions on file changes.** A file that may hold work that is not the agent's no longer asks separately;
  restore points and post-write read-back stay, and one transcript line reports an observed change. A
  user-selected write Ask still asks.
- **External CLI programs start without the adoption question.** A Claude or Codex program whose files the bundled
  policy does not name is hashed, checked once in UnodeAi's own folder with no model request, recorded and started,
  with a notice naming the old and new versions. A policy entry marked bad is still refused. The 0.9.97 rule that
  nothing of an untested program runs before the user answers no longer holds.
- **An unconfirmed Stop or crash no longer locks the agent.** The next start requests the old process tree's cleanup
  and continues; the old stop is not relabelled as verified.
- **`write_document`** writes DOCX and PDF through the same write policy, approvals and restore points as other
  writes, on every route; it takes structured text, never HTML, macros, external assets or font paths. Rendering runs
  in a worker thread with a 256 MiB heap limit. The host font broker reads only Windows system font files
  (`%WINDIR%\Fonts`) and hands their bytes to the worker; no font path comes from the model.
- **Chat links to `.docx`, `.xlsx`, `.pptx` and `.pdf` files open in the system's associated application**, after the
  existing path and read-folder checks. Any other file that cannot open as text is never handed to the system: the
  only action offered is Reveal in File Explorer.
- **Delegated-result bodies are kept on disk** in VS Code's workspace storage for the extension (`context.storageUri`), so a result survives a reload; archived and
  decided bodies are reclaimed automatically.
- **New runtime dependencies:** `pdf-lib` 1.17.1, `fontkit` 2.0.4 (with `brotli` 1.3.3 and `dfa` 1.2.0) and `yazl`
  3.3.1. Their licence texts ship in the package. A development-only override pins `@azure/msal-node` 7.1.1 (§8).

**v0.9.97 Checked file changes, stops that are seen, and the CLI program that was checked.** This release
corrects path-safety, restore and Stop defects of 0.9.96, and adds one optional new authority, managed Codex.

- **Corrected defects of 0.9.96.** Four path-safety defects (alias spellings of `.git`/`.unode`, parent-folder
  spellings the delete guard missed, a write or delete redirected to a same-named file, a snapshot input read
  through a link), a file restore that could write to another file with the same relative path, and a Stop that
  ended only npm's `claude.cmd` shell while Claude kept working. Each has an audit-log entry of 2026-10-19.
- **One write policy before the file changes that reach UnodeAi**: UnodeAi's file tools, Claude's native
  Write/Edit/NotebookEdit, and a Codex file change that Codex asks UnodeAi to approve. Unsaved editor changes are
  refused, and a file that may hold work that is not the agent's needs the person's decision for that one change.
  UnodeAi's own tools keep a file's exact bytes before they replace or delete it, within the restore-point limits
  (32 MiB a copy, 256 MiB a workspace, 30 days). Not covered: the edits Codex's own sandbox allows under Ask for
  approval and Approve for me, every edit under Full access, and a file a shell command writes on any route.
- **`save_attachment`** writes only a file the person attached to this request, byte for byte, through that same
  policy, and reports the SHA-256 read back. It takes an attachment id, never bytes from the model.
- **The Request summary reports file effects as the host observed them**; a model's claim counts nothing.
- **A stop is reported only when it was seen.** An agent whose stop, or whose own exit, was not confirmed is not
  started again by UnodeAi until the person starts it. An automatic Codex App Server replacement starts only after
  the old tree was seen to stop.
- **Every CLI start hashes the program's files**, and a program this release did not test asks once before
  anything of it runs. The bundled list qualifies Codex CLI 0.163.0 (OpenAI's Windows x64 package) and Claude CLI
  2.1.306 (Windows x64), each after real-run release canaries. A Codex escalation reaches the person's card, a recognised dangerous delete apart,
  when no host command policy is injected (a regression of this release's own command guard, found by the
  canaries and never released).
- **Managed Codex (Windows x64), off until the person sets it up.** It adds network destinations (the hosts of a
  bundled policy entry, only after the person approves them), a store under `%LOCALAPPDATA%\UnodeAi\cli-store\`,
  and processes: Windows PowerShell's `Get-AuthenticodeSignature`, and one check run of a downloaded version with
  no model request. It is not an isolated profile: the native program uses and writes the person's `CODEX_HOME`.
- **Measured limits stated, not fixed.** Codex 0.163.0's Windows sandbox with network off refuses connections to
  other machines but not to this computer, so a local proxy reaches the internet; managed Codex shares
  `CODEX_HOME`; Claude CLI rewrites `~/.claude.json` at each start. Managed Codex tells a version in use from one
  that is not by asking Windows which processes run, through Windows PowerShell. Each PowerShell run asks about at
  most 60 processes and is bounded at 5 seconds; a check of more processes makes several runs one after another,
  so it can take longer. On GitHub's Windows runner, while it ran the test suite, a run with a 30-second bound
  answered and the next run did not answer within 5 seconds; a desktop answers in about half a second. An answer
  that does not come counts as "in use", so on a host that slow nothing is removed wrongly, but: old versions are
  kept beyond the newest three, and can fill the store's 3 GiB so that a later download is refused; Try again
  answers that the version is in use; a download of a version another window started is skipped until that
  window is known to have stopped or ten minutes have passed; the first managed-Codex start or card action in a
  window waits for its own run; and a version used by a window that ended abnormally before its own run answered
  can stay kept with no time limit. The bound is not changed in this release (the Owner's decision).

**v0.9.96 One shell per command, a checked starting folder, and observed stops.** This release binds each
command to the shell that runs it, and reports a stop only when the host saw it. It widens no authority.

- **One shell identity from the check to the run.** Every command string the host runs carries one typed shell
  identity: the shell the agent's terminal proved for its last command, the shell the terminal settings name, or
  the declared direct shell. Normalization, the `CommandPolicy` check, the approval card and the run all use that
  one identity. No other shell is chosen after an approval. If the terminal changes between the approval and the
  start, or proves another shell kind than the one approved, the command is not started. A command is attempted
  at most once and is never replayed.
- **Nothing is started for a command before its approval.** The identity on the approval card is decided from
  facts alone: the settings (`terminal.integrated.defaultProfile.*`, `terminal.integrated.profiles.*` and
  `vscode.env.shell`, VS Code's resolved default shell) and the agent terminal's last proof. No terminal is
  created, no program started and nothing typed to decide it. After the approval the host opens the agent's
  terminal if needed, waits for its integration and its folder, and probes its shell before every command. A
  command that is refused, denied or never answered therefore starts nothing, also when the terminal profile is
  one a trusted workspace chose. After the approval, the agent's lifecycle, the terminal-settings revision it was
  approved under and Workspace Trust are checked again before a terminal is created, after each wait, and
  immediately before the command starts; a change means not run. A prepared command is one-shot in every wrapper:
  its first execution consumes it, whether it starts or is refused, so it can run only through a new preparation
  and approval. Settings that name Command Prompt, a WSL profile or a shell the host cannot check
  take the declared direct shell at once, named on the card. A terminal opened under earlier terminal settings is
  retired before a command runs under new ones. Claude CLI `Bash` and `PowerShell` calls are checked as POSIX
  and PowerShell commands; Claude still runs them itself. A Codex CLI command whose shell the host did not
  measure gets a neutral identity. It can be approved once, is never remembered, and matches an allowlist
  silently only as one simple command without any expansion character.
- **Approvals belong to one grammar.** Session and project approvals are kept per grammar: `cmd`, `powershell`
  or `posix`. An approval in one grammar never lets a command run silently in another. A chain is allowed without
  a prompt only on the separators its grammar admits: `&&` in `cmd.exe`, `;` in Windows PowerShell, `;` and `&&`
  in PowerShell 7 and POSIX shells. Each grammar also has its own characters that always force a prompt, checked
  inside quotes too: `%`, `^`, `;` and parentheses in `cmd.exe`; `$`, `@`, braces, parentheses and the backtick
  in PowerShell; `$(`, `${`, `!`, parentheses and the backtick in a POSIX shell. Project approvals moved to a new
  storage record. An older record grants nothing except its execution switch, and a malformed new record grants
  nothing. Entries of `unode.allowedCommands` apply only in the grammars that can run them. A per-agent
  narrowing from Agent Builder is a ceiling over the same set, taken for the grammar of each command: a ticked
  project approval counts only in its own grammar.
- **The starting folder is checked, not confined.** A command runs in a terminal only after shell integration
  reports the agent's working folder as the terminal's folder, compared as physical paths. A changed folder
  retires the terminal; the host never sends `cd`. A folder change seen after the start stops the command and
  reports its outcome as unknown. This proves where a command starts. It is not a sandbox: a running command can
  change folder, and the approval gate, Folder Access and Workspace Trust still decide what may run.
- **The declared direct shell is resolved like any host program.** The fallback, background commands,
  `run_checks`, the worktree verifier and the verify command run through Node with an explicit shell executable,
  never `shell: true`. On Windows that is `cmd.exe`, found by the host executable resolver, which never takes a
  workspace or worktree candidate. `ComSpec` is used only when it is an absolute path to a file named `cmd.exe`.
  On macOS and Linux it is `/bin/sh`. When neither resolves, nothing runs.
- **A stop is reported only when it was seen.** On a timeout the host sends Ctrl-C and waits two seconds. It then
  terminates the process tree, checks that every captured process is gone, and disposes the terminal, even if the
  prompt came back. If it cannot confirm the stop, or the terminal closes while a command runs, that agent's
  command lane closes: no later command of the agent starts, foreground or background, until the agent is
  restarted or the window reloaded. A background command is checked against its lane, and against Workspace
  Trust, both when it is prepared and when it would start, because its approval may have waited in between.
  `kill_command` reports a background command as killed only after its tree was seen gone. When a session ends,
  every background command that may still run is stopped again, also one whose earlier stop was unconfirmed;
  each stop that still cannot be confirmed is shown in a warning. A pending command approval of an agent that is
  removed or restarted is closed by the host as withdrawn, and no later click can run it.
- **A host shutdown sends every stop first.** The editor ends the extension host a few seconds after deactivation
  starts. The host's exit then ends each of its direct children at once, Node's job object doing so on Windows;
  their descendants survive, with no root left for `taskkill /T` to walk. `deactivate()` therefore begins the
  shutdown before anything else. From then on:
  - no direct command starts, also one prepared or approved before;
  - a Windows stop runs `taskkill /T /F` without listing first;
  - a stop already waiting on a listing stops waiting;
  - the POSIX listings of one stop, which find the descendants to kill, may take one more second together;
  - nothing waits to observe a stop, and none is reported as confirmed.

  Every stop is sent before anything is waited for. A save that was still pending is started first, so it stores
  the state from before the stops, and it is waited for last; a save that hangs or fails holds back no stop. The
  host then waits for every stop it can find: the cleanup of each agent, also one that an earlier Stop detached;
  every direct child it started and that has not closed, wherever it came from; every agent terminal's tree; and
  the MCP servers. Only after that does it dispose the services those stops report through. A stop that cannot
  finish within the editor's shutdown time can leave the command's descendants running.
- **A stop never targets a number Node has seen end.** Once Node reports that a child it started has ended, the
  child's number may already belong to another process, so a stop of that child sends nothing by that number. A
  child that ended before its stop is reported already stopped, as a root that is gone always was. One that ends
  while its tree is being listed gets no taskkill and no signal, and nothing listed under its number is stopped: on
  Windows the poll and the second listing then decide the outcome, and on POSIX the stop is reported unconfirmed. A
  second stop of the same child, its owner's and the host's at shutdown, joins the one under way and sends nothing
  of its own.
- **A background stop is confirmed only once the command's output has closed.** A shell can end while a process
  it started, which the stop did not reach, still holds its output open. So after a tree stop that was confirmed,
  or that found the shell already ended, `kill_command` and the stop at the end of a session wait for the output
  to close, for at most one confirmation time (5 s) that every stop of the command shares, a retry included. If it
  does not close, the stop is unconfirmed: `kill_command` and `check_command` say that the command may still be
  running, and a stop at the end of a session is named in the output channel and shown in a warning. Nothing is
  sent to the ended shell's number for this. At shutdown nothing waits for the close, and a wait under way ends; a
  close not seen by then makes the stop unconfirmed, named in the output channel only. A closed output means only
  that no process holds it any more; a process that let go of it, or that left the tree, can still run, as the
  limits above say.
- **New host processes for observing a stop.** On Windows the host lists processes through Windows PowerShell,
  resolved by the host executable resolver, with `-NoProfile -NonInteractive` and one fixed
  `Get-CimInstance Win32_Process` query that takes no input and reads each process's parent and creation time. A
  process created before the one now listed under its parent number is not that one's child: Windows keeps a
  parent number after the parent ends, so `csrss.exe` can list a just-started shell as its parent. The host then
  runs `taskkill /T /F` on the command's root, as before. A non-zero exit is not taken as proof either way:
  `cmd.exe` ends on its own once its only child is stopped, and taskkill then reports it missing. After every
  captured process is seen gone, a second listing decides, and the stop is confirmed only when that listing is
  readable and shows no captured process and no child of one. The second listing stops nothing and clears no
  other failure. A descendant that started after the first listing and whose own parent has also ended appears
  in neither listing. A confirmed stop therefore means stopped as far as the listings can show; it is not a
  promise that no descendant anywhere survived. On macOS and Linux the host lists processes with `ps`, as before.
  It pauses the root and each captured descendant with `SIGSTOP` until the tree stops changing, then sends
  `SIGKILL` leaf-first. A process that left the tree before the snapshot cannot be observed or stopped this way.
  A descendant that exits between a snapshot and its pause frees its PID; if another process of the same user
  took that PID at once, it would receive the signal. A PID that is still in use when the check runs is reported
  as an unconfirmed stop, never as stopped. Each listing, and taskkill, may run for 20 seconds.
- **Output is bounded.** The model receives at most 16,000 characters of a command's output, from its start and
  its end, with terminal escape sequences removed.
- **A Workbench left without a host is replaced only on the user's word.** After Restart Extension Host, VS Code
  keeps the Workbench editor tab but neither calls its panel serializer nor delivers its messages to the new host.
  Reload Window and a closed and reopened window still restore it through the serializer, and VS Code resolves the
  sidebar view again by itself (measured on VS Code 1.142.0 with an isolated probe extension, not UnodeAi). A
  Workbench tab, identified only by its exact native view type `mainThreadWebview-unode.workbench`, counts as
  unconnected when it has been its group's active tab for two seconds without attaching. The host then asks, and
  closes that tab only after the user chooses **Reopen Workbench**. Right before it acts it checks again that the
  window is not closing, the bound root is unchanged, the tab still exists and no Workbench attached meanwhile.
  A tab in the live Workbench's own group is never judged, and when several tabs are unconnected the host does not
  choose between them. No other tab, editor or terminal is touched, and neither Close All nor Reopen Closed Editor
  is used. Recovery starts no turn, command, MCP call, approval answer or resend. A second Workbench that VS Code
  restores while one is connected is shown as an older copy, with scripts disabled, and is never attached.
- **A second, text-only local copy of unsent Workbench text.** VS Code already stored the Workbench page's own
  state, drafts included, in workspace storage. The host now also keeps each agent's unsent Workbench text, with
  host-issued ordering, in the activation-bound root-scoped workspace state: never `globalState`, synced keys,
  repository files or provider storage. It holds no attachment, file name, permission, tool argument or
  credential. Edits are accepted only from the live Workbench page's own generation, and bounded at the parser and
  the store: 20 drafts, 1,000,000 characters per draft and 2,000,000 in all. A longer draft is not copied, never
  truncated, and the composer says so. An accepted send, an emptied draft, an agent's removal, closing the
  Workbench and Reset UnodeAi remove the copy. Saving text that did not change, for example when another agent is
  chosen, is not an edit, so an accepted send of that text keeps it stale after a reload too. An accepted send
  clears only what it sent, whenever its acknowledgement comes: text changed after Send stays, with its copy, and
  only the attachments that went with the message are removed. The copy is ordinary
  local data, not secret storage, and not crash-proof: text typed in the last seconds before a restart may be
  missing, and the rebuilt Workbench says it restored the last saved copy. With no bound root nothing is read or
  written. At window close a pending write starts with the other saves and is waited for last; it holds back no
  stop.
- **Agent incarnations.** Each agent in the roster gets an incarnation, a host sequence, the first time the copy
  sees it; removing the agent forgets it. An agent later created with a removed agent's id therefore gets a new
  one and inherits no draft, in either chat view, however many agents were removed in between. Nothing is kept
  for a removed agent, which bounds this state by the roster. When the roster loads, agents no longer in it are
  forgotten with their copy. Drafts saved by an earlier UnodeAi, which carry no incarnation, are taken over only by
  agents that were in the first roster the copy saw. A live page reports its drafts once, before any edit; a
  later report from it is ignored. Writes are serialized, and the page is told a draft is saved only once the
  workspace-state update settled. Restored text reaches no model until a new explicit Send.
- **Nothing is judged before the roster is loaded.** The host restores the roster only after it has registered
  the chat views, while VS Code restores a Workbench tab as soon as its serializer is registered. Until the roster
  is loaded, no chat page drops a draft as belonging to a missing agent, the Workbench's start report waits, no
  draft is copied or seeded, and no tab is offered for reopening. A roster that was refused (a stored route the
  host will not start) or failed to load is not taken for an empty one: nothing is dropped or forgotten, recovery
  stays off, and nothing is copied, until a later start loads the roster. Agents created meanwhile do not change
  that, and the composer says that a draft has no saved copy.
- **Which CLI program is started is the user's choice.** The new `unode.claudeCliPath`, like `unode.codexCliPath`,
  is an application-scoped, authority-bearing User setting. A workspace or folder value is ignored and reported,
  it is a restricted configuration in an untrusted workspace, and a team file or an agent message cannot set it.
  It must be an absolute path. The host executable resolver resolves it like any host program: an existing file,
  links resolved, never inside a workspace or worktree. A native program starts without a shell. npm's `claude.cmd`
  is started, as before 0.9.96, only through the validated `cmd.exe` route: one quoted token, and now also refused
  when it contains `%`. With the setting empty, the lookup UnodeAi used before is kept, so no user is moved to
  another installation, and host programs such as `taskkill` keep resolving apart from the Claude program.
- **Listing programs starts none of them.** Check / choose CLI finds Claude and Codex programs from the file
  system alone: npm's package and launcher, the native installer, a copy that comes with an editor extension, and
  absolute PATH entries. It starts only the program the user picks: once with `--version`, and for Codex also
  `login status`, as before. Each run starts in a host-owned folder, with Anthropic or OpenAI credential variables
  removed, bounded to 15 seconds and 64 KiB of output. That folder is prepared in extension storage and refused if
  it is inside a workspace folder, as written or after links are resolved, compared by whole path segments (a
  folder named `..cache` inside the workspace is inside it); if it cannot be prepared, no check runs, and no
  program starts in the extension host's current directory. A different program is saved only after
  the user confirms it, only if the setting did not change meanwhile, and only if the chosen path still starts the
  same program file that was checked: a launcher or link pointed elsewhere, or a file replaced, while the user
  decided is refused. The window closing stops the flow. Choosing a program is not network
  consent: Codex's path-bound consent still applies to a new program, and Claude's egress and repository approvals
  are unchanged. It starts no agent, stops none, and grants nothing. Codex keeps its version floor and refuses a
  prerelease, as before. A `--version` run is still a program running, and nothing here claims it makes no network
  request.
- **Update instructions run nothing.** They name the installation UnodeAi starts. The command is fixed: npm's
  global install of the CLI's own package, or the native installer's own `update`. A program path is quoted for
  the user's default shell (PowerShell, `cmd.exe` or a POSIX shell), and the command is refused where the path
  cannot be quoted. **Update in terminal** opens a new terminal, with the shell the command was written for, in the
  same host-owned folder rather than the workspace; without that folder it opens none. It types the command there
  without pressing Enter. Starting the terminal starts that shell with the user's own startup files and trusted
  terminal settings; the update command runs only when the user presses Enter. **Copy the update command** puts
  the same text on the clipboard. UnodeAi itself runs no installer, updater or package manager. The command
  updates whatever npm the terminal finds, under the user's own npm configuration, environment and PATH, which may
  not be the npm that installed the program UnodeAi starts; npm's global install does not read a project `.npmrc`
  in any case. UnodeAi therefore asks the user to check the program again, and claims no repair until a check
  shows it.
- **The latest published version comes from npm, only with consent.** Check / choose CLI and Update instructions
  ask `registry.npmjs.org` for the public `latest` document of the CLI's npm package (`@anthropic-ai/claude-code`
  or `@openai/codex`). The request goes through the consent-gated metadata fetch:
  - the host is offered, unticked, in the existing metadata consent prompt;
  - a declined host is not asked about again in that session;
  - a grant is listed in the Security panel and can be revoked there.

  Nothing is looked up at activation or when Settings opens. The request is a GET with no key, cookie, prompt or
  workspace content. Redirects are refused, and it is bounded to 8 seconds and 256 KiB. Only a release version of
  that same package is kept, with its time, and a lookup is reused for ten minutes. The version is shown beside
  the measured one; it never chooses a program, and nothing is installed.
- **Provider errors are text.** From a provider error saying the CLI is too old for a model, the host takes only
  the two version numbers, by one fixed pattern, for a host-written line and a notice with the two actions. Its
  suggested command, link or path is never acted on, no other error is taken for an old CLI, and the failed turn
  is not resent.
- **Codex's project trust stays inside the project (corrected; since v0.9.84).** When an agent's working folder
  is below the project root, the host gives Codex a process-local `projects` override that names the root, the
  working folder and each folder between them, with the trust level of the user's choice: `trusted` for **Trust and
  load**, `untrusted` for **Continue without project automation**. The walk up from the working folder stopped
  when a folder was spelled exactly like the root. On Windows the root is the physical path, which starts with
  `C:`, while the working folder keeps the editor's spelling, which starts with `c:`, for example a worktree under
  `.unode\worktrees`. The walk then never met the root and went on to the drive root, so with **Trust and load**
  every folder above the project, up to `c:\`, was marked trusted for that Codex process. Codex could then load a
  `.codex` configuration from one of those folders as a project layer. The configuration check before every start
  inspected `.codex` folders up to the drive root, the user's home excepted, and bound the approval to the digest
  of everything it inspected. Its dialog, however, shows a bounded summary of at most 24 entries, not an exhaustive
  list of locations or automation, so such a configuration was not necessarily shown on its own. Either way it
  belonged to no workspace. Now the walk continues only while a folder is strictly inside the root, compared by
  path identity: by whole segments, and on Windows without regard to case. No folder above the root is named, and a
  working folder whose name starts with two dots, such as `..agent`, gets its own entry, so Codex no longer writes a
  trust entry for it into the user's `config.toml`. The same whole-segment comparison now decides the Folder Access
  warning about a read-only folder inside a writable one (the grants themselves are unchanged), the check of the
  folder CLI programs start in, and the check of the Codex model loader's folder.
- **A Codex approval card's Shell line comes from the host.** The last line of a Codex command card names the
  shell the host derives from the command itself, the one its command policy checked, in a field of its own, after
  the command. The reason Codex's model gives for a request is not shown on a command card or in the Team summary,
  so a model-written `Shell: …` line cannot pose as the host's. Approval stays single-use.
- **A Codex model list and thread belong to their program.** Account model lists are kept per program and version
  (eight programs at most); another program's list, a list from an older version of the same program, or the
  0.9.95 list keyed by version alone is not offered. A refresh captures its selection (the setting, the program and
  the identity of its file) before its version and login checks. It confirms it again before consent, synchronously
  right before App Server is spawned (after the loader has prepared its folder, with nothing awaited in between),
  and before saving. A selection that changed, a closing window or a changed workspace starts nothing more and
  saves nothing. A check is kept only for the program file that was checked: once the file is replaced or
  a link is pointed elsewhere, its version and the cached list are no longer offered until it is checked again. A
  saved thread now names its program, and is not resumed in another one; a snapshot from before 0.9.96 names none
  and is resumed as before. For Codex, the resolved program is saved, not a link to it.
- **The observed model is evidence, not a setting.** The model a CLI reports in its own start event is shown
  beside the requested one. It is never taken from the requested model, and it is forgotten with the process.

No dependency was added. One network destination was added, `registry.npmjs.org`, reached only as described
above, after consent. The manifest gains one activation event, `onWebviewPanel:unode.workbench`, so UnodeAi starts
when VS Code restores a Workbench tab, and one setting, `unode.claudeCliPath`. A Test-mode probe for the extension-host test is returned only in VS Code's Test mode, and
refuses any other caller.

**v0.9.95 Exact-file scopes, restored conversations and reviews of workspace files.** This release corrects
boundaries that said one thing where they were granted and another where they were enforced. It widens none.

- **A scope entry that names a file is that file and nothing else.** Folder Access and a task scope are compiled
  once, when they are admitted, into grants that keep whether each names a folder or a file. A file grant gives
  no sibling, parent or child path, no listing, no search, no folder delete and no command working directory. It
  is checked again at each use: if a link on its path leads elsewhere, or something else holds its name, the
  file is refused. A scope without a writable folder has no command tool, and a command is never sent to the
  path base instead. Workspace Trust removes write authority from a file grant as it does from a folder. A
  delegated task scope and a coordinator's own contract scope go through one intersection, which can only
  narrow. These grants are enforced by the host's own file tools, so they apply to OpenAI-compatible agents; a
  Claude CLI or Codex CLI agent is not given one, and an agent whose Folder Access names files only is not
  started.
- **Restored history is not a live instruction.** The host records that an agent has a request before it hands
  the request to a backend, and records the end only when it has seen it. If that record cannot be stored, the
  request is not sent. On restore, an OpenAI-compatible conversation is continued up to its last answered
  request; a request without an answer is kept apart as bounded host evidence (at most 50 messages and 256 KiB,
  without images) and is never sent to a provider. A Codex CLI conversation is kept by Codex and cannot be
  inspected, so it is resumed only when the record says the host saw its last request end; otherwise, and for
  one an earlier version saved without that record, the agent starts a new Codex conversation. The log of this
  holds counts and reason codes, never message text.
- **A review of a workspace file is closed only against the file that was dispatched.** The host keeps a
  SHA-256 of the file's bytes and its physical path from the dispatch, privately: neither enters the task card,
  a grant, an evidence record or a portable export. Before a close is recorded it reads the file again, so an
  edit made outside its own tools refuses the close as well.
- **A refused file change is counted.** The host keeps, as a count per attempt and never as a path in a record,
  the file changes it refused and the agent did not make. An attempt with every such change refused is not
  reported as complete. Inside a turn a file is one file however a call spells its path, and it is identified
  the way the file tool itself resolves it; a path outside the agent's writable folders is compared as text and
  is not looked up on disk.
- **No write goes through a link whose target does not exist.** This closes a way out of a writable folder
  that earlier versions had. A symbolic link inside the folder, pointing at a file that did not exist, resolved
  to nothing, so the write check fell back to the directory holding the link, which is inside; the write then
  followed the link and created its target wherever it pointed. The host's file tools now ask whether something
  holds the name before they fall back: if it does, nothing is written, edited or deleted through it. A link
  whose own text points out of the root is refused as a workspace escape, as a live link is; any other fails,
  because the host cannot show where it leads. The resolver used for checkpoint restore, the rules file, shared
  memory and project knowledge refuses the same link. This covers the host's own file tools and its own writes.
  Claude CLI and Codex CLI write files themselves, under their own sandbox and permission rules.
- **A restarted Claude CLI coordinator reaches only its own team tools.** Each launch of a Claude CLI
  coordinator now gets a loopback team-bridge server of its own, with its own port and random token. Before, the
  host shared one such server between launches. A launch that started while the previous process was still
  exiting (an Agent Builder save restarts the agent this way) received that server, its token and the previous
  launch's team tools, and kept them for as long as it ran. There, every dispatch and close was refused, because
  those tools belong to a launch that is over. The other team tools ran with the previous launch's settings. For
  example, `run_checks` used the verification command and command policy the agent had before the edit, still
  behind command approval. Now an old process reaches only its own launch's tools, where its late dispatches and
  closes are refused, and its server closes with it.
- **A command is not a task check, and a refused call is not a run.** For a delegated task that declared no
  check, the Job outcome used to count the last command its agent ran as the task's check. A command that exited
  0 read `Task checks passed`, and a call the host had refused was recorded as a run that failed. Now a refused
  `run_command`, `run_checks` or Bash call records no run and replaces no earlier one, and only a check the task
  declared counts. A refusal that Claude CLI makes on its own reaches the host as an ordinary error, and is
  still recorded as a failed run.

**v0.9.94 Request summary, request limits and reviewer evidence.** This release records what each turn did and
adds one optional stop that the person decides. It adds no authority to act. When a turn that hands control back
ends, the host freezes one closeout record, and Chat shows a Request summary card projected from that record and
from the spend records. The card is display only: the host writes every word of it, the webview puts that text
on the page as text, nothing on it is read from an agent's reply, and showing or opening it runs nothing. The
record is never sent to a model. **Request limits (§3):** `unode.requestLimits.providerTurns` and
`unode.requestLimits.tokens` are authority settings 44 and 45 (User Settings only, restricted in untrusted
workspaces), so a repository can neither raise nor remove a limit. A limit can only hold or stop work. At a
limit the host holds the next step it controls, and a card on the approval surface asks **Stop request** or
**Continue request**. Only a person's click on Continue continues. An unknown action, an answer with no person
behind it, a card that cannot be shown, no answer within 15 minutes and shutdown all stop the request. Continue
is not an approval: the held step then meets the same Workspace Trust, scope, policy and approval gates as it
would without a limit. On the Claude CLI and Codex routes the host counts the turns it starts. It can neither
count nor hold the model requests the CLI makes inside a turn, nor Codex's own commands and file changes, and
the card says so. Limit state is held in memory and ends with the window. **Reviewer evidence:** `read_file` can
return numbered lines, and a numbered read and every `search_files` result begin with a short receipt the host
issues. An agent that holds an admitted review task can close it with citations, which the host checks against
the receipts of that same attempt and refuses when they do not hold. The check proves that the cited lines were
displayed to the reviewer, not that a finding is right. This gives the holder of a review a way to close it and
no read, write, command, network or approval authority. A search now ends after 20 seconds or when its caller
cancels. **Reference prices:** a price list can declare a second name for one of its rows. The names are part of
the shipped lists; a refreshed list cannot declare one. New stored state: the closeout records, in workspace
state, for the last 100 such turns of each agent and for every turn its conversation still shows. A record holds
ids, times, counts, route and model names, and the workspace paths of files the host recorded a write or a
delete for. It holds no message text, file content, command line, key or endpoint. The run ledger gains a
count-only record of a review's evidence. No network destination, command path or dependency was added.
**Stored conversations:** a stored model conversation is given only to the kind of backend that wrote it, and
one that is not taken is discarded before the backend starts. Before this release an agent changed from Codex
CLI to an OpenAI-compatible connection sent Codex's stored thread reference to the new provider (audit log).

**v0.9.93 Job outcome, a coordinator's first action, and one command path removed.** This release shows what a
team job did, and changes little about who may act. When a coordinated job closes, Chat shows a Job outcome card
projected from the run ledger and the spend records. The card is display only: the host writes every word of it,
the webview puts that text on the page as text, and nothing on it is read from an agent's reply. A card's action
is decided in the host, which runs it only for a card this chat shows and only when that card offers it.
**Continue unfinished work** starts a new request of the person: the host composes the text from typed facts of
the run, shows it in a dialog whose first button is **Not now**, sends it only when the person confirms, and
never puts it into a turn that is running. The only model-written text that can enter that request is the
target a dispatch named, flattened to one line and cut at 80 characters, and the person reads it before it is
sent. **One execution path is removed (§3):** Generate Evidence Report used to run the workspace's verify
command; it now formats stored facts and runs nothing. **On the Claude CLI route (§3)** the coordinator's
team-bridge entry carries `alwaysLoad`, which puts that one server's tool definitions into the first request. It
grants nothing: the tools, the allow list and the gates are the same without it. The managed-integrations bridge
and the Skill-action bridge now each have a local server of their own, with its own port and token, where a
coordinator's shared the team bridge's; a bridge therefore lists only its own tools. All three stay on the loopback address
with a random token per start. (Corrected in v0.9.95: the team bridge's server and token were shared with a
coordinator launch that was still exiting, so they were not new on every start until v0.9.95. See the v0.9.95
entry.) A coordinator's request that reaches no dispatch, close or reply while its model
is silent for 60 seconds is ended by the host, and a card offers a retry, another route or a stop; nothing is
retried or switched without the person, the limit holds only before the first action, and it does not run while
a tool runs or an approval waits. On a team with teammates, a dispatch whose target matches none of them is
refused; before, under `delegate-preferred`, it authorised the coordinator to do the task itself. New stored
state is content-free. In the run ledger: a run's opening and closing turn ids, the basis of a close the host
made, and a typed retry link between two attempts, validated at dispatch and again on restore and dropped with a
recorded reason when a rule fails. In a chat's workspace state, per card: the run id, the coordinator id, the
turn the card follows and the close time. Portable Run Evidence becomes `portable-run-evidence/5` with the retry
link's two fields, a task handle and one of two fixed words, and its `retained` declaration now states that its
timestamps are UTC. No network destination, setting, repository input or dependency was added.

**v0.9.92 turn timing, waits for a person, and command corrections.** The host times each turn on one clock and keeps the time a person takes to decide
out of it; to do that, every approval and every blocking dialog now runs inside a wrapper that pauses the
requesting agent's clock. The wrapper returns the dialog's own result unchanged, and if it fails before the dialog
is shown the call rejects, which every caller treats as not approved. **One approval was raised for no agent, and
is corrected:** the write approval of an OpenAI-compatible or custom-gateway agent carried no agent identity, so
the v0.9.88 statement below that such a card is withdrawn on Stop was not true of it. The card stayed open after
the agent was stopped, until its 15-minute window ended, and an approval given in that time still wrote the file
the person saw in the diff. It now names its agent and is withdrawn with it (Audit log, v0.9.92). Capability
defaults change for seventeen
built-in roles: a new or explicitly reset/saved System Architect, and sixteen roles that verify or calculate what
they deliver, may request command execution, because a role holds the tools its own work needs (Owner decision,
2026-10-02). By the same decision the four roles that were read-only by tool list (Reviewer, Application
Security Engineer, Privacy & Data Protection Officer, GRC Analyst) may write files, so that they can write the
review or report that is their deliverable. No built-in role is read-only by tool list any more: that a reviewer
does not edit the work it reviews rests on its instructions and on write approval where the user enables it.
This does not pre-approve a command or widen an existing saved agent. Workspace Trust, folder/task scope, command
policy, approval and catastrophic-command blocking apply unchanged; no consent, scope, route or retry decision
changes. Three other things change about commands on OpenAI-compatible and custom-gateway agents (§3): a
command starts in the same working directory spelled with an upper-case Windows drive letter; a foreground
command may run for up to ten minutes when the model states so (it was a fixed two); and `check_command` may wait
up to five minutes for a background command the agent already started. None of these adds a command, widens a
root or skips the command approval, which runs first as before. One description the model reads became less
restrictive in its advice: `dispatch_task` now tells a coordinator to leave the optional per-task folder ceiling
out for an ordinary task. The enforced boundary is unchanged, the worker's own Folder Access, and the ceiling was
already optional; a coordinator that follows the advice narrows fewer tasks below that boundary, and parallel
tasks without a ceiling claim no files (a stale write is still rejected). New stored state is content-free: each
ended turn's timing, ending and spend-unit id in the run ledger (schema v10, excluded from Portable Run Evidence),
the phase breakdown on a turn's final transcript message, and on a finished tool card the number of milliseconds
a person took to decide while the call was open. No network destination, setting or repository input was
added, and no dependency of the shipped extension changed. One development tool was upgraded because of an
advisory published during the release audit: the packager `@vscode/vsce`, from 3.9.2 to 4.0.0 (§8).

**v0.9.91 typed tool results, and a separate tool gate for each Claude agent.** This release fixes one security
defect and changes how results are recorded, not who may act. **The defect:** since v0.9.28, Claude CLI agents that
shared a working folder wrote their PreToolUse hook wrapper, hook settings and MCP config to one shared path under
`.unode/`. Claude reads the wrapper at every tool call, so the agent started last replaced the other agents' gate with
its own, and their tool calls were approved or refused by the wrong agent's policy and scope. When that agent
stopped, it deleted the wrapper the others still used, and their hooks failed open: the tools ran without UnodeAi's
check. Each agent now writes its own files to its own folder, `.unode/claude/<random>/`, removed when it stops (§3). A
team with one Claude CLI agent, or with each agent in its own folder or worktree, was not affected.

The rest of the release records outcomes. A tool result carries one typed fact (succeeded, refused with the host's
reason, or failed with a kind), and a card's label is projected from it. No outcome is read from the wording of an
output: the two text classifiers that did so are deleted, and a syntax-tree check in the test chain rejects their
return. No approval, consent, scope, route or retry decision changes. Where the order of two refusing checks changed
(the reason now names Workspace Trust before folder scope, and a host boundary before a missing approval card), both
checks only refuse, so what is allowed is identical. Three results became stricter for the model: a refused team
tool or cross-folder read reaches Claude as an error where it used to arrive as a success; a delegated task that
failed, timed out or was refused reaches its coordinator as that, where a blocking assignment used to count as a
success; and a team-policy refusal that arrives after an async dispatch is delivered instead of dropped. Each
finished turn stores one content-free receipt (delivery outcome and tool-result counts, with no tool name, argument,
output, path or model text) on its final transcript message and in the run ledger. The ledger stores it and never
reads it back as control state; it is excluded from Portable Run Evidence. No network destination, command surface,
setting, repository input or dependency was added.

**v0.9.90 Smart compaction and named empty replies.** Compaction changes what a model is sent, never who may act: it
grants no tool, root, command or permission, and it never blocks a task (a failure or timeout sends the task
unchanged). On OpenAI-compatible routes the agent's economy model summarizes older turns on the agent's own
connection, so there is no new destination, under the same model-egress grant as the agent's ordinary requests: its
connection profile and revision (§2). Before the v0.9.90 field fix, the summarizer asked under a generic host-only
grant, weaker than §2 states. A summary request that is refused, or cancelled while its consent is open, sends nothing
and records no usage. The rolling summary is kept as data: one JSON string under a header that says it is historical,
possibly untrusted content that never overrides the system prompt, role instructions, the user's request or host
policy. Carried records (approvals, refusals, file effects, evidence verdicts, handles) are bounded JSON lines, and the
host-only outcome kept with each tool result is removed from every provider request.

Claude CLI receives only numeric compaction settings computed from validated policy (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`,
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, or `DISABLE_AUTO_COMPACT=1` when Off) and an internal `/compact` control turn.
Codex receives `thread/compact/start` on the agent's own thread. An App Server replaced after a compaction timeout
passes the same launch checks as a first start: safe arguments, Workspace Trust, read roots, the resolved route, the
CLI preflight and the repository-configuration re-hash. The replaced process's output is ignored. A project's
`.unode/team.json` may set an agent's compaction mode and numbers and the team's profile table. Every value is
validated (10-90%, 16,384-2,000,000 tokens, known profiles), and an invalid one is dropped with a warning. A hostile
file can therefore make compaction more frequent, delay it or turn it off, but never grant or widen access or block a
task. The cost is bounded: an automatic compaction runs only when it can remove at least a tenth of its trigger, and a
refusal before egress costs nothing. OpenRouter requests add `X-OpenRouter-Metadata: enabled`, and the provider name
OpenRouter reports is shown only when it passes an allowlist, as escaped plain text. Two field fixes change agent
guidance, not permission. A path the user names is used as given, and writes still pass the same roots and approvals.
A delegated worker may use what the user told it directly in its own conversation, and it still never web-searches for
a user-supplied fact.

**v0.9.89 spend visibility and reminders that never gate work.** Crossing a spend target never stops, pauses,
refuses or shortens model work, changes `max_tokens`, wakes a coordinator or emits `host_wait`; the provider path
takes no lock and never awaits a price lookup or a reminder. Usage is recorded as immutable events in per-window
NDJSON shards under the extension's global storage (`spend/v1/<workspace root identity>/`), fsynced before any total
or reminder uses them. The records hold ids, token counts, integer nano-dollar amounts, cost-basis labels and
opaque price-source ids; no prompt, output, path, key, login or credential fingerprint. A reset appends a new
counter epoch and never deletes a record; Repair never edits one; control from a newer schema is never
overwritten. Reminder state is a series of revision files, each published once by exclusive create, so a window
whose maintenance-lock lease ran out while it was stalled cannot write over newer state. A spend alert is a detached dialog (`check:modal-safety` requires `void` and the chime), and **Stop this
request** is single-use and bound to the request that crossed the target.

Prices come from labelled sources in a fixed order, and only billed amounts, exact user or account-route prices and
a reference the user explicitly chose can drive a dollar reminder. A public `usable_group`/`group_ratio` list, an
`Authorization` header or a stored key alone never becomes an account price; an account price is bound to one
connection and key generation, and a key change in any window drops it and any in-flight result for the old key.
The undated built-in price table is gone: two dated reference catalogs captured anonymously on 2026-09-27 ship
digest-checked, and a user-initiated refresh (see §1) sends no key and refuses redirects. `unode.spend.targets` and
`unode.spend.referencePriceMode` are authority settings 42 and 43 (user settings only, restricted in untrusted
workspaces). A repository's `.unode/budget.json` is parsed strictly (no duplicate keys, 64 KiB, strict UTF-8, must
resolve inside the project), and it has no effect until the user accepts that exact content digest; it can then only
lower a reminder the user already enabled, and it can never enable a reminder, choose a reference, reset a counter
or make a sound.

Two field fixes change no permission. The F7-21 progress token that lets an agent poll a changing background
command is host-only: it is not in the tool schema and nothing the model sends can mint or override it, so an
unchanged or forged poll still trips the repeat limit. The read-root note tells agents which confirmation-gated
local root they may ask to read and says it is not a grant; tools, read and write roots, shell scope and portable
evidence are unchanged, and untrusted workspaces get no note.

Path spelling (release-stress finding S1). Where UnodeAi compares a path it resolved against one it was given, both
sides are now physical (the native realpath), so VS Code's lowercase drive letter, a junction or an 8.3 short name
cannot make one file look like two. No boundary widens: the containment checks themselves are unchanged; a link to
a configured folder outside a task's scope is still refused (as a recoverable task-scope gap, as designed, rather
than an escape); HOME's `.codex`/`.claude` stay excluded from repository inspection under either spelling; and the
Claude launcher's safe-argument rule is unchanged (a skill plugin in an 8.3 temp folder is passed by its long form,
or skipped as before if that fails the rule).

**v0.9.88 one decision per approval, exact content only when delivery is known, and an attention chime.** One
host broker (`ApprovalDecisionBroker`) now settles every approval, card or native modal, on all three routes. A
prompt settles once, on the first human answer, its 15-minute window, or disposal; every later answer is dropped
in the broker before it reaches an approver or a side effect, so a modal answered after its window saves no
project command approval, no approve-all-writes grant and no web or tool memory. Side effects apply only to a
human settlement, and a withdrawn wait records no permission decision. **Stop** withdraws that session's waits with
a denial before the backend is released, and a prompt shared by another session stays open for it. The Claude and
Codex backend timers remain as a last-resort net five seconds after the broker's window. This closes the v0.9.87
known limits: OpenAI-compatible command and write cards now have a human window and are withdrawn on Stop, and the
waiting state is published only while a prompt is really open.

Content a coordinator publishes from a content receipt renders verbatim from a typed span, and no path is stored.
A receipt covers exactly the whole lines the host placed in the model-facing result, receipt line first, and is
publishable only when the host knows the model received it: the OpenAI-compatible host sends it itself (reads are
now sized to its 24,000-character model-input bound); Claude CLI must report an exactly equal files-bridge
`read_file` result in stream-json (probed: the CLI reports its own replacement of an oversized result, which never
matches); Codex CLI does not report what its model saw, so the model must return a random check code from the
result's last line. That confirms the start and the end only, not the middle, and the manual says so. Codex
coordinators get a host `read_file` that cannot widen the sandbox: read only, no write roots (the constructor would
otherwise make its root writable and readable), exactly the turn's read roots, the task scope's path base, refused
when untrusted or in Plan mode, rebuilt each turn. Workers do not get it. A turn trigger is accepted only from the
host's own `unode` wake, never from model prose or another sender. A send that is not acknowledged is never resent.

The attention chime is synthesized with Web Audio in the chat webview: no audio file, no egress, no process spawn,
and the webview's Content Security Policy stays `default-src 'none'`. Only a random opaque id of at most 64
characters crosses to the webview and back; the prompt key, which can hold a local folder path, stays in the host.
The sound never delays a prompt or throws into it. `unode.attentionSound` is the 41st authority setting: read from
user settings only and restricted in untrusted workspaces, so a repository cannot silence it.

*Release audit evidence (Claude, 2026-09-27, candidate `00cec9a`).* Claude implemented this release and Codex
audited it three times: the implementation (approved for the field test at `5e3bd9c`), the fixes made during the
field test, and the fix for its finding on those (approved at `4628af8`). `00cec9a` is `4628af8` plus two test
fixes and no product change: an assertion on a random receipt id failed about 1 run in 16, and a fixed 5 ms sleep
could lose to a loaded machine; together they failed one CI mutation baseline. Clean worktree at `00cec9a`, `npm ci`
first:
- **Gates:** build, doc gates, `tsc` and lint pass. Release gate: 3,423 tests, 3,422 passed, 1 documented skip.
  e2e: 19 passing / 2 pending, plus 1 (folderless). Bundle: 102 files, 2.15 MB; smoke 2, and 7 passing / 1 pending.
  Canaries 27/27. Focused mutation 124/124, including 47 new v0.9.88 mutants (among them: a late modal answer
  reaching persistence, Stop releasing before leaving, a pending receipt published, a receipt activated without
  exact equality or by another tool, the Codex `read_file` keeping a write root or ignoring the turn's read roots,
  a Codex receipt without its check code, the internal attention key sent to the webview, an unclassified modal
  passing the gate, a stopped run left open or a settled one closed by the host, a read card dropping a file line
  that looks like a receipt line). `npm audit` 0/0. The release commit differs from the candidate only in
  documentation.
- **Live probes** (Owner-approved, ephemeral): Claude CLI 2.1.209 and Codex CLI 0.155.1 as recorded in the design,
  §5.5; the chat webview's audio in VS Code 1.139.1 stays `suspended` with no gesture, as recorded in §5.11.
- **Field** (Owner, VS Code, two rounds, final package `1b28917`; Cursor step 4): every design §8 step passes. The chime
  played when an approval card and a model-network consent dialog appeared and never on the answer; with the setting
  off it was silent. Stop removed a pending command card and the command never ran. Round 1 found five defects, fixed
  in `3e214b7`, `0b09bb7` and `1b28917` (a stopped run never closing, cards placed at first render, receipt lines on
  read cards, a roster label that did not expire, a closeout reaching its card only after a reload). None widened
  any permission.
- **Codex's audit of the field fixes** approved them but one: the read-card fix recognised the receipt and check
  lines by their shape, so a project file could hide a look-alike first or last line from its tool card (display
  only; the model's text was unchanged). Each receipt read now returns its own card text, and nothing is recognised
  by shape. Tests on all three routes and three focused mutants cover it. This fix (`4628af8`) and a change that
  stops copying the run ledger on every change (`fc33ead`) came after the field package; Codex judged that they
  need the final gate above, not another field round.

Known limits: on Codex CLI an exact-content block confirms only that the model saw the first and last lines of the
read. The chime is silent until the person has typed or clicked in a visible chat view since it opened, and it never
plays in a hidden one. A Codex coordinator's `read_file` takes the turn's read roots at its first read, so a Folder
Access change made during a turn applies from the next turn (Codex's own sandbox is fixed per turn as well).

**v0.9.87 integration results, saved-team permission restore, and bounded rework.** Managed MCP responses with
`isError: true` are typed `integration_error` failures on every backend route even when the server stayed
responsive. They do not quarantine the connection, but repeated identical failures count toward the
OpenAI-compatible anti-spin breaker, and Marketplace evidence records the call as exercised, not succeeded. Non-text
MCP content is summarized by type, URI, media type and decoded size instead of inlining bytes; a structured-only
response is framed and bounded. When a managed stdio server exits while connecting, the failure reason carries a
bounded stderr tail (20 lines / 2 KiB, rolling from spawn), shown as plain text only. Values resolved from
SecretStorage placeholders are redacted from it, including a value split across process chunks; ordinary
environment values such as `DEBUG=1` stay readable.

Saving a team to This project records the exact file SHA-256 plus its physical file identity in extension-owned
global state; deleting that save removes the record. A project team file still loads through the project-file
validator with every widening permission removed. Restoring permissions always needs a person's decision:
- **A recognised save** (same bytes at the same path) offers one team-level confirmation that lists each agent's
  permissions.
- **Any other file** (a changed byte, a copy, or a cloned repository) opens a per-agent review with every option
  unticked. For pre-0.9.87 saves without a skills list, it offers the primary skill plus the role template's skills.

Either way, the restore changes only skills, tools and playbooks, agent by agent. It drops grants the route cannot
load, caps tools to the file's own declaration, and keeps Codex agents bounded with ask-for-approval. It does not
re-validate unrelated settings, so a legacy `temperature` on a Claude CLI agent no longer blocks it. Route capability
compatibility is still enforced when each agent's backend starts (`assertAgentCapabilityCompatibility`), so a
restore cannot run a tool its connection does not support. One failing agent stays read-only and is named; the
others keep their restored permissions. The repository file itself never grants authority.

Delegated progress is host-observed: provider requests count steps, streaming refreshes activity, and elapsed,
waiting and stalled labels are derived locally. A stalled label grants no cancellation, retry or other authority.
On the OpenAI-compatible route, command, write and public-web approvals now report "Waiting on your approval" around
the unchanged approver call; approval semantics did not change. A `needs-rework` decision sends a real worker turn
that counts as live delegation work. Its reply reaches an idle coordinator through the existing async-result wake,
so the PM reviews it and reports to the user. That wake makes an unattended PM–worker loop possible, so at most two
rework requests per delegation handle are sent after the user's last message. A third is recorded but not sent, and
the host closeout says so. Only a message from the user re-arms it; the host's own wake does not. The save-scope
choice is a modal with two destinations and VS Code's single Cancel, and every non-destination result writes
nothing.

*Release audit evidence (Claude, 2026-09-26, candidate `2b77988`).* Clean worktree, `npm ci` first:
- **Gates:** build, doc gates and `tsc` pass. Release gate: 3,298 tests, 3,297 passed, 1 documented skip. e2e: 17
  passing / 2 pending, plus 1. Bundle smoke: 2, and 7 passing / 1 pending. Canaries 27/27. Focused mutation 77/77,
  including three new v0.9.87 mutants: fingerprint location ignored, unrecognised save skips review, rework never
  capped. `npm audit` 0/0.
- **Real code path** (guided-form parsing, placeholder resolution, `MCPHub`, the SDK stdio client). The v0.9.86
  field mistake, environment text entered as an argument, now reports `Cannot find module '…UNODE_MCP_FIXTURE_TOKEN=
  ${UNODE_FIELD_TOKEN}'` instead of only "Connection closed". A SecretStorage value printed by the server appears
  as `[redacted]`, while `DEBUG=1` and `port 3001` stay intact. A healthy server still mounts.
- **Field** (Owner, VS Code, PelagoWebsite two-folder workspace):
  - The unticked review restored write for a pre-0.9.87 save.
  - A recognised save restored all seven agents, including two Claude CLI agents carrying a legacy `temperature`.
  - A worker created and read back a file.
  - On the OpenAI-compatible route, the file-write and command approvals reported "Waiting on your approval" (3 s and
    4 s).
  - A rework reply woke the PM, which reported the final two-line file without user input.
  - The save-scope modal, the single Create/Save/Load entry, delete from the unified list, and the Dashboard order
    all behaved as described.
- **Not run live:** an `isError` result through the real Claude and Codex CLIs. The failure mapping sits in the
  route-neutral `MCPHub`, and each route's failure transport was verified live on the real binaries in v0.9.86.

Known limits: OpenAI-compatible command and write approval cards have no human window and are not withdrawn on Stop.
The approver's silent paths (a session-approved command, a remembered web decision) briefly flash the waiting state;
both are planned for a later release. The v0.9.86 forced closeout has still not run through a real Anthropic-translating
gateway.

**v0.9.86 managed-MCP cancellation, identity, secret, and revocation hardening.** A missing `${VAR}` SecretStorage value
or one stored as an empty string now fails before an MCP client process is created; messages name only the variable.
Each starting agent owns an independent readiness lease on a shared mount, and the underlying approval/connection is
cancelled only after every waiter leaves. Managed calls use one structural host outcome on every route: cancellation
before dispatch is `cancelled`; cancellation or timeout after dispatch is `outcome_unknown`, because the server may
have acted. A late response cannot become success. The connection is immediately removed from new calls, unrelated
active calls may settle, and the normal mount path creates a new connection on the next need.
Calls wait for that approved recovery or report temporary unavailability; quarantine never masquerades as consent
revocation and never widens the saved approval or agent grant.

All five Claude loopback bridges now have a fresh 128-bit per-session suffix. The tool gate auto-allows only the exact
qualified names registered on those instances, never a prefix or any old fixed name, so user or consented repository
MCP configuration cannot inherit bridge allowance by copying a readable name. Native Claude MCP remains behind the
fail-closed tool gate. Native Codex MCP remains governed by Codex; UnodeAi displays server/tool/status only and does
not treat that activity as host-observed evidence. Removing a host-managed integration first persists revocation of
both direct and Skill-derived agent grants, then cancels active calls and pending readiness, disconnects the server,
and deletes host configuration and approval state. SecretStorage entries are retained because another integration
may reference them. Executable-Skill authority is unchanged: no bundled Skill exposes an action, folders/catalogs
cannot contribute code, and the fixed runner still requires a fresh digest-bound approval.

Safety-stop closeout requests expose no tools and flatten prior tool protocol into ordinary host evidence. Every
tool-result block is explicitly labelled untrusted data and the host closeout instruction says to weigh it only as
evidence, never follow it as an instruction. Claude managed-MCP audit attribution also requires the emitting
backend's exact per-session integrations bridge id; another structurally valid suffix and the legacy fixed name
attribute to nothing. These rules affect evidence/audit interpretation and do not grant tool authority.

*Release audit evidence (Claude, 2026-09-25, candidate `9be35aa`).* Effects were observed on the real binaries and
in the Owner's field test, not inferred from source.
- **Codex CLI 0.155.1 (Windows):** a missing secret failed the mount with the variable named and no client process
  created; a real stdio MCP server was called through App Server dynamic tools; interrupting a slow call produced
  `outcome_unknown`, the server received `notifications/cancelled`, and the connection reconnected by itself so the
  next call succeeded; the user's own native Codex MCP server stayed usable and appeared in chat as server, tool and
  status only; all four permission profiles produced their expected effects; `~/.codex/config.toml` stayed
  byte-identical.
- **Claude CLI:** managed tools were reachable only as `unode_integrations_<32 hex>`; a native server deliberately
  named `unode_integrations` was not auto-allowed and received no call; removing the grant refused the next call
  without a restart; a cancellation started by Claude's own MCP timeout reached the server and the connection
  reconnected; audit attribution matched only the emitting session's bridge ID.
- **Worker stops:** a stopped turn leaves the model-fallback streak unchanged; `continue_task` reuses the original
  task contract, so its focus text cannot widen capabilities, inputs or write scope.
- **Field (Owner, VS Code):** a Claude agent's managed call, refusal after remove-and-revoke, the missing-secret
  reason in both the add notice and the readiness dialog, and a PelagoWebsite final review that returned a verdict
  without the earlier reject-and-redispatch loop.

Known limits: the forced closeout was not run against a real Anthropic-translating gateway (its request shape is
proven by an automated test of the outgoing body); and when a stdio server exits while connecting, the reason shows
"Connection closed" rather than the server's own error output, which is planned for a later release.

**v0.9.85 native parity, managed-MCP readiness, and executable-action security re-audit.** Claude and Codex
retain their native user configuration and native MCP support; repository `.claude`, `.mcp.json`, and `.codex`
remain behind the content-digest consent introduced in v0.9.84. Claude native tool and MCP calls remain behind
the fail-closed `PreToolUse` gate. Codex native MCP follows Codex's own reviewer/approval behavior; a nested call
may run without a UnodeAi prompt, so UnodeAi makes no mediation claim for that native path. Agent Builder grants
are separate, host-managed integrations. Startup waits up to 45 seconds for every granted managed server,
including first-time approval. Resolved failures require an explicit not-now, retry, or continue-without decision;
an unanswered approval reaches the deadline and stops startup. A timed-out approval generation is invalidated, and a server that connects
late is disconnected. Every managed call rechecks the current saved grant.

Executable Skills do not supply executable files. `skills/` and remote catalogs remain instruction-only; the
VSIX boundary rejects scripts, binaries, and executable directories there. An extension-bundled manifest may
select only a handler compiled into the fixed `out/skills/SkillActionRunner.js`. Every invocation requires live
Workspace Trust and a new exact-tree-digest **Allow once** decision, uses structured bounded I/O, a reduced
environment, no shell, a maximum 120-second deadline, and returns an audit receipt. At timeout UnodeAi requests
one process-tree kill while it still owns the original child and resolves immediately even if an inherited pipe
stays open. Node cannot create a Windows Job Object, so a deliberately detached background process may survive;
the approval warning and documentation do not claim otherwise. No executable Skill action is bundled in v0.9.85.

*Release audit evidence (Claude, 2026-09-24, candidate `23561cf`).* Effects were observed on the real binaries,
not inferred from source. On Codex CLI 0.155.1 (Windows): a real stdio MCP server reached through the Hub was
called as an App Server dynamic tool, and after the saved grant was removed the next call was refused without a
restart; the native Skill body loaded, survived restart and resume with changed content, and was invisible to a
second agent; all four permission profiles produced their expected effects; `~/.codex/config.toml` stayed
byte-identical across every probe. On the Claude CLI: the same MCP server was reached only through the
`unode_integrations` loopback bridge (no `--strict-mcp-config`, native configuration untouched), and grant removal
refused the next call. The fixed runner executed the compiled canary handler; a Skill naming a non-compiled handler
(including `constructor`), an undeclared `scripts/helper.py`, or a `.js` reference file was rejected at load. A hostile
project team file cannot widen a Codex agent: `toolCeiling`, `codexPermissionProfile`, `playbooks`, `mcpServers`
and `autoApprove` are stripped, an explicit empty tool list resolves to read-only, and an absent one to the default
Ask for approval. That audit recorded one defence-in-depth limit: Claude's tool gate trusted readable bridge-name
prefixes, so deliberately similar native MCP names could inherit an allowance. The current implementation closes
that limit with unpredictable per-session bridge ids and an immutable set of exact registered qualified tool names;
old fixed names and similar prefixes receive the ordinary approval decision.

**v0.9.84 CLI, repository-configuration, and gateway security re-audit.** This release adds a user-requested
OpenAI Codex CLI process route and a CLI-controlled network path, so it would be inaccurate to describe it as
adding no execution or network surface. UnodeAi first runs bounded local `--version` and `login status` checks;
before Codex App Server starts or a model request is made, it asks for a separate Codex consent
bound to the canonical executable path; changing to another binary asks again. Legacy host-only grants remain
revocable but authorize no executable. Closing or declining the dialog starts no App Server or model request,
and revocation stops the running process tree. Each Codex
agent defaults to **Ask for approval** in Act mode (workspace-write, on-request, user-reviewed, sandbox network
off). It may instead use **Approve for me** (workspace-write with Codex `auto_review`, whose started/completed
reviews are shown in chat) or explicitly confirmed **Full access (unsafe)** (`danger-full-access`, network on,
no approval prompts). Full access removes the sandbox and UnodeAi records no checkpoints. Plan mode, untrusted
workspaces, read-only Folder Access, and write-disabled roles resolve to read-only; an agent with explicit Folder
Access grants cannot use Full access, which resolves to Ask for approval. Routine Codex edits are not UnodeAi
checkpoints. A card appears when Codex requests an escalation, which is Codex's decision: a blocked action it does
not retry simply fails. Measured on the Windows 0.155.1 binary through the production backend: under Ask for
approval, a blocked out-of-workspace write produced an escalation request and declining it left no effect; under
Approve for me, the same kind of request went to Codex's reviewer, whose review started and completed.
Permission escalations and the MCP calls Codex routes for approval use single-use cards; unknown, malformed,
timed-out or closed requests are denied. Codex does not route every tool call that way: on 0.155.1, an MCP tool
(the bundled `node_repl` plugin) called from inside Codex's own `exec` code tool ran with no approval request, so
no card could be shown. That is Codex's behaviour under the user's own plugin configuration, and the official
Codex extension shares it; UnodeAi makes no sandbox or approval claim for such nested tool calls. Codex uses the user's installed binary, login and native user
configuration. UnodeAi does not read `auth.json`, `config.toml` or `CODEX_HOME`, inject an OpenAI API key, install
Codex, or control the CLI's network destinations. No CLI process is prewarmed or started during activation.
**Load models from Codex**, or **Refresh models from Codex** when account models are cached, is an explicit user
action available in Agent Builder. Opening the picker does not request account models. The action verifies a
supported executable and login before consent, runs App Server with the product's read-only arguments from the
extension's global-storage directory (never a workspace), sends only `initialize` and `model/list` requests, and
stops the process tree in a `finally` boundary. Executable discovery is also user-triggered: supported npm and
standard user installs are presented before PATH candidates, with the verified version and full path shown for
confirmation, so an older editor-bundled preview cannot be selected silently.

**Claude Headless in v0.9.83 and earlier loaded a repository's `.claude` hooks and `.mcp.json` servers without a
UnodeAi prompt. v0.9.84 asks first.** The same content-bound trust boundary now covers repository `.claude`,
`.mcp.json`, and `.codex` configuration before either CLI starts. Detection follows each native CLI's measured
discovery locations, including relevant ancestors when only a monorepo subfolder is open, while excluding HOME
`.claude` and `.codex` as uninspected user configuration. The dialog presents redacted effect-bearing details,
closing it is a decline, and the files and
Workspace Trust state are rechecked immediately before spawn. A content change invalidates the grant. In an
untrusted workspace, or when a link makes the inspected content ambiguous, UnodeAi never offers repository trust;
Codex receives a process-local `trusted` or `untrusted` project override matching the choice; the user's Codex
configuration file is never edited.

OpenAI-compatible gateway grants are now bound to the profile, destination and revision rather than only to a
host. Legacy grants do not satisfy that narrower identity, so existing users receive a one-time re-consent prompt
per gateway after updating. The only timer-driven network work is daily price refresh: user-owned per-provider and
global toggles control it, destinations must already be approved, concurrent triggers are coalesced, failures back
off, and activation starts no scheduled request. This re-audit found no new credential-file read, telemetry path,
activation-time network request, or repository-controlled way to enable these grants or toggles.

**v0.9.83 local-read consent recovery boundary.** Local project-discovery approval remains session-only and
never widens write or shell authority. A decline or unavailable confirmation blocks that root for the entire
top-level user-request epoch shared by the coordinator and its delegates, so retries and delegation cannot create
a prompt loop. A later direct user request may ask again. Only an explicit decline is listed as a user decision;
a thrown dialog fails closed without becoming one. Recovery reopens the full confirmation, and revocation applies
before the next tool call.

**v0.9.82 project-state boundary.** Every project-sensitive value held in editor `workspaceState` is physically
namespaced by a digest of the canonical first workspace-folder root. This includes rosters, transcript families,
checkpoints, pending results, run and ownership records, project policy, integration evidence, execution-hook and
command approvals, MCP approvals/configuration, and migration guards. The sole global value in that reused bucket
is Workbench Inspector panel visibility, which carries no project content or authority. A root change invalidates
the scoped adapter and clears live selection/presentation state before further work. Existing unscoped VS Code and
Cursor state is imported once only when the editor application identity supplies the same-root storage guarantee;
it is never imported in Devin or an unknown host. Reset Workspace State enumerates only the current root's
namespace. Checkpoint restore additionally resolves its target against the currently bound physical root before
any delete or write.

**v0.9.82 consent-decline boundary.** A user decline is a typed terminal condition, not a transport error. The
OpenAI-compatible route carries it past transport retry, request-body recovery, and streaming-to-non-streaming
fallback. A declined request therefore produces one consent dialog, zero fetches, and one terminal result. The
allow path and the per-host consent record are unchanged; a later user turn may ask again under the existing
policy. Claude Headless remains gated before spawn. OpenAI Codex CLI is likewise gated before spawn, with a
separate disclosure that OpenAI is the default, a configured provider may differ, and UnodeAi does not control
that CLI's network behaviour.

**v0.9.82 release-integrity boundary.** The release test runner rejects a non-zero exit, worker/pool error,
missing or malformed final report, count inconsistency, pending or undocumented skipped test, and totals below
the checked-in file/test baseline. Extension-host E2E remains a separate candidate gate. The public source drop
contains a checked-in `SOURCE` record naming the exact 40-hex private source commit; this identifies the private
source to a reviewer with repository access and is not an independent public proof.

**v0.9.81 project-content execution boundary — update now.** The repository history shows both affected
paths in the initial v0.9.11 tree, and they remained through v0.9.80. A checked-out `.unode/team.json` could
set an agent `env` map; when that agent was started, values such as `NODE_OPTIONS` and `PATH` were merged into
the provider child. The file could also set `autoApprove`; for a write-and-execute Claude agent this selected
`bypassPermissions` and disabled UnodeAi's command gate. Separately, Windows host launches used bare
`claude.cmd` and, for one Git probe, a shell lookup with the workspace as `cwd`, allowing a same-named program
in the project to win resolution. In VS Code and Devin the folder first had to be trusted; Cursor does not
provide that trust boundary. Starting the affected agent or using the Git-backed action was the trigger.

v0.9.81 classifies every team-file field at one load boundary. Identity, display, prompt, registered route and
model data remain untrusted data. Folder/tool/command restrictions may only narrow host authority. Process
environment, automatic approval, backend/base-URL overrides, restart/cwd controls, executable Skills/Playbooks,
tool/edit protocols, and per-agent or top-level MCP process configuration are host-only and are ignored with one
visible notice; the writer no longer emits them. Because v0.9.80 did not retain roster provenance, the one-time
upgrade removes only `env` and `autoApprove` from source-unknown workspace state and says what it removed. Skills,
Playbooks, MCP grants, routes, backend choices and other user configuration remain intact.

The upgrade also moves host-owned MCP approval and configuration state from `roam.approvedMcpServers` /
`roam.hostMcpServers.v1` to `unode.approvedMcpServers` / `unode.hostMcpServers.v1`. A server still present in a
legacy project team file is imported only when its exact launch configuration already has a host-owned approval
for that workspace. The notice names imported integrations and unapproved project entries that were ignored;
an edited or never-approved entry gains nothing. Because the old keys are retired after migration, downgrading
to 0.9.80 requires approving those integrations again.

Host-selected programs now resolve to an absolute executable using only absolute host `PATH` entries; current
directory and relative entries are excluded, and a result inside a workspace or UnodeAi worktree is refused.
Git uses `shell: false`; an absolute `.cmd` shim uses the shell only after resolution. The host rewrites its
Claude tool-gate wrapper before each launch, and approved stdio MCP programs are fixed to the resolved host path
before either backend route receives them. These changes do not alter a literal command that the user approved:
project-relative command semantics remain part of that approval. The Claude-route MCP caveat in §5 also remains:
an inherited editor process variable may satisfy a server placeholder, but project `team.json` can no longer
create or override that process variable. This is a documented limitation of the current release.

**v0.9.80 repository-settings boundary:** Cursor 3.20.10 was tested with a harmless repository
`.vscode/settings.json` containing `"unode.commandApproval": "none"`. Its extension host reported
`{"effective":"none","workspaceValue":"none"}`. Cursor therefore honours the repository value while offering
no usable untrusted-workspace state for that folder. `restrictedConfigurations` is useful defense in depth, but
is not the cross-editor authority boundary. **v0.9.79 and earlier did not have this host-side boundary:** in an
editor that honoured repository settings without an untrusted mode, a repository could influence the listed
UnodeAi settings. UnodeAi now resolves all 39 authority-bearing settings from `inspect().globalValue`, then the
manifest default, and never from workspace or workspace-folder layers.

The audited keys are command policy (`allowedCommands`, `commandApproval`, `verifyCommand`); consent and reach
(`allowCrossProviderDispatchWithoutApproval`, `writeApproval`, `webAccess`, `additionalRoots`, `localReadScope`);
execution and scheduling (`concurrencyStrategy`, `maxConcurrentAgents`, `gate.enabled`, `gate.maxSelfRetries`,
`gate.maxRedelegations`, `engine.postWriteDiagnostics`, `engine.verifyObligation`, `engine.workspaceContext`,
`worktree.autoMerge`, `worktree.maxParallel`, `worktree.verifyBeforeMerge`,
`worktree.verifyTimeoutSeconds`); executable/route/egress selection (`codexCliPath`, `defaultProvider`, `baseUrl`,
`unodeBaseUrl`, `customBaseUrl`, `pricingSources`, `modelCatalogUrl`); and catalog egress
(`marketplace.catalogUrl`, `marketplace.fetchCatalog`, `marketplace.skillLibraryUrl`). Smart routing and cost
authority are included too (`smartMode.enabled`, `smartMode.defaultTier`, `smartMode.roleTiers`,
`smartMode.taskTierHints`, `modelTiers`, `modelTierParams`, `modelPrices`, `priceGroup`, `priceMultiplier`).
*Allow for project* command approvals are no longer settings at all: they are workspace-scoped records in
UnodeAi-owned `workspaceState`, keyed by the physical first-folder identity, and can be inspected or revoked with
`UnodeAi: Manage Project Command Approvals`. Repository values are not migrated. VS Code greys these
application-scoped keys and supplies its own scope explanation before an extension can inspect the folder value;
UnodeAi's ignored-values notice is a backstop for editors that do expose one.

**v0.9.80 workspace-write boundary:** a window with no workspace folder has no project write target. Rules,
memory, project knowledge, attestations, persistence, team configuration and integration evidence are unavailable
there rather than falling back to the editor process directory. If the first folder changes, their captured root
is invalidated, running agents, Integrations, and UnodeAi terminals are stopped, the Team Rules editor closes, and later turns or
saves visibly refuse until the window reloads. Existing `.unode` directories under an editor installation are
not read or imported as workspace data.

**v0.9.80 interrupted-task boundary:** an admitted task never remains “active” solely because its worker promise
was lost. A worker crash records `worker-lost`; extension-host restore reconciles persisted active rows to
`host-restarted` only when the row belongs to an earlier epoch of that editor window or its owning window's
heartbeat lease has expired. An isolated VS Code 1.137.0 probe confirmed that Reload Window changes
`vscode.env.sessionId`, so its restored row can remain active until that foreign lease expires, for no more than
30 seconds after reload; a five-second
maintenance tick records the first expired observation. The UnodeAi output channel records the resolved host
identity and the exact reconciliation branch so this timing is observable rather than inferred. A second live
window therefore cannot adopt or interrupt the first window's work.
Both loss paths are terminal `interrupted` facts with last-observed and detection timestamps kept separate. The
only repair is a resumed exact owner heartbeat newer than a `host-restarted` detection, and it applies only while
no coordinator disposition has been recorded; an abandoned, superseded, or replaced attempt remains terminal. Live
worker loss ends the exact attempt and its temporary grants; after a host restart the process-private grant store
is already gone and reconciliation closes the restored attempt identity again. The handle cannot auto-wake, and
only an explicit abandon or host-admitted linked replacement disposes the interrupted work. A coordinator
`task.complete` cannot hide interrupted work: that run closes as partial and names the affected handle. Portable
Run Evidence uses schema `/4` for the added `interrupted` state and accounting field; `/3` artifacts are not
reinterpreted.

**v0.9.80 governed Integrations:** catalog metadata cannot grant authority. Active entries must carry source,
maintenance and exact-install provenance; a local process, network endpoint or credential always receives the
host's approval-required classification. Configuration, approval, mount, exercise and success are recorded as
different facts, and adding a Role Template or team never grants an integration to an Agent. The build gate
requires every verification date to be current and rejects mutable npm `@latest` identities; the installed
extension keeps an overdue entry visible with an overdue label instead of blanking the entire Integrations tab.

**v0.9.79 cross-provider brief consent — a default relaxed by Owner decision, stated rather than implied:** a
coordinator brief sent to a teammate on a different model provider no longer asks per dispatch by default.
`unode.allowCrossProviderDispatchWithoutApproval` (default `true`) sends it without a dialog; turning it off
restores the per-dispatch modal introduced in v0.9.75, now with one Cancel button instead of two. The setting is
application-scoped and listed in `restrictedConfigurations`, so a repository cannot turn approval back off after
you turned it on. It removes a dialog, not a check: an unresolvable destination still refuses the dispatch,
same-destination dispatch never asked, and each send made without a dialog writes its destination host to the
UnodeAi output channel. It does not change the separate per-host model-egress consent described in §2.

**v0.9.79 shared-memory trust boundary:** the shared-memory change adds no network, shell, MCP, command,
write-tool, or model-egress authority. It adds a local command that reads the existing primary-workspace memory file and,
only after a visible confirmation in a trusted workspace, stores an exact-row SHA-256 attestation in VS Code
workspace state. The record is versioned, bounded, keyed to a digest of the normalized first workspace folder,
uses the fixed actor marker `local-user`, and contains no note prose, OS username, account, or email. Missing,
corrupt, unknown-version, cross-workspace, and untrusted-workspace states all resolve to zero attestations.

**Attestation changes prompt admission and display, not product authority.** Every reloaded row is either
`untrusted` or `human-attested`; `pitfall`, `contract`, and `decision` remain author-selected semantic kinds and
never confer trust. An attested row is retained before unattested rows within the existing bounded prompt budget.
It does not grant a tool, folder, command, write, network, MCP, delegation, execution-hook, completion, or evidence
permission, and it is not a claim that the prose is true, fresh, or relevant. Editing any byte inside the row or
revoking through the same local surface returns it to untrusted; exact copied rows collapse to one prompt slot.

**The Markdown source is now confined and quoted as mutable data.** Load and append re-resolve the real path and
fail closed if the file or a parent symlink/junction escapes the first workspace folder. Every rendered field is
bounded and structurally encoded, so a sanctioned `memory_note` containing `</shared_memory>`, a forged trust
attribute, or `SYSTEM:` remains text inside one untrusted note. The complete block has both row and byte bounds.
Prompt text and its content-free receipt now come from one selection snapshot; a mid-turn note/reload can affect a
later turn, but cannot make the current receipt describe different memory. The receipt retains only bytes and typed
selected-row trust counts, never note bodies, and remains excluded from portable evidence.

**v0.9.78 ordering, and a source-side ingestion pipeline that does not ship:** this release **adds no
network, filesystem, shell, MCP, or model-egress reach**. The extension's only production changes are one
reordering in `extension.ts` and a two-line string correction in `TeamTools.ts`.

**The reordering does not widen a write.** The legacy price-coefficient read repair still writes exactly one
setting, `unode.priceMultiplier`, at Global scope through `settings.writeGlobal`, and only ever writes the
conservative list-price default for a connection that already has a stored key. What changed is *when*: the
repair no longer runs ahead of `UnodeAi: Open Settings` or `UnodeAi: Refresh Model Prices`. It is started
after the requested action completes and settles independently. A single in-flight promise still guards it,
so the two entry points cannot produce two concurrent writes. A repair that fails is now reported to the
user with a route to User Settings JSON rather than silently aborting the command — **strictly more
disclosure than before, and no additional authority.**

**ECC ingestion is developer tooling and is not in the VSIX.** `tools/**` is excluded by `.vscodeignore`,
and the bundled staging boundary check confirms the packaged file list contains no `tools/` entry. **No ECC
Skill is installed, bundled, enabled, available to the extension, or executed in v0.9.78.**

**The ingestion pipeline does not execute candidate content.** The adapter's only child process is `git`,
spawned with `shell: false` and a fixed argv. It treats *repository-local* configuration as untrusted, not
just system and global: `GIT_CONFIG_NOSYSTEM=1` and a null `GIT_CONFIG_GLOBAL` neutralise the outer two, and
the invocation additionally pins `core.fsmonitor=false`, `core.hooksPath` to an empty fixture directory,
`diff.external=` and `core.pager=cat` — because `core.fsmonitor` in a cloned repository's own config can
name an executable. Candidate Skills are inventoried, hashed and classified; they are never run, sourced or
imported. Directory and payload shapes that could carry execution are rejected outright
(`executable_directory`, `executable_payload`), as are `path_escape` and `symbolic_link`.

**The report is metadata, not upstream content.** It publishes paths, hashes, licence outcomes, status and
reason codes, and aggregate classifications. It does not carry Skill bodies, descriptions, excerpts,
scripts, attachments or rewrites, and it states in its own summary that PASS is compatibility, not approval
or behavioural effectiveness.

**v0.9.77 local project-discovery review:** this is the first expansion of UnodeAi's host-owned read reach.
In a trusted workspace, `unode.localReadScope` defaults to `parent`, making the workspace's resolved parent
directory available for sibling-project discovery. **Nothing outside the workspace is read or searched until
UnodeAi shows that resolved absolute path and the user confirms it.** The modal says that a search can walk
the whole tree and that returned filenames and content may go to the configured model provider. An approval
lasts only for the extension session. A decline or dismissed dialog fails closed for the current top-level user
request across the crew and suppresses immediate tool retries and delegate re-prompts; a later direct user request
may show the confirmation again. A thrown or unavailable dialog refuses that request without recording a user
decision or repeatedly reopening the failed UI. The refusal notification appears at most once per root and request
and offers **Grant folder access**, and the Security panel lists session-local granted/declined roots with
grant/revoke;
revocation takes effect before the next tool call. `volume` uses the same gate with an extra warning that a
filesystem volume can include other users' profiles. `workspace`, `parent`, and `volume` are the only values;
the setting is ignored when Workspace Trust is off and remains restricted from workspace configuration.

The expansion is read-only. Writes, edits, deletes, generic shell commands, and Claude native `--add-dir`
authority remain in the working folder; per-agent Folder Access and task scope can only narrow what is
reachable. `read_file`, `list_dir`, `search_files`, and `inspect_git_tag` all require the same local-scope
confirmation before touching that root. Every admitted access puts an opaque root ordinal, action, and count
on its tool card and in run evidence. The receipt deliberately carries no absolute path, path fragment,
filename, query, or source content. Portable Run Evidence retains that bounded fact as an explicit declared
choice; it never retains the location or contents that produced it.

**v0.9.76 refusal-detail and task-tool review:** no path, command, tool, or destination becomes permitted
that was not before. The set of refused actions is identical; the change is only what a model is told about
a refusal and which tools it is offered. A refusal detail is host-authored and literal-only: it has the
branded `HostToolRefusalDetail` type and can be constructed only by `hostToolRefusalDetail` with a
substitution-free string literal. `check:refusal-detail-literals` fails any other call site and self-tests
both the accepted literal and rejected interpolation. A user's own free-form reason for denying a web request
is deliberately not forwarded; the security test plants a path and token in that reason and proves neither
reaches the model.

`report_context_gap` retains its non-disclosing refusal for an unknown input, so it reveals nothing about
whether an unauthorised source exists. Narrowing advertisement does not narrow enforcement: routing still
recognises every host tool, while each task-only handler requires a live attempt on every transport. That
includes the Claude bridge, whose tool schema is fixed at connection and remains unchanged. Three formerly
unpinned authority boundaries now have tests; v0.9.81 adds four project-content/process-launch boundaries.
`npm run test:release-authority-canaries` requires a green baseline and reports 25/25 targeted mutations killed,
refusing to count a crash or a missing anchor as a kill.

**v0.9.57 development review:** activation no longer writes a global price setting. The v0.9.56
`backfillPriceMultipliers` behaviour is historical (and remains recorded in the audit log below); the current
`repairPriceMultipliers` is an idempotent **user-triggered** read repair, reached only when the user opens
Settings or explicitly refreshes model prices. It considers only registered connections with a key actually in
SecretStorage, leaves a bare-number setting and every stated coefficient (including `0`) alone, writes only a
missing connection entry of `1`, makes no network request, and shows why it wrote with an action to open the
setting. If no safe repair applies, it leaves the value unstated. The extension-host test observes that a
legacy key remains unstated after activation and that the same key is repaired only after Settings opens.

The composition root now creates the catalog, pricing, live-price and balance services only on their first
real use. Their sole metadata transport still checks prior metadata/model consent before a packet moves;
lazy construction is not permission to fetch. Command and sidebar registration are host adapters, and the
first pure-service boundary rejects a `vscode` import in model, route, capability and parameter code. The
new user-brake E2E observes a running Solo agent and verifies `Stop All Agents` actually stops it; Solo still
remains outside a coordinator's `cancel_task` authority. No new network destination, credential path,
persistence format, telemetry, or model authority is added by this work.

**v0.9.57 rich-content development review:** `fetch_url` still makes only the user-approved anonymous
public-web request; a PDF does not create a second network path. A `%PDF-` magic-byte match is required
before bytes enter an extension-owned temporary directory. The only model-visible handle is a session-scoped
ordinal (`content-1`), never a source URL, a query string, a temporary path, raw bytes, image, frame, audio,
or provider token. PDF.js (Mozilla PDF.js, Apache-2.0) runs in a separate Node worker with no URL input,
no PDF JavaScript/eval support, no worker fetch, no link or attachment following, a 10 MiB download ceiling,
200-page ceiling, 20k characters per page, 200k total extracted-text ceiling, a 15-second parser timeout,
and a 64 MiB worker old-generation heap ceiling. That worker installs only `@napi-rs/canvas@0.1.100`'s
pure-JavaScript `DOMMatrix` geometry polyfill on its own global; no platform-specific native canvas binary
is included in the VSIX.
Assets expire after 30 minutes and are deleted at expiry and backend disposal (including cancellation/agent
end). A corrupt, encrypted, over-limit, or scanned page fails closed or says `OCR required / unavailable`;
it is never represented as text that was read. Tool results identify the exact requested/searched page range
and total page count. Before any tool result enters provider history it receives a smaller, independent 24k
character cap and an explicit omitted-content marker; remote extracted text is wrapped as untrusted data,
not an instruction, tool directive, or permission basis. Image/video analysis remains unsupported: public-web
approval does not authorize a vision/transcription upload. Portable Run Evidence records only a bounded
receipt: a document-local content ordinal, `pdf` class, store/read/search outcome, extraction outcome,
page coverage, truncation and OCR state. It does not carry the host asset id, source URL/query, attachment
name, temporary path, raw bytes, extracted text, image/frame/audio, or provider payload; both the ledger
write boundary and the portable builder validate that closed receipt shape.

**v0.9.75 workspace-escape and coordinator-brief review:** no path becomes readable or writable that was not
before, and the set of refused actions is identical. What changes is whether a refusal ends the current turn.
Terminal authority moved from a substring match against a host-written message to the structured
`WorkspaceEscapeError` path-boundary signal. Only five lexical or physical path proofs construct that signal,
and `check:workspace-escape-boundary` fails if it is constructed anywhere else; a refusal therefore cannot
end a turn by accident. A shell out-of-root detector still scans a command line and is explicitly a heuristic,
not a sandbox proof: it blocks the command before execution but does not end the turn. Repeated attempts stay
bounded by the existing failure and iteration budgets.

`coordinatorBrief` is a separate egress surface. Coordinator-authored text can be user-derived and enters a
worker's prompt, so a cross-destination dispatch is governed by `unode.allowCrossProviderDispatchWithoutApproval`.
Since v0.9.79 it defaults to on and the brief is sent without a dialog, with the destination host written to the
output channel; with the setting off, the dispatch receives its own modal consent before an attempt, persistence,
worker session, or prompt exists. The setting is application-scoped and restricted, so a workspace cannot change
it, and it never bypasses destination resolution. Destination equality uses the resolved privacy domain, falling back to the
canonical execution endpoint when that domain is unresolved; it never trusts a provider label or model id and
fails closed if either destination cannot be resolved. The brief's declared inputs are checked at contract
compile and its `basisRefs` are checked again against the attempt's granted inputs; a missing grant refuses
dispatch and the worker never starts. The brief is retained only in the internal run record for audit, excluded
from Portable Run Evidence (declared in `PORTABLE_EXCLUSIONS`), the Markdown evidence report, activity and
conversation exports including MessageBus persistence, and team-file persistence. Ordinary run/task deletion
and workspace reset remove it.

**v0.9.74 task-scope and field-policy review:** this release adds no network, filesystem, shell, MCP, or
delegation authority. The set of paths a tool may read or write is unchanged: configured Folder Access remains
the outer boundary, a temporary task scope remains a strictly narrower boundary, physical symlink targets are
checked, and a path outside configured access remains a terminal `scope` refusal. The change is only what
happens *after* an already-denied request: a path inside configured access but outside the temporary assignment
is now the bounded `task-scope` refusal, so the same turn can use another granted input or report the gap. It
does not disclose a path, root, target, or credential, and it cannot grant the rejected action. An unavailable
temporary image is likewise a capability refusal, not a false folder-boundary report. The write and symlink
classification branches are mutation-proved in both directions.

Run-record policy is a compile-time declaration of which already-recorded fields can appear in a portable
artifact; persisted JSON remains `unknown` until the existing normalizer checks it. It adds no persisted source
contents, path, credential, network request, model payload, or new export authority.

**v0.9.73 terminal-state and receipt review:** this release adds no network, filesystem, shell, MCP, or
delegation authority. It changes how already-observed lifecycle and receipt facts are represented. An
unfinished directed turn is a structured `task.partial` terminal event with a literal partial state; it
cannot be represented as a successful completion merely because verification passed. A run closeout uses
the narrower `complete | partial` type, so `not-observed` cannot describe a run the host has closed.

`inspect_task_status` now joins the durable ledger with the coordinator-owned live handle state. The overlay
contains bounded enums and timestamps, not worker prose, command output, source contents, paths, or hidden
ownership details. A restored retained result can be reported ready without claiming an in-memory worker or
promise survived the restart. A status action is exposed only when the result is already ready and names the
non-blocking collection surface.

Portable Run Evidence moves to **`portable-run-evidence/3`**, a declared schema change. It adds bounded
run-closeout and delegation-completion states and renames an input receipt's `read` key to `readReceipt`.
The value is `observed | not-observed`: absence of a host receipt is no longer exported as a claim that a
worker did not read. Actual access failures remain closed reasons (`missing`, `expired`,
`outside-task-scope`, `unreadable`). The artifact still carries no request or result prose, input purpose,
source id, absolute path, file contents, command line, credential, or private route identity.

**v0.9.72 decision-reporting review:** this release **adds no new reach, and fixes a case where a
refusal the host had already enforced was reported as a success.** The two questions asked of it were
whether anything can now be reached that could not be before, and whether anything the host records is a
claim it cannot support.

**Nothing new can be reached.** No tool is added, no network path, no filesystem path, no capability. The
release changes how an already-made decision is carried from the point of enforcement to the point of
display; it does not change what is permitted.

**The security-relevant defect was in the reporting, not in the gate.** `summarizeToolResult` decided whether
a tool call had succeeded by testing its own output against an anchored list of English prefixes in
`isToolError`. `Web access denied:` — the string this product emits at the public-web consent gate — was not
on that list, so a fetch **the user had denied** was summarised with `ok: true`. **The gate itself always
held**: the request was refused, no network call was made, and no content was retrieved. What failed was the
account of it, in the activity feed and in what the model was told. That distinction is why this is a
truthfulness defect rather than a containment breach, and it is also why it was worth a release: a user's
next decision rests on the report of the last one. Host tools now return `success | refused | failed` with a
closed-enum reason, `toolSummary` no longer accepts a bare string from a host tool, and the prefix list is
deleted rather than extended.

**The same shape was re-created inside this release and caught before it shipped.** Deleting the prefix list
left `await_tasks` and `collect_ready_tasks` marking nothing, so a collected batch containing a failed
delegated task reported as a successful tool call. It was found by mutation during review, not by the suite.
Both collectors now bind the wording to the status through one helper, and **each collector is proved
separately**, because a mutation of the shared helper is killed by either test and would conceal an unwired
call site.

**The new refusal reasons are content-free by construction.** A workspace refusal message is assembled from
the tool name, the reason enum (`capability`, `scope`, `trust`, `consent`) and fixed guidance text; no
absolute path, folder root, target name or credential reaches it. `RunVerdictWithholding` carries a reason
enum and a count of preceding accepted verdicts — nothing from the rejected value. `workspacePath` now
distinguishes `refused:scope` from `failed:{invalid-target,not-found,unreadable}` where it previously
returned one bare `undefined`; the distinction is a category, not a disclosure of what was found where.

**Text the host did not author is now marked as such on the failure path too.** A failure whose output quotes
a worker reply or a subprocess (`await_tasks`, `collect_ready_tasks`, both `run_checks` failure exits) carries
`mixed-external` rather than being presented as host-authored. This extends the posture already applied to
remote extracted text: content the host did not write is never a host decision.

**The package-script parser reads untrusted text and executes nothing.** `commandNormalize` now tokenises
script bodies from `package.json` to classify each invocation of a runner. It cannot construct a command: it
either names an existing script, which is run as `npm run <name>`, or inserts `run` into the agent's own
tokens. Every scan is a single linear pass. A body it cannot read with confidence — command substitution, an
unquoted shell group, an unterminated quote — is refused rather than guessed at, and the effect of the change
is strictly fewer scripts eligible for a watch-defaulting runner, not more.

**The deferral is recorded rather than closed.** `classifyToolFailure` still runs at `SessionManager.ts:1589`
for `tool_result` events from `ClaudeHeadlessBackend` and `CodexBackend`, which emit no `failureKind`. It
selects the UI category label only and **cannot flip `ok`**, which comes from `block.is_error` on the Claude
path and from the exit code on the Codex path. ROADMAP Track E carries the three sites and the end state:
every event carries its own `failureKind` and the phrase table is deleted. **Adding a phrase to cover a newly
observed string is a regression, not a fix.**

**v0.9.71 dispatch-authority and note-provenance review:** this release **narrows one authority,
adds one persisted provenance field, and adds no new reach.** The two questions asked of it were whether
anything can now be reached that could not be before, and whether anything the host records is a claim it
cannot support.

**Dispatch authority is narrowed, and the narrowing is the security-relevant change.** Before this release a
capability label made a dispatcher: any agent holding `delegate` received the full delegation surface, and a
shipped skill granted that label by default. **Three consequences were confirmed in a live trace and then in
the tree.** A worker's sub-delegation was **invisible to the coordinator** -- handle maps are per-instance, so
neither `inspect_task_status` nor `collect_ready_tasks` could reach it, and an entire branch of work had no
accountable observer. **A task scope did not survive the hop**: a requested scope is intersected against the
*target* agent's permanent configuration, never against the dispatching agent's active scope, so a worker
narrowed to one read-only folder could dispatch work that ran under the target's full configured permissions.
And the coordinator's only account of that branch was the worker's prose. **A team now has one coordinating
identity**, resolved once and consulted through a single predicate that both former copies now call.

**Nothing gained authority.** A worker that could dispatch can no longer dispatch; it can only send an
ordinary message proposing work. **The host never parses that message** -- deciding whether a proposal is
worth acting on is meaning, and it belongs to the coordinator, which is an agent. **No request protocol, queue
or classifier was added**, because any of those would put the host back in the business of reading intent.

**Legacy configurations lose the capability without losing the file.** A saved team granting `delegate` to a
worker, or carrying a second `role: 'pm'`, still loads with every member. The capability is dropped in memory,
the designated coordinator is the same one the product's existing `find(role === 'pm')` already selected, and
each change is a validation warning. **A stricter rule that failed the load would have taken the user's whole
team configuration with it**, which is the failure mode v0.9.70 caught in review and did not ship.

**One defaulting hole was found while auditing this release and closed.** `workerComplianceProtocol` defaulted
its coordinator id to a resolution over its own single config, which resolves any `role: 'pm'` to itself. The
only production caller passed the real id and the function selects prompt text rather than authority, so
**nothing was granted** -- but it was a default that quietly restored the behaviour this release removes, on an
exported function. The parameter is now required.

**Settlement now reports a host observation that a worker cannot fabricate.** The declared required inputs are
compared against the resolver's own `readAt` receipts, and the counts are written to evidence, task status and
the run ledger **without the coordinator calling any tool**. When every required input went unread the
delegation settles into its own outcome rather than an ordinary delivery. **The counts are never read from
`task.complete` metadata**, and a test constructs a worker that forges read metadata to prove it: a fix that
trusted worker-supplied structure would be defeated by the same turn that defeated the rule it replaced, and
would look structured while doing it. **The host records; it does not reject.** Whether the delivery is
acceptable remains the coordinator's decision.

**The new persisted field is a routing fact, not an identity claim.** A shared-memory note now records the
**host-selected tier** for the turn that wrote it. `ModelTier` is a closed host vocabulary and the tier is the
host's own routing decision, so it identifies no underlying model. **`EffectiveExecutionIdentity` was
deliberately not used**: its own header forbids copying it into prompts, ledgers or portable evidence, and
`.unode/memory/notes.md` is persisted, user-visible and injected into prompts -- all three at once. **The tier
is not a tool parameter**; it is resolved host-side at write time and cannot be supplied by a model. The note
kind is model-selected from a closed vocabulary and is **never inferred from the note's text**.

**Provenance was recorded and never acted on.** Nothing scored, filtered, hid, re-ordered or discounted a note by
its tier. At v0.9.71, retention differed by the agent-declared kind, not by tier, and the injected block stayed
bounded at thirty notes. v0.9.79 removes that kind-based priority because an author-selected semantic label is not
a trust decision; the historical write-time routing fact remains unchanged.

**Two long-standing unproved boundaries are closed.** Attempt liveness was expressed twice -- once as a named
predicate and once inlined -- and the proof was attached to the copy; mutating the predicate now fails a test at
every consumer, including the coordinator self-execution site that had survived every mutation since v0.9.62.
The contract-managed anti-redelegation rule, which had one enforcement point and no test at all, now has one.

**Runbook 4a was re-run on this tree.** Its results and the survivor count are recorded with the release.

**v0.9.70 task-truth and prose-removal review:** this release **adds one new read-only tool and one
off-by-default policy, deletes three host judgements over natural language, and moves two enforcement points
without changing what either permits.** The question asked of every item was the same: does this widen what
can be reached, what can leave, or who may decide.

**Nothing here widens permission, and the one item that looks like a tightening is not one either.**
Workspace Trust now gates writes, edits, deletes, `apply_patch` and `run_command` at a single tool-dispatch
boundary instead of four per-tool guards. **A command in an untrusted workspace was already refused** -- the
host empties the writable roots when the workspace is untrusted, and the shell path then met the read-only
refusal; the Claude backend denies shell tools ahead of any approval. What was wrong was ownership and
honesty: **the refusal told the agent it lacked a writable folder and to ask for one, which would not have
helped**, and the trust property was being enforced by a neighbouring rule about write roots -- one edit away
from not being enforced at all. **`apply_patch` had no guard of its own** and borrowed `apply_edit`'s, which
no test could kill. All five surfaces now carry the same decision and the same stated reason, and a test
constructs the case the neighbouring rule cannot mask: writable roots present, `execute` granted, workspace
untrusted, with the command executor and the approval callback both asserted unreached.

**There is deliberately no per-command approval in an untrusted workspace, and that was a decision, not an
omission.** The approval for running code from a folder is VS Code Workspace Trust, made once and
deliberately in the platform's own UI. A per-command prompt was rejected because **the prompt would be
induced by the very content Workspace Trust exists to distrust** -- an agent reads a file from an untrusted
repository, that content proposes a command, and a dialog appears naming the command but not what caused it.
A narrower carve-out for "the user asked for this in the same turn" was also rejected, because an agent
acting on untrusted content it has just read can satisfy that condition.

**The new tool is read-only and returns no new class of data.** `inspect_task_status` reports the lifecycle
of a coordinator's own delegation handles. It **consumes nothing, messages no worker, wakes no worker, and
performs no disposition**; it does not expose another coordinator's handles, raw result text, source content,
absolute paths, commands or secrets. It is a second view of state the coordinator already receives, not a
second store of it.

**`report_context_gap` lost its model-supplied `reason`, which is a reduction in what a model can assert.**
The advertised schema now takes only the input id. `missing`, `expired`, `outside-task-scope` and
`unreadable` come from the host's own latest access observation for that exact attempt, and a later
successful read invalidates an earlier gap rather than leaving a contradiction in a durable record. **A
worker can no longer record that an input was unreadable after the host successfully read it.**

**Three host judgements over natural language are deleted, and none is replaced by a better matcher.** Two
regexes graded a delegated model's prose for whether it had claimed its checks passed or that no files
changed; both were English-only, so **the same claim in the language this product is operated in was
invisible**, and the negation window was short enough that an explicit denial could be recorded as a false
claim. Both are gone, with the two mismatch fields they set, **including from the portable-evidence key
allowlist that tests walk**. A skill description was refused unless it contained an English keyword and five
whitespace-separated tokens -- two independent English assumptions, enforced by a throw, so **no non-English
skill could be registered at all**. Both checks are deleted rather than localised. Workflow branch selection
no longer matches a substring of a model's reply, where a branch condition of `approved` fired on "not
approved"; a step declares its outcome labels, the agent selects one, and the host compares for equality.

**The migration that keeps old workflows loading does not weaken the boundary.** A pre-0.9.70 branch with no
condition meant "always", so it becomes a fallback taken only when no declared label matched. **The fallback
is never offered to the agent**, so a model cannot select the host's own reserved token, and an exact
declared label always wins over it. Genuinely corrupt data -- an explicitly empty new-format label, a
non-string legacy field, a missing target -- is still refused; only the legacy shape is repaired, and each
repair is reported as a validation warning rather than by failing the load. **Before this, a team file
carrying that shape failed validation entirely, taking its members and MCP servers with it.**

**The human-approver rule moved to one place and now covers two paths it did not.** Whether a run verdict
names a real person rather than a host actor was checked when a verdict was recorded, but **not when one was
read back from disk, and not when one was projected into portable evidence**. A host-authored verdict
persisted into the ledger could therefore have been exported as a human acceptance. Both paths now read
through a single normaliser, and mutating it fails a ledger test and an export test.

**The artifact-review policy is off by default and enforces only what the host can observe.** When a person
enables it, an explicitly marked artifact review must run under a **different reported model identity**. The
policy is stored in host-owned state and changed only through the panel's human event path; it adds no prompt
text when off. **It does not claim that two reported identities prove two different underlying models**, or
that a review was good. Team Rules now renders built-in protections as display-only, and every rendered
protection is mapped to a test whose removal fails.

**Runbook 4a was re-run in full on this tree: twelve mutations, eleven kill.** The twelfth is the
coordinator-liveness survivor recorded before this release, unchanged and not repaired here. **The two
families this release rewrote are not in that table**, so they were mutation-proved separately: five
per-action Workspace Trust mutations all kill, and the converged approver check kills both a ledger test and
an export test.

**v0.9.69 local-document and cross-project review:** this release adds **one new capability that reads
bytes** and **one new runtime dependency**, and deletes four rules. **Both additions are the ones to look at,
and the question is the same for each: does it widen what can be reached, or what can leave?**

**`read_file` reads PDF, DOCX and PPTX from a read root, and that is not a new boundary.** The file is
resolved and authorised by the identical path that admits a text file: a document outside an agent's read
roots is refused before a byte is examined, and being a document grants nothing. **The extracted text goes to
the model exactly as text-file contents already do**, so no new egress class exists and no new consent
applies -- the content-asset store's separate approval covers uploading an *image* to a remote vision model,
which this path never touches. **Nothing enters the content-asset store at all**: the text returns through
`read_file`'s own result, so there is no new asset, provenance or expiry surface.

**The parser is the part that handles hostile input, and it is isolated.** DOCX and PPTX are ZIP containers,
so a workspace file is now parsed by a real archive reader. **It runs in a `worker_threads` worker under the
same `resourceLimits` heap cap and terminate-timeout as the PDF worker** -- the comment on that worker states
the rule, that untrusted-document parsing must not grow the extension-host heap, and this obeys it rather
than repeating the mistake of parsing on the host. The size is checked with `stat` **before any bytes are
read**, so an oversized file cannot cost the heap on the way to being rejected. The reader refuses encrypted
entries, Zip64 and any compression method other than stored or deflate; it bounds declared uncompressed size,
**aborts mid-stream when actual expansion exceeds the cap**, and bounds the entry count. **It opens only
`word/document.xml` and `ppt/slides/slideN.xml`** -- never an embedded image, a macro, an OLE object or an
external relationship -- and **follows no URL for any reason**. A plain `.zip` is still refused as binary.

**`yauzl 3.4.0` is a directly declared, version-pinned runtime dependency**, not a transitive one inherited
by accident, and it has no native build step. **A hand-written ZIP reader was considered and rejected**: the
dependency was never the cost, the isolation was, and "no new dependency" would have meant parsing hostile
archives on the extension host with none of the worker's protections.

**The cross-project team library is the release's other reachability change, and every rule points inward.**
A saved team may now live in host-owned per-user storage instead of the workspace. **A repository cannot
supply that file**, which is the same property `.unode/rules.md` does not have. Crossing the scope boundary
**cannot widen permission**: a folder grant survives only if it is inside the target workspace after
resolution **and `realpath`** -- so an absolute path, a `../` escape and an in-workspace symlink pointing out
are all dropped, and each has its own test. **"Absolute" alone was the wrong criterion** and was corrected in
review before implementation. Per-agent MCP grants are removed wholesale rather than reported, because a
grant naming a server id that the target workspace happens to reuse would otherwise bind silently to a
different service. **`env` is never written to the global scope and is stripped when reading an older global
record**: `AgentConfig.env` is a verbatim user-supplied map merged into the child process environment, not a
SecretStorage reference, so a user-global file spanning every project on the machine is not a place for it.

**What was deleted, and why none of it protected anyone.** The `read_files` cross-check refused a dispatch
when a declared input was absent from a declared list -- **a list that grants nothing**, as `dispatch` states
in its own comment. It failed every limb of the keep-line, and **the authority checks around it are untouched
and re-proved by mutation**: an input outside the contract task scope is still refused, and read authority
still comes from folder access. `isSoloShapedTask` and the verification-command allowlist both **inferred
meaning from language**: one read the user's own message through English keywords and code-file extensions,
the other decided from a list of tool names whether a shell command counted as a verification. **A host that
decides what someone meant from a pattern is wrong the moment it tries**, and `verified` now comes from a
declared sensor, which is a host-observed fact.

**The Activity feed became an export surface and is bounded as one.** A tool line now names its target, so
the rule is that the target is a closed vocabulary rather than "the tool's arguments": a workspace-relative
path for a path tool, **a command's program name alone** -- never the command line, its arguments or its
environment -- and for anything else the de-plumbed tool name and nothing more. **An MCP tool the host does
not own renders as its name only**, so no third-party argument, token or absolute machine path is written
into a feed that persists and can be exported. Absolute paths outside the workspace are dropped rather than
relativised.

**The one addition that records identity carries no authority.** The effective execution identity is
host-private, lives only in process, and exposes **two named comparison facts and no verdict**. It is absent
from every prompt, tool result, roster entry and portable export -- and the portable-evidence key allowlist
that tests already walk is the enforcement point, so adding it anywhere in an export fails an existing test.
**It deliberately does not claim that two agents ran different models**, which the host cannot observe; it
records what the route reported.

**Runbook 4a was re-run in full on this tree** -- eleven mutations across both `delegate-required` branches,
read- and write-root intersection, hook approval origin binding, content-grant attempt liveness, contract
attempt exclusivity, recorded-file `realpath`, firm-retry contract carriage, task-scope input containment and
coordinator liveness. **Ten kill. The eleventh is the coordinator-liveness survivor already recorded before
this release and it is unchanged** -- not a regression, and not repaired here. For a release that deletes four
rules and rewrites three admission modules, that table is the evidence that what was deleted is not what
protects anyone.

**v0.9.68 nudge-removal review:** this release **deletes five behavioural mechanisms, one runtime
instruction and three required contract fields**, and adds one observational number. **The inverted question
again: what stopped being enforced, and could any of it have prevented harm?**

**Nothing removed was preventing harm, and the keep-line is why that can be stated rather than hoped.** A
host invariant is kept if it would otherwise widen permission, revive consent, cause irreversible
destruction, or write an unobserved fact into a persistent or user-visible record. **A nudge does none of
those.** It injects a message and costs a round-trip; an agent that ignores it proceeds exactly as before.
**A mechanism an agent may ignore was never a control**, and calling five of them safety was the confusion
this release ends.

**Two of the five were a security defect in their own right.** `looksLikeAnnouncedAction` and
`looksLikeToolDistrustRefusal` pattern-matched the agent's natural-language output and acted on the match.
**v0.9.66 established that the host must never read prose to decide what an agent claimed** — the reason
`close_assignment` and the delivery states read structured fields. That rule was applied to delivery and
left standing in the nudge layer. **A host that acts on a regular expression over model output is
manipulable by anything that writes model output**, and removing it closes a surface rather than opening
one. The removal is complete — the module is deleted, neither backend references it, and a check fails the
build if any of six names returns.

**Verification did not weaken.** Declared verification sensors and `run_checks` (v0.9.60) are the mechanism
that observes whether work was checked; the verify nudge asked politely and recorded nothing. **Deleting the
polite version does not remove the observation**, and every verification property in the canary table still
fails its mutation.

**One runtime instruction was removed on evidence, not on principle.** The guidance stating that a tool
result is not a user-visible reply was **present, correct and injected when the exact failure it addresses
recurred** (v0.9.66 §1), and v0.9.67 made its subject structural. **This audit does not claim instruction is
useless.** It records that this instruction was tested in production against its own failure and did not
hold, so its cost is no longer paid. The removal was precisely scoped: `freshRead`, the coordinator
delegation protocol and the worker grounding guidance are untouched.

**Three contract fields became optional and one did not.** `expected_deliverable`, `constraints` and
`dependencies` are ceremony — supplied to satisfy a validator, carrying no host decision. **`effects` stays
required, because `effects.writeScope` is the boundary that stops a delegate writing outside its task**, and
`required_capabilities` stays because the host filters candidates on it. **The loosening is proved at both of
its enforcement points**: the parser admits omission, and a canary asserts the schema advertised to the model
does not list those names as required. **The first review pass found only the parser proved** — a rule can be
under-proved on the way out as easily as on the way in.

**The one addition is observational and carries no authority.** Turn timing starts from the MessageBus
timestamp so queueing is visible, accumulates approval waits the host already recorded, and reports them
**separately from the total**. It travels in message metadata, **beside the transcript text and never inside
it**, so it cannot become content an agent authored. It neither retries, blocks, nor changes a completed
turn. Charging the approval wait to the turn, or starting the clock at emission instead of enqueue, each
fails a test.

**Runbook 4a was re-run in full on this tree** — eleven mutations across coordinator fallback, command-mode
narrowing, task-scope preflight, grant liveness, single live attempt, all three Solo/`delegate-required`
enforcement sites, recorded-file `realpath`, firm-retry contract carriage and hook approval digest. **All
eleven kill.** For a release that deletes enforcement, that table is not a formality: **it is the evidence
that what was deleted is not what protects anyone.**

**v0.9.67 constraint-removal review:** this release **removes** a constraint. That inverts the usual
question, so this section answers the inverted one: **what stopped being enforced, and could any of it have
prevented harm?**

**What was removed.** v0.9.66 required a coordinator to reproduce a document's bytes in a tool argument and
refused the delivery unless the reproduction matched the host's own copy verbatim. **That check is gone**,
along with the two-step declare-then-publish binding and the normalisation specification and comparison that
served it. Two tools became one.

**Nothing it prevented is unprotected now, because it never prevented anything the removal reintroduces.**
The check existed to stop an agent claiming it had shown content it had not. **In the new shape the agent
cannot make that claim at all**: it names a receipt and a state, and the host publishes its own bytes. There
is no reproduction to be wrong, no assertion to be false, and no comparison to defeat. **This is a removal
that closes the hole more completely than the check did** — the check refused a bad claim after the fact;
the new shape makes the claim unexpressible.

**What is still enforced, and why these two survived the cut.** A receipt may be published only in the
coordinator turn that recorded it, and a turn accepts one terminal state. Both fall inside the keep-line
this release adopted — they prevent content crossing a turn boundary it was never granted for, and prevent a
user-visible record being rewritten after acceptance. **Both fail their mutations**, as do slicing a
`partial` prefix host-side, refusing a fractional or out-of-range length, and clearing receipts at the turn
boundary.

**The removed constraint was a security cost, not a security benefit.** It refused a correct intent, cost
184 seconds of the strongest available model to recover from, and could not be escaped — the binding was
immutable, so a refused coordinator could not rebind to a fresh copy. **A guard that traps a correct agent
is not defence in depth; it is an availability defect with a safety-shaped justification.** Recording that
plainly is the point of this entry.

**No new authority, and the removal grants none.** The agent still cannot name a path, still cannot reach a
receipt from another turn, and still receives no capability it lacked. The content it publishes is content
the host had already read under the agent's existing read authority. **Runbook 4a was re-run in full on this
tree and all eleven mutations kill.**

**One property is asserted end to end rather than at a boundary**, deliberately: a 15.8 KB document must
arrive as an actual assistant reply and not through a bounded tool receipt. That is verified by a test that
counts model round-trips (**two**) and asserts the published bytes, because the alternative — trading a
transcription burden for a display truncation — would have reproduced the original defect through its own
fix.

**v0.9.66 declared-delivery review:** this release adds **no new network destination, no new credential
path, no new command-execution path, no new filesystem authority and no exported schema change.** It adds
two coordinator tools and one host-owned per-turn record. **Nothing it adds can widen what an agent may do;
everything it adds can only refuse.**

**The capability, stated precisely.** A coordinator may bind its turn to one content receipt the host issued
**in that turn**, then publish a final reply with a closed state — `shown`, `partial` or `not-delivered`.
The declaration names an **opaque receipt id, never a path**: the host resolves the bytes from its own
record, so the model cannot name a file it was not given, cannot reach a receipt from another turn, and
cannot revise the binding once made. Receipts are cleared at every turn boundary. **A model-supplied path
never enters this path at all**, which is the same rule v0.9.65 established for input receipts and v0.9.61
for recorded-file opens.

**The check is a comparison, never an interpretation.** `shown` requires the declared source to appear in
the reply verbatim; `partial` requires the stated omitted-character count to correspond to a prefix that is
actually present; `not-delivered` requires a reason. **The host never inspects reply prose to decide what
was claimed** — it reads a closed enum, exactly as `close_assignment` reads an outcome field rather than a
sentence. A design that recognised claims in natural language would have been a heuristic, and a heuristic
is what this release exists to replace.

**A refused claim is never published.** It is returned to the model as an error for correction. **This is
the security property of the release**: the product could previously tell a person it had delivered
something it had not, and the mechanism that now prevents it is a host comparison rather than an
instruction. Both mutations — dropping the `shown` verbatim check and dropping the `partial` prefix check —
fail tests, as do binding a foreign receipt, carrying a receipt across a turn boundary, revising a binding,
and replacing an accepted terminal state.

**The guidance layer is deliberately not the fix, and is pinned.** This exact failure was addressed in
v0.9.61 with runtime guidance that says the right thing — *"'I read it' is not 'I showed it to you'"* — and
it was present, correct and injected when the failure recurred on v0.9.65. **A rule that lives only in a
prompt is not a rule.** This release adds no prompt text and no nudge family; a canary fails if that
guidance string changes, and a turn that declares nothing produces the same transcript, evidence and prompts
as before.

**Deferred streaming output fails open.** The Claude backend holds assistant text emitted after a
declaration so unvalidated prose cannot appear as the answer before the host has checked it. **If the turn
ends without a terminal state, that text is emitted unchanged** — the deferral can delay output, never
discard it, and it is bounded by the turn.

**One correction was made to this card's own design during review, and it prevented false refusals.** An
earlier draft would have refused `shown` whenever the tool card's preview was truncated. That is wrong: the
capped `detail` is the card's preview, while the full `output` is what the model receives, so a truncated
preview says nothing about whether the reply contains the content. Verified in code before the criterion was
removed.

**Runbook 4a was re-run in full on this tree** — eleven mutations across coordinator fallback, command-mode
narrowing, task-scope preflight, grant liveness, single live attempt, all three Solo/`delegate-required`
enforcement sites, recorded-file `realpath`, firm-retry contract carriage and hook approval digest. **All
eleven kill.**

**v0.9.65 path-identity review:** this release adds **no new network destination, no new credential path,
no new command-execution path, no new product capability, and no new exported schema** —
`portable-run-evidence/2` is carried unchanged from v0.9.64. It changes how a path is resolved, how a read
receipt is matched, and what the closeout can assert. **Two of those three are security-relevant, and one of
the fixes could itself have become a disclosure.**

**A task scope was a ceiling that also moved the floor.** `primaryRoot` carried three unrelated ideas at
once: the base a model-supplied relative path resolves against, the authorisation roots, and the shell
working directory. Under a scope it took the value the third wanted, so the first moved with it and a
declared workspace-relative input resolved one segment too deep. **Read-side this failed closed** — the file
was not found and the task reported a context gap. **Write-side it did not.** The doubled path was still
inside the scoped write root, so the authorisation check passed and the write created its parent directory:
**a delegated write under a `readwrite` task scope landed in a folder nobody declared and reported success.**
That is the more serious half, and it was silent.

**The fix separates the three, in the types rather than by convention.** `pathBase` is always the agent's
configured root and a model path is resolved against it exactly once; `readRoots`/`writeRoots` do
authorisation only, against the already-resolved absolute path; `commandCwd` stays inside the effective
writable scope. **`commandCwd` deliberately does not follow `pathBase` back to the workspace root** — a
shell is not a full filesystem sandbox, so a command's working directory is a containment boundary in a way
a resolved path is not, and widening it would hand a scoped task a broader starting point than its scope
grants. A last-boundary re-derivation collapses an out-of-scope `commandCwd` before spawn even if a future
caller supplies one, and **that collapse is mutation-proved rather than left to every caller behaving.**

**Authority did not widen.** Resolving once and then checking narrows nothing and grants nothing: a file
outside the scope is still refused even though the base can now reach it, and every v0.9.61 canary still
fails its mutation — a contract scope only narrows, an `InputGrant` binds to an attempt and dies with it, a
contract never holds two live attempts, Solo is never an automatic fallback in any of its three enforcement
sites.

**An input receipt was derived from model input rather than host observation, which inverted this product's
own evidence rule.** A read was matched by normalised string equality against the declared path, so an
absolute path — or a case variant on a case-insensitive filesystem, where contract admission lowercased and
receipt matching did not — marked nothing. **A file the host had demonstrably opened could be reported as
unread**, and it was: the Owner's reviewer produced line counts and a thirteen-point audit while the
receipts said `read=no`. Matching is now by resolved physical identity through **one primitive shared with
contract admission**, so the two halves of the product can no longer disagree about whether two spellings
are the same file, and case follows the filesystem instead of a hard-coded assumption that is wrong on one
of the two kinds.

**The receipt fix was itself a disclosure risk, and is closed by construction.** An `InputGrant` lives
inside a `TaskAttemptCard`, which is formatted into text a worker model receives **and** flows into both the
internal evidence pack and portable evidence. **Storing an absolute physical path on a grant would have
leaked the host's directory layout to a model and into an artifact whose entire purpose is to carry no
paths.** The identities are held in host-private attempt state, cleared when the attempt ends, and never
copied onto a grant; a mutation that copies one onto the card fails a test. **A Windows-specific canary
defect was found and fixed during that work** — `JSON.stringify` escaping of backslashes let a leaking
mutant survive an assertion that searched the serialised form, so the assertion now inspects the structured
value instead. **A canary that a path separator can defeat is not a canary.**

**The closeout can no longer infer a judgement that was never made.** A recorded-disposition count is now a
real count, not `settledButUndisposed === 0`, which is also true when nothing settled, when everything was
cancelled, and when the only event was a refused dispatch. A mutation replacing the count with the settled
total fails a test.

**Runbook 4a was re-run in full on this tree** — eleven mutations across coordinator fallback, command-mode
narrowing, task-scope preflight, grant liveness, single live attempt, all three Solo/`delegate-required`
enforcement sites, recorded-file `realpath`, firm-retry contract carriage and hook approval digest. **All
eleven kill.**

**v0.9.64 actionable-exception review:** this release adds **no new network destination, no new credential
path, and no new command-execution path.** It adds **host actions a webview can trigger**, one new persisted
vocabulary, and one **widened exported enumeration** — and saying it "adds no new authority" would understate
the obligation, so it is not said.

**What the webview gained, stated precisely.** A chat panel may now send `repairAction` with a bounded
`kind` and an opaque host-issued `outcomeId`. **It cannot name an agent, a model, a task, a command or a
path.** The host resolves every one of those from its own record of the terminal outcome, and the protocol
parser refuses a readiness repair kind that carries an `outcomeId` at all. **Nothing is derived from rendered
text**: the blocked-delegation prose is unchanged and is never parsed; the structured receipt is emitted by
the host branch that produces the terminal state.

**A rendered offer is not authority, and neither is the absence of one.** Every arriving `repairAction` is
re-validated at invocation, not at render: the outcome must belong to the currently selected agent, the
target agent must still exist, the session must still be reachable, and the invoked kind must match the
action the card currently offers. A record in the `unavailable` state has no action, and that is what refuses
it. Each of those four checks was mutation-tested and each fails a test — including the reachability check
and the offered-action match, which survived the first review pass and were closed before release.

**A repair is idempotent, and a retry is a new attempt.** Repeated and concurrent clicks on one outcome
produce exactly one effect, guarded at both the click and the receipt. A delegation retry re-enters
`startContractAttempt`, which re-runs the delegatable roster, the full candidate filter and fresh
`beginAttempt` grant issuance. **It never re-uses a dead attempt, a dead grant or an old handle**, and a
mutation that lets it fails a test.

**An expired approval can never become an approval, and this release did not build a way to try.** E3b — an
offer to re-issue a consent — was gated on showing, per approval origin, that the host retains a rerun
recipe. **No origin cleared that gate**, because `ApprovalQueue.expire()` deletes the resolver and resolves
the caller's promise with a denial, so the continuation has already run. **No E3b code was written.** A
timed-out card states that the request cannot be resumed and offers nothing.

**One correctness defect was found by this release's own canary table and closed.** A `delegate-required`
contract must never fall back to coordinator execution. That property has three enforcement sites; two had
proofs. The site that fires after `startContractAttempt` fails — a file-claim conflict, a refused grant, a
refused dispatch — was correct in production and untested. Both remaining sites now fail their mutations.
**Production behaviour never changed; the guard is what was missing**, which is the same shape recorded in
v0.9.61, v0.9.62 and v0.9.63 and the reason a standing card exists for it.

**Portable Run Evidence moves to `portable-run-evidence/2`, and this is a declared breaking change.** A
timed-out approval was previously indistinguishable from a human denial: `recordApprovalMetric` collapsed it
to `denied` and the portable `decision` field admitted only `allowed | denied`. It now admits `expired`.
**A strict reader of the v1 two-value enumeration will encounter a third value** — that is the reason for
the version bump rather than a silent widening. Repairs export as a closed
`consent-timeout | delegate-empty` category with an `offered | invoked | unavailable` state, re-validated at
export as well as on ledger restore. **The opaque outcome id is declared in the exclusion list and stays
internal**, along with every agent id, model name, path, task text, attempt, grant and approver identity.
Nothing identifying was added to the artifact.

**And one user-visible correctness defect, on this release's own subject.** The roster rendered a timed-out
approval as `!` — the same non-colour marker as verification-failed, no-evidence, coordinator-rejected and
human-intervention-required — while the roster's own status key, the manual and the wiki all documented
`⌛`. The cause was a key collision: a delegated task that timed out and a consent request that expired both
arrived as `'timed-out'`. They now have distinct keys, the documented marker renders, and each is tested
from its real producing path.

**v0.9.63 chat message-boundary and step-timing review:** this release adds **no new network destination,
no new credential path, no new command-execution path, and no new product authority.** It adds one new
persisted field — `completedAt` on a tool card — and one new build gate. Verified against the release diff:
the changed source files are `ChatViewProvider.ts`, `chatToolHistory.ts` and the new protocol module; no
backend, extension-host or evidence source file is touched.

**The security question here is whether typing a message made it more trusted. It did not.** Every
`ChatViewProvider` inbound command now has one declared shape parsed once at the boundary, replacing sixteen
hand-written `typeof` checks. The parser rejects an unknown command, rejects a payload carrying any field the
command does not declare, and bounds every field — identifiers at 160/240/120 characters, an approval note
at 16 KiB, the observation array at 256 entries. **What the message may then do is unchanged:** the webview
still names only opaque host-issued ids and never a path or an authority, and the host still re-derives
every permission from its own state. Attachment validation is the same pre-existing bounded validator.

**Two authority checks that were correct but unguarded are now guarded.** Removing the identifier length
bounds failed no test before this release, and neither did removing the check that **Open full file in
editor** only accepts a receipt belonging to the currently selected agent. Both mutations now kill — the
first against twenty protocol assertions, the second against a regression test that constructs two legitimate
agents, selects one and requests the other's real receipt. Behaviour never changed; the guards did not exist.
**This is the third consecutive release in which an authority check shipped correct and untested** (v0.9.61
coordinator fallback, v0.9.62 firm retry, these two), which is being carried forward as a structural question
rather than a third patch.

**The new gate is falsifiable.** `check:chat-webview-protocol-boundary` fails if a hand-written `typeof msg.`
validator reappears in a migrated provider, and it self-tests by planting a violation and requiring its own
rejection. It runs in `pretest`, so it gates every test run and every CI job, and it is included in the
public source drop.

**Batching and virtualisation cannot drop a security-relevant event.** A consent prompt, an approval, a
cancellation, an evidence fact, an error and a final answer must arrive complete and in order through the
production frame coalescer and the production webview animation-frame pacing — the same exported source
string the webview runs, not a model of it. Mutating the delivery path to drop one block fails that test.

**Step timing adds a measurement, not a disclosure.** `completedAt` is recorded only at the `use`→`result`
transition and persists in the same chat history that already stores the start time. **It does not enter
portable evidence**, which carries no per-tool timing, and a duration is never inferred from render time: a
card without a measured finish reports *duration not recorded* and a group containing one reports a
*partial span*.

**v0.9.62 orchestration-boundary review:** this release is a bounded refactor with **no new product
capability, no new network destination, no new credential path, no new command-execution path, and no new
persistent record.** Verified against the release diff: `src/extension.ts` is the only modified source file,
and the added files are a host adapter, its tests, and a boundary check script.

**The security question for a refactor is not what it adds — it is what it quietly stops enforcing.** So the
review was the authority canaries rather than a diff read. Every property mutation-proved in v0.9.60 and
v0.9.61 was re-run on the refactored tree: the coordinator fallback still re-runs the full filter, an
`InputGrant` still binds to an attempt and dies with it, a contract still cannot hold two live attempts,
Solo is still never an automatic fallback, a recorded-file open still resolves `realpath` before comparing
against current read roots, and a hook approval still binds to declaration digest and origin. Each still
fails its test.

**One canary survived, and the survival was informative rather than alarming.** The task-scope property had
moved to a stronger check — `preflightTaskScope` inside the candidate filter — and re-running the mutation
in its new location killed it. **A surviving mutant after a refactor is a question about where the property
went, not a verdict that it is gone**, and answering it is now part of the release runbook.

**One guard was genuinely missing, and it predates this release.** Dropping either the declared files or the
task contract from a firm retry failed no test. Production behaviour was correct — both are passed — but the
regression test had stopped discriminating in v0.9.61 when `dispatch` was rewritten to carry a contract. The
same mutation survives at the `v0.9.61` tag, and `TeamTools.ts` is untouched here, so this was inherited
rather than introduced. It was closed before this release shipped, with the assertion comparing the retry
payload against the first dispatch's rather than against a literal, so a future signature change cannot
hollow it out the same way.

**The boundary is enforced by a check, not by intent.** `check:orchestration-boundary` fails if the
composition root declares an orchestration policy function again. It self-tests in both directions — a
planted declaration must be caught, and a commented-out one must not be — and it was verified by planting a
real violation in `extension.ts` and confirming the gate fails.

**v0.9.61 task-contract and receipt-open review:** this release adds **no new network destination, no new
credential path, no new command-execution path, and no new persistent record.** It adds one new
host-mediated filesystem entry point — opening a file the user clicks in a tool receipt — and replaces the
delegation authorisation model with one that binds authority to an execution attempt rather than to an
agent or a clock.

**The webview never names a file, and three independent boundaries stand behind the one that does.** A tool
receipt's *open in editor* action sends only an opaque `agentId` and `toolId`; the provider refuses unless
the agent is the currently selected one, resolves the path **from the host's own durable tool receipt**, and
the extension then re-derives that agent's current read roots and resolves the physical path with
`realpath` **before** comparing it to them. A symlink therefore cannot turn a receipt into a path outside
Folder Access, and a stale receipt whose file has moved reports that rather than opening something else.
This is a user-initiated read into the editor; it grants no agent anything. All three properties are
mutation-proved: removing the symlink resolution, the root containment check, or the containment predicate
each makes a test fail.

**Authority now binds to an attempt, not to an agent and not to a TTL.** v0.9.59 expired turn-supplied
grants per turn and v0.9.60 established that a firm retry is a second execution of the same task. Together
those made "per task" too loose. An `InputGrant` is `{ attemptId, agentId, inputId }`, every authority check
requires the attempt to still be live, and one contract can never have two live attempts. Ending an attempt
revokes its authority synchronously while leaving the grant in the historical card as a receipt — the record
of what was authorised survives; the authority does not. Mutation-proved in all three directions: removing
the asset-read authority check, letting an attempt never end, or allowing concurrent attempts on one
contract each fails tests.

**One grantability decision, two callers.** `preflightInputGrants` answers *could every required input be
granted to this agent* and is called by both the candidate filter and the real grant path. Two
implementations of that question would drift, and the drift would be a silent authorisation difference
between what was checked and what was issued.

**The coordinator executing its own contract gets no looser path.** Falling back to the coordinator re-runs
the same capability, scope, file-claim, input-grant and sensor checks a delegate faces, and a coordinator
already holding a live self-executed contract is refused a second one. **This invariant shipped unguarded
in review and was caught by mutation** — the entire suite passed with the coordinator's re-validation
removed, while the product's own message to the user continued to claim every gate had been re-evaluated. A
regression test was added before release; the mutation now fails as it should. Solo is never an automatic
fallback, and `no-executor` is a distinct task state that says so rather than being recorded as an agent
failure.

**Portable evidence carries ordinals and booleans, never contract prose.** A task state exports its kind, a
document-local input ordinal and a reason code; an input receipt exports the ordinal plus `supplied`,
`reachable` and `read`. The coordinator-authored objective, the input purpose text and every raw identifier
are withheld and declared in the artifact's own omission table, and their absence is proved rather than
asserted: the fixture seeds them with a `SECRET-` prefix that a whole-document canary forbids, and leaking
the purpose field into the export fails that canary immediately.

**What the host claims to know is bounded by design.** `supplied` means the host issued a grant, `reachable`
means a granted tool resolved the source, `read` means a read receipt was recorded. **`understood` is not
representable** — there is no field for it, which is the point.

**v0.9.60 execution-hook and task-contract review:** this release adds **no new network destination, no
new credential path, and no new command-execution path.** It adds one new host-owned gate that can only
ever *subtract* authority, one new persistent record to authorise that gate, and one new field that carries
file paths to a delegate without carrying permission.

**The execution-hook gate has no vocabulary for granting anything.** A declaration selects a shipped
host action by id — it is not a script, not a repository file, and not a model tool surface — and the only
effect available to it is refusing an action the agent could already take. Declaration parsing rejects any
field resembling a grant (`command`, `write`, `writeScope`, `network`, `mcp`, `grant`, `permissions`, and
their plurals) **before** it looks at ordinary syntax, and unknown fields are refused outright rather than
ignored. Every hook carries an enforced time ceiling and output ceiling, and **fails closed**: a hook that
times out, errors, exceeds a ceiling, or names an action the host does not have blocks the action it gates
rather than waving it through.

**A repository cannot supply a hook, and this was found in review rather than after release.** The first
version of this design read `unode.executionHooks` as an ordinary setting on the reasoning that a setting is
a human act. **That reasoning was wrong**: a repository can ship `.vscode/settings.json`, which would have
replaced *"a repository must not obtain execution rights by shipping a hook file"* with *"a repository
obtains them by shipping a hook setting"*. Nothing in the product defended against this — `inspect()` had
exactly one use, for detecting a settings change, and Workspace Trust does not cover it, since trusting a
repository enough to open it is not approving a gate that runs before every tool call.

The shipped rule is therefore: **the setting is an inert candidate in every scope**, with no user-scope
exception — a scope-dependent rule is one `inspect()` mistake away from the same breach. A hook takes effect
only after an explicit `UnodeAi: Apply Execution Hooks`, in which the complete normalized declaration is
shown and confirmed; approving a hook by name is not approving a hook. The approval is stored in the
extension's own workspace state, **which lives outside the repository and no repository can write**, and is
bound to a SHA-256 digest of the normalized declaration *and* its settings origin. Editing the declaration,
moving it to another scope, or presenting a record that does not match makes the hook inert again. **No
agent has a tool to write the setting or the approval record** — neither VS Code command execution nor
settings writes exist on any model-facing tool surface — and because the registry is resolved lazily at each
hook point, revoking an approval reaches an agent that is already running.

Each of these is proved by mutation rather than asserted: removing the approval requirement, the origin
binding, or the digest binding each makes a test fail. A guard no test can kill is not a guard.

**A verification plan carries sensor kinds, never commands or prose.** The plan's vocabulary is a closed set
of four host-observed sensor kinds. It has no command field on purpose, so the existing command policy
remains the only way a command can execute, and a model's plan cannot become a way to run something. Plans
are evaluated only against evidence the host recorded while the task ran; no model prose is evidence that a
plan was satisfied. Portable evidence carries the sensor kinds and the host's result under the existing
closed field allowlist, with plan prose declared in the artifact's own omission table.

**Declared task files are location, not permission.** A coordinator's `files` list now travels with an
assignment and with the firm retry after an empty reply. It does not widen `taskWorkspaceAccess`: a declared
path outside an agent's resolved scope stays unreadable and unwritable, asserted by a canary that names a
file outside the scope and checks the resolved ceiling is unchanged.

**v0.9.59 authority and record-boundary review:** this release adds **no new network destination, no new
credential path, no new command-execution path, and no new persistent file written outside the existing
stores.** It **narrows** one authority that was too wide, adds one model-facing read confined to the calling
agent, and adds one human record whose identifying half is withheld at export.

**Turn-supplied content is no longer readable by any agent that holds generic read permission.** To carry a
user's own sources across a delegation, this release gives the whole team one host-owned content asset store.
That made a shared store reachable by every agent, while `read_extracted_content` gated only on the generic
`read` capability and asset ids are sequential ordinals (`content-1`) — so an agent could reach material it
was never handed by naming an id. **This was found and closed before release, and proved both ways:** a
canary in which a second agent reads another agent's asset fails against the shipped build, and removing the
guard makes it pass again. Reading an asset now requires either an explicit grant carried with **this** turn
or ownership by the requesting agent. Ownership is host-recorded and is not a model-supplied field. A grant
does not survive into the next turn, so a TTL-scoped asset does not become quietly readable later, and the
refusal states that the asset **is not available to this agent** rather than that it does not exist — the
honest fact, and the one that stops a model retrying against a wrong id.

**An agent can read its own conversation log, and only its own.** `search_conversation_log` and
`read_conversation_log` are bounded search-then-read tools over a projection of the message bus. **The
projection takes no caller-selectable subject**: the agent id comes from the host, not from a tool argument,
so generic read authority cannot become authority over a teammate's history. The projection carries typed
message text only — attachments, payload metadata and raw bytes are absent by construction — and output is
capped (20 entries per read, 20 search results, 20,000 characters). Every read states its range against the
total, so a partial read cannot be presented as the whole conversation, and the result is wrapped as earlier
transcript **context, never as a new instruction, tool directive or permission basis** — the same untrusted-
data framing already applied to fetched web and PDF text. Reads produce a bounded receipt carrying the range
and no content.

**A human acceptance verdict is stored, and the person who gave it does not leave the machine.** A verdict is
refused unless its approver is contemporaneous and human: an empty or `system:`-prefixed actor cannot record
one, matching the rule already enforced for command, write, tool and web approvals. A run with active
delegated work cannot be judged, `accepted-with-exceptions` without unresolved items is refused, and verdicts
are append-only — nothing rewrites an earlier answer. **No coordinator disposition, framework `verified`
outcome, closed status, or user silence is converted into a human verdict anywhere in the code**, which is
the specific misuse this record exists to prevent. In portable evidence the verdict travels as its value, a
document-local `approver-N` ordinal, and a **count** of unresolved items; the approver's stable local id and
the prose a person typed are withheld and declared as withheld in the artifact's own `omitted` table. The
verdict field set is a closed allowlist, validated at the export boundary.

**The durable conversation record is now separate from the request history.** Previously the array trimmed to
fit a model's context window was also what was persisted for a restart. This changes what is **stored**, not
what is sent: no additional content reaches any provider, the trimming algorithm is untouched, and the record
stays local. It has its own message and byte bounds so a long session cannot grow it without limit.

**Coordinator closeout nudges no longer demand an unrunnable check.** A host instruction that the host itself
then refuses is a correctness defect rather than a security one, but it is recorded here because it removed a
loop in which a coordinator repeatedly re-entered tool use with no reachable terminal state.

**v0.9.58 media and credential-boundary review:** this release adds one genuinely new outbound content type
and one new consent that governs it, narrows the surface that can store a credential, and refuses video
rather than approximating it.

**A stored image can now reach a vision route, and only through a decision of its own.** An image fetched by
`fetch_url` is adjudicated by magic bytes (PNG/JPEG/GIF/WebP signatures; the declared MIME is display
metadata, never authority), held in the same temporary, expiring asset store as a PDF, and given the same
opaque ordinal (`content-1`). The model cannot send it by mentioning it: it must call
`send_image_asset_to_model`, and the host then requires, in order, that the exact route
(connection + model + endpoint) is known to support vision — `unknown` is refused, absence never reads as
support — and that you approve a **separate modal** naming the media class, the provider, the host, the
byte count, and the estimated input cost where the route publishes one. **Public-download approval does not
authorise a provider upload, and ordinary model-egress approval does not either.** These are stored as their
own grant kind, keyed per host *and* per purpose, so approving vision on a host does not approve
transcription on it; a legacy host-only consent entry cannot migrate into a media grant at all, because a
bare hostname cannot honestly mean either purpose. The general grant and revoke calls throw if handed the
media kind, so a future call site cannot create one by accident.

**An approved image is authorised for exactly one request.** It is attached to the request body only, never
to conversation history or a persisted snapshot, and it is cleared when that request settles — including on
a gateway failure and on user cancellation, so a later, unrelated turn cannot resend it without asking
again. Both of those paths are pinned by tests that were mutation-tested: each fails when its clear is
removed. If the provider rejects the image, the rejection is recorded against that exact route rather than
latching a global "no vision" flag, the asset is dropped, and the retry carries an explicit statement that
the image was omitted — so a text-only answer cannot be mistaken for analysis. Portable Run Evidence
receives only class, action, processing class (`local-storage` or `remote-vision`) and consent outcome
against a document-local ordinal; the validator rejects any combination that does not match, and no URL,
path, filename, byte, or provider payload is carried.

**A local PDF you attach takes the public PDF's path, not a second one.** It enters the same store under the
same `%PDF-` signature check and the same 10 MB ceiling, and the model receives only a receipt and the
existing page-scoped read and search tools. The filename never reaches the model, durable history, or
evidence. Admission is conservative over both the reported and the received length, so a forged small `size`
cannot walk an oversize file past the boundary. Backends that cannot honour this path — the Claude CLI and
Codex CLI runners — refuse the turn and say so rather than silently dropping the attachment. All user
attachment ceilings are now the store's single 10 MB limit, raised from 8 MB.

**Video is unsupported and says so.** `fetch_url` refuses declared or sniffed video before reading the body.
No decoder, native module, WASM, PATH-discovered FFmpeg, or first-use download was added, and none was
approved. Each candidate was measured against the canonical artifact and rejected on the record: no
bundled decoder had a candidate with a licence, codec set and platform matrix to review; no `ffmpeg` or
`ffprobe` was discoverable, and a PATH lookup would make a machine-local binary an implicit dependency of
unknown version and licence; and no transcription endpoint contract exists whose cost and retention could be
described truthfully before asking. Metadata inspection is not offered as video understanding.

**One door now stores a provider credential.** Seven interactive entry points previously wrote a key and
only one of them asked for the account's price coefficient or invalidated the caches derived from the old
key — so a discounted key silently over-reported cost and a replaced key kept showing the previous key's
prices and model list. Storage, the coefficient prompt and invalidation are now a single boundary that every
interactive door crosses. `SecretsManager.promptAndStore` and `SettingsBridge.setApiKey` were **deleted**
rather than rerouted, and the settings bridge no longer has a secret-write method at all. The two writes
that are not a user stating a credential — the legacy `ROAM_API_KEY` migration and the E2E fixture — stay
silent by design. A packaging-time gate scans the whole production source tree for credential writes and
fails on any surface outside four reviewed files; it was verified by planting an eighth door in a new file
and confirming the gate named the file and line.

**No new capability was added to the shipped artifact.** The VSIX still contains zero `.exe`/`.node`/`.dll`/
`.wasm`, still ships three JavaScript outputs, and grew by 6,926 compressed bytes (+0.36%) because the media
work reuses the PDF worker already shipped in v0.9.57 rather than adding a second media dependency. The
extension-host proof seam added for local PDFs runs only in `ExtensionMode.Test` and is not exported from
`activate()` outside it, so it is unreachable in a published build. No new network destination, activation
-time path, telemetry, persistence format, or model authority is introduced by this work.

**Historical v0.9.56 review:** three narrowings, one new model-facing authority, and one activation-time
**settings write** — the first thing this extension does unasked since the activation-time network path was
removed, so it is described in full rather than summarised. `backfillPriceMultipliers` gives each
already-configured gateway an explicit price coefficient of `1`. It touches only connections whose key is
actually in SecretStorage, writes the value `1` and no other value, leaves a bare-number setting alone,
writes nothing when there is nothing to add, makes no network request, and says what it did once with a link
to the setting. It exists because "nobody has stated a rate" and "this key pays list price" were the same
absent value, which is a correctness problem in the direction of under-reporting cost. `cancel_task` is new
authority: a coordinator can end a teammate's turn, not merely ask. It is bounded by the host, which decides
whether the stop happens and reports whether it did — never the coordinator itself, and never a solo agent,
which belongs to no team; both boundaries are now asserted in a real extension host rather than against an
injected callback. The three narrowings all reduce what reaches a model: one content sniffer now guards
`fetch_url`, `read_file` and attachments with magic-byte, control-character and strict-UTF-8 checks; the
fetch boundary classifies Content-Type and refuses an oversized declared length before any body is read, then
streams through a reader that cancels at 1 MB; and a delegated task scope is refused **before** `task.assign`
rather than silently widened. `credentialFingerprint` is a 32-bit FNV-1a tag that keeps two keys in two cache
slots — **not a cryptographic control**, and documented as such at the definition. No new network
destination, no new credential path, no new persistence format, no telemetry.

**v0.9.55 review:** this release changes the boundary of an artifact designed to leave the organisation.
New runs retain three exact internal facts: the actor attached to a contemporaneous human approval, the
host-resolved route/endpoint/privacy-domain receipt, and SHA-256 hashes computed while changed-file bytes
still exist. The internal Markdown pack shows the first two. The portable builder never trusts those raw
identifiers: approvers become document-local ordinals; exact built-in route tuples become closed categories;
custom route ids, private hostnames, and endpoint-bearing privacy ids stay out. An MCP grant exercise, prompt
expiry, or host disposal has no durable human approver. Source/diff bytes are hashed synchronously and never
attached to the `RunRecord`; incomplete observation fails closed to an explicit unavailable declaration.
Portable hashes still disclose equality and permit confirmation guesses, and workspace-relative paths and
timestamps still identify work, so all three are declared in the artifact's `retained` section. These are
local persistence/export changes, not telemetry, a new destination, or automatic egress.

**v0.9.54 review:** two new surfaces, both local-only. Saved teams add a **write path** — the roster is
written to `.unode/teams/*.json` through the same serializer and validator as `.unode/team.json`, so a route
persists a connection id and a model id and never a key. It is not a claim that the file carries nothing
historically sensitive: in v0.9.54 an agent's `env` map was persisted verbatim, exactly as `team.json` then
persisted it. v0.9.81 ends both writes and ignores the field on read. The
`${VAR}` placeholder rule applies to MCP server env rather than to this. `.unode/` is excluded by the
`.gitignore` the extension itself writes, so a saved team is not committed by accident. Portable Run Evidence
adds an **export**, not an egress: the host writes a file the user chose. It carries no composed prose,
ordinalizes configured agent ids, and explicitly declares the workspace-relative paths and timestamps it
retains. Neither surface adds a network path, a credential path, a tool, or a permission.

**v0.9.40 review:** Capability profiles add local Settings visibility for protocol and compatibility facts.
Their observations live only in a backend session; they have no automatic persistence, telemetry, listener,
or network path. Exporting an observation yields an approval-required proposal, not a saved configuration
change. This release does not add a security-sensitive egress or effect surface.

**v0.9.45 review:** a coordinator may attach an explicit, temporary folder scope to one delegated
assignment. It is a narrowing only: the host intersects it with the delegate's configured Folder Access,
does not persist it, and removes it before the next turn. It cannot grant a new path, write access, shell
access, or a way around Workspace Trust, CommandPolicy, write approval, or the Claude `PreToolUse` gate.
The host refuses a scoped dispatch for a backend that cannot enforce a per-turn filesystem boundary instead
of claiming that it did. The intersection (including a request wider than the permanent grant), read-only
per-turn enforcement and reset, scoped-dispatch error path, and visible temporary scope are covered by unit
tests; the wording of a task is deliberately **not** used to infer a scope.

**v0.9.46 review:** the selected OpenAI-compatible edit dialect remains inside the existing rooted-write,
approval, checkpoint, and exact-old-text boundaries; the dialect changes advertised syntax, not authority.
Tool descriptions now state the actual anonymous/public-web and shell-dialect limits and are source-gated.
Delegation evidence no longer treats read-only tool activity as delivery: it is labeled “tool activity
recorded; delivery not checked”; only recorded writes with a passing observed check are `verified`. The
classification is deterministic and does not send content to a model or infer whether prose was adequate.
The Messages export now records retained-window truncation metadata; this adds no egress, telemetry, or
retention beyond the existing local bounded presentation history.

**v0.9.47 review:** a coordinator disposition is an explicit local tool call made after the coordinator has
decided what to do with a settled result. It is not inferred from reply text and no LLM grades whether work
was adequate. The bounded reason for a rejection is delivered over the existing local MessageBus to the
delegate and is rendered with the amendment; no new network destination, credential path, or authority is
created. Current-session counters remain coordinator observations only: no human or enterprise acceptance
record is stored or claimed.

Repository instructions and structured Markdown under `docs/` now contribute deterministic L1 indexes to a
normal model prompt. Their fixed instruction precedence is unchanged, and a relevant full source remains an
explicit root-confined `read_file` operation. The indexer rejects outside-root and symlink paths and does not
confer a permission, but its compact workspace text is still normal prompt context sent only to the provider
the user configured and approved. This is a narrower standing disclosure, not a new egress route or a claim
that no model request contains workspace material.

**v0.9.53 review:** two role catalogues and nine instruction files; **no new egress path, credential path,
tool, or permission**. Skills are Markdown read into a prompt — the validator rejects executables and
symlinks under `skills/`, and that is unchanged. These roles do carry `read`, which on the Claude backend is
the capability that makes public-web tools advertisable when `unode.webAccess` allows or the user approves
an `ask`; that existing consent-gated path is unchanged and is not widened by adding a role to it. The Contract & Compliance roles are constrained by
capability, not by wording: the privacy and GRC seats deny write, shell and delegation, and the contract
analyst denies shell and delegation. One skill is a **refusal**: sanctions, export-control and licensing
questions are routed to a named human rather than determined, because a classification an agent produced
would be relied on as a clearance. Nothing in this release reads, stores, or transmits the documents such a
team would work on beyond the existing folder-access and approval boundaries that already govern every
agent.

**v0.9.52 review:** no new network destination, credential path, or authority. `close_assignment` and the
host-authored closeout are local records built from framework-observed counts; the closeout text carries no
file path, no message content, and no model output. Replacing blocking delegation with `dispatch_task` /
`collect_ready_tasks` changes when a coordinator's turn releases, not what it may reach: file claims, folder
scope, command policy, write approval, and the Claude `PreToolUse` gate are untouched, and the retired tools
remain reachable only through the existing host-owned compatibility path. The idle watchdog now counts
material output rather than any byte, which can only end a turn sooner. The disappearing-reply sensor is
observation-only: it reports item identifiers, counts, and turn epochs — never message text — and its
records live in extension-host memory for the session, are capped, and are never persisted or transmitted.

**v0.9.51 review:** entirely a disclosure-accuracy release. No new network destination, credential path,
stored field, tool, or authority. Every change alters what a local surface *says* about state the extension
already held: the composer meter distinguishes an unstarted agent from a runtime that owns its own context
instead of rendering both blank; the compaction result stops giving one answer for three conditions; the
per-turn receipt states that it counts attached sources only, not the conversation, system prompt, or tool
definitions. The new `UnodeAi: Compact Context` command invokes the existing local compaction path and
reaches no network. The context receipt's numbers and its sensitivity/staleness signals are unchanged; no
matched content, path, or file body enters any of the new strings.

**v0.9.50 review:** context-window discovery adds no network destination. It reads the model list the user
already asked for and already consented to, through the same `consentGatedFetch` path, and there is no
activation-time, timed, or speculative probe — the constraint that the v0.9.29a incident below exists to
enforce. A provider's refusal of an oversized request is recorded as a per-model ceiling: a model id, a token
count, and an ISO timestamp, stored with the agent roster. It carries no conversation content, no path, and
no credential, and it can only lower a limit, never raise one or grant anything. The streaming and retry
deadlines added here bound how long a request may run and stop an oversized body from being resent; both
reduce spend and resource use rather than extending authority.

**Summary:** UnodeAi is an in-editor AI coding-agent extension. It runs models *you* choose against your
code, and — *with your consent* — can run shell commands, edit files, and call tools. It has **no telemetry
or remotely reachable control service.** Model traffic goes only to a provider you configure and choose (since
v0.9.99 that choice is the approval, announced by a notice; §2); other network-capable tools are explicit and
documented below. Every high-risk capability is gated or has a default the user can narrow; since v0.9.98, commands
run automatically by default, with the floors in §3, and since v0.9.99 public web access is allowed by default.

---

## 1. Network egress — what leaves your machine, and where

UnodeAi can make outbound requests to these categories of host:

| Destination | What is sent | When |
|---|---|---|
| **The AI provider/gateway route you select** (registered endpoints such as `api.openai.com` and `openrouter.ai`, or a named Custom gateway's locally stored HTTPS endpoint) | Your prompt + any workspace files the agent includes + the model name | Only when an agent runs, **and only to a connection you set up and chose**; since v0.9.99 the first request records the grant and shows a notice, and a destination you revoked or declined is asked about again first (see §2). A workspace agent file cannot replace a registered connection's endpoint or secret identity. |
| **A vision route you select, carrying bytes of a stored image asset** (same provider/gateway host as above) | The image bytes of one temporary `content-N` asset, for one request | Only when an agent calls `send_image_asset_to_model`, the exact route is known to support vision (`unknown` is refused), **and** a separate media grant exists. Since v0.9.99 the first upload to a vision or transcription model you set up records that grant with a notice; after you revoke or decline it, a modal naming the media class, provider, host, byte count and any published input-cost estimate asks again before any upload. This grant is stored per host **and** per purpose — approving vision never approves transcription — and neither public-download approval (§1) nor model-egress approval (§2) authorises it. The asset is attached to that one request, never to history, and is dropped when the request settles, including on failure or cancellation. |
| **Provider billing / model-metadata endpoints** (`/api/pricing`, balance, `{base}/models`, `unode.modelCatalogUrl`) | Your API key in the `Authorization` header if one is stored — **no prompts, no code, no workspace content** | To populate the model picker and show prices/balance. **Only for a host you have already approved** — either for model traffic, or by answering the separate "fetch live prices from *host*?" prompt. Never on install, never in the background for an unapproved host. Enforced on the fetch itself (`consentGatedFetch`), not at each call site. |
| **Unode or Roam public price list, for a dated reference** (the provider's profile-pinned `https://…/api/pricing`) | Nothing but a GET with `Accept: application/json` — **no API key**, no prompts, no code | Only when you run **Update Unode/Roam reference prices** (a command, or the button on that provider card) and approve the host under the metadata consent above. Redirects are refused, the body is bounded to 2 MiB and fully validated, and the previous capture stays in use on any failure. Nothing refreshes it on activation or in the background. |
| **Opt-in hosted skill catalog** (a URL you set) | Nothing (a GET request) | Only if you set a catalog URL, enable `unode.marketplace.fetchCatalog` (default **off**), **and** the catalog is validly signed. With no signing key configured — the state this build ships in — it is **not fetched at all**. |
| **A public URL or search requested through `fetch_url`, Claude `WebFetch`, or Claude `WebSearch`** | The URL or search query and normal HTTP request metadata — not an automatic workspace upload | Only when the agent has `read` and the public-web policy allows it. Since v0.9.99 `unode.webAccess` defaults to **allow**, which permits it without a card (each search or fetch still shows as a tool card in the chat, and a URL or search term can carry text the agent has read; see §7); `ask` presents a human approval card and `off` denies it. A value you set yourself is kept. A session approval under `ask` is crew-wide but is not persisted. Private, loopback, link-local, and cloud-metadata URL targets are blocked on the gateway `fetch_url` path. |
| **A URL you type yourself as an `@url` mention in the chat composer** | A GET request for that URL, then the fetched text is attached to your message (and so goes to your model provider under the model-egress consent) | Only when you type `@https://…` in a message you send. It uses the same SSRF-hardened fetch as `fetch_url` (private, loopback, link-local and cloud-metadata targets refused, every redirect hop re-checked, bounded size). Since v0.9.99 it has no time limit: the message waits for the page, a reminder offers **Send without it** or **Keep waiting**, and Stop of the message ends the read, including during the address lookup. **It does not consult `unode.webAccess`**, so `off` does not block a URL you typed yourself. This is a known gap in the current release. |
| **Claude native external-effect tools** (`Artifact`, `CronCreate`/`CronDelete`, `RemoteTrigger`, `PushNotification`, `ScheduleWakeup`, `SendMessage`) | Tool-specific content/arguments to Claude/claude.ai features | Only after a UnodeAi approval card for that tool effect; the inherited fail-closed `PreToolUse` hook also applies inside native subagents |
| **Managed Codex downloads (Windows x64)** (the URLs of a bundled policy entry: `releases.openai.com`, `github.com`, and the redirect host `release-assets.githubusercontent.com`) | GET requests for one archive, with no cookies and no credentials | Only after you set up managed Codex and approve those hosts on its card, for a version the bundled list names; automatically only if you chose automatic updates. Redirects are followed only to the entry's listed hosts, within its exact size and a time limit. Nothing is uploaded. |
| **An MCP endpoint you configure and approve** | Tool-specific arguments defined by that MCP server | Only after that server is approved and granted to the agent; MCP is default-deny |

There is **no telemetry, analytics, crash reporting, or phone-home endpoint.** Model turns go to the provider
you select — which can be a self-hosted / in-VPC endpoint — under the model-egress consent of §2 (since v0.9.99
recorded at the first request to a connection you set up, with a notice). An
explicitly invoked MCP tool, public-web request, or Claude native external-effect tool may transmit the
arguments shown for that tool to its configured destination; none of those paths is a silent background
upload.

**The gateway `fetch_url` agent tool is SSRF-hardened.** It refuses loopback, link-local / cloud-metadata
(`169.254.169.254`), and RFC1918 ranges — including decimal/hex/octal-encoded bypasses of `127.0.0.1` —
and disables automatic redirects. See [`src/backend/webFetch.ts`](src/backend/webFetch.ts).

---

### A fresh install has no ungated activation-time network path

**Source-level assurance:** every activation-time metadata path — price server, catalog, account balance,
and there is no licence check or analytics endpoint — is consent-gated, so it refuses an unapproved host
before a packet moves. Every outbound request in the table above is downstream of an action you took and a
host you approved or a connection you set up yourself (§2). The legacy Custom gateway migration that can run at
activation (§5) sends nothing.

**UNVERIFIED (stated plainly, not implied):** that a clean-profile install emits *zero* network traffic. No
packet capture with a positive control is on file, so this document does **not** offer "zero"/"nothing" as an
outward guarantee — only that no ungated activation path exists **in the source**. A clean-profile capture is
the recorded exit criterion for upgrading this from a source-level to an effect-level claim; until it is run,
the guarantee is exactly as strong as the source review and the path lint below, and no stronger.

This was **not** true before v0.9.29a, and it is the most serious defect this project has shipped. Activation
called a live-price refresh unconditionally, so a brand-new install — no API key, no configured provider, no
approved host — sent a request to two vendor gateways the moment the editor finished starting. It contradicted
this document, and "install → unsolicited vendor beacon" is the behavioural signature registries classify as
unwanted software. It is fixed at the root: **the gate is on the fetch, not on the callers.** Every metadata service — live
prices, account balance, and the model catalog (both its curated URL and the gateway's own `{base}/models`) —
is constructed with a fetch wrapped in `consentGatedFetch`
([`src/models/LivePriceService.ts`](src/models/LivePriceService.ts)), which refuses an unapproved host before a
packet moves: **a convenience fetch may ride on a host you already approved; it may never open a network
relationship with one.** There is no ungated path for a caller to forget, and a service added tomorrow
inherits the rule. A background refresh skips silently; only a path you actively initiated (opening the model
picker, switching provider, running **UnodeAi: Refresh Model Prices**) may ask, and it asks about every host it
is about to contact, with a prompt that says what the request actually is.

The only scheduled request is the daily price refresh. Provider-owned Roam and Unode price sources have
separate, user-owned **Automatic daily price refresh** toggles; unbound `unode.pricingSources` entries have a
global toggle. Both default on to preserve existing behaviour. A repository cannot enable them. Scheduled
requests coalesce, back off after failure, never run at activation, never prompt, and still cannot contact an
unapproved host. Balance, model-catalog and Marketplace requests remain user-triggered.

The first version of this fix guarded the *price call site*, and review immediately found `ModelCatalog`
fetching straight past it. That is why the check moved to the fetch: "every caller remembers to check" is not
a property anything can hold.

**What the source-level assurance rests on.** [`src/__tests__/noPhoneHome.smoke.test.ts`](src/__tests__/noPhoneHome.smoke.test.ts)
scans for known activation-time fetch paths. That test is a **lint, not a packet capture** — it proves the
patterns it scans are absent, not that the running extension emits zero packets. This is why the section above
marks the effect-level "zero traffic" claim `UNVERIFIED`: the lint plus the construction gate are the evidence
that exists, and a clean-profile capture with a positive control is the evidence that does not.

Approving a host to receive **your code** implies approving it for a price query. **The reverse never holds:**
"yes, fetch prices" can never authorize sending source code. The two grants are stored separately and listed
separately in the **UnodeAi: Security** panel, each revocable.

---

## 2. Model egress consent — a model request goes only to a destination you set up or approved

Before **any** model request is sent, UnodeAi checks for a grant for the exact gateway profile destination, bound to
the profile id, canonical scheme/host/port, and profile revision. **Since v0.9.99 a missing grant no longer opens a
modal first** (the Owner's decision: the person's own setup is the consent). Saving a connection with its key and
choosing it for an agent is treated as the decision to send work there: the first request records the grant, shows
one non-modal notice naming the destination and how to revoke it, and is sent. An endpoint or key change advances the
profile revision, so the next request records a new grant and shows the notice again. A legacy host-only grant is
not widened into a profile grant; the profile grant is recorded on its own. **A destination you revoked in the
Security panel, or answered Do not allow for, is remembered** (in the extension's global state, per profile and
destination) and gets the modal of earlier releases before anything is sent: *"You revoked or declined sending work
to `<host>` earlier. UnodeAi is about to send this agent's prompt and any selected workspace files there … Allow?"*
Only **Allow** there sends the request and releases the decline. Before v0.9.99 that modal was shown before the
first request to every destination. Enforced at every egress
point — the OpenAI-compatible request path
([`OpenAICompatBackend`](src/backend/OpenAICompatBackend.ts) `fetchOnce`/`fetchStreamOnce`), the chat
summarizer, and before the Claude CLI is spawned ([`ClaudeHeadlessBackend.start`](src/backend/ClaudeHeadlessBackend.ts))
via the `onBeforeEgress` hook. OpenAI Codex CLI uses a dedicated version of the same pre-spawn gate. Its notice
(since v0.9.99, at the first start of a Codex program the user chose) names the executable and says that Codex
connects to OpenAI, or to the provider in the user's Codex configuration, under the user's own login. Its modal
(after a revoke or decline) also states that the user's Codex CLI makes its own connections outside UnodeAi's
network control. A Codex decline is kept for every Codex executable; a different
executable no longer asks separately. Media uploads (§1) use the same rule with their own per-host, per-purpose grant.
Declining creates no Codex process. Revoking that grant kills any running Codex process tree. Declining an
ordinary model request ends the turn with "no prompt or code was sent." Since v0.9.82, a typed
decline bypasses OpenAI-compatible transport retry, request-body recovery, and streaming fallback, so the same
turn does not prompt again and no request is sent.

The **`UnodeAi: Security`** panel lists every exact gateway grant and lets you **revoke** any of
them (a revoke is remembered as a decline, so the modal asks before the next request), alongside a live summary of Workspace Trust,
command/write approval, MCP, and which providers have a key.

---

## 3. Code execution — defaults and gates

| Capability | Default | Control |
|---|---|---|
| **Shell commands** | *Automatic (since v0.9.98)* | `unode.commandApproval` defaults to `all` (Automatic); `ask` prompts per command, `allowlist` uses a fixed prefix list, and `none` disables commands. A bounded guard classifies each command under the shell that runs it (audit log, 2026-10-19; changed 2026-10-26): a recognised dangerous delete **asks once** in `all`, `ask` and `allowlist`, with Don't run as the default (no answer means not run), and is refused in `none` — a recursive delete of the working folder, the folder above it, a drive or home root, or a `.git`/`.unode` segment, read as written and, for a command UnodeAi runs itself, resolved on disk so a short name, a link or an absolute path to one of them is caught too; a simple literal command it can read is **supported**; and anything it will not decode (a wrapper or inline script, an escape, an expansion, an unidentified shell, over budget) is **opaque** — never allowlisted and never remembered: run in `all` (the default), where it is labelled not analysed; a single-use prompt in `ask`; refused in `allowlist` and `none`. A folder delete that holds files UnodeAi did not make asks once, with Don't delete as the default. This is a limited heuristic, not a sandbox: it does not check every equivalent spelling, says nothing about what an allowed program does internally, and an approval is your authorisation, not a proof the command is safe. OpenAI-compatible `run_command` and every Claude `Bash`/`PowerShell` call, including a native subagent's, use the same [`CommandPolicy`](src/backend/CommandPolicy.ts). **In `all` (the default), a supported command or chain runs without a prompt; the rest of this paragraph is the rule for `ask` and `allowlist`.** There, a chain runs without a prompt only if every one of its segments is independently allowlisted (otherwise `ask` prompts and `allowlist` refuses). Since v0.9.96 the separators split on depend on the shell grammar of the command: `&&` in `cmd.exe`, `;` in Windows PowerShell, `;` and `&&` in PowerShell 7 and POSIX shells, and none for an unidentified shell. Empty segments (`npm test &&`) are rejected rather than ignored, and everything else that changes what executes — `\|`, `>`, `<`, a lone `&`, newlines, and the grammar's own expansions (`%`, `^`, `;` and parentheses in `cmd.exe`; `$`, `@`, braces, parentheses and backticks in PowerShell; `$(…)`, `${…}`, `!`, parentheses and backticks in a POSIX shell) — makes the command opaque, inside quotes too (the opaque rule above). So in `ask` or `allowlist`, with `npm test` and `npm run lint` allowlisted, a POSIX shell's `npm test && npm run lint` is silent and `npm test && npm publish` is not; in `all` both run. Session and project approvals are kept per grammar (see the v0.9.96 summary). The optional, user-only `unode.debug.promptedCommandLog` is off by default; when enabled it retains only local `CommandPolicy` template frequencies for prompts actually shown. Templates are redacted before they are stored — **filesystem paths become `<path>` and any value attached to a flag becomes `<redacted>`**, so no raw command line, absolute path, or inline credential is retained. It has no network path and is never transmitted. |
| **File writes / edits / deletes** | Checkpointed where storage allows | Workspace write/edit/delete operations create restorable checkpoints, and UnodeAi's own file tools keep the exact bytes of an existing file before they replace or delete it (audit log, 2026-10-19). Since v0.9.99, when that copy cannot be kept (storage full or read-only, no room), the change still happens and the tool result and one transcript line say it has no restore point and why; before, the file was not changed. A file over 32 MiB is copied to its restore point on disk as a stream, within the workspace's restore-point room. Since v0.9.99 a file with unsaved editor changes is written or deleted on disk; the editor's unsaved text is not saved, reloaded or discarded, and one transcript line says so. `unode.writeApproval` can require per-write diff approval; guarded file tools cannot escape their configured roots (realpath, traversal, and symlink checks). A restore is checked as a new write when it is asked for: it acts only on the file the change was recorded for and needs Workspace Trust and an open workspace folder (audit log, 2026-10-19). A file with unsaved editor changes, or one that no longer holds what UnodeAi last recorded, is restored only when the person chooses **Restore anyway** on the confirmation (since v0.9.99; refused before); the current bytes are kept as a restore point first where they can be, and the editor's unsaved text is not touched. `save_attachment` writes a file the user attached only through the same path, byte for byte (audit log, 2026-10-19). `write_document` (v0.9.98) writes DOCX and PDF through the same path. Since v0.9.98 a file that may hold work that is not the agent's no longer needs a separate decision; a user-selected `unode.writeApproval` Ask still asks. |
| **MCP servers** (local `stdio` subprocess / remote) | **Default-deny** | Any subprocess/remote/env server requires explicit one-time approval before mounting ([`shouldRequireApproval`](src/mcp/McpApproval.ts)); an agent sees only servers it was granted. Since v0.9.99, adding a server yourself in the Marketplace or with **Add MCP Server** records that approval, for this workspace and the server's exact launch spec (command, arguments, URL, environment placeholders, timeout), so its mount asks nothing more; a server from any other source, such as a file, or a later change to one of those fields, still asks. MCP tool calls have no implicit deadline; a server's configured `timeoutMs` still applies, and Stop ends a call. |
| **Agent Skills** | **Extension-owned instructions; actions ask once** | `SKILL.md` and references are instruction-only. A bundled manifest may select only a handler compiled into the fixed VSIX runner; Skill folders and remote catalogs cannot carry code. Every action requires Workspace Trust and a fresh digest-bound approval. |
| **Plan mode** | Backend-specific | OpenAI-compatible planning turns receive no write/run/delegate/MCP tools. Claude Headless receives planning guidance; use read-only Folder Access when you need CLI-enforced native write/shell/worktree/external-effect denies. |
| **OpenAI Codex CLI** | **Native permission profiles** | A separate pre-spawn consent gates the App Server (since v0.9.99 recorded at the first start of a Codex program the user chose, with a notice; a modal only after a revoke or decline; §2). Act offers Ask for approval, Approve for me (the default since v0.9.98; `auto_review` with a visible audit trail), and separately confirmed Full access (unsafe). Full access has no sandbox, enables network, has no approval prompts, and records no UnodeAi checkpoints. Plan and host ceilings resolve to Read only. The Workbench shows the effective profile instead of Commands/Writes. Codex owns its network and read behaviour; no destination-enforcement or workspace-read-confinement claim is made. With network access off, Codex 0.163.0's Windows sandbox refused connections to other machines but not to this computer (`127.0.0.1`), so a local service, or the internet through a local proxy, stays reachable from a sandboxed command. |

**Processes UnodeAi may launch after the relevant user action:** the selected Claude CLI; the selected Codex
App Server (plus bounded version/login/model-list probes); the fixed Claude tool-gate wrapper running the packaged
`out/claudeToolGate.cjs`; approved host-managed stdio MCP servers used by OpenAI-compatible, Claude, or Codex
agents; the fixed executable-action runner `out/skills/SkillActionRunner.js`; approved shell/verification commands,
typed into the agent's terminal or run by the declared direct shell (`cmd.exe` or `/bin/sh`, resolved as a host
executable); the process-tree helpers that stop and observe them (`taskkill` and a fixed Windows PowerShell
process listing on Windows, `ps` and signals on macOS and Linux); and Git/worktree helpers. Since v0.9.97 also:
a CLI program's one-time check when a program the bundled policy does not name is adopted (automatically since
v0.9.98; after **Check and use this program** before) (`--version`, then one start in UnodeAi's
own folder with no message, stopped while it runs); and, for managed Codex after set-up, Windows PowerShell
running `Get-AuthenticodeSignature` on the downloaded program files (also for an external Codex package's
adoption question) and one check run of each approved version with no model request. Since v0.9.98 also: the
system's associated application for a `.docx`, `.xlsx`, `.pptx` or `.pdf` chat link the user clicks (through VS Code's
`openExternal`; no other file type is handed over). The document renderer is a worker thread inside the extension
host, not a process. Remote MCP uses a network client rather than a local server process. This inventory does
not include native child processes or native MCP servers started independently by Claude or Codex from the user's
own CLI configuration.

---

The shell outside-root detector is a **detect-and-alert heuristic**, not a sandbox boundary. For
model-emitted OpenAI-compatible `run_command` calls, an out-of-workspace absolute path forces a human
approval prompt with a warning when `CommandPolicy` would otherwise allow the command; without an approver,
the command is refused. Configured verification commands (`unode.verifyCommand`, `run_checks`, completion
gate, and worktree verifier) have deliberately different semantics: they are Workspace-Trust-gated,
checked by `CommandPolicy`, and still run when policy allows them, but a one-time non-blocking warning is
shown if the configured command names a path outside the workspace. This keeps automatic verification from
being silently broken by a trusted monorepo/shared-toolchain command while still making the unusual path
visible to the user.

**A request limit holds; it never grants (v0.9.94).** With `unode.requestLimits.providerTurns` or
`unode.requestLimits.tokens` set, the host asks one gate before each step of a request that it controls: a model
request on the OpenAI-compatible routes, an action that writes, deletes, runs a command, reaches the web or
dispatches work, and the start of a turn. At a limit the step waits for the person's decision. The gate stands
before the tool, not in place of its checks: after **Continue request** the step meets Workspace Trust, scope,
`CommandPolicy` and its approval as before. Reads, listings and searches are not held. On the Claude CLI and
Codex routes the gate acts at the tool calls UnodeAi mediates and at the start of a turn; the model requests
inside a turn, and Codex's own commands and file changes, are outside it. A tool call that arrives when its
agent runs no turn belongs to no request and is not held.

**Generate Evidence Report no longer runs a command (v0.9.93).** Through v0.9.92 that command ran the workspace's
verify command to fill its report, under the same Workspace Trust and `CommandPolicy` checks as the paths above.
It now writes the Job outcome of one finished job from the run ledger and the spend records, and starts no
process. The same holds for **Open evidence** on a Job outcome card and for the export list's **Evidence
report**.

**How long an approved command may run (v0.9.92; changed in v0.9.98).** A foreground OpenAI-compatible
`run_command` waits 120 seconds, or the time the model states, at most 600 seconds. Since v0.9.98 that is a waiting
budget, not a deadline: a command still running at its end is not stopped but continues as a background command of
the agent (through v0.9.97 it was stopped). A background command runs until the agent stops it or the agent's
session ends, as before; `check_command` may wait on it for at most 300 seconds per call
and starts nothing. These limits bound a command that policy and approval have already allowed; they are not an
approval. Every host-started command, and each agent's terminal, starts in the agent's working directory with the
Windows drive letter upper-cased, which names the same directory.

**One shell per command, and observed stops (v0.9.96).** A foreground OpenAI-compatible `run_command` takes one
prepared lease: the agent's terminal, under the shell the settings name or the terminal last proved, or the
declared direct shell, named on any approval card. Nothing is started to prepare it. The terminal is opened and
its shell, folder and output capture proved only after the approval, and the command runs only where that proof
matches. The lease's shell is the one the command is normalized, checked, approved and run in, and the command is
attempted at most once. One agent's foreground commands are serialized through approval,
execution, timeout grace and cleanup; agents do not wait for each other. A command UnodeAi stops has its process
tree terminated and observed, and its terminal, if it ran in one, disposed. Through v0.9.98 an unconfirmed stop, or a terminal that
closed during a command, closed that agent's lane, for background commands too, until a restart or a window reload.
Since v0.9.99 it no longer does: that command's result reports an unknown outcome and says the command may still be
running and may have had effects; it is not run again, and the agent's next command runs in a new terminal or
process. Such an earlier process may therefore still run beside a later command. `kill_command` reports
`killed` only for an observed stop. These rules bound commands that policy and approval already allowed. They grant nothing, and the folder check is not a filesystem sandbox.

Agents may declare a `folderAccess` scope from Agent Builder's advanced Folder Access editor or directly in
`.unode/team.json`: each folder is `read` or `readwrite`, and when the field is present it is a ceiling, not
an additive grant. The Security panel lists each agent's folder grants beside its MCP grants for audit.
Separately, a coordinator can pass an **explicit task scope** on one delegation. It is an additional,
temporary ceiling: its real-path read/write roots are intersected with the saved `folderAccess` roots, it
expires when that turn ends, and it is shown on that task's delegation card as temporary (then ended). It
never changes Agent Builder data or the Security panel's permanent-grant record. An invalid/out-of-range
scope is returned to the coordinator as a reasoned refusal; it is not silently broadened. Task scopes are
currently enforced only on OpenAI-compatible agents, whose tool roots are reset before every turn. A
read-only task scope removes both write and shell tools, so shell commands cannot bypass its file roots.
OpenAI-compatible agents enforce the resulting read/write root set in `WorkspaceTools`; Claude Headless
agents are limited to one writable folder as their `cwd`, use the read-only `unode_files` MCP bridge for
extra read roots, and refuse multi-write-root scopes. When `folderAccess` is explicit, shell execution is
removed from that agent so a command cannot bypass the file-tool roots. A read-only Claude scope removes
native `Write`/`Edit`/`NotebookEdit`, `Bash`/`PowerShell`, `Monitor`/`TaskCreate`, and the filesystem/external-effect tools
`EnterWorktree`, `ExitWorktree`, `Artifact`, `CronCreate`, `CronDelete`, `RemoteTrigger`,
`PushNotification`, `ScheduleWakeup`, and `SendMessage` via `--disallowedTools`. It also removes
`Agent`/`Workflow`/`ToolSearch`, because live testing showed those native delegation/discovery tools can
reach worktree creation despite direct `EnterWorktree` denies. A no-write or untrusted Claude scope applies
the same write, shell, scope-breaking, subagent, and tool-discovery denies. This is user-requested
capability scoping, not a claim that UnodeAi shrinks Claude's entire native tool surface for normal agents,
and it is still name-filter containment rather than full per-call mediation. The no-write launch-argv test
asserts that `Monitor` and `TaskCreate` are absent from the offered native surface; the inherited
`PreToolUse` hook remains the per-call defense for stale or newly discovered tool names. In untrusted workspaces, the
effective write-root set is always empty and folder grants are validated against their resolved real path,
so repo-supplied symlinks cannot widen read access outside the workspace.

### OpenAI Codex CLI — consent-gated local App Server

OpenAI Codex CLI starts `codex app-server --stdio` only after local checks: Workspace Trust is on, Folder
Access has at least one readable root, the selected route is unchanged, and the Codex consent of §2 holds. Since
v0.9.99 that consent is recorded at the first start of a Codex program the user chose (for an agent or for Agent
Builder's model list), with a notice naming the executable; only after a revoke or decline does the user have to
accept a modal that names OpenAI and the model provider configured in Codex and explains that Codex connects there
itself. The version and login preflight also runs only after that consent. Decline means no Codex process exists. Stop, disposal, route replacement and
Security-panel revocation kill the whole process tree, including descendants on Windows.

The App Server process and each thread are pinned from the host-owned per-agent choice: Ask uses
`workspace-write` / `on-request` / `user`; Approve for me uses `workspace-write` / `on-request` / `auto_review`;
Full access uses `danger-full-access` / `never` with network enabled. Plan mode and host ceilings use a read-only
turn policy. Full access is never accepted from repository or workspace configuration and requires a fresh modal
confirmation whenever it is enabled. The returned thread policy is checked before
any turn starts; an unexpected reviewer, approval mode, sandbox mode, working directory, network flag or writable
root refuses the turn.
Known final argv bypasses remain rejected at the spawn boundary.

Codex's approval callback is conditional, not an interception point for every action. Under Ask, routine commands and
workspace edits allowed by the active sandbox run without a callback, card, or UnodeAi checkpoint. When App Server
does send an eligible command, file-change, permission, or prompted MCP approval request, UnodeAi checks the live
Workspace Trust, Plan/Act, capability, and Folder Access ceiling and presents a single-use card. An approved
file-change callback is checkpointed before acceptance when its exact patch data is available. Unknown and
malformed requests, timeout, host disposal and a closed webview decline. Native Codex reads are separate from
these effect approvals and remain part of the read limitation below.

Approve for me produces no UnodeAi approval card. UnodeAi displays every measured
`item/autoApprovalReview/started` and `item/autoApprovalReview/completed` event with its action and decision.
The live protocol recognizes `thread/approveGuardianDeniedAction`, but its required serialized denial event is
not declared by the measured notification schema; **Approve anyway** is therefore shown only when Codex actually
supplies that event. `guardian_subagent` is not selected because the documented standard profile is `auto_review`.

**Read and network boundary:** Codex uses the user's own OpenAI login and its binary owns the connection.
UnodeAi does not claim to restrict its destination hosts. Folder Access selects the effect policy but does not
prove read confinement: prior probes read sibling/Home files, so Codex must be treated as able to read files
available to the Windows user and send selected content to its configured provider. macOS and Linux sandbox behaviour is not
claimed. The Security panel repeats the read limitation.

UnodeAi never opens anything under `~/.codex` or `CODEX_HOME`, never reads, copies or logs `auth.json` or
`config.toml`, never injects `OPENAI_API_KEY`, and never installs or updates the user's Codex installation (managed
Codex, below, is UnodeAi's own copy, downloaded only after the user sets it up). It also does not run a
pre-start listing subprocess. After consent, App Server's `model/list` supplies the models visible to that logged-in
account; UnodeAi caches that response by exact CLI version and keeps the account-default sentinel available. Codex
loads the user's native hooks, notification command, MCP servers, plugins and configured model provider. UnodeAi pins the native on-request/user-reviewer policy, sandbox policy, analytics off and
OTel export off. Codex 0.155.1 transports a prompted MCP tool call as a `mcpServer/elicitation/request`; the
host accepts only the validated empty approval form and routes it to a single-use card. Other MCP forms and
malformed requests decline. Codex CLI 0.155.0 or newer may be used; Windows
validation records 0.155.1, and every newer build must still pass the live handshake and effective-policy checks.

**Attachments.** A text file the user attaches goes into the `turn/start` text, in the block and with the
120,000-character cut of the other routes. An image goes in as a `{ type: "image", url }` input whose URL is a
`data:` URL of the admitted bytes, unchanged, and only when the `model/list` of this App Server process lists the
thread's reported model with `image` in `inputModalities`. Since v0.9.99, a PDF, any other kind, and an image the
model is not shown to accept are left out and the turn is still sent: the model is told which files it did not get
and not to claim it read them, and the user sees one notice line (before v0.9.99 the turn was refused before
`turn/start`). A text past the 120,000-character cut continues through `read_extracted_content`. These bytes go to
the provider Codex connects to, under the same Codex consent; no new destination is added. A source a coordinator forwards to a Codex teammate is read for the turn's input through the
reader tools' own grant rule, checked when the turn is sent: an asset a task contract manages only through the
live attempt's grant, with an attempt its grant or the agent's own asset, without a contract the handoff itself.
The store's record decides the media kind; PDFs are not delivered; forwarded text is capped at 200,000 characters
per turn, and since v0.9.99 the rest is read through `read_extracted_content` when the thread has that reader. A
source that is not delivered is named to the model as such. The turn's context receipt lists an
attachment or a forwarded source only after App Server accepted the `turn/start` that carried it. The image path
and the input shape were read from the schema that `codex app-server generate-json-schema` and `generate-ts`
produce for 0.163.0 and are covered by fake App Server tests; no model was called, and 0.155.1 was not re-measured.
App Server accepting a turn does not prove that the model saw the image. The 0.163.0 program contains a notice
that stands in for image content when a model takes no image input; that path was not exercised, and the
model-list check is there so that such a turn is not sent.

Repository `.codex` or Claude `.claude`/`.mcp.json` configuration is checked only at exact locations on the
agent cwd's ancestor chain that the native CLIs may load. Claude 2.1.209 was measured loading `.mcp.json` past
the Git root and HOME; Codex root markers are user-configurable, so ancestor discovery does not guess a shorter
boundary. HOME `.claude` and `.codex` remain excluded as user configuration. A redacted,
content-digest-bound dialog precedes every CLI/helper process when project configuration exists. Its summary is
bounded to 24 entries and is not an exhaustive inventory of locations or automation; the digest binds the approval
to everything inspected, shown or not. Trust and load preserves native user and project features. Claude can omit the project layer with
`--setting-sources user`; Codex receives a process-local full `projects={...}` override with `trust_level="trusted"`.
The override names the project root and, for an agent working below it, the working folder and each folder up to
the root, compared by path identity; it never names a folder above the root (since v0.9.96; see the v0.9.96 entry).
Continue without project automation gives Codex the same override with `trust_level="untrusted"`, which disabled
the project layer even when the user config trusted that project in the 0.155.1 probe. Skills may still load as
instructions, but any script they request is governed by the command decision above. Any
change to what the configuration can do invalidates the grant, and linked config outside the workspace is never
followed. Since v0.9.99 the digest compares JSON settings files (`.mcp.json`, `settings.json`,
`settings.local.json`) in a canonical form, so reordering or reformatting is not a change, and it leaves out the
`permissions.allow`, `permissions.deny` and `permissions.ask` lists of `settings.local.json`, which Claude Code
rewrites itself when the user answers its prompts; every Claude tool call still meets UnodeAi's own `PreToolUse`
gate. Everything else in those files counts; every other file, and a JSON file that does not parse, is compared
byte for byte. A decision stored by an earlier
release is recognised and moved to the new digest. A start made with project automation off no longer stops when
the configuration changes afterwards, because none of it is loaded.

The final `assertResolvedRoute` check and `src/routes/__tests__/RouteContracts.test.ts` remain the route-identity
boundary. The fake App Server tests exercise all approval classes plus malformed, unknown, timeout, host-forbidden
and policy-precedence failures. Historical 0.137/0.144 probe results remain evidence for the explicit limitations
above, not a description of the current App Server protocol.

### Which CLI program runs, and managed Codex

**Identity at every start.** Every start of Claude CLI or Codex CLI hashes the files it binds (the Codex package
beside the program, or the program alone when that package cannot be bounded; the Claude program; npm's
`claude.cmd` and the program it starts, when that program is missing and the launcher still runs through `cmd.exe`),
in a worker thread, with no cache by path, date or size. A failed or
timed-out hash refuses the start. The bundled compatibility policy, validated when the extension loads, names the
exact files of tested versions. This release names two: OpenAI's Codex CLI 0.163.0 Windows x64 package (its archive
SHA-256 matching GitHub's asset digest, `codex-package_SHA256SUMS` and releases.openai.com's `release.json`; all 45
files with their SHA-256; 30 program files with OpenAI's Authenticode signature, the C runtime with Microsoft's,
`rg.exe` unsigned) and Claude CLI 2.1.306's Windows x64 program (its manifest's GPG signature checked against the
pinned Anthropic key, and the same bytes in the npm package). Each passed the release canaries on real runs, with no
mock counted; an entry is a code change audited like any other. **Since v0.9.98, any other set of files is adopted
without a question** (the Owner's decision, 2026-10-25): the start shows a notice naming the recorded and current
versions, and the same one-time check runs first. A policy entry marked bad is refused unless the user chose **Run
anyway** for it (below), and a program whose files
change during the check is hashed again and checked against the policy before it is used. Before v0.9.98, any other
set of files needed the user's answer to a question that named them, and nothing of the program ran before that
answer. In both versions UnodeAi starts the program once in its own folder outside every workspace, with no model request, and records
the adoption for exactly those files (the check runs the launcher the question described, never the setting read
again, and nothing is recorded when the files changed during the check) (an exclusively created record under `%LOCALAPPDATA%\UnodeAi\cli-store\`, never
rewritten). A record is not used while a folder an agent may write, or a Folder Access grant, reaches that store. A
policy entry marked bad cannot be adopted. **Since v0.9.99 the user can still choose Run anyway for it** in Check /
choose CLI: a modal warning names the reason the release marked it bad, the compatibility check above must pass
first, and the choice is recorded in the extension's global state for exactly those files and that bad-list entry
(a new bad-list entry, or other files, ask again). Every start of that program then shows a warning. Without that
choice a start of a bad-listed program is refused, as before. An external program inside the store is never started as external. npm's `claude.cmd`
only starts the program inside its package, so that program is started directly, without `cmd.exe`, and checked as
that one file, the same bytes the native installer ships.

**Session pins.** A session is pinned to the identity its last user-chosen start resolved, saved in the workspace
before the process starts; a failed save refuses that start. Every start the user did not ask for (App Server
restart, restart after an exit, a start for a message, a start another agent asks for, the first start after a
reload) launches exactly that identity or is refused, and never falls back to another program. The residual stays
as stated in the identity section: the window between the hash and the spawn, and a helper a running CLI starts by
path later, are not closed against a process that already runs with the user's own rights.

**Managed Codex (Windows x64, after the user sets it up).** UnodeAi downloads only the URLs and redirect hosts of a
bundled policy entry whose hosts the user approved, with `redirect: 'manual'`, no cookies and no credentials, within
the entry's exact size and a time limit. It checks the archive's SHA-256, extracts only the entry's listed files
(no links, no unlisted paths) while checking each file's SHA-256, checks that exactly the listed files are program
files, and checks every program file's Authenticode result against the signer the entry lists for it: the pinned
OpenAI or Microsoft subject and root (the Microsoft C runtime DLL's catalog chain may carry an expired intermediate
only when its bytes were just matched to their pin), or, for a file listed as unsigned (`codex-path/rg.exe`), no
signature, with its bytes pinned. A version that fails any check is not kept. No downloaded version runs before the
user's OK for its exact files. After that OK it is checked once in a work folder outside its instance folder, with an
allowlisted environment (on Windows, Node's process library adds `LOGONSERVER`, `SYSTEMDRIVE`, `USERDOMAIN` and
`USERNAME` from the host to the child) and an empty `CODEX_HOME` of its own, with no model request; its process tree is stopped and
the stop must be observed, otherwise the version stays blocked until the user's **Check again**. Every managed start
hashes the version folder again and refuses (and marks bad) a folder whose files changed. A real agent start that
fails at the program's own level (no process, an exit, another version, no `initialize` answer) is followed by one
such check of that version, through the same admission, and a failed check marks it bad; nothing is started again
for the agent. Since v0.9.99 the `initialize` handshake has no deadline: no answer within 30 seconds counts as such
a failure (reported once, with a notice to update the Codex CLI), while the start itself keeps waiting until Codex
answers or the user presses Stop. A start's lease on its version, the model list's included, is given up only after its process tree
was seen to stop. An automatic App Server replacement (after a Plan/Act switch or Folder Access change that the
running App Server did not apply, or after a compaction of uncertain fate) starts only after every earlier App Server
tree of that agent was seen to stop; an unconfirmed stop, a failed stop or a root that had ended by itself starts
nothing, fails the waiting message and every later one until the agent is stopped, and keeps the version held. The App Server
environment has every `CODEX_MANAGED_BY_*` variable removed after all layers are merged, and a managed start's
arguments must be `app-server --stdio` with no `update`, `daemon`, `login`, `logout` or `install`.

**Managed Codex is not an isolated profile.** UnodeAi owns only the program folders under
`%LOCALAPPDATA%\UnodeAi\cli-store\`. An agent's managed Codex uses the user's own `CODEX_HOME`, as an external Codex
does, and the native program writes there itself. The O4 release checks of 0.163.0 recorded it creating and
replacing shared sandbox helpers (`.sandbox-bin\codex.exe`, a versioned `codex-command-runner` copy), refreshing
sandbox state through its own set-up program (`.sandbox\` files, `cap_sid`, the sandbox accounts' access), rewriting
its built-in skills (`skills\.system\`), and adding session, history and state-database records. `.sandbox-bin\` is
shared by every Codex program of the user's account. Some of these changes could not be attributed to one program,
because the user's other Codex processes were running at the same time. UnodeAi itself still never reads or copies
`auth.json` or `config.toml`, and never changes the user's installed Codex package. The empty `CODEX_HOME` of the
post-download check above is that check's only; ordinary sessions use the user's.

**Claude CLI writes its own state at start.** In the same checks, every start of Claude CLI 2.1.306 rewrote
`~/.claude.json` and saved a backup under `~/.claude/backups/`, removing the oldest one. These are the
native CLI's own writes, not edits by UnodeAi, which does not open those files; they happen whenever the CLI runs.

Every decision that can take managed authority away (choosing the external CLI, removing a host, turning automatic
updates off, a rollback, a bad mark, a failed or unconfirmed check, Reset) is recorded in one control journal whose
records are published by exclusive link and protected by a separate numbered floor file; a reduction is reported
only after its floor record is flushed in two regions. If the newest record is lost, managed Codex stays paused until
the user confirms the settings again; if the journal or its floor cannot be read, it is paused, and the user's **Use
external CLI** writes a separate pause file whose presence, whatever it contains, blocks managed Codex in every
window. Every managed start is admitted while holding a read handle on its instance's admission gate, and it checks
the pause file, the journal, that the instance is still enrolled and that managed Codex is selected; while the
external CLI is selected no managed Codex process starts, pinned restarts included. Reset closes that gate before it
retires the instance, so no start can cross it, and a new set-up uses a new folder that no earlier path can name.
Only a gate seen closed counts as an interrupted Reset: an instance that is missing, names another store or cannot be
read is never retired, at start-up or by the user's Reset, since one window's failed open proves nothing about a
window that holds its gate; it starts nothing and gains no authority, and **Use external CLI** stays available.

Not verified: a real power cut during a floor write; managed Codex on any platform other than Windows x64; that the
publisher signature check reaches the revocation servers on every network (an offline answer is shown as
"revocation not confirmed").

### Agent Skills

Skills are shipped as extension-owned `skills/<category>/<name>/SKILL.md` files. The validator enforces
lowercase kebab-case names, reserved-word rejection, descriptions that state both purpose and use case, and
an instruction-only tree: scripts, executable payloads, executable directories, and symlink escapes are rejected.
An optional `unode-actions.json` can name only a closed handler id compiled into the fixed VSIX runner; it cannot
name a path, command, argument vector, module, download, or interpreter. The bundled VSIX boundary requires
`skills/**/SKILL.md` and the fixed runner while rejecting executable files and directories under `skills/`.

OpenAI-compatible agents receive only L1 names/descriptions until they call the read-only `load_skill` or
`read_skill_file` tools. Both are limited to that agent's granted names; L3 resolves the requested path with
`realpath` and refuses anything outside the individual skill directory. This deliberately reads extension
resources rather than extending workspace read roots. Since v0.9.99 a long skill body or reference is returned in
bounded parts, each naming the call that reads the next, instead of being refused (over 24,000 characters) or cut
(at 100,000); the grant, path and instruction-versus-executable checks run before any part is read, and the
executable-action notice goes with every part.

Claude Headless materializes a temporary, per-agent `--plugin-dir` containing only granted skills. It never
writes a `.claude` directory in the workspace or user home, and deletes the temporary plugin on process exit.
Every granted Claude agent receives that plugin, including read-only and folder-scoped agents. A live Claude
2.1.206 check confirmed that skill bodies load with `Bash`, `PowerShell`, `Write`, `Edit`, and
`NotebookEdit` disabled; the plugin therefore does not widen filesystem, shell, or write access.

Executable action manifests and runner code are never copied into Claude plugins or Codex native Skill roots.
The projection contains only inert instructions/references plus a host-authored notice directing the model to
`run_skill_action`. The extension host revalidates the full Skill digest before and after approval and invokes the
fixed runner by absolute extension path. Approval is single-use and is not remembered for a session or project.

On Windows, the global Claude launcher is a `.cmd` shim. Before any loopback bridge or Claude process starts,
UnodeAi rejects model and reasoning-effort values containing shell metacharacters. The temporary plugin path is
passed as it is when it uses only the same command-safe character set; since v0.9.99 any other path (for example a
temporary folder with a space) is passed in double quotes, and a path holding a character `cmd.exe` still reads
inside double quotes (`"`, `%`, `!`) or a line break is not passed at all: its folder is removed and the agent
gets the skills' names and descriptions only. Without the shim (no shell) the path is one raw argument. The long user and role prompts are streamed on stdin, never placed on
the command line.

### Claude Headless native tools and subagents

Claude CLI exposes native `Agent`/`Workflow` delegation tools. UnodeAi does **not** ban those tools by
default. Instead every Claude process is started with an ephemeral `--settings` file declaring a matcher-`*`
`PreToolUse` hook. Claude inherits that hook into native subagents, so each tool call reaches UnodeAi's local
policy endpoint before execution. A matching user or project Claude allow-rule cannot bypass this hook.

The hook is fail-closed: the shipped dependency-free `out/claudeToolGate.cjs` sends the request only to a
random-port `127.0.0.1` endpoint with a per-session bearer token. A missing script prevents the agent from
starting. Endpoint loss, timeout, malformed JSON, or any hook exception exits **2** (not 1), which Claude
treats as denied. Claude 2.1.206 silently ignores a hook settings file with an `env` object in `-p` mode, so
UnodeAi writes a private, per-session `.cmd`/`.sh` wrapper instead; it sets the hook-only environment and
pins `ELECTRON_RUN_AS_NODE=1` before launching the hook. Since v0.9.91 the wrapper, the hook settings and the MCP
config of each agent live in that agent's own folder, `.unode/claude/<16 random hex>/`, created at launch and removed
at stop. Before v0.9.91 they were fixed paths under `.unode/`, shared by every Claude agent in the folder: the last
agent to start replaced the others' gate, and its stop removed it for all of them (see the v0.9.91 summary above). The endpoint applies `CommandPolicy` to
`Bash`/`PowerShell`; honors `unode.writeApproval` for native `Write`/`Edit` previews; asks before
external-effect tools; and asks before a native tool name it does not recognize. "Always allow this tool"
on an external-effect or write tool lasts only for that running agent session. Since v0.9.99, for the user's own
MCP tools and native tool names this release does not recognize, it is kept for that agent across Claude restarts,
in the project's extension storage; it is never machine-wide or crew-wide, the first use still asks, the Security
panel lists the kept tools per agent with a revoke that applies to the next call, and removing the agent forgets
them. A deny is never kept there.

Read-only, no-write, and untrusted scopes retain their CLI-level tool denies as defense in depth while the
hook mediates every observed call. The native-subagent notification remains as a visible control: it now
reports that the subagent is mediated, states before the decision that disabling is for this agent only, and
still offers Stop agent or Disable subagents.

**Caveat:** MCP servers are separate processes with their own filesystem access. Folder rules constrain the
agent's built-in tools and Claude native tools, not what an approved MCP server can reach.

## 4. VS Code Workspace Trust

UnodeAi declares `capabilities.untrustedWorkspaces: "limited"`. In an **untrusted** workspace it runs
**read-only**: agents can chat, plan, read, and search, but shell commands, file writes/edits/deletes,
Claude native worktree/external-effect tools, MCP servers, and the verify command are all disabled until you
trust the workspace. Security-sensitive
settings (`unode.allowedCommands`, `unode.commandApproval`, `unode.verifyCommand`, gateway URLs, catalog
settings) are `restrictedConfigurations` as defense in depth. More importantly, UnodeAi reads every
authority-bearing value from User Settings or the manifest default, so a repository's own settings cannot
silently re-enable them even in Cursor, where the tested repository value was effective and no untrusted state
was available. **Field-confirmed on the released bytes (2026-09-19):** Cursor 3.21.13 does not grey these keys
but withholds their repository values from extensions — a repository `commandApproval` of `all` then `none`, and a
growing `allowedCommands`, left UnodeAi's logged policy at the user's `ask` and allowlist; VS Code 1.137.0 greys
and withholds them. Devin 3.8.20 was not re-tested for this row (Owner-scoped minimal run). In VS Code an untrusted folder showed the read-only dialog and refused `run_command`.
Settings that are inert until a separate host-owned approval—such as execution-hook candidates—
remain inert regardless of their settings origin.
Virtual workspaces are unsupported. Enforcement is at every chokepoint and checked live.

---

## 5. Secrets

API keys are stored through VS Code SecretStorage — never in `.unode/team.json`, settings, chat exports,
logs, or source control. Agent Builder integrations on every backend route use the host-owned `MCPHub`; `${VAR}`
placeholders are resolved there from SecretStorage and the external server or secret is never copied into a
Claude/Codex global configuration. Native user-configured CLI MCP remains owned by that CLI and may use the
environment/credential behavior the CLI provides; UnodeAi does not inspect or rewrite those user files. The
Claude team/file/permission/managed-integration MCP bridges and the native-tool gate
use random, bearer-authenticated loopback endpoints. Their temporary configuration is written under the
**gitignored** `.unode/` directory with owner-only permissions (`0600` where supported) and cleaned up on
teardown; request bodies are capped at 64 KiB, except, since v0.9.99, a `write_document` call to a bridge that
hosts that tool, which has no body size limit (the bearer token is checked before the body is read). The gate URL/token are passed only in the hook process
environment, never on Claude's command-line argv.

### Named Custom gateway profiles

Named Custom gateways are machine-local, versioned profiles under VS Code global storage. Their immutable
`custom:<opaque-id>` is the only route identity; an agent route does not persist an endpoint, API key, or
secret reference. The extension host derives the canonical HTTPS endpoint and current SecretStorage reference
from the effective registry for every model request. A workspace/team file or forged webview message therefore
cannot redirect a profile's key to another host or another connection's secret.

Every custom key set/replace uses a host-generated SecretStorage generation. The durable registry records only
the opaque reference, never the key value; the VS Code adapter stores the key value under that reference in the
extension's private SecretStorage namespace. Endpoint/key/archive changes advance the profile revision. Before each model egress,
the backend compares its construction snapshot with the current profile and denies stale, missing, tombstoned,
endpoint-changed, or credential-identity-changed connections before a prompt request is sent.

**Model loading and connection testing are explicit metadata actions.** They request consent for only the
selected profile's host and perform only its `/models` request with that profile's key when present. They do not
send prompts or workspace files. Custom profiles do not inherit a built-in gateway's catalog cache, endpoint,
price, balance, or credential. Unknown custom price/balance data stays unknown.

The retired singleton Custom configuration is migration input only. In an untrusted workspace, it remains a
non-runnable repair and no legacy key is read. In a trusted workspace, each legacy agent's endpoint comes from its
own record or else the User-level legacy endpoint setting, and must be HTTPS; the key copied is the SecretStorage
entry the legacy record names. Since v0.9.99 a migration that only recreates the person's own binding (every
endpoint is the User-level legacy endpoint, and the only key copied is the legacy `CUSTOM_API_KEY`) runs at activation
without a confirmation, and one non-modal notice afterwards names the new gateways and says nothing was sent. Any
other endpoint or key name may be the repository's choice wherever the record is stored, because restoring the
project's `.unode/team.json` saves its members into workspace state. Such a migration runs only after a host-authored
modal that lists each endpoint and names the stored key it would be used with; **Do not migrate** is the default, and
declining or closing it copies nothing and is remembered for that roster. A decline recorded by an earlier release is still honoured. The
migration itself sends nothing; the first request on a migrated gateway is then covered by the §2 rule, which records
the grant with a notice rather than asking. The old key and setting are retained
for later workspaces; malformed, missing-key, unknown, and archived records remain visible repairs with zero
model-content egress.

Since v0.9.99 an endpoint or key edit of a Custom gateway while one of its agents is mid-turn is no longer refused:
a notice says the change waits, and it is saved once no agent on that gateway is mid-turn (Stop counts). Agents
restart on the changed profile before their next request, and the changed revision gets a new §2 grant.

Claude CLI 2.1.x uses `--allowedTools` as an auto-approval list, not as a full native-tool sandbox. UnodeAi
therefore adds only the exact names of its mounted local loopback tools to `--allowedTools`: team delegation,
the read-only file bridge, and the command-permission callback. It never auto-approves native shell/write
tools or any user-configured MCP server. A team `run_checks` call still reaches `CommandPolicy`, and
delegated work still reaches the target agent's existing folder, command, and approval constraints.

Historical Track-A experiments deliberately did not copy Codex CLI authentication into an extension-owned home directory. They kept
the user's `CODEX_HOME` so the selected CLI could use its existing local login, while every candidate invocation
passed `--ignore-user-config` and `--ignore-rules`. This prevented `config.toml` and project rules from
steering the run, but the CLI could still load user-owned skills/plugins from `CODEX_HOME`; their exact runtime
effect is **UNVERIFIED**. The discarded candidate required an explicit absolute `unode.codexCliPath`, checked
its stable supported version and `codex login status`, and never chose whichever `codex` executable happened to
be first on `PATH`. Track A deliberately did not pass `--ephemeral`. **Cross-process `resume <thread_id>` recall was
tested directly against `codex-cli 0.144.3` and did NOT reproduce prior context** — a new process resuming a
thread returned an error or no content rather than the earlier conversation. UnodeAi therefore does **not** rely
on or advertise cross-restart Codex memory; a Codex agent's context is best-effort within a running session.
Any rollout/session files are owned by the selected CLI's `CODEX_HOME`; their exact location and retention are
**UNVERIFIED**.

### Temporary copies on this computer (v0.9.99)

Three kinds of work content are written, unencrypted, to folders UnodeAi creates in the system's temporary folder
(on Windows `%TEMP%`), never in the workspace, settings or the network. Each deletion named below is an attempt: a
file that is locked (for example by an antivirus scan) or cannot be removed for another reason is left in place
without an error, like a crash leftover.

- **Attachments being added** (`unode-attach-*`). The chat composer hands each file it attaches to the host in
  1 MiB pieces, at most four unacknowledged, and the host appends them to one temporary file per attachment, per chat
  view. There is no fixed size limit; a file larger than one sent file may take in memory (an eighth of the extension
  host's heap, and no more than one base64 string can hold) is refused when it is added. When the message is sent,
  the host reads its copy into memory whole and deletes the temporary file. The file is also deleted when the person
  removes the attachment, when a message to a working agent drops its files, and when that chat view closes; the
  folder is deleted when the extension shuts down normally. **Residual:** after a crash of the extension host or the
  editor, or a deletion that fails, leftover attachment copies can stay in that folder until the person or the system cleans the temporary
  folder. The files of one message that together exceed what the window can safely hold in memory produce a warning
  in the composer and the transcript; the send is not stopped, so a very large message can still exhaust memory.
- **The content store** (`unode-content-*`), which already held attachments, fetched sources and extracted
  documents. Since v0.9.99 it also keeps the complete text of a tool result or fetched page that is longer than what
  the model is given (24,000 characters for an OpenAI-compatible tool result, 64 KiB for a managed integration's
  result on Claude, Codex's own cut on Codex, and one page of a fetched page), so the agent can read the rest with `read_extracted_content` without the tool being run or the URL fetched
  again. Such a copy is owned by the agent that received it, and other agents' readers refuse its id unless it is
  handed to them through the existing source hand-off grants. The fixed 30-minute expiry is replaced: an item is held
  while the person's request, a delegated attempt or a pending save that uses it lasts, and once nothing holds it, it
  is removed at the next use of the store after 30 minutes. The folder is deleted when the extension shuts down
  normally. **Residual:** a crash or a failed deletion leaves it in place, as above; and a request's items stay held until the person's
  next request to that agent.
- **Document drafts** (`unode-document-draft-*`). `write_document` calls with the same draft name append blocks to a
  draft file of that agent; the final call renders one DOCX or PDF through the usual write policy, approval, restore
  point and read-back. A draft part writes nothing to the workspace. A draft is deleted when its file is written, when
  Stop ends a call that added to it, or when the agent stops; after a render failure it is kept so the Word fallback
  needs no resending. **Residual:** a crash or a failed deletion leaves it in place.

The download size limits are unchanged (10 MiB for `fetch_url`, 1,000,000 bytes for an `@url` mention); since
v0.9.99 the fetched text is no longer cut at 100,000 characters.

---

## 6. What the extension does *not* contain

- **No install hooks** — no `postinstall`/`preinstall` scripts.
- **No silent downloaded or app-authored dynamic code execution** — the VSIX contains no remotely fetched
  code, and UnodeAi never passes provider output or remote source text to `eval`. A user-approved MCP server
  may intentionally launch a configured package command such as `npx`; that process and destination are
  shown before mounting. Bundled AJV internally uses `new Function` to compile local JSON Schemas into
  validators; its unused standalone-code loader is not included.
- **No bundled binaries** — the shipped VSIX contains zero `.exe`/`.node`/`.dll`/`.wasm`. Native modules in
  the dev tree (esbuild, vsce-sign, keytar) are devDependencies, excluded from the package.
- **No media runtime** — v0.9.58 added no OCR engine, video decoder, WASM module, native binary, or
  first-use download. Video intake is refused outright rather than approximated; the measured rejection of
  every candidate is recorded in the release's own decision record, kept with the development history.
- **No obfuscation** — the shipped `extension.js` is standard esbuild output; full readable source is here.
- **One bundled runtime** — production dependencies, including AJV schema validation, are compiled into the
  single readable `out/extension.js`; the VSIX does not carry a general `node_modules` tree or source map.
- **No remotely reachable control daemon** — the mobile remote-control work is a private development preview
  in a **separate package (`@unode/serve`)** that is **excluded from the VSIX** (`packages/**` in
  `.vscodeignore`, plus a packaging-time boundary check). It is not a v0.9.25 user feature. The extension
  runs no relay, pairing, push, or remote-control service. For Claude integration it may open a temporary,
  random-port listener bound only to `127.0.0.1`; every request requires a random bearer token and the
  listener is torn down with the agent session.

---

## 7. Why an automated scanner may still flag it (and why that isn't malice)

UnodeAi's *legitimate* capability profile — read workspace files, send them to a model endpoint, run shell
commands, spawn MCP subprocesses — overlaps with the behavioral signature classifiers use to detect
exfiltration and remote-code execution. That overlap is intrinsic to *any* AI coding agent (Copilot,
Cursor, Cline, Continue share it). The controls above exist specifically to keep every one of those
behaviors user-consented and auditable rather than silent — in particular, the egress-consent gate (§2)
means the "reads files → sends to a remote host" pattern can occur only toward a destination the person set up
and chose, or approved. Since v0.9.99 that consent is recorded at the first request with a visible notice rather
than a modal, so it is per-destination and revocable, but no longer an explicit click before the first send.
Public web tools are a separate path: with `unode.webAccess` at its v0.9.99 default of `allow`, an agent with
`read` can request any public URL or search without a card, and a URL or search term can carry text the agent has
read. Each such request shows as a tool card, but nothing stops it first. Set `unode.webAccess` to `ask` or `off` to
gate or remove that path.

---

## 8. Dependency audit

**As of v0.9.99 (2026-10-28, for the release head), `npm audit` — development dependencies included — and
`npm audit --omit=dev` both report 0 vulnerabilities.** One change since v0.9.98, in `package-lock.json` only:
`qs` 6.16.0 → 6.16.1, the first version patched for a moderate advisory reviewed into the database on 2026-10-27 at
16:10 UTC (GHSA-6pq8-jhm2-2vcw). `qs` reaches the tree through the MCP SDK's `express` (a production dependency
path, so both audit forms reported it until the update) and through the packager's `typed-rest-client`. The top-level
copy now takes 6.16.1, and the separate 6.16.1 copy under `body-parser` named in the v0.9.98 paragraph is merged into
it. UnodeAi imports only the SDK's MCP client modules, which (with the SDK's shared modules) load neither `express`
nor `qs`, so `qs` is not part of the bundled `out/extension.js`. No dependency was added or removed, `package.json` lists the same dependencies, and no network
destination was added.

**As of v0.9.98 (2026-10-26, for the release head), `npm audit` — development dependencies included — and
`npm audit --omit=dev` both report 0 vulnerabilities.** Added for the document writer, all shipped: `pdf-lib` 1.17.1
(with `@pdf-lib/standard-fonts` 1.0.0, `@pdf-lib/upng` 1.0.1 and its own `tslib` 1.14.1), `fontkit` 2.0.4 (with
`brotli` 1.3.3, `dfa` 1.2.0, `restructure` 3.0.2, `unicode-properties` 1.4.1, `unicode-trie` 2.0.0 with its own
`pako` 0.2.9, `tiny-inflate` 1.0.3, `clone` 2.1.2, `base64-js` 1.5.1 and `@swc/helpers` 0.5.23), and `yazl` 2.5.1 →
3.3.1 for writing DOCX (with `buffer-crc32` 1.0.0; `@vscode/vsce` keeps its own 2.5.1 and 0.2.13). Licence texts for
`fontkit`, `dfa` and `brotli` (MIT, plus Google's Apache-2.0 notice for the Brotli data) are packaged with the other
third-party licences. Also re-resolved: `body-parser` 2.4.0 (and `content-type` 2.1.0, `qs` 6.16.1, a shared
`iconv-lite` 0.7.3), `fast-uri` 3.1.9 and `zod` 4.6.7. Development only: an `overrides` entry keyed at `@azure/identity`
pins `@azure/msal-node` 7.1.1 for GHSA-xcx6-jx8p-x3h5 (with `@azure/msal-common` 16.14.3). `@azure/identity` is
reached only through the packager `@vscode/vsce`, and a test keeps the pin and that single path. Also
`serialize-javascript` 7.1.3. None of these adds a network destination.

**As of v0.9.97 (2026-10-22, for the release head), `npm audit` — development dependencies included — and
`npm audit --omit=dev` both report 0 vulnerabilities.** Changed since v0.9.96: `@modelcontextprotocol/sdk` 1.32.0
and `hono` 4.13.13 (audit log, 2026-10-20), and, on 2026-10-22, the development test runner `vitest` 4.1.11 →
4.1.12 for two moderate advisories in `@vitest/mocker` (GHSA-qxg6-89mg-rqv8, GHSA-xp26-3454-mjgp). The runner does
not ship; its update re-resolved only development packages (`vite` 8.3.5, `rolldown` 1.2.15, `chai` 6.3.0 and their
companions), and the release test gate's runner-integrity pin moved with it. Later that day `ip-address` 10.7.2 →
10.7.4, the first version patched for a moderate advisory reviewed into the database at 16:19 UTC
(GHSA-rxp7-6hxx-x8q5, quadratic time on a long IPv6 zone identifier). It reaches the tree only through the SDK's
server-side rate limiter (`express-rate-limit`), which UnodeAi's bundle does not contain; only `package-lock.json`
changed. No dependency was added.

**As of v0.9.96 (2026-10-16, re-run on 2026-10-19 for the release head), `npm audit` — development dependencies
included — and `npm audit --omit=dev` both report 0 vulnerabilities.** No dependency was added, removed or
re-resolved: `package-lock.json` differs from v0.9.95 only in its version field.

**As of v0.9.95 (2026-10-11, re-run on 2026-10-16 for the release head), `npm audit` — development
dependencies included — and `npm audit --omit=dev` both report 0 vulnerabilities.** No dependency was added,
removed or re-resolved: `package-lock.json` differs from
v0.9.94 only in its version field.

**As of v0.9.94 (2026-10-09), `npm audit` — development dependencies included — and `npm audit --omit=dev`
both report 0 vulnerabilities.** No dependency was added, removed or re-resolved: `package-lock.json` differs from
v0.9.93 only in its version field.

**As of v0.9.93 (2026-10-07), `npm audit` — development dependencies included — and `npm audit --omit=dev`
both report 0 vulnerabilities.** The candidate of this release was audited at 0 on 2026-10-04, and three
advisories were raised against its lockfile in the three days after; each was answered by raising the package
to a patched version.

*One of them concerns code that is in the VSIX.* On 2026-10-07 both audits reported GHSA-6qxp-vccf-f47h (high),
reviewed on 2026-10-06: the OAuth client of `@modelcontextprotocol/sdk` before 1.31.0 could send stored
OAuth credentials to an authorization server that the MCP server named. The SDK is a runtime dependency, and
its client, that OAuth code included, is part of the bundle. UnodeAi does not use the SDK's OAuth client. It
opens an HTTP or SSE connection to an MCP server with the server's URL alone, gives the transport no
`authProvider`, and calls none of `auth()`, `fetchToken()` and `withOAuth()`; it therefore holds no OAuth
credential for an MCP server that the flaw could send, and by the advisory's own test it was not affected. The
SDK was raised from 1.29.0 to 1.31.0, the first patched version, and `package.json` now requires `^1.31.0`, so
an affected version can no longer be resolved. Only the client that connects to the MCP servers you configure
uses the SDK; UnodeAi's own local bridge servers are not built on it. One package enters the bundle with this
version: the SDK's HTTP client now reads a response's media type through `content-type` 1.0.5 (MIT), a header
parser that was already in the lockfile as a dependency of the SDK. Its licence is among the third-party
licences in the VSIX.

*Two concern packages that are not shipped.* On 2026-10-06 the
same lockfile reported two advisories, both reviewed into the advisory database on 2026-10-05:
GHSA-jqcg-44mw-7w3h (critical), IP spoofing in `proxy-addr` 2.0.7 through an IPv4-mapped IPv6 trust subnet, and
GHSA-68fv-2mgg-jv7q (high), an event-loop denial of service in `source-map-js` 1.2.1. `proxy-addr` reaches this
project through `@modelcontextprotocol/sdk` → `express` and is counted as a production package, so
`npm audit --omit=dev` failed as well; the extension's bundle contains no `express` code, and the package
contains no `proxy-addr` file. `source-map-js` comes through the test runner, `vitest` → `vite` → `postcss`,
and is not shipped. A plain, non-force `npm audit fix` raised them to their patched versions, 2.0.8 and 1.2.2.

No dependency was added or removed: apart from its version field, `package-lock.json` differs from v0.9.92 in
those three entries only.

**As of v0.9.92 (2026-10-03), `npm audit` — development dependencies included — and `npm audit --omit=dev`
both report 0 vulnerabilities.** The first candidate of this release was audited at 0 on 2026-10-02. A day later
`npm audit` reported six high-severity entries, all one advisory: GHSA-vfj7-8cjw-p6xm, a stack-exhaustion denial
of service in `braces` through deeply nested patterns, with no patched version. It reached this project only
through the packager, `@vscode/vsce` 3.9.2 → `secretlint` → `globby` → `fast-glob` → `micromatch` → `braces`.
Nothing of that chain ships in the VSIX and `npm audit --omit=dev` stayed at 0. `@vscode/vsce` is now 4.0.0,
which no longer depends on `secretlint` or `braces` and requires Node 22 (CI runs on Node 22 and 25). `ovsx` 1.0.2,
the Open VSX publisher, declares `@vscode/vsce ^3.7.1`, as does its newest release, 1.2.0; on its own it would
bring 3.9.2 and the advisory back. An `overrides` entry makes it resolve the project's `@vscode/vsce`. That runs
`ovsx` outside its declared range, and what covers it is narrow: `ovsx` uses `@vscode/vsce` in one place, to
build a package from source, and this project publishes a finished `.vsix`, for which that code is not reached;
with 4.0.0 the `ovsx` CLI loads and the function is still exported. The first real upload with this pairing is
this release's. The lockfile changed for development packages only: 19 changed version, 19 were added and 146
removed; the 117 production packages are the same.

**As of v0.9.91 (2026-10-01), `npm audit` — development dependencies included — and `npm audit --omit=dev`
both report 0 vulnerabilities.** No dependency was added, removed or re-resolved: `package-lock.json` differs from
v0.9.90 only in its version field.

**As of v0.9.90 (2026-09-30), `npm audit` — development dependencies included — and `npm audit --omit=dev`
both report 0 vulnerabilities.** Advisories published after v0.9.89 were cleared within the declared ranges:
`fast-uri` 3.1.8 (bundled through `ajv`), `markdown-it` 14.3.2 (packaging only), and the `brace-expansion` overrides
at 2.1.7 and 5.0.12 (test tooling). No dependency was added.

**As of v0.9.84 (2026-09-24), `npm audit` — development dependencies included — and
`npm audit --omit=dev` both report 0 vulnerabilities.** v0.9.89 adds one runtime dependency, `jsonc-parser` 3.3.1
(MIT, no dependencies of its own; previously present only as a development dependency), bundled from its ES module
build to read `.unode/budget.json` strictly. On 2026-09-28, during the v0.9.89 field test, two moderate advisories
were published: `ip-address` <= 10.5.0 (IPv6 range classification; reached through the MCP SDK's
`express-rate-limit`, a runtime dependency whose code is not in the bundled extension) and `undici` 7.28.0-7.29.0
(WebSocket decompression; reached only through the `@vscode/vsce` packaging tool). `ip-address` is now 10.7.2 within
its declared range and the `undici` override 7.29.1; both audits report 0 again. The history below is kept for
context; the development-toolchain residual it describes no longer appears in the audit.

**As of the v0.9.33 G2 dependency-hygiene pass (2026-07-24), `npm audit --omit=dev` reports 0
vulnerabilities.** This is the audit that covers production dependencies that can contribute to the bundled
VSIX. A plain, non-force `npm audit fix` raised dev-only `postcss` from 8.5.15 to 8.5.23 (and its `nanoid`
dependency from 3.3.12 to 3.3.16). It deliberately retained `@modelcontextprotocol/sdk` 1.29.0; the unsafe
`--force` alternative would downgrade that SDK to 1.24.3.

At that time `npm audit` still reported five high-severity *dev-toolchain* entries. They are all projections of
GHSA-mh99-v99m-4gvg in `brace-expansion` <= 5.0.7 through the VS Code test path
`@vscode/test-cli` -> `mocha` -> `glob` / `minimatch` -> `brace-expansion`. npm reports no upstream fix for
this graph. This is an accepted development-only residual risk, not a shipped-extension dependency: the VSIX
boundary check rejects `node_modules`, and its only code files are the compiled extension bundle and the
dependency-free Claude tool gate. We will revisit it when the VS Code test CLI / Mocha dependency chain offers
a non-breaking fix; we will not use `--force` or downgrade the MCP SDK to make the audit display cleaner.

The prior `fast-uri`, `js-yaml`, `hono`, and `body-parser` findings were resolved through non-breaking updates.
The current security evidence is the audit commands above and the package-boundary check, rather than a claim
that development dependencies ship in the VSIX.

The VSIX boundary check remains independent of audit status: the package contains exactly two code files —
`out/extension.js` (the esbuild bundle of our own source plus its production dependencies) and the
dependency-free `out/claudeToolGate.cjs` — and carries **no `node_modules` tree**. Development dependencies
therefore remain absent from the distributed extension.

---

## 9. Release-artifact provenance

Release artifacts are reproducible on one **canonical platform**: the `release-integrity` GitHub Actions job
on `ubuntu-latest`, after `npm ci --ignore-scripts` and its clean-tree assertion. The job records the exact
Node and npm versions, runner OS/architecture, source tag/commit, artifact size, and SHA-256 alongside the
VSIX. Only a version tag matching `package.json` can produce the downloadable canonical release artifact.

This is deliberately **not** a claim of byte-identical archives across Windows, macOS, and Linux. The payload
entries and total size were measured equal across the investigated Windows/Linux builds, while the archive
bytes differ because `extension/images/icon.png` carries Windows mode `-rw-rw-rw-` and Linux mode
`-rw-r--r--`. We do not normalise ZIP file modes or post-process a completed VSIX: that would create another
byte-changing release path near a Marketplace freeze without improving the frozen-hash protection.

The release flow is: retrieve the artifact from the tagged CI run, compare its SHA-256 with the value CI
recorded, run `npm run publish:frozen -- --file <artifact.vsix> --sha256 <recorded-hash> --dry-run`, then
have an owner run the same existing `publish:frozen` command without `--dry-run` only after authorization.
The command rebuilds nothing and hashes the bytes again immediately before upload.

**Credential boundary:** `.ovsx-pat` never enters CI. CI builds and records evidence; a human publishes. The
workflow has no Open VSX or Marketplace publishing credential, and no CI step uploads an extension to either
registry.

---

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.** Email **yan.huohua.zhang@gmail.com**
with a description and impact, steps to reproduce (or a PoC), and the extension / OS / VS Code versions.
We aim to acknowledge within **3 business days** and to ship a fix or mitigation for confirmed exploitable
issues as quickly as the severity warrants. Please allow a reasonable window before public disclosure.

## Good practice

- Review agent diffs before finalizing a merge — you are the backstop.
- Approve shell commands and MCP servers only from task sources you trust.
- Never paste real secrets into task instructions or MCP configs.

---

## Audit log

- **2026-10-28 — v0.9.99 release security re-audit (Claude; the Owner's standing rule).** Claude reviewed the
  security-relevant changes from the v0.9.98 release (`c45eb0ed`) to `f0284582` against this file, reading the code
  changes rather than the commit messages. Several current-state statements had stopped being true. Corrected here:
  - **The summary, §1, §2 and §7 said no model request leaves before the person approves the destination in a
    modal.** The first request to a connection the person set up and chose now records the grant with a notice; the
    modal returns only after a revoke or **Do not allow**, which are saved. The same holds for Codex (where a
    different executable no longer asks separately) and for vision and transcription uploads.
  - **§1 showed `unode.webAccess` defaulting to Ask, and `@url` as time-bounded.** The default is Allow; a value the
    user set is kept. `fetch_url` and `@url` have no 10-second deadline; Stop ends them, including during the address
    lookup.
  - **§3 said UnodeAi's file tools do not change a file whose restore point cannot be kept, and that a restore
    refuses unsaved editor changes or newer work.** A change now goes ahead and says it has no restore point; a file
    with unsaved editor changes is written on disk; **Restore anyway** restores over newer work on the person's click.
  - **§3 said a foreground command is stopped at 120 seconds (at most 600).** Since v0.9.98 that is a waiting
    budget, after which the command continues in the background; this file had not been updated then.
  - **§3 said an unconfirmed command stop or a closed terminal closes the agent's command lane.** Later commands now
    run in a new terminal or process, and the result says the earlier command may still be running.
  - **§3 showed MCP mounts asking for every sensitive server.** A server the person adds in the Marketplace or with
    Add MCP Server is approved by that act, for its exact launch spec.
  - **The Codex section said every content change to repository CLI configuration invalidates the approval.** The
    digest now compares JSON settings in canonical form and leaves out the `permissions` lists of Claude's
    `settings.local.json`.
  - **The CLI section said a bad-listed program is always refused.** Run anyway exists, after a warning and a
    passing compatibility check, recorded per file set and bad-list entry.
  - **The Claude section said "Always allow this tool" lasts only for the running session.** For the user's own MCP
    tools and unknown native tool names it is now kept per agent across restarts, with revoke.
  - **§5 said a legacy Custom gateway migration needs a confirmation before a key is copied, and that bridge request
    bodies are always capped at 64 KiB.** Both changed, as §5 now says: a migration that only recreates the person's
    own legacy binding runs without a confirmation; any other key or endpoint still needs one, which now names the
    stored key. This re-audit found that the first version of this release had dropped the confirmation for every
    legacy record. A repository could then have bound one of the person's stored keys to an endpoint it chose, or,
    through the roster saved when a project opens, to the person's own legacy endpoint. The confirmation was restored
    for every binding other than the person's own before release.
  - **The Skills section said the temporary plugin path is held to the command-safe character set.** A path outside
    it is now quoted, or not passed when quoting cannot protect it.

  Also checked:
  - **No new network destination, process kind or dependency.** The removed questions change when a grant is
    recorded, not where data can go. The legacy gateway migration sends nothing. The Codex 30-second report is a
    local notice; for managed Codex it triggers the existing one-time version check, with no model request.
  - **Floors kept.** `CommandPolicy` and the secret-pattern code are unchanged; Disabled, Ask each, Plan mode, the
    dangerous-delete and folder-delete confirmations, Claude external-effect approval cards, Stop, the 15-minute
    approval windows, the two-round automatic rework limit (now with Continue rework) and user-set request limits
    remain. The coordinator's own action without a contract runs under its own configured permissions; a filed
    contract still limits it. A queued overlapping dispatch starts through the same filters, claims and grants. A
    folderless window gives an OpenAI-compatible agent no file or command tools.
  - **Hostile workspace configuration.** The changed defaults (`unode.webAccess`, `unode.localReadScope`'s implied
    parent read, `unode.notifications.resultStyle`) are application-scope settings a workspace cannot set, and an
    explicit value the user set is kept. A team file UnodeAi did not save (copied or edited), opened as a saved team,
    still loads read-only with the unticked per-agent review; only an exact save UnodeAi recorded restores its saved
    permissions without a question.
  - **Dependencies.** §8. Both `npm audit` forms report 0 on 2026-10-28.

  Residual risks, stated plainly:
  - Public web access is on by default: an agent with `read` can send a URL or search term, which can carry text it
    has read, to any public host without a card (§7).
  - Model, Codex and media egress to a destination the person set up is no longer confirmed by a click before the
    first send; the notice comes as the request leaves.
  - The workspace's parent folder is readable by agents by default in a trusted workspace, after a notice.
  - In a trusted workspace, a legacy Custom record that uses the legacy `CUSTOM_API_KEY` and the User-level legacy
    endpoint is migrated without a confirmation, even when a project's team file supplied the record; the project
    then chooses only the model and which agents use the person's own gateway. Any other key or endpoint asks first.
  - Attachment copies being added, kept tool and web results, and document drafts are unencrypted files in the
    system's temporary folder; a crash or a failed deletion can leave them there (§5). Each sent attachment is read whole into memory, and
    a very large message can exhaust the window's memory after a warning.
  - A command whose stop could not be confirmed may keep running beside the agent's later commands.
  - A change that could not keep a restore point cannot be undone from UnodeAi.
  - Long-running fetches, MCP calls, Codex starts and OpenAI-compatible turns are ended by Stop or the user's
    request limits, not by a fixed deadline.

- **2026-10-26 — v0.9.98 release security re-audit (Claude; the Owner's standing rule).** Claude reviewed the
  security-relevant changes from the v0.9.97 release to `d8eaf2ab` against this file. This file had no v0.9.98
  entry before this one, and several of its current-state statements had stopped being true. Corrected here:
  - **The summary and §3 said every high-risk capability was off or gated by default, and showed commands as Ask.**
    Commands now default to Automatic, with the dangerous-delete and folder-delete confirmations as floors. The
    dangerous-delete guard no longer blocks in every mode: it asks once, except under Disabled, where it refuses.
  - **§3 showed Codex's Ask for approval as the default.** Approve for me is the default (`CodexPermissionProfile`).
  - **The CLI section said nothing of an untested program runs before the user answers.** Since this release it is
    adopted after the one-time check, with a notice; a bad-listed entry is still refused.
  - **The v0.9.97 summary's rules for unfamiliar files and unconfirmed stops** no longer hold; the v0.9.98 summary
    says what replaced them.
  - **The process inventory** now names the associated application for a document chat link, and says the document
    renderer is a worker thread, not a process.

  Also checked:
  - **The document writer.** The model supplies structured text only (`contract-v1`, `report-v1`); there is no HTML,
    macro, external asset or font path input. Fonts come only from `%WINDIR%\Fonts` through the host broker. The
    write goes through the ordinary write policy, approval, restore point and read-back on all three routes; Plan and
    read-only scopes do not write.
  - **Opening files from the chat.** An audit of `3f9cce9b` found that any file VS Code could not open as text was
    handed to the system, so a link to an executable could run it on a click. It was fixed before release
    (`15e2ab40`): only `.docx`, `.xlsx`, `.pptx` and `.pdf` are handed over, and nothing else is ever launched.
  - **Hostile workspace configuration.** The release adds no setting a workspace can set to widen authority.
    `unode.commandApproval` and `unode.writeApproval` are application-scope settings, which a workspace cannot set,
    and an explicit narrower choice is kept.
  - **Egress.** No new destination. Request-composition diagnostics are numeric and go only to the local UnodeAi log.
  - **Dependencies.** §8. Both `npm audit` forms report 0 on 2026-10-26.

- **2026-10-22 — v0.9.97 release security re-audit (Claude; the Owner's standing rule).** Claude reviewed the
  security-relevant changes from the v0.9.96 release to `4808405` against this file. The entries below this one
  that say "next release" or "not yet released" are v0.9.97; they were written as each change was implemented,
  before its audit. Their outcomes:
  - **The bounded command guard (S0) and the integrated slices.** Codex passed `96927eda` and the integrated head
    `56e91a2e` after the failures the entries record, each corrected.
  - **The CLI program store and managed Codex (P6).** Codex passed `74ba8aef`, then the O4 qualification after
    three failed audits (`bce732b`, `3629520`), at `0dd9a9fa`.
  - **The first CI run's corrections.** Codex passed `35219b07`. Its complete local chain, with the unit gate also
    on Node 22, and CI both passed.
  - **The Use external CLI card.** `4808405` was found while preparing the field sheet: the card of a working
    managed Codex offered no way back but Reset. It awaits its audit with this entry.

  The re-audit found two omissions in this file and corrected them here:
  - **The network inventory (§1) did not list the managed Codex downloads.** A row now names the hosts and when
    they are reached.
  - **The process inventory (§3) did not list the processes this release adds:** the one-time program check after
    **Check and use this program**, Windows PowerShell's `Get-AuthenticodeSignature`, and a managed version's check
    run.

  Also checked:
  - **Hostile workspace configuration.** The release adds no setting and no `.unode/team.json` field. Managed
    Codex keeps its record and versions under `%LOCALAPPDATA%\UnodeAi\cli-store\`, outside every workspace, and a
    start refuses a store that a folder an agent may write reaches.
  - **Egress.** The new destinations are the managed Codex download hosts above, reached only after set-up and
    host approval. Codex agents now send attached text and images to the Codex provider, under the existing
    model-egress consent.
  - **Dependencies.** `@modelcontextprotocol/sdk` 1.32.0 and `hono` 4.13.13 (the 2026-10-20 entry), and the
    development runner `vitest` 4.1.12 for two advisories `npm audit` reported on 2026-10-22 (§8). Both `npm audit` forms report 0.
  - **Field.** The field run of the `35219b07` candidate is in progress; its results go into the release record.

  This entry does not record an audit of itself.

- **2026-10-20 — dependency advisories cleared for the next release (not yet released; Codex's independent audit
  passed).** The complete local chain on the audited release candidate found `npm audit` failing on four
  advisories reviewed into the database that day:
  - `@modelcontextprotocol/sdk` ≤ 1.31.0, two advisories: GHSA-6prh-2h8m-c8cw, moderate (CVSS 6.5), and
    GHSA-22jm-h49p-29qw, high (CVSS 8.6). The SDK ships in the package.
    - **Reachable:** UnodeAi connects to remote MCP servers through the SDK's `streamableHttp` and `sse` client
      transports, which followed a cross-origin redirect and re-sent custom headers and request bodies (6prh).
    - **Not reached:** the experimental tasks advisory (22jm) concerns tasks not tied to the session that created
      them. UnodeAi uses no experimental tasks API; read from the import list (`client/index`, `stdio`,
      `streamableHttp`, `sse`).
  - `hono` 4.12.4–4.13.10, moderate (GHSA-5r4p-p66f-jhc7, `serveStatic`). It is a dependency of the SDK's server
    side and does not appear in UnodeAi's built extension.
  - `follow-redirects` 1.16.0 and `vite` 8.3.0–8.3.2, development tools only.

  **Fix:**
  - The SDK moved to 1.32.0, the first patched version. Against 1.31.0, it changes the `streamableHttp`, `sse` and
    `auth` client files and `shared/protocol` / `shared/transport`; `client/index` and `stdio` are unchanged.
  - `hono` 4.13.13, `follow-redirects` 1.16.1 and `vite` 8.3.4, as resolved within the declared ranges.

  `npm audit` and `npm audit --omit=dev` now report 0, and the MCP tests pass.

- **2026-10-20 — Edit history closes from inside the Workbench (next release, not yet released; Codex's design,
  Codex's independent audit pending).** The chat webview gains one inbound message, `closeInspector`. It carries no
  field besides its name: no agent, checkpoint, path, URI or command, and the protocol refuses any other field. The
  host honours it only from the Workbench page and then runs its own `unode.hideWorkbenchInspector`, the command the
  title bar runs, which updates the rail, the saved state and the title-bar context together; the page changes no
  class itself. It closes a view and grants nothing. The command was not added to the `chatCommand` allowlist.
  Verified by focused tests of the parser, the host handler, and the real Workbench script (close button, Escape,
  where focus returns).

- **2026-10-20 — the Request summary lists a request's file effects as the host observed them, for the next release
  (not yet released); Codex's independent audit pending.** The card's Changes section is now fed only by the host's
  own observations, per request: a host commit read back as written (`host-verified`), a native Claude or Codex change
  read back as the bytes its input fixed (`native-observed`, which proves the content, not the author), and anything
  that may have changed a file without that confirmation (`effect-uncertain`, also when another request changed the
  same file between the native change's approval and its read-back). An approval, a prepared Codex diff, a recorded
  checkpoint, a tool's own success report and reply text are not effects; the old list counted Codex changes when they
  were approved. A host `delete_file` or `delete_dir` tells the agent it deleted something only when the host's look
  after the removal finds the path empty; anything found there, or a look that fails, is reported to the agent as not
  confirmed and counts as `effect-uncertain`, and nothing is removed again or put back (the agent used to be told
  "Deleted" when that look found something there). A new file whose write fails part way is called not changed only
  when the host then finds it removed again; one that stays is `effect-uncertain`. A delegate's effects count for the
  request that delegated the work, by the request the change was planned under, not by the turn running when it
  settles. A restore of the person marks the change it undid on that
  request's records. **What is kept:** the closeout records (already in workspace state) now hold each path's grade and
  restore mark; a checkpoint record now also holds the id of the request it was made for and the path that request's
  card shows. No content. **What is read:** after a native file tool reports a failure, the host reads its target back
  (inside the agent's writable folders, as after a success) to tell whether it changed. **Hardening:** a message's
  image preview is taken from stored chat history only as a PNG, JPEG or WebP data URL of at most 200,000 characters;
  any other value, a cut one included, shows no picture. Tested on Windows with real files, a fake Claude stream, a fake
  Codex App Server and the real webview script. **Residuals.** Effects of a shell command, and Codex changes applied in
  its sandbox without an approval request, are not observed file by file; the card says that other effects are not
  fully covered. The read-back shows content, not authorship: an outside program writing the same bytes is not seen.
  Two agents in different worktrees writing the same relative path are one entry. The Job outcome card's change list is
  unchanged. A restore of a change recorded outside a running turn, or before this version, marks no card. Not run on
  Linux or macOS, nor with a real Claude or Codex CLI.

- **2026-10-19 — `save_attachment`: a file the user attached, written byte for byte through the shared write
  policy, for the next release (not yet released); Codex's independent audit pending.** The tool takes exactly an
  attachment id and a destination; any other argument (bytes, a URL, a type, a provenance claim) refuses the call.
  It saves only an asset the chat composer's attachment entry made as a user attachment, still within its 30
  minutes (a save does not extend them), and granted to this agent for this turn or by the task attempt that
  carries it; a web download, text an agent or the host passed along, an id of another agent's turn and an id the
  host never issued are refused, each with its own outcome. The type is read from the bytes: PNG, JPEG and PDF by
  their signatures, and a text attachment only after a binary-signature check; each only under the extensions of its
  type (25 for text), and GIF, WebP, a mismatched or a missing extension are refused. Nothing is converted or
  fetched. The write goes through the same steps as `write_file`: the write policy and its one-change decision, the
  team read-before-write check on the OpenAI-compatible route, the write approval (its card names destination, type,
  size and SHA-256 instead of a diff), the per-file lock, the exact bytes of a replaced file kept first, the staged
  sibling and rename, and the read-back. After every wait, and again just before the file is created or replaced,
  Workspace Trust, the agent and the call, the attachment's life and grant, and the destination are looked at again;
  any change writes nothing. The
  receipt (relative path, bytes, SHA-256, created or replaced, restore point) is only what the read-back found.
  Claude reaches the tool through its files bridge and Codex as a dynamic tool, both served by host file tools with
  the same policy, approval, restore points and Workspace Trust; Plan mode refuses, and a coordinator with teammates
  needs a task contract, as for a write. **New on disk:** a text file the user attaches is now also kept, as
  attached, in the content store's temporary folder (images and PDFs already were), for its 30 minutes; its bytes are
  checked against the size and SHA-256 recorded when it was stored before a save. Tested on Windows with real files
  and exact PNG, JPEG, PDF, GIF, BOM/CRLF, LF and Latin-1 fixtures, on the host tools, through Claude's files bridge
  (a real local server, a fake CLI process) and through a fake Codex App Server. **Residuals.** An attachment that expires, or a grant that ends, after that
  last look is still written. The team read-before-write check of the OpenAI-compatible
  route refuses to replace an existing file the agent could not read first, which includes every binary file in a
  team that shares a folder. A Codex agent that may write starts one fresh Codex thread after the update, since
  Codex cannot add a tool to a resumed thread. Claude and Codex agents still receive no PDF attached to their own
  turn. Not run on Linux or macOS, nor with a real Claude or Codex CLI.

- **2026-10-19 — the exact bytes of a file are kept before UnodeAi's own file tools replace or delete it, for the
  next release (not yet released); Codex's independent audit pending.** Until now a restore point held only the
  text UnodeAi decoded from the file, recorded after the change. Now, before `write_file`, `apply_edit`, `apply_patch`
  or `delete_file` replaces or deletes an existing file, and after the per-file lock and its re-checks, the host
  writes the file's bytes to its own extension storage, flushes and reads them back, and commits a versioned index
  naming them; only then does the change start. When that cannot be done (every restore point that could make room
  is in use, the folder or its index cannot be used or written), the change is not made and the tool says why;
  nothing reports it written. A file over 32 MiB, the most one copy holds, is not replaced or deleted by these tools
  at all. A change that was then not made removes its copy. A restore
  of such a change puts back those bytes, checked against their recorded size and SHA-256, and is refused rather
  than falling back to the decoded text when they cannot be read or do not match. Copies live in one folder per
  workspace, named by the workspace's identity, under the extension's global storage on this computer: never in
  workspace state, the project or the network. They are file contents, as sensitive as the files themselves. Limits:
  32 MiB per copy, 256 MiB and 30 days per workspace, and 200 restore points of both kinds per workspace, counted
  once per change. Room is made only from this workspace's own copies that are not in use; the copy a change is
  being made with, and the first copy a request keeps of a file until that request ends, are never removed for
  room. At start-up the store removes only what an interrupted copy left in its own folder (staging files, unnamed
  payloads, entries without their payload) and never writes a project file; a restore point whose copy is gone is
  removed from the Edit history. Tested on Windows with real files, including a crash between the copy and the
  change (the copy is complete, the file untouched, nothing claims the change). **Residuals.** Claude's and Codex's
  own file tools still keep text restore points, made after the change. A folder delete keeps only its listing. A
  restore does not keep a copy of what it replaces. Two VS Code windows of the same workspace share its folder
  without a lock between them: one window's clean-up at start-up or its index write can remove a copy the other
  window relies on, which then leaves that restore point unusable (it is refused, never restored from text). A
  request's end is noticed at the next copy, so its copies stay protected until then. The workspace identity
  ignores letter case, as for UnodeAi's other per-workspace state, so on a case-sensitive filesystem two folders
  whose paths differ only by case share one folder. On Windows a directory cannot be flushed, so whether a copy
  survives a power loss rests on the filesystem's own journal.

- **2026-10-19 — attachments reach Codex agents, and Attached context lists an attachment only after its route sent
  it, for the next release (not yet released); Codex's independent audit pending.** Until now a Codex agent
  received no text or image attachment: its turn text never read them. A Codex teammate also could not read a
  source a coordinator forwarded, because Codex has no host content reader. The turn's context receipt nevertheless
  listed every attachment, on every route, when the person pressed Send, and the request summary counted them.
  This was a truthfulness defect, not a disclosure: nothing was sent that the receipt did not name. Now a Codex turn
  carries text files as text and images as image inputs, and only for a model that App Server's model list shows
  accepting images. PDFs and any other kind are refused before `turn/start`. A forwarded source goes into a Codex
  teammate's turn through the reader tools' grant rule, checked at send time; a withdrawn grant, an expired asset, a
  PDF, an image for a model without image input and text past the 200,000-character cap are named as not delivered.
  Each route now reports which attachments the payload it handed over carried: the Claude CLI after its stdin took
  the packet, the OpenAI-compatible route when the provider answered a request with a success status, Codex when
  App Server accepted `turn/start`. Only those are listed, and a turn that never sent them lists none and counts none
  in its request summary. A chat turn's saved message no longer carries the attachment text among its context
  sources. **Residuals.** "Sent" means that the route's transport took the payload, not that the model used it. Codex's
  own image size limit was not measured; an image App Server refuses at `turn/start` is not listed, while a refusal
  later in the turn is reported as a turn error after the image was listed. The App Server protocol was read from
  the 0.163.0 schema with fake App Server tests, without a model call; 0.155.1, the validated version, was not
  re-measured for image input. The composer refuses an image or text file over 8 MiB and the host any attachment
  over 10 MiB; the two still differ, and this change widens neither.

- **2026-10-19 — one write policy before every structured file change, on all three routes, for the next release
  (not yet released); Codex's independent audit pending.** Until now only the host's own file tools checked
  anything before a change, and only that a teammate had not changed a file since this agent read it. Claude's
  native Write, Edit and NotebookEdit were let go at the PreToolUse hook without a check of their target unless
  write approval was on; a Codex file change was checked against the writable roots by text before its card, and by
  real path only when it was checkpointed after the card. No route looked
  at unsaved editor changes, Git state, or whether the file was the person's own work. Now one policy, asked by
  the host tools before the change, by the Claude hook before it answers allow, and by the Codex file-change
  approval before its card, looks at the one file named, in a fixed order where the stricter answer wins: unsaved
  editor changes refuse; a change since this request read or wrote it, or a write by another request still
  running, needs a decision; Git's modified, staged or untracked state needs a decision unless the host's own
  record says it wrote exactly these bytes; committed and unchanged goes on; outside Git, a read of this request
  or the host's record lets it go on and nothing else does; a new file goes on. The decision is a single-use card
  bound to the file as observed; "Approve all", automatic writes and remembered tool approvals do not answer it,
  nobody to ask is a refusal, and a change, appearance or unsaved editor state of the file while it is open voids
  it. After the waits, inside a per-target lock, the host tools check trust, a stopped agent, call or host, where
  the path now leads, unsaved editors and what the file holds, and check them again just before the replace; the
  native routes check the file, the editors and trust again after a card. Claude's and Codex's targets are proved before anything is asked: the Windows name
  rule, inside the writable folder by whole segments, the real path of the target or its nearest existing parent
  inside the root's real path, no link whose target is gone. A Claude call naming no exact file and a Codex move
  are refused, with the advice not to use a shell instead. The host's records hold path, size, SHA-256, file
  identity, request and time, never content, at most 1,000 per workspace for 30 days; only bytes the host wrote and
  read back, or a native result that reads back exactly as its input said, are recorded. A file with more than one
  name is not overwritten. A delete removes the object the path names, so a **symbolic link is refused** on the host
  `delete_file` and on the native delete routes (its evidence would describe the referent, but the unlink would
  remove the link and leave the referent, wrongly recorded as deleted); a hard link is a regular file and one of its
  names may still be deleted, removing that name and leaving the file's other names and bytes. Nothing is listed, hashed or asked of Git when a request starts (a counted test holds
  an ordinary turn at zero). The host tools now replace an existing file through a new sibling and a rename, create
  missing folders as part of the change and report them, refuse a read-only file, and report a change as made only
  when the file reads back as written. **Residuals.** Codex applies the edits its own sandbox allows under Ask for
  approval and Approve for me, and everything under Full access, without asking UnodeAi: those are not checked.
  Between the Claude hook's allow, or the Codex accept, and the CLI's own write nothing holds the file; a change in
  that moment is seen only when the result is read back. Serialisation is inside one extension host; another
  window or program is seen only through the content or identity it changed before the last look, and nothing here
  is an OS compare-and-swap. Shell commands are outside this policy. On Windows a replaced file takes its folder's
  default permissions, so permission entries set on that one file are lost (measured); on macOS and Linux the
  permission bits are copied, but a rename does not carry over another user's ownership, extended attributes or
  ACLs. Git is asked with its file-system monitor switched off, but a repository's own clean filter may still run
  when Git compares a file. No
  promise is made about a power loss during a write.

- **2026-10-19 — a folder whose name starts with two dots is inside the workspace at every path check except the
  command guard, for the next release (not yet released); Codex's independent audit pending.** Claude's inventory
  listed fifty containment call sites. Most compared `path.relative(root, target)` with a leading `..`, so a child
  folder named `..cache` or `..agent` read as the folder above. That refused it, wrongly, in the file tools
  (reads, writes, deletes, search, listing, the command working folder, the physical link check), Folder Access
  (the untrusted-workspace filter, collapsing, file grants, task-scope intersection), the Codex start, turn-scope
  and approval gates, task contracts (scope coverage, the review target), checkpoint restore and diff, the Codex
  checkpoint, the budget file, project team-file grants, receipts and the context senders. None let a real escape
  through: a real parent, a sibling whose name starts like the root, another drive and a link out still come out
  as outside. Each of these checks now compares whole path segments, through the shared helper (`pathContainment`)
  or the segment checks the entry below added, keeping its own choice of whether the root itself counts, and its
  own lexical or physical form. A newly accepted path still
  needs every grant and task scope it needed before. Two consequences: `delete_dir`'s physical protection of
  `.git` and `.unode` is now reached through a `..name` folder as well (a link inside `..cache` that leads to a
  `.git` folder is refused as protected), and a read-only Folder Access grant on a `..name` folder inside a writable
  folder is writable in practice, as for any other folder, with the existing warning. `@` mentions also hold a
  workspace at a drive or filesystem root, and the workspace tree sent with a turn no longer lists another
  workspace folder's file on another drive. **Not changed:** the command guard (`CommandPolicy`,
  `ShellCommandGate`), which is being redesigned on its own. There an absolute `..name` path inside the workspace
  is still read as a path outside it: a model's command naming one is asked about, or refused when nobody can be
  asked, and a configured command gets the outside-path warning.

- **2026-10-19 — a file restore could act on the wrong file, in released 0.9.96 and earlier; corrected for the
  next release (not yet released); Codex's independent audit pending.** Claude's inventory of the restore path found
  it. Each case was reproduced with the product's own checkpoint recorder and restore commands on fixture folders
  holding marker text, never a real repository or model. None was reported from the field. Every case needs a person
  to choose a restore and confirm it; no agent can start one.
  - **The restore wrote to a different file than the one changed.** A restore point kept the path as the agent's
    tool gave it, relative to the agent's own folder, and every restore, from the Edit history's **⟲** and from
    **UnodeAi: Restore File Checkpoint…**, read it against the first workspace folder. The confirmation named only
    the relative path. Undoing an edit of `packages/web/src/a.ts` by an agent whose Folder Access is `packages/web`
    therefore overwrote the workspace's `src/a.ts` with the other file's old content, and undoing a file such an agent
    had created deleted a same-named file of the first folder; the notice said the file was restored. Agents in a
    worktree, in a Folder Access subfolder or in another workspace folder were affected on the OpenAI-compatible
    route, and on the Claude route whenever Claude gave a relative path. Codex restore points were already made
    relative to the first folder, so they named the right file, but a Codex change in another workspace folder was
    refused. Affected: every released version in which an agent could work in a folder other than the first
    workspace folder; the first such version was not determined. Fix: each restore point records the absolute file
    the tool resolved and where it led on disk. A restore acts only on that file, inside an open workspace folder,
    and only while the path still leads there; the confirmation names the file in full. Restore points recorded by
    earlier versions do not say which folder their path belongs to: they stay listed, with restore disabled.
  - **A restore checked less than a write.** It ran in an untrusted workspace, although the extension manifest
    states that file writes are disabled there; over unsaved editor changes; and over any later change of the file,
    so work done after the recorded edit was overwritten, or a created file rewritten since was deleted. Fix: a
    restore is refused without Workspace Trust, for a file with unsaved editor changes, and unless the file holds
    exactly what UnodeAi last recorded for it (the newest recorded edit's result, or what the last restore left).
    The confirmation counts every recorded edit it undoes, by agent. The decision holds for the file as it was
    found: every check runs again at the commit, and once more after the restore's own file writes, immediately
    before the file is replaced.
  - **A restore wrote content that was not the file's.** A deleted folder's restore point holds a list of the files
    it contained, and a restore wrote that list as a file at the folder's path. When an OpenAI-compatible agent
    replaced or deleted a file that was not UTF-8 text, its restore point held the text with replacement characters,
    and a restore wrote that back as the original. Fix: neither is offered for restore.
  - **A restore reported success without checking.** Fix: the content goes to an owned temporary file beside the
    target, which is flushed and then renamed over the target after the last check; the result is read back and
    hashed. A read-back that does not match, or a failed rename or delete after which the target is not provably
    unchanged, is reported as unconfirmed, the restore point is kept, and nothing is written again. A file with a
    second name on disk (a hard link) is refused.
  - **Residuals.** The checks and the rename are separate filesystem calls, so another program can still change the
    file between the last check and the rename. On Windows a directory cannot be flushed, so whether a completed
    restore survives a power loss rests on the filesystem's own journal. These restore points keep text, not the
    file's bytes; the entry above adds exact copies for UnodeAi's own file tools. A Codex restore point holds the
    change Codex proposed, read with LF line endings, so a file Codex
    wrote differently, for example with CRLF line endings, is refused as changed. A restore is still not recorded
    in the run ledger or the request summary.
  - The v0.9.82 entry above says checkpoint restore resolves its target against the currently bound physical root
    before any write; that held only for agents whose own folder was the first workspace folder.

- **2026-10-19 — saved task batches, new for the next release (not yet released); Codex's independent audit
  pending.** A task dispatched for delivery in batches saves each completed section through one host tool,
  `save_task_checkpoint`, on all three connections. What it stores and who may use it:
  - **Storage.** On this machine only, in the workspace's own extension storage folder (`task-checkpoints`, under a
    digest of the first workspace folder's root), one file per batch. Not in the project, not synced, not uploaded,
    and not in telemetry or portable evidence. A batch holds the task's text, so it is sensitive work product, with
    the same file-system protection as the rest of the extension's storage; it is not encrypted. Limits: 256 KiB
    per batch, 2 MiB per task, 16 MiB per workspace, kept 30 days after the task ended; a running task's batches are
    never removed. At a limit the new batch is refused and nothing saved is removed. The person can open or delete a
    task's batches with `UnodeAi: Saved Task Batches…`.
  - **Authority.** A batch is saved only for the live attempt of the agent executing it, by the same check as a
    published artifact. The model supplies only the text and section metadata; the attempt, the digests and the
    receipt are the host's, and an argument naming any of them is refused. Saving grants no file, command or
    network authority and extends no wait, budget or deadline. A Stop, the close of a task's result windows and a
    host interruption end the attempt first, and a batch arriving afterwards is refused, also one being written at
    that moment. A stopped task's batches are given to no model: only the person opens them, as an unsaved document,
    and nothing is resent or re-run. A coordinator reads only its own handles' batches, and turning them into a later
    task's input keeps the source task's whole input provenance and an incomplete mark.
  - **Crash behaviour.** A batch is written to a temporary name, flushed and renamed into place before it is
    confirmed; a partial write the host never confirmed is removed at the next load, and a file whose text does not
    match its recorded SHA-256 is never listed. Tested on Windows with the product code on temporary folders. Not yet
    tested: a power loss (UnodeAi flushes each file before it renames it, and nothing more), Linux and macOS, a real
    CLI or model.
  - Codex's audit of that implementation found one gap, corrected before release: a deletion the person asked for
    while a task's first batch was being saved was decided before that save pinned the task, and then removed the
    batch the host had just confirmed. The deletion is now decided under the same per-task lock that orders the
    task's saves, its end and deletions, after every one queued before it. Reproduced and tested with the product
    code by holding the batch's write open, not by timing.

- **2026-10-19 — a Stop could leave an agent's CLI running, corrected for the next release (not yet released);
  Codex's independent audit pending.** Reported from the field once: a delegated Claude CLI task was cancelled, and
  the same CLI session still called `publish_task_artifact` 26.7 seconds later. The call failed with a refused
  connection: UnodeAi's bridge had already closed. The two stop defects below were reproduced with the product's
  stop code on the test's own harmless processes (an idle `node` stand-in for the CLI), the third with the team
  tools' test fakes; never a real CLI or model.
  - **Claude CLI started through the npm `claude.cmd` launcher (Windows; since 0.9.22, the first tagged release).**
    The stop ended the CLI's input, signalled the process the extension had started and dropped its tree kill as
    soon as that process exited. Through the launcher that process is `cmd.exe`: it exits at once and the CLI keeps
    running, and with its input ended it finishes the turn it is in, tool calls included. From the code, a native
    `claude.exe` lost the same tree kill, so a command it had started could keep running; that case was not
    reproduced.
    Exposure: model requests and tool calls after Stop. Calls through UnodeAi's bridges failed once they closed, and
    UnodeAi's PreToolUse gate exits with its blocking code when its host does not answer, but a command already
    started kept running, and the agent could be started again beside it.
  - **Codex CLI (since 0.9.30).** The stop ended App Server's input before it stopped App Server's tree. A root that
    ends on the end of its input before its tree is walked leaves the processes it started running. Reproduced with
    a stand-in root that ends on its input; how fast the real App Server ends was not measured.
  - **A coordinator's `cancel_task` with a handle stopped whatever turn the teammate was in (since 0.9.56).** After
    the task's own turn had ended, that could be a later request of the user's. A handle now reaches only that
    task's own turn or its queued assignment.
  - Fix: a stop first ends the stopped turn's task attempt, so its grants and artifact publication are refused, and
    the Claude backend closes every local endpoint of the CLI at once. Then the whole process tree is stopped while
    its root still runs, with the observed tree termination of 0.9.96, and the input is no longer ended first. The
    agent counts as stopped only when every captured process was seen gone; otherwise the Team panel shows **Stop
    unconfirmed** and UnodeAi starts no second process of that agent by itself until the user starts it. A process
    that left the tree before the stop is outside what this observes, as in 0.9.96. A wait that
    times out no longer ends the task on the run record, so the stop that follows is recorded. Not yet tested: a real
    Claude or Codex CLI, and the real-process tests on Linux and macOS (they run in CI).
  - Codex's audit of that correction found one gap, corrected before release: a CLI or App Server whose own
    process had already ended before the stop was still counted as stopped, although a process it had started could
    still be running (reproduced with a stand-in root that ends on its input and leaves a detached child). Its
    process number is never listed from or signalled once UnodeAi has seen it end, as in 0.9.96, so such a stop now reads **Stop
    unconfirmed**. The same holds when an earlier App Server of that agent, replaced in place, was not seen to stop.
  - Codex's audit of the integrated release candidate found the same gap after a crash (D11): a Claude CLI or App
    Server that ended by itself, with no Stop, left no stop record, and an agent set to restart after a crash was
    started again beside whatever that process had started. The Owner ruled, on Codex's recommendation, that such an
    end is an unconfirmed stop unless the backend saw its whole process tree end. It is now recorded as one, for the
    agent and for the turn it was running, before that turn's end is reported. No automatic restart follows, a
    configured one included, and a message to the agent is refused with the reason, as after an unconfirmed Stop;
    the user's own start goes ahead and says the previous stop was not confirmed. Neither CLI's backend can see that
    whole tree once its root has ended, so in practice every crash of either now reads **Stop unconfirmed**.

- **2026-10-19 — Chat file links open through one host boundary (next release, not yet released; Codex's
  independent audit pending).** A Markdown link to a file in an agent's reply now opens that file in the editor. It
  adds one user-initiated read into the editor, and no network destination, credential path, command execution or
  write. Each kept agent reply gains a bounded list of the folders its links are read against (at most 32 paths,
  kept with the reply and trimmed with it).
  - **What the webview sends.** A click sends `openFileReference` with the agent id and an opaque link id: the
    reply's transcript sequence and a 16-digit digest of the link as written. It carries no path, folder, URI,
    command or claim of authority. The protocol refuses any other field and any other id shape, and
    `check:chat-webview-protocol-boundary` fails if a field is added to that message. The webview never receives the
    recorded folders or the recorded read ceiling (FOPEN-N1), and a chat export omits both.
  - **What the host does.** It finds the reply (the live one or a kept one of the agent shown) and the link again
    in its own copy of the text; a trimmed, cleared or forged id opens nothing and says so. It reads the destination
    again under the host's path rules, decoding once. Only an absolute `http(s)` address stays a web link. `file:`,
    `command:`, `javascript:`, `data:`, `vscode:` and every other scheme, network shares, device paths,
    drive-relative paths, any `..` segment, malformed or double escapes, encoded dots, separators, colons and
    control characters, and on Windows a stream, device or trailing-dot name are refused and shown as text; the page
    receives no destination for them. A relative path is read against a folder recorded with the reply: the agent's
    own working folder when the host knows it, or every workspace folder when the agent works in the default first
    folder of a multi-root workspace, and the user then chooses. The recorded folder is a base, never a grant. After
    that choice the link must still be shown. Then, with no wait in between, the agent's current read folders
    (Folder Access, Workspace Trust) and the file's real path decide: symlinks and junctions followed, containment
    by whole path segments, a regular file only; a read folder whose real path cannot be read grants nothing. **The
    target must also be inside the read ceiling the agent had WHEN the reply was written (FOPEN-N1)**, recorded with
    the reply as a bounded, host-only list of the real paths its folders had then. A folder whose real path could not
    be read then is left out and grants nothing. The click compares the target's real path with that list as
    recorded and never resolves it again, so a junction or symlink pointed elsewhere later does not move an old
    reply's scope, a later widening of the agent's folders does not open an old link, and a narrowing revokes it.
    The editor opens the checked real path. A remote window and a
    virtual workspace folder are refused: their file semantics are not validated for this.
  - **The read_file receipt uses the same check.** It keeps its id-only click. It now also refuses a directory or
    another non-regular file, opens a file inside a child folder named `..name` (whole-segment containment; it was
    refused before), and shows a notice where it returned silently.
  - **Residuals.** The editor opens the checked path by name, so a swap on disk between the check and the open is a
    local race this does not close. A reply written before this change, or imported (whose historical scope is
    dropped at the boundary), has no recorded read ceiling and opens nothing — its message-time authority cannot be
    proven (FOPEN-N1, fail closed). A receipt's relative path is still read against the agent's folder of today. Not
    yet exercised in a real VS Code window.
  - **Verified by** focused tests through the real chat wiring (the host's Markdown, the production webview
    renderer and click path, the sidebar and Workbench message listeners, the navigation boundary over real folders
    with a recorded editor), the path rules under explicit Windows and POSIX semantics, and hand-applied mutants:
    dropping the containment, the agent and conversation check, the re-check after a folder choice, the recorded
    folder, the id shape or field list, the error notices, or the file link itself (back to a `#` stand-in) each
    makes a named test fail.
  - Codex's audit of the integrated release candidate found one gap, corrected before release (FOPEN-RC-N1): the
    recorded read ceiling held folder names, and the click resolved them again, so a workspace junction pointed from
    folder A to folder B after a reply was written let that reply's link open a file in B that was outside its scope
    (reproduced through the production path with a real Windows junction). The ceiling is now recorded as real paths
    when the reply is written and compared as recorded. A test points a real junction elsewhere after the reply and
    shows the old link opens nothing.

- **2026-10-19 — four path-safety defects in released 0.9.96, corrected for the next release (not yet
  released); Codex's independent re-audit pending.** Claude's inventory of every path check found them, and each was reproduced with the
  product code on fixture folders: stand-in `.git` and `.unode` folders holding one marker file, and a harmless
  canary string, never a real repository, credential or model. None was reported from the field.
  - **`.git` and `.unode` could be deleted by an alias spelling (Windows; since 0.9.27, the first tagged release
    with this protection).** `delete_dir` judged its protection on the written path. Under VS Code's runtime,
    `.git::$INDEX_ALLOCATION` (the folder's stream name) and an 8.3 short name such as `GIT~1` both name the real
    folder, passed the check, and `delete_dir` deleted it. The catastrophic-delete guard let `rmdir /s /q GIT~1` and
    `rmdir /s /q .git::$INDEX_ALLOCATION` through as well. Exposure: an OpenAI-compatible agent's `delete_dir` with
    automatic writes, or after the user approved a delete that showed the alias; a command in `all` mode, one an
    allowlist admitted, or one shown for approval in `ask` mode, where the guard should have refused it outright.
    Fix: `delete_dir` also judges the resolved physical target under every write root, and refuses a root itself or
    any `.git` or `.unode` segment. The guard reads a stream suffix and trailing dots or spaces as the same folder.
    The command gate resolves each literal delete target with the system realpath, from the directory the command
    runs in. On Windows, `write_file`, `apply_edit`, `apply_patch`, `delete_file` and `delete_dir` refuse a path
    segment holding `:`, a reserved device name with or without an extension, or a trailing dot or space.
  - **The guard missed other spellings of the parent folder (since 0.9.27).** `rm -r ./..`, `rm -r sub/../..`,
    `rmdir /s /q .\..`, `rd /s /q sub\..\..` and `Remove-Item -Recurse .\..` ran in `all` mode; every `rm -rf` was
    already refused whatever its target. Fix: a target is judged as written and as normalised. The working folder
    itself (`.`, `sub/..`) is refused too, and so, by the physical check, are absolute spellings of the working
    folder, a root or a folder above them. PowerShell aliases with `-Recurse`, a colon-bound `-Path` and a comma list
    are read, and a quoted value is read as the shell passes it. A delete's targets end at its own command segment,
    so `rm -r dist && tsc -p .` still runs. Containment is judged by whole path segments, so a working folder named
    `..cache` is inside its parent, and `.git` is judged under every folder that holds the target. PowerShell
    aliases with `-Recurse` and a comma list are read, and a whole-word quote is read as the folder it names; a
    colon-bound quoted value (`-LiteralPath:".git"`), an escape or an interpolation is not decoded (see the bounded
    guard below).
  - **A write or delete could change another file and report the one requested (since 0.9.22, the first tagged
    release).** A path the tool could not place was redirected to the longest trailing part of it that existed in
    the workspace. `delete_file('..cache/x.json')` deleted the root `x.json` and reported `Deleted ..cache/x.json.`,
    `delete_dir('..cache/sub')` deleted the root `sub/`, a new file written under `..cache` overwrote a same-named
    root file the agent had read, and a real path outside the workspace was redirected to a same-named workspace
    file. The approval prompt and the checkpoint named the requested path, not the file changed. Exposure:
    OpenAI-compatible agents. Fix: a write or delete is never redirected. A path under a foreign prefix that reads as
    a workspace path is refused, naming each workspace path it could mean, so the next call names one; nothing is
    asked, checkpointed or offered as a folder. Reads are refused the same way: where such a prefix ends cannot be
    told, since a workspace folder the model expected and that is missing looks the same as the prefix, so even a
    single existing match may not be the file meant. Until 0.9.96 `read_file` and the other read tools read that
    match.
  - **A coordinator's dispatch snapshot could be read through a link out of the workspace (since 0.9.61).** The
    snapshot input was checked as text, then read with a call that follows links, and the content was granted to the
    delegate as a content asset, although the delegate's own `read_file` refused the same link. Content outside the
    workspace could therefore reach the delegate's model provider. It needs a link inside the workspace that points
    out, for example one a cloned repository carries. Fix: a snapshot reads only a regular file physically inside the
    attempt's workspace, through one handle whose identity is checked, within the size bound. After the read the
    workspace root must still be the same folder and the file the same file at the same path. An attempt that does
    not start keeps no reservation and no snapshot it stored.
  - **Codex failed four successive corrections of the command guard, and the direction was then changed.** The
    first (`8c552a5`) failed on five points (a quoted `-LiteralPath:".git"` passed; a `..name` working folder hid
    its parent; a narrower working folder hid a `.git` a wider root saw; the snapshot accepted a re-bound root; a
    missing `..name` folder let a read fall back to a root file). The file-tool and snapshot points were fixed and
    hold. The next three (`7b62402`, `0942ebd`, `392efa5`) were each a new bypass of a hand-written shell word
    reader that tried to decode quotes, wrappers and escapes exactly: an escaped quote, a wrapper's inner script
    read under the outer grammar, and a PowerShell backtick inside double quotes. The Owner judged this approach
    wrong: a text heuristic cannot be a reliable safety boundary for an arbitrary shell. These remain recorded as
    FAILs; none was retroactively passed.
  - **The command guard is now a bounded, three-state check (`CommandPolicy.inspectCommand`).** It classifies a
    command under the shell that runs it as: a recognised dangerous delete (**blocked** in every mode, dominant — a
    catastrophic text pattern, or a literal recursive delete of the working folder, an ancestor, a drive/home root
    or a `.git`/`.unode` segment); a simple literal command it can read (**supported** — a chain of the grammar's
    admitted separators, literal words, whole-word quotes only); or something it will not decode (**opaque** — a
    wrapper or inline script, an escape or expansion, an unidentified shell, a recognised delete command carrying a
    parameter it does not read exactly (an abbreviation such as PowerShell `-Fo` for `-Force` or `-Rec` for
    `-Recurse`, or an unlisted switch), a delete target holding a wildcard (`*`, `?`, `[`, `]`, quoted or not) or
    starting with `~`, over a 16,384-char / 32-segment / 32-target budget, or a delete target whose
    real path a filesystem query could not confirm within a one-second budget, or with no free slot in the
    process-wide limit of eight queries in flight). `supported` is not a claim the
    command is safe. An opaque command is never allowlisted and never remembered: in `allowlist` and `none` it is
    refused, in `ask` it is a single-use prompt bound to that exact command (no session or project grant), and in
    `all` (unsafe) it runs, labelled not analysed. A missing mode or an uninjected policy is not `all`: an opaque
    command is refused there. The historical N1/N2/N3 counterexamples are now opaque, not decoded. Native Claude
    and Codex command approvals apply the same classification and single-use mapping. A Codex agent, which the
    extension starts without a host command policy, asks the person on a single-use card for every escalation
    Codex requests, whatever its classification, and refuses only a recognised dangerous delete; no escalation is
    accepted silently. (Corrected after the O4 release canaries: between S0 and this correction, a command the guard
    could read in Codex's measured PowerShell wrapper was accepted outside the sandbox without a card. It was never
    released.) The on-disk physical check of
    a delete target runs only where UnodeAi executes the command itself, not on the native self-executed routes
    (tracked for P2).
  - **Wording and limits.** The command check is a limited heuristic, not a sandbox: it does not check every
    equivalent spelling, and it says nothing about what an allowed program does internally. "Could not be analysed —
    approve once, or refused" and "recognised danger — refused" are separate; UnodeAi never reports that a command
    passed a safety check. `all` (unsafe) mode gives no mis-delete or workspace-isolation guarantee, and an approval
    is the user's authorisation, not proof the command is safe. A command having gone through a write tool or left a
    checkpoint does not mean every shell effect can be recovered. Residuals, unchanged by this repair and recorded
    for a later pass: a `$`-stream alias of `.git` on the PowerShell command route (opaque, so it runs only in
    unsafe `all`); a POSIX backslash-newline line continuation that splits a delete verb; and the native
    self-executed routes, which get the literal check and the mode mapping but not the on-disk physical check.
  - **Codex failed the first bounded candidate (`da90c75`) on two points, both now fixed.** *S0-N4:* PowerShell
    binds an abbreviated parameter (`-Fo`/`-For`/`-Forc` → `-Force`), so a protected-target delete spelled that way
    was read as `supported`, not caught. The guard now reads a **finite vocabulary** of exact delete parameters
    (`-Recurse`, `-Force`, `-Path`, `-LiteralPath`, and the single-letter `-r`); a recognised delete command carrying
    any other `-` token — an abbreviation, an unlisted switch, `--`, a negative number — is **opaque**, not decoded on
    a partial reading and not enumerated spelling by spelling (widened from multi-letter parameters with S0-N8, below).
    An exact recursive delete of a protected target stays **blocked** even beside such a token, because blocked is
    checked first. One consequence: an abbreviated recursive delete of
    `.git`/`.unode` that the previous wording blocked in every mode is now opaque, so it is refused in
    `allowlist`/`none`, a single-use prompt in `ask`, and runs only in unsafe `all`. *S0-N5:* the one-second physical
    budget was checked only between targets; a stalled `realpath` could hold the gate indefinitely. Each filesystem
    query — protected-root and target resolution alike — is now raced against the remaining budget, reports
    `uncertain` (→ opaque) at the deadline, and no further query is started past it. The stalled query cannot be
    cancelled (fs.realpath has no abort); it is abandoned and its late result ignored.
  - **Codex then failed the repair (`6bdf5a1`) on S0-N6, now fixed.** The deadline bounded one call's wait, but each
    abandoned query kept running, so every later call started another: six calls against a filesystem that never
    answers left six queries pending. Every physical query now goes through one **process-wide limit of 8 queries in
    flight**. A query holds its slot until the system call really returns; with every slot held, the guard starts no
    query and reports `uncertain` (→ opaque). A filesystem that never answers therefore costs at most eight outstanding
    queries in total, however many commands are checked, one after another or at once; a healthy one never comes near
    the limit, because one call resolves one query at a time.
  - **Codex then failed `349caff` on S0-N7, now fixed.** When the real path of a protected folder (the working folder
    or a workspace root) could not be read, the guard used the folder's written spelling in its place. That spelling
    is not where the folder is: a root that is a link, whose lookup was denied, was compared by name while the delete
    target resolved to the root's real location, so a delete of the workspace itself passed as clear (Codex's probe:
    `{ ok: true }`). Every failure to read a protected folder's real path is now `uncertain` (→ opaque), as every
    failure to read a target's was already. Both kinds of query failure fail closed; neither is "no hit so allowed".
  - **Claude's own review of the same candidate found one more gap of this kind, fixed with it (W1).** A delete
    target holding a wildcard was read as one literal target and passed as clear. PowerShell's `-Path` and cmd's
    `erase`/`del` match wildcards themselves, inside quotes too, so `Remove-Item -Recurse -Force "*"` (every item in the
    working folder, `.git` included) and `erase /s /q "*"` ran silently in `allowlist` and with no policy; the unquoted
    `*` was already opaque. A recursive or forced delete target holding `*`, `?`, `[` or `]`, quoted or not, or
    starting with `~` (the home folder), is now **opaque** in the scanner, so the native Claude and Codex routes, which
    have no on-disk check, get it too; a recognised dangerous target in the same command is still blocked first. In
    the on-disk check, a quoted target holding a character its shell may expand (such as a single-quoted POSIX `$`) is
    `uncertain` rather than skipped.
  - **Codex then failed `f2c7855` on S0-N8, and the on-disk check now follows one rule instead of cases.** Codex found
    four more targets the check skipped (counted as clear) without knowing where they lead: a WSL path, a POSIX target
    holding `\`, a Git Bash absolute path with no drive mapping, and a Windows PowerShell `/alias`, taken for a cmd
    switch although it is a path at the drive root. They were one fault: "could not tell" was treated as "nothing to
    check". The Owner and Codex agreed to fix the rule rather than add cases. A delete token now has four outcomes
    only: (1) **proven not to be a target** — a `-x` parameter in PowerShell (the scanner makes any `-` token outside
    the exact vocabulary opaque) — skipped; (2) **a proven host path the system resolves**
    — judged protected or clear; (3) **a proven host path the system reports absent** — skipped, since it names
    nothing; (4) **anything else** — `uncertain` (→ opaque). The forms whose host path counts as proven are one closed
    list (no expansion character or `~`; POSIX: not WSL, no `\`, on Windows a relative path or an MSYS drive path;
    cmd: not drive-relative; PowerShell: no colon beyond a drive-absolute `C:\`), so a spelling not on it is unproven
    by default and needs no rule of its own. That also closes forms nobody had listed: a cmd drive-relative `D:.`, a
    PowerShell drive `ws:\` or provider path, and a POSIX `-alias` after `--` (a POSIX `-x` is no longer assumed to
    be an option, so it is resolved, and an option that names no file is simply absent). Visible consequence: under a
    WSL shell every recursive or forced delete is opaque (a single-use prompt in `ask`, refused in `allowlist`),
    because this host cannot map WSL paths. With this rule S0 stops growing by shell spelling: what it cannot prove,
    it does not clear. The native routes' lack of an on-disk check remains P2's, and unsafe `all` keeps its stated
    risk.
  - **Codex then failed `5393187` on S0-N9: one premise of the rule was not proven, and it was removed.** The check
    took every cmd `/x` token for a switch. cmd only starts a program; the program decides what a token means, so in
    `rm.exe -r /alias` the `/alias` is a path, and a link there to the workspace passed as clear even in `all`. The fix
    deletes that assumption rather than listing programs: a cmd `/x` is resolved like any other token, and an
    ordinary switch that names no file is simply absent. The only argument the check now takes as proven is a
    PowerShell `-x`, which the scanner's exact vocabulary guarantees.
  - **Not part of S0, by Codex's ruling:** the comparison of physical paths is by spelling, so two names the system
    returns for one folder (an administrative share `\\localhost\C$\ws` for `C:\ws`, or another namespace) are not
    recognised as the same folder. That belongs to a future file-identity model, not to more path spellings here.
  - The 0.9.27 entries below say the guard blocks these targets in every mode and that `delete_dir` refuses
    `.git`/`.unode` whatever the spelling; that absolute wording is superseded by the bounded guard above.

- **2026-10-19 — v0.9.96 release security re-audit (Claude; the Owner's standing rule).** Claude reviewed the
  security-relevant changes from the v0.9.95 release to `d2556da`, the head that passed the complete local chain
  and CI, against this file. The entries below this one were written as each change was implemented, before its
  audit, and say so; their outcomes are:
  - **The command boundary, the stops and the shutdown.** Codex passed `0b274c7` after four failed audits, each
    corrected, as the 2026-10-16 entry records.
  - **The Codex field corrections.** Claude passed `9b49da5`.
  - **Workbench recovery and the CLI program selection, with the latest-version lookup and Update in terminal.**
    The audits failed `0ec9c7e`, `3f83edc`, `155b710`, `5ff9ff0` and `642600f`. Codex passed the cumulative
    correction at `3c7f6f4`, then the field corrections at `b2919ea`, then a test correction at `d2556da`.
  - **The field runs.** One field run of the `3c7f6f4` candidate and a re-test of `b2919ea` passed what they
    covered. The npm update itself was not field-tested, since both installed CLIs were already the latest.
  - **CI.** It passed on the pushed head `086a2b6`, a documentation-only descendant of `d2556da`.

  The re-audit found one claim to correct:
  - **The Codex trust walk was older than its entry says.** The entry "the Codex trust override stops at the
    project root" describes the walk that went on to the drive root as reached through a `..agent` folder. It was
    reachable in every release since v0.9.84 for any working folder below the root whose spelling differed from
    the physical root, which on Windows the editor's lower-case drive letter is enough for. It is listed with this
    release's boundaries above. The correction is the one Codex passed at `3c7f6f4`; no code changed in this
    re-audit.

  Also checked:
  - **Hostile workspace configuration.** The release adds one setting, `unode.claudeCliPath`. It is
    application-scoped, a workspace or folder value is ignored and reported, and it is restricted in an untrusted
    workspace. No field was added to `.unode/team.json`. The terminal settings a command's shell is taken from are
    a trusted workspace's to set, as the boundaries above say.
  - **Egress and processes.** The one new network destination, `registry.npmjs.org`, is reached only through the
    metadata consent. Update in terminal runs nothing.
  - **Dependencies.** No dependency was added, and both `npm audit` forms report 0 on 2026-10-19.

  This entry does not record an audit of itself.
- **2026-10-18 — v0.9.96 the field corrections after the field run of `3c7f6f4`; Codex's independent audit
  pending.** The Agent Builder decided whether Codex account models were listed by comparing display copy, and an
  ordinary list response could replace the outcome of **Refresh models from Codex**. The page now decides by the
  model's source, and the panel keeps the outcome until the next load. A Reload Window now selects the agent last
  chosen, as Reopen Workbench does. No permission, consent, network destination or process start changed: a
  refresh still starts nothing without the click, the checks and consent. The notification that `powershell.exe`
  terminated with exit code 1 after an extension host restart comes from UnodeAi ending the agent terminal's
  shell, with any command still in it. That is by design; it is documented and not changed. This entry records the
  implementation only: no audit `PASS`, package or CI exists for it yet.
- **2026-10-18 — v0.9.96 the Codex trust override stops at the project root, whatever the spelling; Codex's
  independent re-audit pending.** Codex accepted RC1, RC2 and the warning-only `folderAccess` change, and found T1.
  The walk from the working folder up to the project root stopped by comparing spellings. On Windows the root comes
  from the physical path while the working folder keeps the user's spelling. With `C:\Repo` as the root and
  `c:\repo\..agent` as the working folder, the walk therefore went on to `c:\`, and the override marked every
  folder up to the drive root as trusted for that Codex process. It now continues only while the folder is strictly
  inside the root, compared by path identity, so no folder above the root is included. This entry records the
  implementation only: no audit `PASS`, package or CI exists for it yet. (Corrected by the v0.9.96 release
  re-audit: the walk went on to the drive root since v0.9.84 for any working folder below the root spelled in
  another case, not only through a `..agent` folder. See the 2026-10-19 entry.)
- **2026-10-18 — v0.9.96 two containment checks that let a `..name` folder through, corrected; Codex's independent
  audit pending.** After RC2, Claude had every other containment check that tests `!relative.startsWith('..')`
  classified by the direction of its error. Two let something through for a folder whose name starts with two dots:
  - The Codex trust override gave no entry to such a working folder. Codex 0.155.1 was measured writing its own
    trust entry for an uncovered subfolder into the user's `config.toml`, which applies outside UnodeAi.
  - A read-only folder of that name inside a writable one was not reported as writable in practice.

  The Owner decided to correct these two in this release. Both now use the whole-segment helper. The shared
  `folderAccess` check that decides grants is not changed, only its warning. The other sites wrongly refuse such
  a folder, or only change what is shown, and are left for a later release. This entry records the implementation
  only: no audit `PASS`, package or CI exists for it yet.
- **2026-10-18 — v0.9.96 Codex's re-audit of `5ff9ff0`: two findings, corrected; Codex's independent re-audit
  pending.** Codex found C2 and the folder failure of C3 corrected, and two remaining defects:
  - RC1: the model loader prepared its folder with awaits after the last selection check, so a change during
    them still started App Server;
  - RC2: the folder checks took a child named `..storage` for a parent, so a workspace folder of that name passed.

  The correction hands the host's check to the loader, which calls it synchronously right before it spawns. The
  check of the CLI folder and of the model loader's folder now compares whole path segments, through one shared
  helper. Other containment checks in the code use the same prefix test and are being classified separately.
  This entry records the implementation only: no audit `PASS`, package or CI exists for it yet.
- **2026-10-18 — v0.9.96 Codex's audit of `155b710`: three findings in the CLI selection, corrected; Codex's
  independent re-audit pending.** Codex accepted the Workbench corrections RR1 and RR2 and the latest-version
  design, and found:
  - C1: a model refresh read the selection only after its version and login checks, so it could start App Server
    for a program that was no longer selected, and save its list;
  - C2: a confirmed launcher could point to another, unchecked program by the time it was saved;
  - C3: when the folder for CLI checks could not be prepared, checks started in the extension host's current
    directory.

  The correction captures the selection before the first check and confirms it before each later step. It
  resolves the chosen path again before saving, with the identity of the program file. It requires a prepared
  folder outside every workspace folder, also after links are resolved, before any CLI program starts. A check
  now holds only for the file that was checked. The Update in terminal wording is corrected: npm's global install
  does not read a project `.npmrc` anyway, and the command updates whatever npm the terminal finds. This entry
  records the implementation only: no audit `PASS`, package or CI exists for it yet.
- **2026-10-18 — v0.9.96 the latest published CLI version and Update in terminal, implementation; Codex's
  independent audit pending.** The Owner's decision after the field run: Check / choose CLI listed only installed
  programs, so on a machine with only an old Codex it could not help. Claude designed and implemented the addition,
  and Codex audits it. The latest version comes from npm's public `latest` document, only through the consent-gated
  metadata fetch, after the user allows `registry.npmjs.org`; it is shown beside the measured version and chooses
  nothing. Update in terminal types the fixed command in a terminal in a host-owned folder and does not press
  Enter. Two release-authority canary anchors of the Claude launch are corrected: C15 names the fallback line, and
  the new C28 the resolver on the path the extension uses. This entry records the implementation only: no audit
  `PASS`, package or CI exists for it yet.
- **2026-10-18 — v0.9.96 Claude and Codex CLI program selection, implementation; Codex's independent audit
  pending.** Codex designed it, Claude implemented it, Codex audits it. The field run hit `Claude Code 2.1.209 does
  not support this model; version 2.1.280 or newer is required`: UnodeAi started npm's `claude.cmd` (2.1.209), while
  a newer Claude program (2.1.301) came with an editor extension. Both CLIs now show the program they start, choose
  one only on the user's confirmation, start nothing to list programs, and keep model lists and threads with their
  program. Only `--version` was run on the installed programs, to confirm the version line; no model request or
  agent turn was made. This entry records the implementation only: no audit `PASS`, native turn on a newer CLI,
  package or CI exists for it yet.
- **2026-10-18 — v0.9.96 Workbench recovery after Restart Extension Host, implementation; Codex's independent
  audit pending.** Codex designed it, Claude implemented it, Codex audits it. A native probe extension measured the
  three lifecycles first (above): only the editor Workbench is left unconnected after a host restart, closing a
  panel during deactivation never reaches the editor, and Reopen Closed Editor cannot bring the old page back. The
  host therefore asks before it replaces an unconnected Workbench tab, and keeps a bounded, text-only, root-scoped
  local copy of unsent Workbench text. Neither grants anything; the shutdown order of the stops is unchanged, with
  a stuck copy write tested not to hold one back. Codex's audit of `0ec9c7e` returned `FAIL`: choosing another
  agent saved unchanged text as a new revision, so text whose send was accepted could come back after a reload
  (R1); a removal mark aged out after 200 later removals, returning that agent id to the first incarnation (R2);
  and a repeated start report of a page could roll back a newer edit (R3). The correction keeps unchanged text's
  revision, gives incarnations to roster agents only, with nothing kept for removed ones, and takes one start
  report per page. Claude also found that the Workbench is restored before the roster is loaded; no page now
  drops a draft, and no copy, seed or recovery happens, until the roster is in. Codex's re-audit of `3f83edc`
  returned `FAIL`: a roster refused for a route was treated as a loaded empty roster, so both copies of every draft
  were deleted (RR1); and an acknowledgement that came before the ten-second wait still cleared text typed after
  Send, with its copy (RR2). The second correction tells a loaded roster from a refused or failed one, and settles
  every accepted send by the sent agent's draft revision, removing only the attachments it carried. This entry
  records the implementation only: no audit `PASS`, native field retest, package or CI exists for it yet.
- **2026-10-18 — v0.9.96 Codex field corrections, independent PASS of `9b49da5`.** Claude rejected `3cb9b35`
  because its command preview mixed a host Shell line with the model's later justification. The correction passes
  the backend-computed shell identity through the dedicated `shellLabel` field, after the command; the mixed
  detail/justification is not shown on command cards or Team summaries. Approval remains single-use. Regression
  tests start at the real backend approval handler with a forged Shell justification and execute both card
  renderers. CLI probes now wait for output-pipe close, keep the existing bounds and credential stripping, and
  report version failures with executable/status/output. Cached account models retain an explicit refresh action
  through the existing consent path. Claude's exact-commit re-audit of
  `9b49da583bf9f2c0fa312f069d96893b531ddcb3` returned PASS with no blocking or important finding. That does not
  establish a native field retest or cover later code; the separate host-restart issue remains open, and no new
  package or CI has been run for these corrections.

**Note on coverage.** v0.9.57 and v0.9.58 are recorded in the review section above but were not appended
here; the practice lapsed for those two releases and is resumed with v0.9.59 rather than backfilled, since a
reconstructed audit entry is not an audit. The same applies to v0.9.82 and v0.9.83: their boundaries are
recorded in the release summaries at the top of this file, and the log resumes with v0.9.84.

- **2026-10-16 — v0.9.96 implementation and release security review (Claude implemented Codex's design in six
  slices and wrote this review before the independent audit of the aggregate).**
  - **One identity per command.** Every host-run command string is bound to one typed shell identity before the
    gate, and the same identity is approved and run. The command-string inventory of the release record lists
    every `spawn` and terminal send. No `shell: true` remains in a host command path. The only variable `shell`
    option outside the direct shell is the Claude CLI launch on Windows, which starts the selected CLI through
    its `.cmd` shim. The host builds those arguments and checks each variable one against a command-safe
    character set; no model command string reaches that shell.
  - **Approvals cannot cross grammars.** A session or project approval matches only in the grammar it was given
    in, and so does a per-agent narrowing that ticks it (the Owner's decision of 2026-10-16: the Agent Builder
    checklist lists configured and project-approved templates, each with its grammars). The old project record contributes only its execution switch, so an approval saved before 0.9.96 asks
    again. That is the upgrade cost, and it fails closed. A Codex CLI command in a shell the host did not measure
    is approved once and never remembered.
  - **A window that closes stops what the host started (Codex's audit of `45bca42`, R1 and R2).** Two gaps were
    found from the source:
    - **R1.** `deactivate()` awaited `stopAll()`, but a Stop only detaches its backend and starts `backend.stop()`
      unawaited, so shutdown did not wait for any background command's stop.
    - **R2.** A Windows stop listed processes, for up to 20 s, before it ran taskkill, while the editor ends the
      host a few seconds after deactivation starts.

    A stand-in host showed the consequence. Its exit ended the command's `cmd.exe` through Node's job object, and
    the command's node child kept running. A taskkill started after that, even detached, no longer found the
    tree; only a taskkill that finished before the exit stopped it.

    Now:
    - the shutdown begins first;
    - from then on a stop sends its kill before it lists, and observes nothing;
    - every cleanup is kept and drained, also one detached earlier;
    - every live direct child is stopped as a backstop;
    - the session services are disposed only afterwards.

    The same stand-in host, with a stop held behind a 20-second listing, left the node child running when it
    exited without the shutdown, in 3 of 3 runs. With the shutdown it exited within about 0.7 s and the node child
    was gone, in 3 of 3 runs.
  - **Nothing at shutdown waits before the stops, and no stop targets a reused number (Codex's audit of
    `5d30b50`, R1 to R4).** Codex reproduced four gaps with fake processes; none sent a real signal:
    - **R1.** `deactivate()` still awaited a pending run save before it started any stop. A save that hung or
      failed held back, or prevented, every stop.
    - **R2.** Each POSIX listing round at shutdown got a fresh second, so five rounds could take nearly all of the
      host's time before the first kill.
    - **R3.** Nothing stopped a direct command from starting after the backstop's one sweep. A check or a
      verifier, which runs without an agent's stop signal, could start a child that no stop would reach.
    - **R4.** The backstop kept a child until it closed, and a child can report its exit long before it closes when
      a process it started holds its output open. The backstop could then send taskkill by the ended child's
      number, which may by then belong to an unrelated process.

    Now:
    - the window-close order is one vscode-free function, `deactivateHost`: the shutdown begins, the pending saves
      start, every stop is sent, and only then is anything waited for, the saves last;
    - one listing deadline serves every round of a POSIX stop, counted from when the stop first sees the shutdown;
    - every direct child starts through the registry, which starts nothing once the shutdown has begun, and the
      sweep repeats until no child it has not stopped is left;
    - a child's number is used only until Node reports the child ended, and a second stop of the same child joins
      the first.

    A save that throws, and a run save that fails, is written to the output channel. The message and checkpoint
    saves hand their write to the editor without a result, as before, so a later failure of theirs is not seen.

    Codex's four probes, run again against the corrected source, show every stop started while the save is
    pending, the first kill at 62 ms on a 50 ms listing time where it came at 246 ms, a late start refused with no
    spawn, and no taskkill for an ended child.
  - **A background command is reported killed only once its output has closed (Codex's audit of `daa5465`; the
    Owner's decision of 2026-10-17).** Codex reproduced `kill_command` reporting a command killed whose shell had
    ended while its output was still open: the R4 correction no longer used the ended shell's number, but it took
    the ended shell as the end of the whole command. The Owner decided that this is corrected in v0.9.96.

    Now a background stop is confirmed only when its tree stop was confirmed and its output has closed, which a
    foreground command already required. The wait for the close takes at most one confirmation time, shared by
    every stop of the command. It does not happen at shutdown, and a wait under way ends when the shutdown begins.
    Nothing is sent to the ended shell's number for it.
  - **A stop that happened is confirmed on a busy machine (the first CI run of `92075a3`; the Owner's and Codex's
    ruling of 2026-10-17).** The CI runner had two cores, and a reproduction on two loaded cores found a defect in
    the Windows stop. In 30 stops, 8 were reported unconfirmed although every process had stopped, and an
    unconfirmed stop closes the agent's lane. There were three causes:
    - taskkill exited 255 because `cmd.exe` had ended on its own before taskkill reached it;
    - the process list ran past its 5-second limit;
    - in 2 of 60 stops made 20 ms after the start, `csrss.exe` was captured as the new shell's child, because the
      shell had been given csrss's ended parent's number, and it could not be signalled.

    The corrections:
    - a non-zero taskkill exit now leads to a second listing, which only observes;
    - the snapshot follows a parent number only to a younger process;
    - each host tool of the stop has 20 seconds, while the best-effort paths keep their limit.

    Under the same load, 60 of 60 stops then confirmed, and the test file passed in 12 of 12 runs (204 tests).
    The same CI run failed on Linux only on a stale test expectation. The release test gate now prints each
    failed test, with its first failure line and the line it failed on.
  - **A plan rests on one settings revision (Codex's audit of `619b52b`).** A preparation that waited for someone's
    command in the agent terminal could keep the shell it had read before the wait while taking the settings
    revision current after it, so a terminal of changed settings would have run a command approved for the old
    ones. The facts are now read under one captured revision, the plan carries that revision, and a change during
    the wait makes the preparation read the settings again.
  - **Every start after the approval is checked again (Codex's re-audit of `5d7c1aa`).** Workspace Trust was checked
    only when an approved terminal command began, before the terminal was opened and probed, and the settings
    revision only before those waits; a refused direct command could be executed again once its condition cleared.
    The trust check is now handed to the provider and checked, with the lifecycle and the settings revision, before
    the terminal is created, after each wait and immediately before the command; every wrapper consumes the command
    on its first call.
  - **Nothing starts before the approval (Codex's audit of `26dfcc4`).** The first hand-over prepared the agent
    terminal before the gate, to name its shell on the card. That started the terminal profile's program, which a
    trusted workspace's settings can choose, also for a command that `commandApproval: none`, a catastrophic
    pattern or the person then refused. The card's shell now comes from the settings and the last proof, and the
    terminal is opened and probed only after the approval; a different proved shell means not run. The same audit
    found that a background command prepared before a quarantine could start after it, that Workspace Trust was
    not checked when a background command started, that a terminal closing during a command released the lane,
    that a new profile was probed in a terminal of the old one, that a command did not invalidate the shell proof,
    and that teardown skipped and did not report background stops that were already unconfirmed. Each is
    corrected, with a test and a targeted mutant.
  - **The folder check is an identity check.** A terminal runs a command only when it reports the agent's folder,
    compared physically. VS Code reports that folder after integration activates, in a later event. The
    extension-host fixture caught this; the wait now covers it. A wrong order would have sent every command to
    the direct fallback, which fails safe but is not what the release promises.
  - **Stops are observed.** A timeout terminates the tree and checks every captured process; an unconfirmed stop
    closes the agent's lane. The review found that only the palette restart and remove reset that lane, while the
    Team panel buttons, an Agent Builder Save, a team replacement or restore and Reset Workspace State did not. A
    closed lane then stayed closed after the restart its message asks for. Every restart and removal now resets
    it. Approval cards were already withdrawn on every stop.
  - **New host processes.** A fixed Windows PowerShell process listing and `taskkill` on Windows, `ps` and
    signals elsewhere, all resolved as host executables. On POSIX a descendant that exits between a snapshot and
    its pause frees its PID, and an unrelated process of the same user that took it at once would be signalled.
    A process that left the tree before the first snapshot cannot be observed. On Windows, after a non-zero
    taskkill exit, neither listing shows a descendant that started after the first one and whose parent has
    also ended.
  - **Hostile workspace configuration.** This release adds no setting, no field to `.unode/team.json`, no
    dependency and no network destination. A workspace cannot choose the direct shell: `ComSpec` counts only as
    an absolute `cmd.exe`, found by the host resolver, which refuses workspace and worktree candidates. A trusted
    workspace's settings can choose the terminal profile, as they can for any terminal you open, and its program
    starts only after a command was approved. Both `npm audit` forms report 0.

- **2026-10-11/16 — v0.9.95 implementation and release audit (Claude implemented six slices and every correction;
  Codex audited them seven times and returned `PASS` three times: for the code at `c85195d` and at `dbffeb0`, and
  for the documents at `05f4cc8`. Two field runs ran on two candidates, and the release record describes them and
  the corrections).**
  - **Grants keep what they name.** Folder Access and a task scope compile once into grants that remember a
    file from a folder. A file grant gives no sibling, parent, listing, search or command working directory, and
    is checked again at each use. A delegated scope and a coordinator's own scope meet in one intersection, which
    can only narrow. The first audit found refused changes keyed by the call's spelling. They are now keyed by
    file identity: physical inside a writable root or grant, and textual outside one, with no disk lookup for a
    path the agent may not write.
  - **No write through a dead link.** A symbolic link inside a writable folder whose target did not exist let a
    write escape the folder (pre-existing; found by the first audit). The host's file tools and its resolver now
    refuse it. The POSIX tests for this ran first on Linux CI for this release and passed there. This Windows
    account cannot create file symlinks, so locally the same path is tested with a dangling junction.
  - **Restored history is not an instruction.** A request is recorded before it is handed to a backend. A
    request without an answer is never sent to a provider again. A Codex CLI conversation is resumed only when the
    host saw its last request end.
  - **What is shown is what was observed.** The first field run found that a command counted as a task check, and
    that a close stood for the rest of a session. A command is no longer a check, and a refused call is no longer a
    run. A close now covers only the results it saw. Two later audits added more: `close_assignment complete` is
    refused while delegated work runs, and a rework's reply needs a decision of its own. None of these grants or
    removes authority. They change what a card and a closeout state may claim.
  - **One server per launch (the second field run).** A restarted Claude CLI coordinator could reach the previous
    launch's team tools, with that launch's verification command and command policy. Each launch now has its own
    loopback server and token. The v0.9.93 entry's "random token per start" is corrected in place.
  - **Hostile workspace configuration.** This release adds no setting and no field to `.unode/team.json`. A
    team file that names files in Folder Access gives no more than the host's own grant compiler admits. No
    dependency was added, and both `npm audit` forms report 0.
- **2026-10-08/09 — v0.9.94 implementation and release audit (Claude implemented in one pass; Codex wrote the
  contract and audited the whole diff twice; both audits and their corrections are in the release record).**
  - **The record and the card.** A closeout record is frozen by the host on every path that ends a top-level
    turn: a reply, a Stop, the first-action deadline, a process that ended. It goes through a strict parser on
    write and on restore, and a record that fails is dropped, not repaired. The card's first word is decided
    from typed facts. Fixtures with hostile reply text ("all tests pass", forged status lines) leave every field
    unchanged (tested). The webview receives text and tones and writes them with `textContent`.
  - **A limit is the person's, and it fails toward a stop.** Both settings are read through the authority
    reader, so a workspace or folder value is ignored (tested for both keys). Only a positive whole number is a
    limit; any other value is no limit of that kind and is never rounded into one. The first audit found that
    the gate forgot a limited request after 256 others and a stop after 200, and that tests accepted it. The
    gate now forgets a request only when the session manager shows that nothing can continue it, and forgets
    nothing when that cannot be established. A stopped request stays stopped: a result that arrives later
    starts no turn of it. After shutdown the gate stays in place and refuses.
  - **A request is counted as it is allowed to leave.** The first audit found that a model request was counted
    after it had passed, so two teammates could both take the last one, and that a compaction's summary
    requests skipped the gate. A step that is followed by a counted request now reserves it in the same call
    that lets it cross, each summary request asks the same gate, and after Continue held requests cross only
    while the new allowance lasts (tested with two real backends on one request and with the real summarizer).
    The re-audit found that a process which ended between its allowed start and its first request left its
    reservation counted, so a limit could be reached one request early. A session's request is now forgotten in
    one place, which gives the reservation back first (two regressions, written first and seen to fail).
  - **The decision is a card, and only one answer continues.** The card is opened through the approval broker
    with no broker deadline; the gate owns the 15-minute clock and closes the card with its reason. The
    settlement continues only for a human approver and the exact Continue action. An expired, withdrawn or
    host-closed card, an approver that is the system, and any other action string are a stop or no decision
    (tested, and mutation-proved). It is not a permission: it records no approval, and `withdraw`, the one new
    call on the broker, can only deny. The modal dialog of the first hand-over was refused by the audit and
    removed.
  - **What a limit does not reach, stated in the product.** On the Claude CLI and Codex routes: the model
    requests inside a turn, Codex's own commands and file changes, the Codex approval callbacks and one
    blank-reply retry. On every route: a token limit acts on usage already seen, calls that act are held but
    not counted, and a tool call outside any running turn is not attributed to a request. Limit state is not
    kept across a reload, by Codex's ruling: no turn can continue a request after one, and a counter alone
    would not make that safe.
  - **Review evidence is checked for what it can prove.** A receipt id is issued by the host, per attempt, for
    a numbered `read_file` and for a `search_files`. A citation must name a receipt of the same attempt, the
    file that receipt displayed and lines inside what it displayed; `observed` and `source-traced` findings
    must cite. The first audit found the earlier wording, "validated by the host", too strong: the state is
    now `citations-checked`, coverage is recorded and shown as the reviewer's own report, and `complete` over a
    cited search that stopped early is refused. A refused submission records nothing. The close is offered only
    to the agent that holds a review task the host admitted. The durable record is counts only: no finding
    text, path, line number, query or file content. A search receipt keeps a SHA-256 digest of scope, query
    and cap in the attempt, not the query.
  - **One disclosure to the model, bounded.** A search receipt line names the folders the search ran over, and
    a read root outside the working folder by its full path. The agent that searched could already read and
    search there.
  - **Price names are shipped data.** An alias must name one real row and may not repeat a row's id or another
    alias, compared without case; a list that breaks the rule is refused whole. A fetched price list declares
    no aliases, so a refresh keeps the ones this version ships. No prefix is stripped and no similar name is
    matched.
  - **Hostile workspace configuration.** This release adds two settings and no field to `.unode/team.json` or
    any other repository file. Both settings are in the authority list and in the manifest's restricted
    configurations. No new field names an endpoint, a key, a command, an MCP server or a link.
  - **A stored conversation stays with the backend kind that wrote it (found in the field on 2026-10-10, after
    the second candidate; Codex traced the cause).** An agent keeps its id when its backend kind is changed in
    Agent Builder, and its stored conversation is kept under that id. Since v0.9.30 the session handed whatever
    was stored to whichever backend started. A Codex backend stores a reference to its thread: the thread id,
    token counts, a model name with its context window, and the signature of its tool surface, which holds the
    names of the MCP tools the agent was granted. An OpenAI-compatible backend took that object for a chat
    message, sent it to the newly selected provider with every request, and wrote it into its own next
    snapshot. The object holds no prompt text, no file content and no credential; in the field the provider
    refused the request. Each backend now signs its snapshot with its kind. The session offers a stored
    snapshot only to a backend of that kind, and discards one that is not taken before the backend starts. A
    save in Agent Builder that changes the kind discards the stored conversation at the save, so that a change
    to another kind and back before a start cannot bring it back. The discard is written behind every save of
    that agent still in flight and is waited for before the agent starts, and a backend whose start began
    before the discard reads nothing and saves nothing afterwards (Codex's audits of the first two corrections
    found the round trip and the two orderings). A change of the kind made while the agent is starting cancels
    that start and starts the agent on the new kind, and a start that was overtaken makes no backend (Codex's
    third audit: before, such a start still ran the agent on the provider it had been changed away from). The
    OpenAI-compatible backend takes a stored record only when every entry is a chat message that is right for
    its role, and otherwise refuses the whole record. Tested with the real backends and with the state the
    field left behind. The other directions sent nothing: the Codex backend reads only a thread reference from
    a snapshot, and the Claude CLI backend reads none.
    **What a discard that could not be written leaves.** The discard is a write to the editor's workspace
    state, and that write can fail. Such a failure is remembered for the life of the window: every later start
    of that agent in the window reads nothing of the stored conversation and tries the discard again, and a
    save in Agent Builder that could not discard reports it and does not start the agent. A stored conversation
    of another kind is refused at every start, also after a reload, because the refusal reads the kind the
    snapshot was signed with and needs no earlier write. Not proved: when the write failed, the window was then
    closed or reloaded, and the agent is afterwards on the same kind that wrote the snapshot, nothing tells the
    new window that a discard was owed, and that snapshot is restored. It is that agent's own earlier
    conversation with a provider of the same kind, and no other agent's.
  - **Gaps carried.** `src/extension.ts`, where the gate, the meter and the card are wired, is run by the
    extension-host end-to-end suite and by no unit test; its call sites are held by the type checker and by
    tests that read its source. A coordinator's own review, closed through its own close, is not written to the
    ledger. A reviewer on the Codex route cannot submit evidence.
- **2026-10-03/04 — v0.9.93 implementation and release audit (Claude implemented; Codex designed the release and
  audited each slice and each correction; the Owner's smoke and re-check are recorded in the release record).**
  - **The card is display, and its actions are the host's.** `jobOutcomeView` returns text and tones; the webview
    writes them with `textContent` and decides no state. The local time of an instant is formatted in the webview
    by one function the host writes into its own script; it takes a stored UTC instant and returns text. A card
    action arrives as a name. The transport accepts five names and nothing else, and the host runs one only for
    an anchor in the selected chat whose current view offers that action (tested, and mutation-proved).
  - **Continue unfinished work.** `jobContinuationRequest` composes the request from the projection: an agent's
    roster name or the target a dispatch named, a fixed phrase per recorded state, and the task handle. It quotes
    no reply and no earlier instruction. The target a dispatch named is the one model-written string; it is
    flattened and cut at 80 characters. The dialog is in the modal gate's list of dialogs a person starts, with
    a non-consent first button. `submitUserRequest` refuses an agent that is not on the team or is in a turn.
  - **Execution: one path removed, none added.** `unode.generateEvidenceReport` no longer calls the verify
    runner. The report is a pure function of a view and a time.
  - **Claude CLI bridges.** `alwaysLoad` is set on the coordinator's team-bridge entry only. A worker's entry and
    the two other bridges are plain. `toolBridgeServerFactory` gives the managed-integrations bridge and the
    Skill-action bridge a `LocalMcpServer` each: bound to 127.0.0.1 on a port the system chooses, with a random
    16-byte token, like the team bridge's. The allow list names each bridge's tools under its own server name, so
    a tool is offered under one name. The bridge identity in a server name stays random per start.
  - **First-action guard.** A state machine with no clock of its own; the silence it reads is the turn timer's,
    which a running tool and an open approval already pause. It arms only for a coordinator's turn from a
    top-level request with a dispatch candidate, and ends that attempt alone. A call that arrives for an ended
    attempt is not run, and its answer is not taken (tested, and mutation-proved). The card's three actions are
    the person's; the host accepts only one the card offers.
  - **Dispatch targets.** A target that matches no teammate is `no-executor` under both delegating strategies
    when the team has teammates. The coordinator is authorised only when no teammate can be dispatched to at all,
    or when the target named teammates and every one failed a filter, and then by its own capability, scope,
    input, claim, sensor and policy checks. The release-authority canaries for the fallback and for Solo pass on
    fixtures that reach those paths.
  - **When a job ends.** Two rules changed, both about the record and neither about permission. A close the host
    makes at a stop requires that nothing is running or interrupted, that every settled result has reached the
    coordinator, and that the coordinator is not in a turn; it marks the run partial. A coordinator's closing
    reply over a stopped or interrupted task is recorded as partial. Neither wakes an agent or starts work.
  - **New persisted state.** Run ledger: `openingTurnId`, `closingTurnId`, the close basis
    `stopped-work-resolved`, `retryOfHandle`, `retryStage`, `retryLinkGap` and a marker that the run records
    retry links. A link is a validated handle and one of two stage words; it is checked against the run's own
    attempts (no self-link, no missing parent, no cycle, parent strictly earlier, same run), and a link that
    fails is removed with its reason and never repaired. Chat workspace state: at most 50 anchors per
    coordinator, each rebuilt field by field on load; unequal copies under one id become a conflict that stays
    and shows no figure. Turns that ended before their run existed are held in memory only, 32 at most, and
    matched by exact agent and thread. None of this is repository input.
  - **Exports.** `portable-run-evidence/5` adds the two link fields and no prose. The statement that timestamps
    are UTC is a constant. The evidence report carries what the card carries: no objective, no instruction and
    no approved command.
  - **Nothing happens silently.** Four places drop or bound something without a line in the chat, judged
    acceptable because each removes a claim and makes none: a retry link that fails a rule is dropped, and the
    evidence pack and the portable `omitted` section say so; a chat keeps the 50 newest cards, and an older job's
    card is no longer shown; a card whose closing reply has left the retained transcript is not shown, because
    its place is never guessed; and a turn that ended before its run existed and is no longer held leaves that
    job's card with partial coverage, which the card states.
  - **Known gaps carried.** A job whose coordinator the person stops before its first reply gets its card only
    after that coordinator's next reply. The consent dialog for reading outside the workspace writes no approval
    receipt, so the card counts no approval for it; the card says that such dialogs are not counted, and shows the
    wait. Both are listed in the manual's known issues or on the card itself.
  - **Repository-configuration matrix.** No setting, team-file field or other repository input was added, so the
    matrix is unchanged; its canaries pass (27/27).
  - **Egress and dependencies.** No new destination. No dependency added. Both audits reported 0 at the
    candidate audit of 2026-10-04 and failed when re-run on 2026-10-06 and again on 2026-10-07, on three
    advisories reviewed in those days (§8). `proxy-addr` and `source-map-js` were raised to their patched
    versions; neither is in the VSIX. `@modelcontextprotocol/sdk`, whose client is in the VSIX, was raised from
    1.29.0 to 1.31.0 for an advisory against its OAuth client, which UnodeAi never enables: it connects to an
    MCP server by URL and gives the transport no `authProvider`. The newer SDK brings `content-type` 1.0.5,
    already in the lockfile, into the bundle. `npm audit` and `npm audit --omit=dev` report 0.
  - **Gates.** The candidate's own numbers are in the release record.

- **2026-10-01/02 — v0.9.92 implementation and release audit (Claude implemented; Codex designed the release,
  audited slice 92-A in three rounds and the first four corrections, and approved the push; Owner field run recorded in
  the release record).**
  - **Approvals and dialogs: the same decisions, now timed.** `blockingPrompt` takes a required argument that
    states whose wait the prompt is, and the brokered approvals run inside `SessionManager.timeApproval`. Each
    wrapper returns the prompt's result unchanged. Traced for every caller: when the wrapper rejects before the
    prompt is shown, model and Codex egress throw, media egress throws, the repository-configuration start is
    cancelled, the coordinator brief is not sent, the read-scope gate records a failed attempt and grants nothing,
    and an MCP mount is not approved. A prompt that throws releases the clock (tested).
  - **A write approval that belonged to no agent (field finding, corrected).** The OpenAI-compatible backend was
    handed `requestWriteApproval` itself. Its tools call the approver with the request alone, so the agent name
    and the origin took their defaults: the card read `An agent wants to …`, the broker filed the wait under the
    session `An agent`, and `leave(sessionId)` on Stop matched nothing. The card therefore stayed open after its
    agent was stopped, until its 15-minute window ended, and since `write_file` does nothing between the decision
    and the write, an approval given in that time still wrote the file. This is read from the code; it was not
    reproduced in the field. A person saw the diff and approved it, so no write happened without a human
    decision; what was missing is the withdrawal v0.9.88 claims, the agent's name on the card and its waiting
    state on the Team row. The wait was also not timed as a person's. Both hosted tool loops now receive one
    approver that passes the agent's name and origin, `requestWriteApproval` has no default for either, so the
    compiler refuses the bare function where an approver is expected, and a test fails if any approval function
    is passed as a value. Every other approval call site was read again: each passes its agent, except the Agent
    Builder's model loader, which no agent raises. Command approvals were not affected.
  - **Execution: three changes, one boundary.** `spawnCwd` upper-cases the Windows drive letter of the directory
    a host-started command or an agent terminal starts in; it names the same directory and is compared with
    nothing. `timeout_seconds` raises the foreground limit from a fixed 120 seconds to at most 600, bounded in
    code and tested; `wait_seconds` lets `check_command` wait at most 300 seconds on a command of the same agent
    and starts no process. Command policy, the approval card and the outside-root check run before any of it, as
    before. The repeat limit on polls is unchanged and still keyed by host-observed progress, so a wait cannot be
    used to poll a silent command without end. Stop ends a wait; it does not stop the background command, which
    is the existing behaviour of Stop.
  - **System Architect: role-complete without a silent grant.** The shipped `architecture` capability now includes
    `execute`, so a newly created or explicitly reset/saved Architect can request `run_command` and its companion
    wait/stop tools. The concrete command still crosses Workspace Trust, folder/task scope, command policy,
    approval and catastrophic-command checks. Persisted `allowedTools` are not re-derived on load, and a regression
    test keeps an older saved Architect without `execute` until the user acts in Agent Builder. A Builder save
    re-derives tools from the ticked capabilities, so any save of such an agent adds `execute`; the form now states
    `Saving adds to this agent: Run commands` beside Save whenever the ticked capabilities grant a tool the saved
    agent does not hold. Runtime guidance is
    generated from the effective tools: a no-execute worker must report the missing capability and must not read
    scripts or history as a substitute for execution.
  - **Sixteen more roles can request commands: sufficiency instead of the fewest tokens.** Owner decision,
    2026-10-02, on the 52-role audit: a built-in role holds the tools its own work needs. Nine roles that verify
    (Technical Writer, Security Engineer, Reviewer, Sales Engineer, Application Security Engineer, Cloud Security Engineer, Knowledge Manager, Developer Advocate and Localization & i18n Specialist)
    and seven that calculate (Financial Analyst, FP&A Analyst, Product Analyst, Data Analyst, Support Operations Analyst, Revenue Operations Analyst and SEO & Analytics Specialist)
    now derive `execute`. Roles whose skills already carried it lost a role-level `deny`; the others gained one of
    two new capabilities, `verification` and `computation`, whose tools are `read`, `search`, `execute`,
    `message` and not `write`. **Four roles gain `write`** by the same decision, because a review, a quality
    report or an assessment is a deliverable and needs a file: the Reviewer (through `documentation`), and the
    Application Security Engineer, the Privacy & Data Protection Officer and the GRC Analyst (their role-level
    `deny` of `write` is removed; the last two still derive no `execute`). What this lowers, stated plainly: these
    four were read-only by tool list, and that was the mechanism behind "an independent validator never edits the
    work". They now receive `write_file`, `apply_edit` and the delete tools like any writing role. `unode.writeApproval`
    is `none` by default, so nothing asks before such a write; the boundary that remains is the role's instruction
    ("you never change the work you review"), Folder Access, a task's write scope where the coordinator sets one,
    and the per-agent edit history and checkpoints, which show and can restore every changed file. A user who wants
    the old guarantee can untick the writing capability for that agent in Agent Builder or set write approval to
    `ask`. What does not
    change: Workspace Trust, folder and task scope, the command policy, per-command approval, the
    catastrophic-command block, and `delegate`, which only the coordinator holds. Saved agents are not re-derived
    on load. A role-level `deny` was never applied by an Agent Builder save, which derives tools from the ticked
    capabilities alone, so an agent created or saved there from one of the seven roles whose skills carry it already held
    `execute` before this release; the templates now agree with that path. Three role descriptions that claimed
    sending, booking or account changes were corrected: no tool for those exists.
  - **Advice to the model that reduces a narrowing.** `dispatch_task` now says to leave `write_scope` out for an
    ordinary task. No field's requirement changed and the worker's Folder Access is enforced exactly as before,
    but fewer tasks will carry the optional per-task ceiling and its file claims. Recorded here because it lowers
    the use of a defence in depth, not a boundary.
  - **New persisted state.** Run ledger schema v10 `turns`: turn id, agent id, thread key, ending, spend-unit id
    and timing, rebuilt field by field on restore, with both timing identities checked. An entry that names
    another run or does not add up is dropped and counted; different entries under one turn id become a conflict
    that stays. The transcript keeps a phase breakdown only when it adds up to its turn. Neither is repository
    input, neither is read back as control state, and the ledger field is non-portable. A finished tool card
    additionally keeps `humanWaitMs`, one number from the host's turn clock; on restore it is kept only as a
    whole number of at least 1 and is used for display alone.
  - **What the chat renders.** The live line shows a provider's display name and a tool card's title through
    `textContent`. The phase and both timers come from the host; a phase or its end from an earlier turn is
    refused.
  - **Nothing happens silently.** Three places drop or bound something without a line in the chat, judged
    acceptable because each removes a claim and makes none: a stored breakdown that does not add up is shown as
    no breakdown; an invalid ledger turn entry is counted in the record and displayed nowhere yet; and a wait or
    timeout above its limit is cut to the limit, which the tool description states and the timed-out result
    names in seconds.
  - **Known gap carried.** Commands that the Claude and Codex CLIs run themselves still start in the directory
    as the editor spells it. It affects whether Vitest starts, not what may run; listed in the manual's known
    issues.
  - **Repository-configuration matrix.** No setting, team-file field or other repository input was added, so the
    matrix is unchanged; its canaries pass (27/27).
  - **Egress and dependencies.** No new destination. No dependency of the shipped extension added or changed.
    Codex's pre-push audit of 2026-10-03 found `npm audit` failing on an advisory published after the first
    candidate audit (`braces`, GHSA-vfj7-8cjw-p6xm, through the packager only). The packager `@vscode/vsce` moves
    from 3.9.2 to 4.0.0 and `ovsx` is made to resolve the same version; §8 states what that pairing rests on.
    `npm audit` and `npm audit --omit=dev` report 0.
  - **Guidance that named a control the product does not have (Codex's audit, corrected).** An agent without Run
    commands or Write files told the requester to "enable Run commands in Agent Builder". Agent Builder has no
    such switch: a permission is what a ticked capability results in. The guidance now says to tick, under
    Tools, a capability whose resulting permissions include the tool, and a test checks those words against the
    form's own.
  - **Gates.** The candidate's own numbers are in the release record.
- **2026-09-30/10-01 — v0.9.91 implementation and release audit (Claude implemented; Codex designed the release and
  audited each slice and every fix; field scope is automated only, by the roadmap).**
  - **Security defect fixed: a shared Claude tool gate.** Found while tracing an intermittent test failure, then
    confirmed with two backends in one folder: the second start replaced the first agent's wrapper, and the second
    stop deleted it while the first still ran. Present since v0.9.28. Each backend now writes
    `.unode/claude/<random>/` (`claudeLaunchFiles`), with the same unlink-then-exclusive-create write as before. A
    test starts two agents in one folder and stops one; a mutant that restores the shared folder is killed.
  - **Execution and approvals: unchanged decisions.** Every reordered check only refuses. Refusal reasons are
    recorded, never sent to Claude: `claudePermissionResponse()` strips them, and a test asserts Claude's permission
    contract is unchanged.
  - **New inputs read from the Claude CLI.** `tool_use_id` in the hook body and the permission arguments, and
    `_meta["claudecode/toolUseId"]` on MCP calls. Each is bounded, used only to pair a host decision with its call,
    and never grants anything. An id that names no call, or two calls, joins nothing and marks the turn's coverage
    partial.
  - **Results became stricter for the model, never looser.** Refused team and files-bridge results reach Claude as
    errors. A blocking delegation that failed, timed out or was refused is no longer a typed success. A late
    team-policy refusal is delivered to the coordinator.
  - **Text classifiers removed.** `classifyToolFailure` and `TeamTools.isTaskFailure` are deleted, with Codex's
    `Error:` prefix inference. `check:typed-outcome-authority` (pretest; shipped in the source drop) walks the syntax
    tree, folds string constants and kills 20 planted violations. It is a regression check, not a proof: a marker
    reached through an object property or a run-time value is outside what it reads.
  - **New persisted state.** The turn outcome receipt on the final transcript message and in the run ledger (schema
    v9), the typed outcome on stored tool cards, and the settlement on retained delegation results. All are in the
    same workspace store as before, rebuilt field by field on restore: unknown fields are dropped, contradictory
    counts and facts are rejected, and a stored fact that is not valid leaves the record unclassified. None is
    repository input. The ledger never reads a receipt as control state, and both new run fields are non-portable.
  - **Nothing happens silently.** A turn whose host decision could not be joined, whose worker process died, or
    that used Codex-native tools is recorded with partial coverage, never as complete. A record from an earlier
    version is "not recorded", never "no tools used". Cancelled and interrupted async results are still not
    delivered to the coordinator's model, as before; an interruption still posts its notice in the chat.
  - **Repository-configuration matrix.** No setting, team-file field or other repository input was added, so the
    matrix is unchanged; its canaries pass (27/27).
  - **Egress and dependencies.** No new destination. No dependency added or changed; `npm audit` and
    `npm audit --omit=dev` report 0.
  - **Gates.** The candidate's own numbers are in the release record.
- **2026-09-29/30 — v0.9.90 implementation and release audit (Claude implemented; Codex audited Slices 1-4, the
  second step and the whole build, and cleared Slice 9 on 2026-09-29; Owner field test passed; Codex's review of the
  field fixes F1-F8 recorded in the release record).**
  - **Egress: a new use, no new destination.** Host-summary requests go to the agent's own connection (its economy
    model), each a priced `compact:` usage unit opened only when the request leaves the host.
  - **Consent correction (field F6).** The summarizer called the egress gate with no scope, so its grant was the
    generic `direct` host-only one, contrary to §2's profile-and-revision binding for "the chat summarizer". It now
    requires the agent's connection scope (`SummaryRequest.ts`). A request refused or cancelled while its consent is
    open sends nothing and leaves no usage or coverage gap (F7).
  - **Prompt-injection containment.** The rolling summary is historical, possibly untrusted data in one JSON string
    that nothing inside can close, and it never claims system authority (whole-build review B1). Carried records
    are data under their own header. `withoutHostFields` strips host-only outcomes from every request.
  - **Process launches.** The Claude compaction environment is numeric-only, from validated policy. A replacement
    Codex App Server re-crosses every launch check and ignores the replaced process's output (whole-build review B2).
  - **New repository input.** Four agent fields and the team profile table in `.unode/team.json`, validated per
    field. Hostile values were tested: a string for a number, 5%, 10 tokens, an unknown mode or profile. All were
    dropped with a warning, and the agent still loads. Effects are bounded as stated above. The manual now says
    that a shared team file can also make compaction more frequent.
  - **New persisted state.** `providerHistory` in the conversation snapshot, in the same workspace store as the
    conversation itself. Codex `codexLastRequest` and `codexContextWindow`: numbers, validated on restore, bound to
    their thread and model.
  - **Display.** Upstream provider names are allowlisted and escaped. Compaction receipts render counts, sizes and
    fixed sentences; the summary is collapsed and labelled as model-written, not evidence.
  - **Guidance, not permission.** A user-named path is used as given (F2). A delegated worker may use what the user
    told it directly (F4). The Team row's Smart compaction button only opens Agent Builder (F1).
  - **Dependencies.** None added. New advisories since v0.9.89 are cleared within declared ranges: `fast-uri` 3.1.8
    (bundled through `ajv`; GHSA-hrr3-gc8f-f4qj), `markdown-it` 14.3.2 (packaging only), and the `brace-expansion`
    overrides raised to 2.1.7 and 5.0.12 (test tooling; GHSA-6j4f-fj2g-mc7p, GHSA-qhr7-859c-m2p7,
    GHSA-q2hr-2g5m-vwhr). `npm audit` and `npm audit --omit=dev` both report 0.
  - **Gates.** Release authority canaries 27/27. The field build at `0f19b4a` (clean worktree, `npm ci`): release gate
    3,848 tests (3,847 passed, 1 documented skip), e2e 29 passing, bundled smoke passing, focused mutation main
    352/352 and v0973 41/41. The release candidate's own numbers are in the release record.
- **2026-09-27/28 — v0.9.89 implementation and release audit (Claude; Owner field test passed; Codex approved
  the release on 2026-09-28).**
  - **New local persistence.** Spend events and a control file under the extension's global storage, per primary
    workspace root identity. Content-free by schema (closed validators reject unknown keys); a 64 KiB line cap;
    per-window shards so windows never overwrite each other; a nonce-checked `maintenance.lock` with a two-minute
    lease that a reused process id cannot hold forever; recorded Repair that never edits events.
  - **New egress.** A user-initiated, keyless GET of the Unode or Roam public price list for the dated reference,
    through the existing metadata consent, with redirects refused (§1). No background or activation refresh.
  - **New repository input.** `.unode/budget.json`: strict parsing, physical containment, exact-digest acceptance,
    narrow-only; its notice is non-modal and silent.
  - **Authority.** Two new user-only settings; workspace values are ignored and reported like the other 41.
  - **No new gate on work.** No spend path can stop, pause, refuse, retry, truncate or wake anything; the one Stop
    action is a single-use user action bound to one request. Checked by tests and focused mutants (automatic stop at
    100%, a late or reused Stop, a spend alert that a turn could await, partial usage reminding, a repository value
    enabling a reminder, a public group or stale key becoming an account price, a lost cross-window receipt, a lock
    that never expires, rounding upward, among 37 new mutants).
  - **Field fixes.** F7-21's token is host-only; the read-root note grants nothing.
  - **Gates** (clean worktree, `a926d8c`, `npm ci` first): release gate 3,571 tests (3,570 passed, 1 documented
    skip); e2e 19 passing / 2 pending plus 1; bundle 103 files, 2.21 MB, smoke passing; canaries 27/27; focused
    mutation main 161/161 and v0973 41/41; `npm audit` 0.
  - **Round 2 (Codex's audit of `531e627`).** Four findings fixed, one not reproduced:
    - An older UnodeAi could overwrite control from a newer schema that appeared after its last read, and Repair
      decided from control read before it took the lock. Both now re-read and re-check under the lock; a newer
      schema in control or in any shard refuses the write.
    - A lock holder whose lease was taken over could still rename over control, rewrite the lock record or delete
      the new owner's lock. Control is now a series of revision files, each published once by exclusive hard link
      (exclusive create where hard links are missing), so any publish of an existing revision fails. The lock record
      is written once; renewal and release only create files named by the holder's nonce.
    - A failed usage write was logged and lost. Events now queue in order and retry (1 s doubling to 30 s) with
      **Usage updating** shown; a partial line never has a later line appended to it.
    - Notice claims were pruned by count, which could drop an active counter's claim, and multiples stopped at
      10,000. A counter now claims only above its highest live claim and keeps one claim; a claim lapses when its
      period ends or its request goes 30 days without usage; the ladder has no cap.
    - An unavailable display cost with a price attached was already rejected; a test and an explicit check were
      added.
    - Nine focused mutants (eight new, one re-anchored) and a fourth independent-process test with a barrier (a
      stalled holder resumes after the new owner took over) cover these.
    - **Gates** (clean worktree, `46dac6f`, `npm ci` first): release gate 3,586 tests (3,585 passed, 1 documented
      skip); e2e 19 passing / 2 pending plus 1; bundle 103 files, 2.22 MB, smoke passing; canaries 27/27; focused
      mutation main 169/169 and v0973 41/41; `npm audit` 0.
  - **Round 3 (Codex's re-review of `46dac6f`).** Codex approved the round-2 concurrency design and found two gaps:
    Repair still wrote control while a shard came from a newer schema (now refused, files unchanged), and the
    30-day request-claim lapse did not apply to the reminder check or to this window's own claims (one rule now
    decides all three). Four new focused mutants.
  - **Gates** (clean worktree, `7b3c1be`, `npm ci` first): release gate 3,588 tests (3,587 passed, 1 documented
    skip); e2e 19 passing / 2 pending plus 1; bundle 103 files, 2.22 MB, smoke passing; canaries 27/27; focused
    mutation main 173/173 and v0973 41/41; `npm audit` 0. Codex's narrow re-review is pending.
  - **Release-stress finding S1 (Codex's release review of `81d4e4a`).** The nightly Windows release stress had
    failed 20/20 suites every night since 2026-09-21 on the same 13 tests: the runner's temp folder is an 8.3 short
    path. Reproduced locally by pointing TEMP at a short name. Boundary-relevant results: the file coordinator keyed
    reads physically and writes lexically (a false "not read" refusal since v0.9.65, never a missed one); task-scope
    classification compared a physical target with lexical configured roots (an escape error where a task-scope
    refusal was due; both refuse); HOME was excluded from repository CLI inspection by its lexical spelling only
    (over-inspection of the user's own CLI folders, never under-inspection); task input identity used the
    JavaScript realpath while the file tools used the native one. All now compare physical paths. No containment
    check or launcher rule changed. Six new focused mutants and one re-anchored.
  - **Field rounds (Owner, VS Code, steps 0-8 passed).** No finding widened a permission. Relevant to control: a
    Codex agent was shown idle for the whole of each turn (since v0.9.84), so **Stop this request** and a
    coordinator's stop did not reach it and a queued task could be delivered into it; a mid-turn `ready` now only
    records the thread id. Reminder wording now says work is continuing only while it is. Two moderate dev-chain
    advisories published during the field test were cleared (see §8).
  - **Release gates** (clean worktree, `dadb37f`, `npm ci` first): release gate 3,610 tests (3,609 passed, 1
    documented skip); e2e, bundle and smoke passing; canaries 27/27; focused mutation main 192/192 and v0973 41/41;
    `npm audit` 0. The whole suite also passes with an 8.3 short temp path, locally and on the GitHub Windows runner
    (CI run 36514612424). The release test gate now distinguishes a skip that depends on the machine (file-symlink
    privilege) from a platform skip; a failing test still fails.
- **2026-09-24 — v0.9.84 release re-audit: a new process route, one disclosed vulnerability, one trust-write
  bug found and fixed during the audit.**
  - **Disclosed.** Claude Headless through v0.9.83 loaded a repository's `.claude` hooks and `.mcp.json`
    servers without a UnodeAi prompt. v0.9.84 inspects repository `.claude`, `.mcp.json` and `.codex`
    configuration along each CLI's own discovery path (up to the volume root, excluding the home-folder user
    directories), shows a redacted summary, and binds the decision to the exact contents.
  - **New process capability.** The OpenAI Codex CLI route spawns the user's own `codex.exe` as an App Server
    after an executable-bound consent, and an explicit **Load models from Codex** action spawns a model-list-only
    App Server in a neutral folder outside every workspace. Before consent UnodeAi runs only `--version` and
    `login status`; `login status` was measured local (it answered through a dead proxy). The executable is an
    authority setting read only from User settings; detection lists npm/user installs before PATH and rejects
    prereleases below the 0.155.0 floor.
  - **Execution and writes.** Codex runs under its own permission profiles; routine commands and workspace edits
    are not mediated by UnodeAi, which the documentation states. Full access is unsandboxed, confirmed each time
    it is enabled, and unavailable to agents with explicit Folder Access grants. Escalations reach a UnodeAi card
    (Ask for approval) or Codex's reviewer (Approve for me); an MCP tool called from inside Codex's own `exec`
    code tool is not routed for approval and no claim is made for it.
  - **Boundary checks, measured on Codex 0.155.1.** UnodeAi pins the profile at process, thread and turn and
    refuses a thread whose sandbox, network, writable roots or temp exclusions differ from its grant. Only write
    roots are offered as workspace roots, because a resumed thread makes every one writable; `environments` is
    omitted, because an empty list disabled escalation. A release probe exercises all four profiles as effects.
  - **Hostile-configuration matrix (this audit).** A repository `.vscode/settings.json` cannot choose the Codex
    binary (application scope, read only from User settings). A project team file asking for
    `codexPermissionProfile: full-access` is stripped. A trusted repository `.codex/config.toml` setting
    `approval_policy = "never"`, `sandbox_mode = "danger-full-access"`, `approvals_reviewer = "auto_review"`,
    network on and temp writable was overridden by the pinned values, and adding `writable_roots = ["C:/"]`
    was refused before any model turn — both measured through the production backend on the real binary.
  - **Found and fixed during the audit.** In a workspace that is not a git repository, a Codex agent working in
    a subfolder was keyed by Codex under that subfolder, missed UnodeAi's root-only trust override, and Codex
    wrote `[projects.'<subfolder>'] trust_level = "trusted"` into the user's own `~/.codex/config.toml` —
    a silent write, and a native trust grant the user never made. The override now covers every folder from
    the working directory up to the workspace root; the same case writes nothing (measured in an isolated
    Codex home), with canary `main-v0984-codex-trust-cwd`. The permission probe had written six such entries
    for its temporary workspaces into the validation machine's own config; it now uses the production gate and
    leaves that file byte-identical.
  - **Network.** Gateway consent is bound to profile, destination and revision; Codex's own network is outside
    UnodeAi's control, as stated. The only scheduled network task, the daily price refresh, is user-toggled and
    does not run at activation (field-verified on reload).
  - **Dependencies.** `hono` 4.13.9, `js-yaml` 4.3.2, `vitest` 4.1.11; `npm audit` and `npm audit --omit=dev`
    both report 0 vulnerabilities.

- **2026-09-19 — v0.9.81 project-content execution authority re-audit.** Repository history places both
  vulnerable mechanisms in the initial v0.9.11 tree and every later release through v0.9.80. A project team
  file could inject provider-child environment and select Claude `bypassPermissions`; on Windows, bare
  host-selected Claude/Git names could resolve from the workspace. The field inventory now makes executable,
  approval, environment, protocol and MCP attachment fields host-only, makes scope fields narrow-only, clears
  only source-unknown legacy `env` and `autoApprove` values once, and omits host-only fields from new project
  files. Existing user-owned Skills, Playbooks, MCP grants, routes, backend choices and other configuration are
  preserved. Already-approved legacy project integrations are imported into host-owned state; unapproved entries
  are ignored and named. The MCP state keys move from `roam.approvedMcpServers` /
  `roam.hostMcpServers.v1` to `unode.approvedMcpServers` / `unode.hostMcpServers.v1`; a downgrade to 0.9.80
  requires approving integrations again. Host-selected
  executables resolve absolutely outside workspace/worktree roots. Four release canaries re-admit `env`,
  `autoApprove`, bare `claude.cmd`, and shell-based Git lookup one at a time; each must fail its named test.
  The hostile fixture contains marker-only payloads, performs no network request and reads nothing outside itself.
  User-approved shell text is unchanged. Claude-route inherited-process MCP secret precedence remains disclosed
  as a limitation of the current release.

- **2026-09-19 -- v0.9.80 release re-audit: the field-run fixes add one local process capability and tighten two
  gates; one consent-UX defect ships as a disclosed known issue.** Reviewed against the code at `11e4e21`, the commit
  of the field-tested candidate; the release commit adds documentation only.

  **New host process (F7-19).** UnodeAi-created terminals now carry the environment marker
  `UNODEAI_MANAGED_TERMINAL=1`, which survives an extension-host restart. On activation, first-folder invalidation and
  deactivation the host closes every terminal carrying that marker and first kills its process tree —
  `taskkill /pid <pid> /t /f` on Windows, a `ps -e -o pid=,ppid=` snapshot and `SIGKILL` elsewhere — with a 5 s bound
  and a direct-kill fallback. It targets only the PID the editor reports for a marked terminal; terminals without the
  marker, including every terminal the user opens, are never touched. The marker is visible to commands run in that
  terminal and grants nothing. The worst case of a forged marker is that UnodeAi closes a terminal — denial of
  service against itself, not a new capability. Field: the delayed write that survived a host restart on the previous
  candidate was killed in VS Code, Cursor and Devin.

  **Tighter execution gate (F7-17, F7-24).** A PowerShell-only cmdlet sent to the `cmd.exe` runner is refused before
  any approval prompt with its own `shell-compatibility` reason; a catastrophic-pattern denial still dominates, and an
  Allow click can no longer be reported to the agent as missing consent. No command that was blocked before can now run.

  **Ledger integrity (F7-16).** The first terminal `superseded`/`abandoned` disposition of an interrupted task is
  immutable in the tool, the run ledger and projection; legacy contradictory rows report the first.

  **New authority key.** `unode.notifications.resultStyle` (dialog | quiet) is application-scoped and resolved from User
  Settings only, so a repository cannot silence result or untrusted-workspace notices; field-checked in Cursor with a
  hostile repository value. It never applies to approval, egress or consent dialogs.

  **Disclosed here and fixed in v0.9.82 (F7-25).** At the time of this v0.9.80 audit, declining the model-egress consent was retried as a transient network error
  (streaming fallback plus up to three retries), re-showing the dialog up to four more times. Each attempt calls the
  same gate and is refused; the request log records the decline each time, and no prompt or code is sent. The defect is
  consent fatigue, not a bypass. v0.9.82 carries a typed decline past every retry/fallback layer. **Also deferred at
  the time and fixed in v0.9.82:** in Devin, rosters and transcripts followed the reusable agent-window workspace
  across projects (F7-26) — a context-exposure risk between projects, with no cross-folder write. Project-sensitive
  workspace state is now root-keyed and old Devin history is not imported.

  **Audit-table omission corrected.** The §1 egress table had no row for the composer's `@url` mention, which
  fetches a user-typed URL through `webFetch` without consulting `unode.webAccess` (pre-existing since the C1 mention
  feature; found in Codex's v0.9.81 planning, confirmed by Claude at `extension.ts` `fetchMentionUrl`). It now has its
  own row as a known gap in the current release. It fires only on a URL the user typed; SSRF, redirect, size and time checks apply.

  **Malicious-workspace matrix.** Repeated for the new key and re-run in the field in Cursor 3.21.13 (repository
  `commandApproval`, `allowedCommands` and `resultStyle` did not take effect, and a repository catalog URL did not
  change the Marketplace); the full key set remains covered by the planted-value unit matrix. **No new network
  destination, credential path, MCP behaviour or dependency.** `npm audit` production threshold passes and one existing
  moderate transitive Hono advisory remains below it (reported by Codex's release audit at `11e4e21`).

- **2026-09-11 -- v0.9.80 pre-release re-audit: repository settings were a real cross-editor authority gap;
  catalog prose and runtime authority now have separate jobs.**

  **The Cursor hypothesis was confirmed before code changed.** Cursor 3.20.10 loaded a harmless repository
  `unode.commandApproval: none`; the extension host observed both effective and workspace values as `none`.
  The fix therefore does not depend on Workspace Trust filtering. v0.9.79 and earlier lacked this host-side
  boundary in Cursor. The complete manifest/code equality test pins the 39 audited keys to `scope: application`,
  `restrictedConfigurations`, and the user/global-only resolver. A hostile workspace value and workspace-folder
  value are planted and resolved for **every** key, including the skill-library link, Smart Mode, model tiers and
  pricing inputs; none can win. Project command approvals use a bounded, workspace-identity-keyed host store,
  are inspectable and revocable, and never replace the user's global allowlist. VS Code greys these
  application-scoped project keys and provides its own scope explanation; the UnodeAi one-time notice covers
  editors that actually expose a legacy project value to extensions.

  **No-folder and changed-folder work fails closed.** The former `process.cwd()` fallback is gone. Services that
  captured the first folder are invalidated when that folder changes; running agents and MCP servers stop, the
  Team Rules editor closes and rechecks its root before saving, and subsequent agent turns, background
  persistence and explicit writes refuse. Tests change the first folder and exercise the stale-root guards; the
  candidate field plan separately exercises Devin's add-a-folder-without-reload sequence.

  **Integration cards do not confer trust.** The release catalog validator requires provenance, maintenance,
  exact install identity and current verification evidence, rejects mutable npm `@latest`, unknown data,
  archived sources and installable-deprecated entries. Runtime validation rejects invalid/future dates but keeps
  overdue entries visible and labelled, so time alone cannot empty the tab. Display and mount use the same shared
  host policy; role suggestions never enter an Agent's MCP grants. Lifecycle evidence is tied to the physical
  workspace and exact server fingerprint. The planted-failure gate runs in ordinary tests, from the bundled VSIX,
  and from inside the allowlisted public source drop.

  **Enter is a non-consent path.** The modal structural gate now resolves aliases, spreads and `MessageItem`
  labels, fails closed on dynamic labels it cannot resolve, audits every action modal, requires the first
  result-dependent branch to dominate the continuation, rejects duplicate Cancel items, and audits multi-select
  QuickPicks. Two planted failures cover an unresolved label and a comparison that does not guard the later
  effect. The model metadata picker starts with every host unselected, so Enter grants none. Real Enter-key
  behavior is still checked in VS Code, Cursor and Devin as described below.

  **Interrupted work is a schema-v8 durable fact, not a process guess.** Each new active delegation records the
  owning editor session, extension-host epoch and renewable heartbeat. An isolated VS Code 1.137.0 Reload Window
  probe changed the session id and therefore took the foreign-owner branch; it waits for the 30-second lease.
  An editor that retains the id instead reconciles its older epoch during activation. The output channel records
  both resolved identities and the branch.
  Each window writes a host-specific `workspaceState` shard. Loads merge through the current host identity into
  `roam.runs.merged.v8`, then delete only unchanged foreign shards whose rows reached that baseline and whose
  newest heartbeat is older than the lease. The pre-v0.9.80 `roam.runs` value remains a read-only migration
  input. Idle maintenance performs no run-state read, and a host resuming after a gap longer than interval plus
  lease skips foreign judgment for one cycle. Concurrent windows therefore do not race one shared whole-array
  key, grow an unbounded shard set, or let a stalled observer permanently override a resumed live owner. Worker
  loss and restored-attempt reconciliation both end the exact attempt. Runs
  containing an interrupted delegation can close only as partial, the internal pack names every interrupted
  handle, and Activity renders the loss reason plus last-observed and detected timestamps even after `abandoned`
  or a linked replacement disposition. Internal run storage is schema v8; Portable Run Evidence is
  `portable-run-evidence/4` and carries the separate interrupted state/count without exposing host ownership.

  **Carry-forward finding from v0.9.79:** the 2026-09-08 v0.9.79 audit entry predates the later Owner decision
  that changed cross-provider brief consent to default-on (`ed18263`). That relaxation was documented at the top
  of this file but was absent from the dated audit entry. It is recorded here rather than rewriting history:
  the default sends a coordinator brief without a per-dispatch modal, remains user/global-only, logs the resolved
  destination, and does not replace the separate per-host model-egress gate. v0.9.80 also makes the modal's first
  action an explicit decline when the user has chosen to require it.

  **Interactive proof still belongs to the candidate.** Structural tests prove every in-scope modal lists the
  non-consent action first and never passes a literal duplicate `Cancel`; they cannot prove how each editor maps
  Enter. VS Code, Cursor and Devin must receive a real-keypress field record before publication, or the release
  note must name the missing test and why.

- **2026-09-08 -- v0.9.79 pre-release re-audit: one host-owned metadata write and one prompt-priority signal,
  with no widened execution authority.**

  The only new durable write is the explicit local attestation in `workspaceState`; the registry is unavailable
  to model tools and carries exact-row digests plus bounded fixed metadata, not prose. Workspace Trust is checked
  live before the confirmation path and again when prompt trust is resolved, so a stored record cannot make a row
  trusted while the workspace itself is untrusted. The prompt signal is deliberately narrow: it changes admission
  priority and the `human-attested` display label, while every host permission decision remains on its existing
  path.

  Shared-memory load and append now reuse the physical workspace resolver. The review included a real
  platform-appropriate directory-link escape test, a normal missing-parent write test, structural delimiter/attribute
  injection tests, exact-byte invalidation, corrupt/cross-workspace store cases, and a mutation that restores
  author-selected `contract` priority and is killed by the focused suite. The single-snapshot routing regression
  changes memory after selection and confirms that the supplied block and typed receipt counts remain paired.

- **2026-09-08 -- v0.9.78 pre-release re-audit: no new reach; one ordering change checked for a widened
  write, and a new source-side pipeline checked for execution.**

  **The diff is small enough to audit exhaustively, and it was.** `git diff v0.9.77..HEAD -- src/` returns
  two production files: `extension.ts` and `TeamTools.ts`. Everything else in this release is documentation,
  tests, or `tools/**`.

  **What was verified, and where:**

  - **The repair's authority is unchanged.** `repairPriceMultipliersAfterUserAction` passes
    `writeSetting: (next) => settings.writeGlobal('priceMultiplier', next)`. One key, Global scope, no other
    setting reachable from that path. Moving the call site cannot widen what the callee is allowed to write.
  - **Detaching it did not create a double write.** `priceMultiplierReadRepairInFlight` still dedupes, so
    `Open Settings` and `Refresh Model Prices` in quick succession share one repair rather than racing two.
  - **A detached failure is handled, not dropped.** `startPriceMultiplierReadRepairAfterUserAction` passes
    both fulfilment and rejection handlers to `.then`, so a rejected repair produces an output-channel
    record and a user-visible warning instead of an unhandled rejection.
  - **`tools/**` is excluded from the VSIX** by `.vscodeignore` line 52, and the staging boundary check
    reported 99 files with no `tools/` entry among them.
  - **The ECC adapter executes no candidate content.** Its single `spawnSync` invokes `git` with
    `shell: false`, a fixed argv, and configuration hardening that covers repository-local config as well as
    system and global — the `core.fsmonitor` case specifically, since a cloned repository's own config can
    name an executable there.

  **One observation, not a defect.** The hardened `runGit` points `core.hooksPath` at a fixtures directory
  that exists to be empty. That is correct and deliberate, but it is a path whose *emptiness* is the control;
  a future change that puts a file there would weaken the guard silently. It is worth a gate if the adapter
  grows more Git surface than the two read-only subcommands it uses today.

  **What this release does not claim.** The Cursor fix has not been exercised on a published build by anyone
  — that is the Owner's post-release check, and it is not evidence for this entry. The Windsurf result is a
  use report, not a surface sweep. Neither is a security finding either way.

- **2026-09-07 -- v0.9.77 pre-release re-audit: the first widening of the read boundary, checked against the
  code rather than against its own description.**

  **The log lapsed for v0.9.73 through v0.9.76** and is resumed here rather than backfilled, for the reason
  this section already gives: a reconstructed audit entry is not an audit. Those releases carry their reviews
  in the section at the top of this file; what they do not have is a dated entry, and pretending otherwise
  would be the first thing in this file that is not true.

  **What was verified, and where.** Every claim in the v0.9.77 review above was checked against source, not
  accepted from the card that asked for it:

  - **Workspace Trust gates it twice.** `configuredLocalReadScopeRoots` returns `[]` when
    `vscode.workspace.isTrusted` is false, and `localReadRootsForScope` refuses independently on its own
    `isTrusted` argument. `unode.localReadScope` is in `restrictedConfigurations`, so a repository cannot set
    it.
  - **An unrecognised value fails closed to workspace-only.** The resolver's `default` branch returns `[]`;
    only `parent` and `volume` produce a root. `parent` at a drive root returns `[]` rather than silently
    becoming `volume`.
  - **All four reaching tools ask.** `read_file`, `list_dir`, `search_files` and `inspect_git_tag` each call
    the consent gate before touching a local-scope root; `search_files` asks for **every** local-scope root
    before listing anything, so a refusal cannot leave a partial scan behind.
  - **A decline is remembered for the session** — the consent gate stores the decision promise per resolved
    root, so a denial is neither re-asked nor retried into an allow.
  - **The widening is read-only in the code, not only in the prose.** `writeRoots` is a separate constructor
    input; the local-scope roots enter through `additionalReadRoots` and reach no write path, shell cwd or
    Claude `--add-dir` authority.
  - **The receipt carries an ordinal, an action and a count.** `file-read`, `directory-list`, `tree-scan` and
    `git-tag-inspection` are distinguishable, and a whole-tree scan is therefore not recorded as if it were a
    single named read.

  **One observation, not a defect.** `configuredLocalReadScopeRoots` passes a literal `true` for `isTrusted`
  because it has already checked trust itself. That is correct today and reads as a hard-coded grant if the
  guard above it is ever moved; the second check inside the resolver is what makes it survivable.

  **What this release does not claim.** The consent dialog has not been read by anyone who did not write it,
  and no browser-selection behaviour has been confirmed by hand. Both are carried as post-release field
  research, which is not a release gate and is not evidence for this entry.

- **2026-08-31 -- v0.9.72 pre-release re-audit: no new reach; a refusal that was enforced but misreported
  is now carried as a value.**

  **The gate held; the report did not.** `summarizeToolResult` classified success by matching its own output
  against an anchored English prefix list, and the string the product emits when a user denies public web
  access was absent from it -- so a denied `fetch_url` was summarised as a successful call. No network call
  was made and no content was retrieved: the failure was in the account, in the activity feed and in what the
  model was told. Host tools now return `success | refused | failed` with a closed reason enum, `toolSummary`
  rejects a bare string from a host tool, and the prefix list is **deleted, not extended**.

  **One re-creation of the same defect was caught by mutation inside this release**: with the list gone,
  neither delegated-batch collector marked its invocation, so a batch containing a failed task reported as a
  successful call. Both now bind wording to status through one helper, each proved separately so a shared-helper
  mutation cannot conceal an unwired call site.

  **No new reach.** No tool, network path, filesystem path or capability is added. New refusal reasons are
  content-free by construction -- a tool name, an enum, fixed text -- and carry no path, root or credential;
  `RunVerdictWithholding` carries a reason and a count and nothing from the rejected value. Failure output
  quoting a worker reply or a subprocess is now marked `mixed-external` rather than host-authored. The new
  package-script tokeniser reads untrusted `package.json` text, executes nothing, runs in a single linear
  pass, and refuses a body it cannot read rather than guessing.

  **Deferred and recorded:** `classifyToolFailure` at `SessionManager.ts:1589` still runs for events from
  `ClaudeHeadlessBackend` and `CodexBackend`; it picks the UI category label only and cannot flip `ok`.
  ROADMAP Track E names the three sites and the end state.

- **2026-08-30 -- v0.9.71 pre-release re-audit: one authority narrowed, one provenance field added, no new
  reach.**

  **Dispatch stopped being a capability label and became an identity.** Any agent holding `delegate` used to
  receive the full delegation surface, and a shipped skill granted it by default. A worker's sub-delegation was
  **invisible to the coordinator** because handle maps are per-instance, and **a task scope did not survive the
  hop** -- a requested scope intersects the target's own configuration, never the dispatching agent's active
  scope. One coordinating identity now exists, resolved once, consulted through a single predicate that both
  former copies call. **Nothing gained authority**: a worker proposes work in an ordinary message and **the host
  never parses it**.

  **Legacy teams keep loading.** A worker's retired `delegate`, or a second `role: 'pm'`, is handled with a
  validation warning and an in-memory drop rather than a failed load, preserving every member.

  **A defaulting hole was found in audit and closed**: `workerComplianceProtocol` defaulted its coordinator id
  to a resolution over its own config, making any `role: 'pm'` its own coordinator. Only prompt text was
  affected and the sole production caller passed the real id, so nothing was granted; the parameter is now
  required.

  **Settlement reports what the host observed.** Required inputs are compared against the resolver's own
  `readAt`, recorded in evidence, status and the ledger **without any tool call**, and **never taken from
  `task.complete` metadata** -- proved by a test whose worker forges read metadata. The host records the fact
  and does not reject the delegation.

  **The note tier is a routing fact, not an identity.** `EffectiveExecutionIdentity` was deliberately not used,
  because its own header forbids prompts, ledgers and exports and a note is all three. The tier is not a tool
  parameter and cannot be model-supplied; the kind is model-selected from a closed vocabulary and never inferred
  from text. **Nothing scores, filters or re-orders notes by tier.**

  **Both long-standing unproved boundaries are closed** -- attempt liveness, whose proof had been attached to an
  inlined copy, and contract-managed anti-redelegation, which had no test at all.

- **2026-08-29 -- v0.9.70 pre-release re-audit: one read-only tool, one off-by-default policy, three
  deleted prose judgements, and two enforcement points moved without changing what they permit.**

  **No item widens reach, egress or authority.** Workspace Trust moved from four per-tool guards to one
  dispatch-boundary decision covering writes, edits, deletes, `apply_patch` and `run_command`. **The command
  was already refused when untrusted** -- writable roots are emptied upstream and the shell path met the
  read-only refusal, and the Claude backend denies shell tools before any approval. What changed is ownership
  and the stated reason: the refusal had named the wrong remedy, and `apply_patch` had been borrowing a guard
  no test could kill. **No per-command approval exists in an untrusted workspace by decision**, because such a
  prompt would be induced by the untrusted content itself; the approval is Workspace Trust.

  **`inspect_task_status` is read-only**: it consumes no result, messages and wakes no worker, takes no
  disposition, and exposes no other coordinator's handles, raw result text, source content, absolute paths,
  commands or secrets.

  **`report_context_gap` no longer accepts a model-authored reason.** The host derives it from its own latest
  observation for that attempt, and a later successful read invalidates an earlier gap.

  **Three prose judgements deleted, none replaced.** Two English-only regexes that graded a model's reply for
  claimed success -- blind in the product's own working language and able to read an explicit denial as a
  false claim -- are gone, with their two fields, including from the portable-evidence allowlist. The
  skill-description gate made two English assumptions and threw, so **no non-English skill could register**;
  both checks are deleted rather than localised. Workflow branching by substring, where `approved` matched
  "not approved", is replaced by exact selection from a host-declared vocabulary.

  **The legacy workflow migration does not weaken anything**: the fallback is never offered to the agent, an
  exact label always beats it, corrupt data is still refused, and each repair is a warning rather than a
  failed load. Previously that shape failed the whole team file.

  **The human-approver rule now covers the reload and export paths it silently did not**, through one shared
  normaliser; mutating it fails both a ledger test and an export test.

  **The artifact-review policy is off by default**, host-stored, changed only through a human event path,
  adds no prompt text when off, and claims only a difference in *reported* identity.

  **Runbook 4a: twelve mutations, eleven kill.** The twelfth is the pre-existing coordinator-liveness
  survivor, unchanged and not repaired. The two rewritten families were mutation-proved separately.

- **2026-08-29 -- v0.9.69 pre-release re-audit: one new read path, one new dependency, four rules deleted.**

  **Two additions, and both were audited as reachability questions.** `read_file` now returns PDF, DOCX and
  PPTX text -- **through the identical resolution and authorisation that admits a text file**, so a document
  outside an agent's read roots is refused before a byte is examined. **The extracted text is the same egress
  class as text-file contents**, no consent applies that did not before, and **nothing enters the
  content-asset store**, so no asset, provenance or expiry surface is created.

  **Hostile-archive parsing is isolated the way the PDF path already was**: a `worker_threads` worker with the
  same heap cap and terminate-timeout, `stat` before any read, refusal of encrypted entries, Zip64 and
  unsupported compression methods, bounded declared size with a **mid-stream abort on actual expansion**,
  a bounded entry count, and **only the two Office text parts opened -- no image, macro, OLE object or
  external relationship, and no URL followed.** `yauzl 3.4.0` is directly declared and pinned; a hand-written
  reader was rejected because the isolation, not the dependency, was the real cost.

  **The cross-project team library cannot widen permission.** Host-owned per-user storage a repository cannot
  supply; folder grants kept only when inside the target workspace after resolution **and `realpath`**, with
  separate tests for an absolute path, a `../` escape and an in-workspace symlink; MCP grants removed
  wholesale because a reused server id would otherwise bind silently to a different service; **`env` never
  written globally and stripped from older global records**, since it is a verbatim user map and not a secret
  reference.

  **Nothing deleted was protecting anyone.** The `read_files` cross-check granted nothing while refusing, and
  the authority checks beside it are untouched and re-proved. Two rules that inferred meaning from language
  are gone; `verified` now comes from a declared sensor rather than a list of tool names.

  **The Activity feed is treated as an export surface**: a closed target vocabulary, a command's program name
  only, and an unowned MCP tool rendered as its name alone.

  **The execution identity carries no authority** -- host-private, in-process, two facts and no verdict,
  absent from prompts, tool results, roster and portable evidence, with the existing key-allowlist walk as
  the enforcement point.

  **Runbook 4a: eleven mutations, ten kill.** The eleventh is the pre-existing coordinator-liveness survivor,
  unchanged and not repaired here.

- **2026-08-28 — v0.9.68 pre-release re-audit: five behavioural mechanisms deleted, and two of them were a
  defect.**

  **No new destination, credential path, execution path, capability or exported schema.** One observational
  addition; everything else is removal.

  **Nothing removed prevented harm, and the keep-line says why.** A nudge injects a message and costs a
  round-trip; an agent that ignores it proceeds unchanged. **A mechanism an agent may ignore was never a
  control.**

  **Two of the five acted on a regular expression over model output.** v0.9.66 established that the host
  must never read prose to decide what an agent claimed, and that rule had been applied to delivery states
  while the nudge layer kept doing it. **A host that acts on patterns in model output is manipulable by
  anything that writes model output** — removing it closes a surface. Module deleted, no references, and a
  check fails the build if any of six names returns.

  **Verification did not weaken**: declared sensors and `run_checks` are the mechanism; the nudge asked
  politely and recorded nothing.

  **One instruction was removed on evidence** — it was present, correct and injected when the failure it
  addresses recurred, and v0.9.67 made its subject structural. Scoped precisely; three other guidance blocks
  untouched.

  **`effects` stayed required** while three ceremonial fields did not, and **the loosening is proved at both
  the parser and the schema the model sees.** The first pass proved only the parser; a rule can be
  under-proved on the way out as easily as on the way in.

  **Runbook 4a: eleven mutations, all kill.** For a release that deletes enforcement, that is the evidence
  it deleted the right enforcement.

- **2026-08-28 — v0.9.67 pre-release re-audit: a constraint removed, and the removal closes the hole more
  completely than the constraint did.**

  **This release deletes enforcement rather than adding it.** v0.9.66's requirement that an agent reproduce
  a document verbatim so the host could compare it against its own copy is gone, with the two-step binding,
  the normalisation spec and the comparison. Two tools became one.

  **Nothing became unprotected.** The check existed to refuse a false claim of having shown content. The new
  shape makes that claim unexpressible: the agent names a receipt and a state, the host publishes its own
  bytes, and there is no reproduction to be wrong.

  **Two rules survived the cut and both fail their mutations**: a receipt is publishable only in the turn
  that recorded it, and a turn accepts one terminal state. So do host-side `partial` slicing, fractional and
  out-of-range refusal, and turn-boundary receipt clearing.

  **The removed constraint was a security cost.** It refused a correct intent, cost 184 seconds of the
  strongest available model to recover from, and could not be escaped because the binding was immutable. **A
  guard that traps a correct agent is an availability defect with a safety-shaped justification**, and this
  audit records it as one.

  **No new authority; runbook 4a's eleven mutations all still kill.**

- **2026-08-28 — v0.9.66 pre-release re-audit: a delivery claim the host can refuse.**

  **No new destination, credential path, execution path, filesystem authority or exported schema.** Two
  coordinator tools and one per-turn host record. **Nothing added can widen what an agent may do; everything
  added can only refuse.**

  **A declaration binds an opaque host receipt from the same turn, never a path.** It cannot reach another
  turn, cannot be revised, and expires at the turn boundary. A model-supplied path never enters the path.

  **The check is a comparison, not an interpretation.** `shown` needs the source verbatim in the reply;
  `partial` needs its stated omission to match a real prefix; the host never reads prose to find a claim.
  **A refused claim is returned for correction and never published** — that is the security property, and
  every guard in it fails a mutation.

  **The guidance layer is not the fix and is pinned.** The same failure was addressed in v0.9.61 with a
  correct sentence that was running when it recurred. This release adds no prompt text and no nudge; a
  canary fails if the guidance changes.

  **Deferred streaming fails open** — text held after a declaration is emitted unchanged if no terminal
  state arrives.

  **One design correction during review prevented false refusals**: a truncated tool-card preview does not
  imply the reply lacks the content, because the capped `detail` is the card while the full `output` goes to
  the model. Runbook 4a's eleven mutations all still kill.

- **2026-08-27 — v0.9.65 pre-release re-audit: a scope that moved the floor, and a receipt that denied a
  read.**

  **No new destination, credential path, execution path, capability or exported schema.** Found by the Owner
  running real work, not by a test.

  **A task scope moved the base a relative path resolves against instead of only narrowing what it may
  reach.** Read-side that failed closed as a context gap. **Write-side it did not**: the doubled path stayed
  inside the scoped write root, so a `readwrite`-scoped delegated write silently created an undeclared
  folder and reported success. Fixed by separating `pathBase`, the authorisation roots and `commandCwd` in
  the types. `commandCwd` stays inside the writable scope — a shell is not a full filesystem sandbox — and
  the last-boundary collapse is mutation-proved.

  **The input receipt was derived from model input rather than host observation.** A read the host performed
  could be reported as unread, which is what the Owner saw. Matching is now by resolved physical identity
  through one primitive shared with contract admission; case follows the filesystem rather than a constant.

  **That fix was a disclosure risk and is closed by construction.** Grants travel inside the attempt card to
  a worker model and into exported evidence, so the physical identities are held host-private and never
  copied onto a grant. A Windows canary defect surfaced here too: `JSON.stringify` backslash escaping let a
  leaking mutant survive a serialised-form assertion, now replaced with a structured check.

  **Authority did not widen**, and runbook 4a's eleven mutations all still kill.

- **2026-08-27 — v0.9.64 pre-release re-audit: new host actions, and the first widened export vocabulary.**

  **No new network destination, credential path or command-execution path.** It does add host actions a
  webview can trigger, so it is not described as adding no new authority.

  **The webview sends a bounded kind and an opaque host-issued outcome id and nothing else.** Agent, model,
  task, command and path are all resolved host-side; a readiness repair kind carrying an outcome id is
  refused at the protocol boundary; and no repair is derived from rendered text.

  **Four invocation-time checks, all mutation-proved:** selected-agent ownership, target existence, session
  reachability, and the invoked kind matching the currently offered action. The last two survived the first
  review pass and were closed before release. Repeated and concurrent clicks produce one effect. A retry
  re-enters full contract admission with a new attempt and fresh grants.

  **An expired approval can never become an approval, and no code was written that could try.** The
  re-issue feature was gated on a per-origin rerun recipe; no origin cleared it, because `expire()` has
  already resolved the caller with a denial. The gate was answered honestly and the feature was not built.

  **`portable-run-evidence/2` is a declared breaking export change.** A timeout is no longer flattened into
  `denied`; the `decision` enumeration gains `expired`, so a strict v1 reader will see a third value. Repair
  facts are a closed category and state; the outcome id is excluded by declaration.

  **One authority guard was missing and one marker was wrong.** `delegate-required` could fall back to the
  coordinator after a failed dispatch without failing any test — correct in production, untested, the fourth
  instance of that shape in four releases. And a timed-out approval rendered the generic `!` while three
  documents promised `⌛`, because the consent and delegation timeouts shared a status key. Both closed.

- **2026-08-26 — v0.9.63 pre-release re-audit: a typed boundary that grants nothing, and a third unguarded
  authority check.**

  **No new network destination, credential path, command-execution path or product authority.** One new
  persisted field (`completedAt` on a tool card, chat history only, absent from portable evidence) and one
  new build gate. No backend, extension-host or evidence source file is touched.

  **Shape validation was audited for authority creep and found to add none.** Sixteen hand-written inbound
  checks became one declared shape per command, parsed once, rejecting unknown commands, undeclared fields
  and out-of-bounds values. The webview still names only opaque host-issued ids; the host still re-derives
  every path and permission from its own state.

  **Two correct-but-unguarded checks were closed before release:** the inbound identifier length bounds, and
  the rule that **Open full file in editor** accepts only a receipt belonging to the currently selected
  agent. Both mutations now fail tests. **This is the third consecutive release with an authority check
  shipped correct and untested** — recorded as a structural question, not patched a third time and
  forgotten.

  **The full authority canary table was re-run** (runbook step 4a). Every property still fails its mutation, including the task-scope property in its
  stronger home. One mutation of the per-agent command allowlist intersection survived and was traced rather
  than reported: the live global policy has the last word on every command, so that intersection is
  defence-in-depth with no independent effect, not a missing guard.

- **2026-08-26 — v0.9.62 pre-release re-audit: a refactor, audited by what it might have stopped enforcing.**

  **No new capability, destination, credential path, execution path or persistent record.** One source file
  modified; the additions are a host adapter, its tests and a boundary check.

  **Audited by re-running the authority canaries rather than by reading a diff.** Seven of eight properties
  proved in v0.9.60 and v0.9.61 still fail their mutations after the move. The eighth had moved to a
  stronger check and fails there — recorded because *a surviving mutant after a refactor is a question about
  where the property went, not a verdict.*

  **The one real gap was inherited, not introduced.** A firm retry could drop its declared files or its task
  contract without failing a test; the same mutation survives at the `v0.9.61` tag and `TeamTools.ts` is
  untouched here. Behaviour was correct; the guard was not. Closed before release, and re-running the canary
  table became a runbook step for every release — **a canary loses its power in the release that rewrites
  the code it guards, which is the release least likely to re-run it.**

- **2026-08-25 — v0.9.61 pre-release re-audit: authority bound to an attempt, and an invariant that shipped
  unguarded.**

  **No new network destination, credential path, command-execution path, or persistent record.** Verified
  against the release diff rather than asserted. One new host-mediated filesystem entry point: a
  user-clicked *open in editor* on a tool receipt.

  **That entry point never trusts the webview with a path.** Only opaque agent/tool ids cross, the agent
  must be the selected one, the path comes from the host's own tool receipt, and the physical path is
  resolved with `realpath` before it is compared against the agent's currently effective read roots — so a
  symlink cannot escape Folder Access. Three mutations, three failures.

  **The authorisation model changed and was proved in three directions.** Grants bind to `{ attemptId,
  agentId, inputId }`; authority requires a live attempt; a contract can never carry two live attempts.
  Removing the read-authority check, preventing an attempt from ending, or permitting concurrent attempts
  each fails tests. One preflight function answers grantability for both the candidate filter and the real
  grant, so the check and the issue cannot diverge.

  **The finding worth recording is the one that was not a bug yet.** The rule that a coordinator executing
  its own contract gets no relaxed path was implemented and completely untested: the full 2,549-test suite
  passed with the re-validation deleted, while the product kept telling the user that every gate had been
  re-evaluated. **A guard no test can kill is a sentence, not a guard.** A regression test was added before
  this release and the mutation now fails.

  **Portable evidence.** Ordinals, reason codes and three booleans; no contract prose, no raw ids. Absence
  proved by a `SECRET-`-seeded whole-document canary, not by the omission table alone.

- **2026-08-25 — v0.9.60 pre-release re-audit: a gate that can only subtract, and a settings scope that
  would have let a repository open it.**

  **No new network destination, credential path, or command-execution path.** Verified against the release
  diff: no added `fetch`/HTTP call site outside a test helper, no added `spawn`/`exec`, and exactly one new
  persistent write — the execution-hook approval record in extension workspace state.

  **The new authority surface subtracts only.** An execution hook selects a shipped host action by id and
  its single available effect is blocking an action already permitted. Grant-shaped declaration fields are
  refused before syntax is considered, unknown fields are refused rather than ignored, and every failure
  mode — timeout, error, ceiling exceeded, unknown action — blocks the gated action.

  **The breach this release nearly shipped, and how it was closed.** Reading `unode.executionHooks` as an
  ordinary setting would have let a repository grant itself a pre-tool gate through `.vscode/settings.json`.
  Nothing in the product defended it and Workspace Trust does not cover it. Shipped instead: an inert
  candidate in every scope with no user-scope exception; effect only after an explicit approval showing the
  full normalized declaration; the approval held outside the repository and bound to a digest of that exact
  text plus its origin; no model-facing path to the setting or the record; and lazy resolution so a
  revocation reaches a running agent. Mutation-proved on all three bindings — approval, origin, digest.

  **What the new task fields do and do not carry.** A verification plan has a closed four-value sensor
  vocabulary and no command field, so it cannot become an execution path, and it is judged only against
  host-recorded evidence. A declared `files` list is task location and ownership and does not widen the
  agent's resolved filesystem ceiling; a canary asserts a declared path outside scope stays outside it.

- **2026-08-25 — v0.9.59 pre-release re-audit: an authority that was too wide, a read confined to its own
  agent, and a human record whose identity stays local.**

  **No new network destination, credential path, command-execution path, or persistent file.** Verified
  against the release diff rather than asserted: no added `fetch`/HTTP call site, no added URL, and the only
  new filesystem calls are deletions in the existing content-asset cleanup path.

  **The widest thing this release created, it also closed before shipping.** Carrying a user's supplied
  sources across a delegation required one host-owned content store shared by the team; combined with a read
  gate gated only on the generic `read` capability and sequential asset ordinals, that made a second agent
  able to read material it was never handed. This was demonstrated with a passing canary during review, and
  the fix is a two-clause authority check: an explicit grant carried with the current turn, or host-recorded
  ownership by the requesting agent. Neither clause is model-supplied. The fix was proved by mutation —
  replacing the predicate with `true` makes the leak canary pass again — because a guard no test can kill is
  not a guard. Grants are cleared per turn, so an asset still inside its TTL does not become readable on a
  later turn, and the refusal names the authority, not the existence, of the asset.

  **The new model-facing read has no subject selector.** `search_conversation_log` / `read_conversation_log`
  read a projection of the message bus filtered by an agent id the host supplies; there is no tool argument
  naming whose log to read, which is the property that keeps generic read capability from becoming
  cross-agent history access. The projection carries typed message text only — no attachments, payload
  metadata, or raw bytes — is capped at 20 entries, 20 search results and 20,000 characters, states its range
  against the total on every read, and is wrapped as untrusted earlier-transcript context rather than as an
  instruction or permission basis.

  **The human verdict keeps the decision and withholds the person.** Recording one requires a
  contemporaneous, non-`system:` approver; a run with active delegated work cannot be judged; and verdicts
  append rather than overwrite. The approver's stable local id (`local:<machineId>`) stays in the internal
  ledger — portable evidence carries a document-local `approver-N` and the unresolved-item **count**, with
  the withheld prose and identity declared in the artifact's own omitted table against a closed field
  allowlist.

  **What changed about storage, and what did not change about egress.** The durable conversation record is no
  longer the context-trimmed request array. This alters what is persisted locally; it adds nothing to any
  provider request, and the trimming that shapes provider input was deliberately left untouched.


- **2026-08-22 — v0.9.56 pre-release re-audit: an unattended settings write, a stop a model can perform, and
  three boundaries that now refuse earlier.**

  **The activation-time write is the newest thing here that acts without being asked.** This project's most
  expensive lesson was an activation-time request, so `backfillPriceMultipliers` is stated in full rather
  than characterised. Its decision is a pure function, `priceMultiplierBackfill(current, connectionsWithKeys)`,
  with its own tests: a bare-number setting returns no plan (a deliberate "same everywhere" statement is not
  rewritten behind the user), an already-stated connection is untouched, `0` counts as stated, and an empty
  plan writes nothing. The host supplies only connections whose `apiKeySecretName` is present in
  SecretStorage. The written value is `1` in every case — inferring a discount unattended would be exactly
  the guess this area exists to refuse. It makes no network request, opens no modal, and emits one
  information message with an "Open setting" action, because a settings change nobody is told about is a
  settings change nobody can undo.

  **`cancel_task` gives a coordinator a real stop, and the host keeps the decision.** The tool takes a
  handle, an agent, or `all: true`; the host callback looks the session up, refuses when the target is the
  coordinator itself, ends the turn through the same `SessionManager.stop` the user's own brake uses, and
  returns whether a stop actually happened. Two boundaries are structural rather than advisory: a coordinator
  cannot stop itself, which would end the turn making the call, and `delegatableRoster` excludes the `solo`
  role, so a solo agent answers to no coordinator. Both are now exercised in a real extension host through
  `makeCoordinatorTeamTools` — the same constructor a real turn uses — rather than against an injected
  callback; the run observes live teammates stopped by name, with the coordinator and the solo agent
  untouched. This is authority over the user's own agents inside their own window: it can waste a turn, and
  it cannot reach a file, a credential, a host, or another user.

  **Three paths now refuse earlier than they did.** `src/contentSniff.ts` is one sniffer for `fetch_url`,
  `read_file` and chat attachments, applying magic-byte signatures, a control-character check and a strict
  UTF-8 decode before content becomes prompt text. It replaced, among other things, a binary-attachment check
  that inferred binary from an exception `Buffer.toString('utf8')` does not throw — a safety branch that had
  been unreachable since it was written. The gateway fetch boundary classifies Content-Type before touching
  the body, refuses an oversized declared `Content-Length` without reading, and streams through a bounded
  reader that cancels at 1 MB, replacing an unbounded `response.text()` that decoded first and asked what it
  was afterwards. A delegated task scope is refused before `task.assign` when the delegate's backend cannot
  enforce it, naming compatible candidates instead of substituting a teammate or dropping the scope; and a
  `superseded` disposition now requires a `replacement_handle` that resolves in the host's own dispatch
  receipts, so a coordinator cannot supersede a result by asserting a replacement in prose.

  **A credential tag is not a secrecy control and is not offered as one.** `ModelCatalog` keys its cache by
  provider, base URL and `credentialFingerprint(apiKey)`, because a gateway returns the models *that key* may
  call and two keys on one account can differ — a cache without it hands a replaced key the previous key's
  answer. The fingerprint is a 32-bit FNV-1a hash. It is documented at its definition as **not a
  cryptographic control**; the property it provides is that two credentials occupy two cache slots, which is
  correctness, not secrecy. It happens to keep the key out of a string that gets logged, and that is stated
  as a courtesy rather than a guarantee. Verified this release: no API key plaintext reaches a cache key or a
  log, and no document advertises the fingerprint as protection.

  **A cost display that under-reports is a security-adjacent defect, and this release had two.** The gateway
  group ratio and the user's stated coefficient were both applied, so 0.33 against 0.33 displayed 0.1089x of
  list — spending nine times what the interface claimed. Exactly one discount is applied now, chosen in one
  place. The second read an empty input box as `0` and displayed every model as free. Both are corrected,
  both are covered by tests, and both are recorded here because a number a user relies on to decide what to
  spend is part of what this document is for.

  **User-initiated writes, for completeness.** Storing an API key now prompts for that key's price
  coefficient and writes it to global settings, and it drops the model catalogue and re-fetches prices for
  that connection. The refresh is not interactive and passes through the same per-host metadata consent gate
  as every other price path, so an unapproved host is skipped rather than contacted.

  **One Test-mode-only command was added.** `unode.coordinatorCancelTask` exists for the extension-host E2E
  and is guarded by the existing `isE2EFixtureRequest`, which requires `ExtensionMode.Test` **and** an
  explicit fixture marker in the arguments. A Development host holding a developer's real roster cannot be
  told to stop it, and in a published extension the guard's mode is never Test. Stated plainly: the command
  is registered in every mode and refuses in all but Test; it is not contributed to the palette, so it does
  not appear to a user, but it is not absent from the build.

  **No new network destination, automatic transfer, credential path, persistence format, or telemetry.**

- **2026-08-21 — v0.9.55 pre-release re-audit: exact identities and hosts enter the internal ledger; only
  builder-owned forms may enter the portable export.**

  **Approver is defined as the actor attached to a contemporaneous decision, not whoever happens to be using
  the machine.** The live approval queue now returns the host-attached actor to command, write, Claude-tool,
  and public-web callers, and `RunPermissionEvent` persists it. An `mcp-grant` row is written when a tool uses
  a server granted earlier; no person decides then. Both `RunLedger.recordPermission` and
  `buildPortableRunEvidence` therefore discard an approver on that kind even if a caller supplies one.
  Expiry and host disposal fail closed without a durable human actor. This prevents a plausible false audit
  claim as well as a disclosure.

  **The current actor source remains `vscode.env.machineId`, and it does not leave in raw form.** The internal
  pack can show `local:<machine-id>` to its operator. Portable output assigns `approver-1`, independently of
  agent ordinals. A canary test plants a machine identity and requires its complete absence from portable
  rendering. Historical permission rows cannot be backfilled and retain an explicit unavailable declaration.

  **The exact route receipt is internal; the portable route is a classification the builder proves.** New
  delegations record connection id/kind, canonical endpoint, and privacy-domain id/status from the same route
  contracts used at the runtime boundary. The internal pack shows them. For portable output, a built-in name
  survives only when kind and endpoint exactly match a closed table. A custom route must have the host-created
  opaque-id shape, OpenAI-compatible kind, and a credential/query/fragment-free HTTPS endpoint, then becomes
  only `custom-gateway`. Execution domains are `built-in-service`, `local-cli-service`, or `custom-gateway`;
  privacy carries only its closed resolution status. Unknown tuples are omitted and declared unavailable,
  never copied or best-effort classified. A private-host canary verifies both the category's presence and the
  hostname's absence.

  **The digest boundary accepts source bytes only long enough to hash them.** The successful checkpoint
  callback supplies before/after content to `RunLedger.recordFileChange`, which immediately stores SHA-256
  values and a deterministic root over sorted `[path, beforeHash, afterHash]` records. Repeated writes retain
  the first before-state and latest after-state. Source and diff bytes are not fields of `RunRecord`. The
  portable builder independently requires relative paths, a path set identical to framework evidence, valid
  SHA-256 values, and a recomputed matching root. Recursive directory deletion, unrecorded writes, historical
  rows, or an unobserved side of an edit remain unavailable. The Claude production checkpoint's
  `restoreDisabledReason` was the non-fixture field found here: its `before: null` means “unknown,” not “new
  file,” and now invalidates the complete digest.

  **Hashes are not anonymity.** They disclose when two versions are equal and permit confirmation of guessed
  low-entropy content. Changed paths and timestamps also remain identifying. All are named in `retained`; the
  portable artifact does not claim those fields are harmless merely because they are not prose. The full
  Markdown pack remains an internal artifact and should be reviewed before sharing because it intentionally
  shows raw approver and endpoint receipts and retains redacted task prose.

  **A production-ledger integration closes the fixture-only gap.** It drives dispatch, route, task scope,
  context, write, framework evidence, disposition, human approval, MCP exercise, and closeout through the
  real `RunLedger` methods, renders both artifacts, and walks every portable object against a runtime schema
  allow-list. Positive canaries require the retained path, bounded route, approver ordinal, and digest to
  survive; negative canaries require source, prose, raw agent/actor ids, private endpoint, and privacy id to
  disappear. No other production-only field entered the portable schema.

  **No new network destination, automatic transfer, credential path, tool, or permission.** Export remains a
  user-invoked write to a chosen local file. Persisted RunRecord v1/v2 data loads without fabricated receipts;
  new records use v3 and portable JSON uses `portable-run-evidence/1`.

- **2026-08-20 — v0.9.54 pre-release re-audit: a new file on disk, an artifact built to leave, and three
  boundary claims that were wrong before review.**

  **The one new write path is `.unode/teams/*.json`.** It goes through `serializeVersionedTeamFile` and
  `validateTeamFile` — the same pair that already owns `.unode/team.json` — so it inherits their route
  handling: `exportVersionedAgentConfig` strips `provider`, `baseUrl` and `backend` and emits a versioned
  route of connection id plus model id. No API key value can reach the file; keys live in SecretStorage under
  a reference. The round trip (write, list, re-read, delete, and a file that no longer validates) is covered
  by `src/state/__tests__/TeamLibraryPersistence.test.ts` against a filesystem rather than by assertion.

  **What the file carried in v0.9.54 is stated rather than glossed.** An agent's `env` map was persisted verbatim.
  That was not new — `team.json` already did it — but this release added a file whose whole purpose was to
  be kept and possibly handed to a colleague, so a user needs to know before they copy one. The manual says
  it. v0.9.81 later removed that field from both readers and writers; this paragraph remains the dated audit
  of the older behavior. `.unode/` is in the `.gitignore` UnodeAi writes at `git init`.

  **The saved document was narrowed during this review.** The first implementation copied the workspace's
  `mcpServers` and `workflows` into every saved team while restore applied only `members`. That was wrong
  twice: the file promised a restore that never happened, and a file meant to be shared would have carried
  this workspace's MCP server command lines to whoever received it. A saved team is now the roster and
  nothing else, and opening one cannot replace workspace-wide configuration.

  **The automatic snapshot moved to the confirmed destructive boundary.** It ran before the user had chosen
  anything, so cancelling a picker still wrote a backup and — with a ten-snapshot cap — ten cancels would
  have pruned a restore point someone needed. It now runs after the confirmation and before any session is
  removed, through a callback the dialog owns. A snapshot that cannot be written no longer fails silently:
  the user is asked whether to switch anyway. Being unable to back a team up is not a reason to trap someone
  in it, but "your safety net is gone" is not a fact to leave in an output channel.

  **Portable Run Evidence is an export, not an egress.** It writes a file to a path the user picked. Its rule
  is that it carries no prose — nothing a user or a model composed as text — which is what makes its eight
  hard exclusions testable: a redactor has to recognise a secret to remove it, and a format carrying no
  composed text has nothing to recognise.

  **The rule was first written as "only bounded, structured values", and the artifact did not honour it**
  (Codex review, 2026-08-21). A configured agent id is a non-empty string a person chose — the team-file
  schema constrains it no further — so `agentId: "Project-X-acquisition-lead"` reached the export; and
  workspace-relative changed-file paths are file names a person wrote. The export's own default file name was
  built from the coordinator's display name, putting a chosen name on the outside of an artifact whose
  premise is that the inside carries none. **The leak tests could not have caught any of it:** every canary
  sat in a field the format already dropped.

  **Identifiers are now ordinals** — `agent-1`, `agent-2`, on one scale including the coordinator — since the
  document only needs them to correlate rows. A role label is carried only when the caller supplies one that
  is in a closed list validated inside the builder, so the boundary does not depend on the caller. **Paths
  are kept and the claim is narrowed instead**, because a count with a file extension is not reviewable
  evidence; the artifact now declares what it retains alongside what it omits, so the person about to attach
  it can see what is in it rather than trusting a summary of what is not.

  **Two fields contradicted that rule in the shipped implementation and were removed** (Codex review,
  2026-08-20). `requestedAgent` is whatever a model typed into a `dispatch_task` call — a tool payload, not a
  host identifier — and `verification.command` is a command line, which is exactly where an absolute path or
  an inline token lives. Both are excluded now and both are declared in the artifact's own `omitted` list, so
  a reader sees the absence.

  **The path filter was rewritten as an allow-list for the same reason.** It enumerated shapes to forbid and
  let everything else through, which is the wrong default when the failure mode is disclosure:
  `file:///C:/Users/...`, `file:///etc/passwd` and `C:private.txt` all passed it, because none of them starts
  with a separator. A path is now kept only when it contains no colon, no home or environment reference, and
  every segment is an ordinary name. Legitimate paths are dropped at the margin; the artifact already counts
  what it drops, and an over-dropped path is a gap where an under-dropped one is a leak. Negative cases for
  every shape above are in `src/observability/__tests__/PortableRunEvidence.test.ts`.

  **The marketplace catalogue grew to 23 entries and adding one installs nothing.** A card is a description;
  mounting a server still requires the explicit one-time approval in `shouldRequireApproval`, and an agent
  sees only servers it was granted. Every package name was checked against `registry.npmjs.org` before
  listing, one candidate was rejected for describing itself as a security-research canary, and one shipped
  card was removed during this review: `mcp-remote` takes its endpoint as a positional argument that our
  install flow cannot supply, so its promise to prompt for one was untrue.

  **No new egress path, credential path, tool, or permission**, and no activation-time network request.
  `check:vsix`, `validate:skills`, `check:notices`, `check:custom-gateway-boundary` and
  `check:tool-descriptions` pass unchanged.

- **2026-08-13 — v0.9.53 pre-release re-audit: two role catalogues, nine skills, and a domain that raises
  the cost of being wrong.**

  **No new mechanism, and one correction to how that was first stated.** A skill is a Markdown instruction
  file progressively disclosed into a prompt; a role template is a name, a prompt, a capability list and a
  tool ceiling. Neither adds an egress path, a credential path, or reach into a file the agent's existing
  folder access does not already permit. `validate:skills` continues to reject executables and symbolic
  links anywhere under `skills/`, and the nine new files are Markdown only.

  The first draft of this entry said these roles "cannot reach a network". **That was wrong and is corrected
  here rather than quietly rewritten.** All four carry `read`, and on the Claude backend `read` is the
  capability `canAdvertisePublicWeb` consults (`ClaudeHeadlessBackend.ts`) before advertising the CLI's
  public-web tools. So a role in these teams can reach the public web **when `unode.webAccess` is `allow`,
  or when the user approves an `ask`** — exactly as every other read-capable role already could. Nothing
  here widens that gate; the accurate statement is that no egress path was added and the existing one stays
  consent-gated. A security document that overstates a boundary is worse than one that states a narrower
  boundary accurately, because a reader plans around it. (Codex review, 2026-08-13.)

  **The new roles are constrained by capability rather than by instruction.** The privacy officer and GRC
  analyst deny write, shell and delegation; the contract analyst denies shell and delegation. This matters
  more than usual here: a prompt asking an agent to be careful is guidance, and this release adds a domain
  where the cost of an agent exceeding its remit is legal rather than cosmetic.

  **One skill exists to refuse.** `sanctions-export-refusal` instructs the agent not to screen parties, not
  to classify controlled technology, and not to state that a transaction is permitted — only to gather facts,
  state the question, and route it to a named owner. A determination an agent produced would be relied on as
  a clearance, and a wrong one is criminal-liability exposure for the organisation and for individuals. It is
  the first skill in this catalogue whose correct output is never an answer.

  Its record step is stated so a **read-only** role can complete it: the refusal goes in the reply, which is
  the record that always exists. Persisting it to a tracker is named as the job of a writer — the coordinator
  or the human owner — because the GRC and privacy seats deny `write` by design, and a skill step a role
  cannot perform is a step that gets skipped in silence.

  **Two disclosure limits are stated in the skills themselves**, because a compliance reader is the one most
  likely to over-read a result: `legal-authority-citation` requires primary authority and marks any citation
  not retrieved in the session as `not verified this session`; `privacy-dpa-review` forbids assessing whether
  a transfer mechanism is currently valid, which is a legal determination that changes with regulatory
  decisions. Neither is a capability restriction — both exist so the output cannot be mistaken for advice.

  **Provenance.** The nine skills are original drafts written against two research documents now tracked in
  `docs/`. Nothing was copied from another catalogue, so `THIRD_PARTY_NOTICES.md` is unchanged and
  `check:notices` passes without a new entry. The SKILL.md frontmatter happens to match the public
  agentskills.io standard; that is format compatibility, not derivation.

  **Unchanged and worth restating:** these teams inherit every existing boundary — Workspace Trust, per-agent
  folder access, command approval, write approval, and consent-gated egress. A knowledge-work team is not a
  lower-trust context, and nothing here creates one.

- **2026-08-12 — v0.9.52 pre-release re-audit: coordinator closeout, non-blocking delegation, and a
  render-side sensor.**

  **Nothing here adds an egress path, a credential path, or a permission.** `close_assignment` writes a local
  record; the host-authored closeout is assembled from counts the host already held (settled-but-undisposed,
  accepted-but-ungated). Neither embeds a file path, a message, a model identifier from a provider response,
  or any part of a delegate's output. The closeout explicitly disclaims any judgement of correctness, which
  is a limit on what the host may assert about work it cannot observe.

  **Removing blocking delegation is a scheduling change, not an authority change.** `dispatch_task` and
  `collect_ready_tasks` dispatch and inspect through the same path `assign_task_async` already used: the same
  file claims, the same per-assignment folder scope and its intersection with the agent's configured grant,
  the same command policy, write approval, and Claude `PreToolUse` gate. The retired blocking tools are no
  longer advertised to the model but remain callable through the host-owned compatibility path, so a bridge
  or a saved workflow cannot break; that path grants nothing the new tools do not.

  **The watchdog change can only stop work earlier.** Counting material output rather than any observed byte
  removes a keepalive, and a turn that ends sooner cannot exceed a boundary it previously stayed inside.

  **The render-side sensor was reviewed for what it can carry, and it carries no content.** It reports item
  identifiers, a live-versus-committed flag, prior/next item counts, and the turn-epoch pair. Message text,
  file paths, and tool arguments are absent by construction. Its records are held in extension-host memory
  for the session only, are bounded, and are neither written to disk nor sent anywhere; the accompanying log
  line goes to the local output channel. A routine window trim is counted rather than retained, so the
  bounded log cannot be filled — and therefore cannot be used to push an earlier observation out of it.

  **Unchanged and worth restating**, because it is the constraint the closeout rests on: the framework
  records what happened and never grades a delegate's prose. Coordinator acceptance remains a coordinator
  observation and is not claimed as human or customer acceptance.

- **2026-08-11 — v0.9.51 pre-release re-audit: disclosure accuracy only.**

  Nothing in this release adds an egress path, a credential path, a persisted field, a tool, or a
  permission. `contextMeter` and `compactOutcome` are pure host-side reads of state the extension already
  held; `UnodeAi: Compact Context` calls the same in-process `compactSession` the composer already called.
  The summarizer it may invoke is the agent's own already-configured economy model over its already-approved
  connection — the same call the automatic path has always made, now reachable from the Command Palette.

  **The new strings were reviewed for what they can leak, and they carry no content.** The meter renders a
  ratio, a token count, a window size, and a fixed sentence naming the runtime class. The compaction result
  renders a count and a reason drawn from a closed set. Neither embeds a file path, a source body, a model
  identifier from a gateway response, or any part of a message. The context receipt's wording changed; its
  computed values, its sensitivity signals, and its rule that matched content never enters the panel are
  untouched.

  **One boundary is stated more precisely than before, and the change is a narrowing of a claim, not of an
  authority.** The per-turn receipt's token number covers attached sources only. It never included the
  conversation history, the system prompt, or the tool definitions — all of which are sent to the provider.
  A reader who took the receipt as the size of the request would have understood the extent of a turn's
  egress as smaller than it is. The panel now says so. This corrects a disclosure, not a behaviour: what is
  sent is unchanged, and the context-source manifest continues to enumerate every source that entered the
  turn with its label, origin, and reason.

- **2026-08-10 — v0.9.50 pre-release re-audit: context-window discovery, a recorded ceiling, and request
  deadlines. Also covering v0.9.49, whose entry this log was missing.**

  **This log skipped v0.9.49.** That release shipped without the re-audit entry this project requires of
  every release, and the omission was found while preparing v0.9.50 rather than by the process that was
  supposed to prevent it. The v0.9.49 review is therefore recorded here, after the fact and labelled as
  such, instead of being backdated into a position that would imply it happened on time.

  **v0.9.49 — run boundaries and the evidence pack.** A run's retained messages, context receipts, and
  permission receipts must now carry that run's host-observed correlation; a reused coordinator or worker
  can no longer be joined to a run by agent identity alone. This is a narrowing, and it is the security-
  relevant half of the change: without it an exported pack could absorb a different run's traffic because
  the same agent appeared in both. **UnodeAi: Export… → Run evidence pack** writes one run to a Markdown file the
  user names. It is a local aggregation of material the extension already held; it adds no network path. Raw
  approved command strings, context source contents, and credential values are excluded from the pack by
  construction, and no model is asked to judge whether the work was correct — coordinator acceptance is
  recorded as a coordinator observation and never as human or customer acceptance. The pack states what it
  omitted relative to its own run rather than presenting a partial record as complete.

  **Context-window discovery reuses a consented request and adds no destination.** The only path that reads
  a model's advertised window is the model picker the user opened: it presents the metadata-consent plan,
  then reads the gateway's already-requested `/models` response through `metadataFetch` / `consentGatedFetch`.
  The parser has no fetch path of its own and cannot originate a request. There is no activation-time probe,
  no timer, and no speculative prefetch — the exact constraint the v0.9.29a entry below exists to enforce,
  re-verified on this tree by the `noPhoneHome` source-shape suite
  (`src/__tests__/noPhoneHome.smoke.test.ts`, 25 cases), which asserts among other things that context-window
  metadata is read only from the already-consented, user-triggered model-picker response. A missing or malformed window is the normal
  response and writes nothing.

  **A recorded ceiling is a number, not a capability.** When a gateway refuses a request as too large,
  UnodeAi stores that request's estimated size as a ceiling for that exact model: `{ model, tokens,
  observedAt }`, written with the agent roster in VS Code `workspaceState` and accepted as a team-file member
  field, so it travels in `.unode/team.json` when that file is written. It contains no conversation content,
  no file path, and no credential — the gateway's own error text is shown in the user's transcript and is not
  part of the stored record. It can only lower an effective window, never raise one; it is bound to the model
  that produced it; and an explicit `contextWindowTokens` outranks it. It grants no tool, path, or network
  authority, and nothing reads it except the local compaction threshold. Three cases record nothing at all,
  including one deliberately conservative floor: a refusal the conversation is too small to explain is not
  attributed to the conversation.

  **Deadlines bound work; they do not extend it.** Streaming now has a first-chunk budget, an inter-chunk
  idle timeout, and an end-to-end ceiling, and the retry chain has a total budget checked on both sides of
  its backoff. An oversized request is recognised at any HTTP status and is not retried. The effect is
  strictly reductive — fewer bytes sent, bounded wall-clock, no resend of a body already refused — and no
  approval, sandbox, or trust boundary is involved.

  **Disclosure accuracy, not authority.** The transcript's truncation notice no longer converges on a dropped
  character count two orders of magnitude too small, undelivered webview pushes are counted and named rather
  than dropped silently, and the retained-window boundary is marked in the transcript. These change what the
  user is told about local data they already hold; none changes what is stored, sent, or permitted.

  **Carried forward from the inventory work, and it is a widening of known exposure, not a new one:**
  `sanitizedCommandEnv()` removes `ELECTRON_`/`VSCODE_`-prefixed keys and inspector-injected `NODE_OPTIONS`,
  but does **not** remove keys by provider name. A full source search found no path in this repository that
  writes a credential into `process.env`. It follows that if the host process environment already carries an
  API key from the surrounding shell at startup, that key survives sanitization and is visible to a
  user-approved command. Whether it does is determined outside this repository and cannot be answered from
  source. Approved commands remain gated by Workspace Trust, `unode.commandApproval`, and per-agent
  narrowing; this is stated so the boundary is not read as stronger than it is.

- **2026-08-09 — v0.9.48 pre-release re-audit: source sensitivity signals, per-agent command narrowing, and
  the closeout continuation.** Three changes touch the security surface; none grants new authority.

  **The sensitivity label is a signal, not a detector, and it never carries content.** Each file-backed
  context source is now labelled `no-mechanical-signal` or `potentially-sensitive` from a union of
  secret-pattern matches, conventional paths, owner-only filesystem mode (`mode & 0o077 === 0`), and
  `.gitignore` membership. The manifest stores only the *names* of the signals that matched — never the
  matched text, the surrounding line, or the file contents — so the label cannot itself become a disclosure
  channel into the webview or a transcript. No model inspects the file to produce the label, and nothing is
  blocked, redacted, or granted from it: it is report-only in this release. It must not be read as evidence
  that a file does or does not contain a secret. It is deliberately tuned toward false positives, because a
  missed sensitive source is a silent disclosure into model context and a false one costs an inspection.
  Enforcement, if any, belongs to the separately scoped consent work, not here.

  The secret vocabulary moved to `src/security/secret-patterns.json`, now read by both the runtime signal
  (`src/security/secretPatterns.ts`) and the public source-drop scanner
  (`scripts/build-public-drop.mjs`). One definition with two consumers means a pattern added for one is
  not silently missing from the other; the drop scanner remains fail-closed by allowlist and was re-run
  clean on this tree.

  **The staleness label is a filesystem fact.** It reports a modification time and a 90-day threshold. It is
  not a correctness, provenance, or safety judgement, and a checkout or copy that refreshes timestamps will
  move it. The UI states the fact it observed rather than asserting the source is current.

  **Per-agent command narrowing can only narrow.** A saved per-agent selection is intersected with the
  current global allowlist at check time, *after* the global policy has applied its hard denials, so it is a
  ceiling on authority and never a grant. The editor exposes a checklist derived from the live global
  allowlist rather than free text, which makes an attempted widening unrepresentable instead of relying on
  validation to reject it — and removes the stale-string failure mode where a saved but no-longer-allowed
  entry could read as authority after the global list shrank. An empty restricted list denies all commands
  and is kept distinct from inheritance. The workspace approval gate, Workspace Trust, and the agent's
  rooted folder are unchanged and remain the enforcing boundaries.

  **The coordinator closeout continuation grants nothing.** It reads a report-only count and continues the
  turn loop; it does not dispatch work, approve a command, widen a scope, or write a file. It is bounded at
  two per turn, is overridable by the user, and no final response is refused because the counter was reached.
  Both the OpenAI-compatible and Claude paths now apply the same predicate — the Claude path reaches the
  report through `TeamMcpBridge` rather than a new shared runner, so neither backend's transport or
  turn-lifecycle contract changed.

  **Not established by this audit:** no packaged VSIX, no installed-host matrix, and no clean-profile network
  capture were run for this build. The activation-time egress position is unchanged from the prior audits and
  is not re-asserted here on new evidence.


- **2026-08-02 — v0.9.35 build re-audit: local Unode Account / Profile.** The Account tab is a local
  rendering of existing provider-key and consent state, not a sign-in surface: it has no password,
  payment, cloud-identity, or arbitrary URL field. Opening it performs no balance lookup; only an explicit
  **Check available balance** action reaches the existing, kind-scoped metadata-consent path. Its host
  message handler accepts balance requests only for a known registered provider, and account, credit/usage,
  and pricing controls route only through the extension-host's registered HTTPS provider URLs. A forged
  provider ID or webview URL cannot create egress. The result labels a stored Unode key **Connected via API
  key — not signed in**, so the UI does not overstate an API credential as a user session.

- **2026-08-02 — v0.9.35 build re-audit: compatible repository instructions and editor selections.**
  `AGENTS.md` and `CLAUDE.md` are now read alongside `.unode/rules.md` as lower-priority repository
  guidance. This broadens the prompt-injection input surface from a UnodeAi-specific file to documents
  commonly already present in a repository, so the loader resolves each candidate physically inside the
  workspace, refuses symlink/junction escapes, de-duplicates identical content, caps each file at 12,000
  bytes with an in-context truncation notice, and names the files it loaded. The fixed order is
  `AGENTS.md`, `CLAUDE.md`, then `.unode/rules.md`; the last is the product-specific rule source. Repository
  text can direct behaviour but cannot grant a command, MCP server, network destination, or write scope:
  those remain enforced by the separate user-settings and host-policy paths, with a regression test that
  enumerates every `CommandPolicy` construction and reload site and kills a bridge **passed as an argument
  at any of them**. That is a syntactic check, not a data-flow proof: a future bridge routed through an
  intermediate local variable would not be caught by it, and the count of sites is pinned so a new one
  cannot appear unreviewed. The **Add to UnodeAi** editor action receives only the explicit
  selection VS Code supplies; it never reads a whole file. It is absent without a selected team agent and
  re-checks that the selection's real path lies in that agent's existing read roots before it can prefill a
  composer. Neither change adds activation egress, telemetry, a dependency, or a secret path.

- **2026-08-02 — v0.9.35 build re-audit: consent provenance.** Egress and metadata grants now retain the
  requesting surface and approval time when newly recorded, so the Security view can distinguish a current
  approval from a migrated legacy host. The migration deliberately preserves legacy host lists without
  inventing a timestamp or requester; it displays **“granted before 0.9.35 — date unknown”** rather than
  false precision. A grant still authorizes only its original host and kind, remains revocable, and does
  not create an egress path by itself.

- **2026-08-02 — v0.9.35 build re-audit: deterministic extension-host fixtures.** The E2E suite may pass a
  `{ e2e: true }` fixture object to its team creation, stop, and key commands. The extension accepts that
  object only in VS Code Test mode; it selects the existing default connection, avoids
  interactive post-create prompts, and uses an offline fake key that teardown deletes. In a production
  extension the object cannot activate that path. This is test isolation only: it adds no product seed
  command, network destination, secret, user-facing privilege, or authority bypass.

- **2026-08-02 — v0.9.34 addendum: the async wake now retains across a busy turn.** A settled delegation
  result queued while the coordinator was mid-turn used to be discarded outright; it is now retained and
  re-attempted at that coordinator's next idle transition. This extends how long a result is held **in
  memory**, and nothing else: retained entries are pruned the moment `await_tasks` or Stop claims them
  (so retention cannot become double delivery), cleared on session stop and on dispose, and delivered
  through the same `ask.question` path with the same framework evidence verdict. It grants no tool,
  bypasses no approval, alters no route, and opens no egress. The one behavioural consequence worth
  stating: a coordinator can now begin a turn on its own slightly later than before — after its current
  turn ends rather than only at the instant a teammate finished — which is the intended repair, not a
  side effect.

- **2026-08-01 — v0.9.34 pre-release re-audit.** The coordinator late-result repair changes internal
  message lifetime, not authority: after a blocking delegation timeout, the correlation listener is kept
  for exactly two additional configured wait windows, then removed; `cancelPending` and session teardown
  remove it sooner. A late result is delivered with its existing framework evidence verdict and cannot
  grant a tool, bypass an approval, alter a route, or create a new egress path. Native-first/XML-demotion
  changes only the already-audited request representation sent to the configured provider; explicit XML
  and Native remain bounded local choices. The remaining 0.9.34 changes are webview presentation/state
  (composer geometry, per-agent drafts, status markers, wizard/rail labels, reduced motion). The pending
  approval geometry uses only a locally measured layout margin while its card is visible; it does not
  change approval authority, request handling, persistence, or egress. These changes add no
  network destination, dependency, secret exposure, command capability, MCP grant, Workspace Trust
  exception, or telemetry. `SessionManager` now refuses to publish a timed-out coordinator turn as
  `task.complete`, preventing an unresolved task from being mistaken for a completed one.

- **2026-08-01 — v0.9.33 "Workbench" release re-audit.** Four changes since v0.9.30 touch the security
  surface. 0.9.31 and 0.9.32 were never released, so this entry covers the whole span.

  1. **Command chaining stopped being all-or-nothing — a deliberate relaxation, scoped and tested.**
     Previously *any* shell control character forced an approval prompt, so `npm test && npm run lint`
     interrupted you even though both halves were allowlisted. `CommandPolicy` now splits on `&&` and `;`
     only and requires **every** segment to be independently allowlisted; empty segments are rejected
     rather than skipped, and `|`, backticks, `$(…)`, `${…}`, `>`, `<`, `&` and newlines still force the
     prompt, because each of them changes *what executes* rather than merely sequencing it. The relaxation
     therefore cannot admit a command the allowlist would have refused on its own. The negative control is
     pinned as a test, not assumed: `CommandPolicy.test.ts:102` asserts `npm test && npm publish` yields
     `allowed === false` **and** `ask === true`. Deliberately not a shell parser — a quoted or escaped
     separator is treated as unsupported syntax and prompts, which is the safe direction to be wrong in.
  2. **Checkpoint restore is now confined on disk, not in the string.** A restore resolved its target by
     joining the recorded path to the workspace root and writing there. This was **not reachable from a
     model** — agent writes are confined at the tool layer — but the checkpoint store is re-read from a
     file on disk, so a hand-edited or tampered state file could turn "restore this file" into a write
     anywhere the user account can write. `..` escaped, an absolute path replaced the root outright, and a
     path through a **symlinked folder or Windows junction escaped while looking perfectly ordinary**.
     Restore and the checkpoint diff now go through [`resolveInsideRoot`](src/backend/workspacePath.ts),
     which `realpath`s both the root and the target — or the nearest existing ancestor, since a restore
     often recreates a deleted file — and refuses anything that lands outside. `lstat` rather than `stat`
     is used while walking, so a symlinked directory is *found* and resolved instead of silently followed.
  3. **The web-access approval window is 15 minutes, up from 3.** This is the time a request waits for a
     human, and an expiry is a **denial** — a longer wait cannot grant anything, it only stops a walk-away
     from being auto-denied at three minutes. The separate seconds-scale transport check is unchanged, so a
     genuinely dead gate still fails closed immediately. A session web grant remains crew-wide and is still
     never persisted.
  4. **`unode.extraModels` is hand-edited JSON and is parsed as untrusted input.** It adds ids to the model
     pickers, keyed by connection id. It grants no capability: it cannot introduce an endpoint, a
     credential, or a route — a model id has always been free text passed to the provider as written, so
     this layer changes which ids are *suggested*, nothing else. Malformed entries are dropped rather than
     throwing.

  **Unchanged, and re-checked rather than assumed:** no new network destination, no telemetry, no
  activation-time egress. The Workbench is a second `WebviewPanel` on the same provider — a rendering
  container, not a trust boundary — and `SettingsBridge.secretBoundary.test.ts` pins that no API key,
  secret value, or credential header reaches webview state, with both natural "tidy this up" leak
  refactors (`...cfg` in the MCP mapping, `...p` in the provider mapping) introduced as mutants and killed.
  `SecretStore` still exposes only `has`/`set`/`delete` — there is deliberately no `get`, so the bridge
  cannot read a value even if asked to.

- **2026-07-14 — v0.9.30 route migration and scope split.** Route migration is a pure, deterministic
  provider/backend conversion: `RouteMigration.test.ts` proves gateway model spelling cannot select a CLI,
  every conflicting legacy pair is rejected rather than guessed, and a second migration is unchanged.
  `RouteContracts.test.ts` proves every shipped default connection resolves to one registry profile, while
  the final `assertResolvedRoute` comparison remains the load-bearing request/spawn boundary. New
  `.unode/team.json` exports write `routeVersion: 1` as their only connection/model authority; the reader
  hydrates legacy adapter fields only after `TeamFileSchema` validates that route. `RouteMigration.test.ts`
  and `TeamFileSchema.test.ts` establish this compatibility window. A hand-edited invalid or unknown route is
  rejected by `TeamFileSchema` before it can become a runnable roster.

  The E3a pre-release endpoint-and-credential audit is established by `openAICompatBaseUrl.test.ts`,
  `OpenAICompatBackend.test.ts`, `modelCatalogBaseUrl.test.ts`, `TeamFileSchema.test.ts`, and
  `RouteContracts.test.ts`: a registered OpenAI-compatible route and its `/models` lookup resolve solely
  from `ConnectionRegistry`; a forged `.unode/team.json` `baseUrl` is stripped with a visible warning; a
  Custom endpoint must be HTTPS; a Custom route paired with a foreign SecretStorage key name is rejected
  before startup; and the runtime derives endpoint and auth identity from the same registered connection.
  The passive Custom balance path declines a malformed/non-HTTPS setting rather than fetching it. A runtime
  envelope at another endpoint or with another auth identity fails `assertResolvedRoute` before egress.
  These are source- and effect-level tests, not a claim that a hostile external network was packet-captured.
  - **Codex Headless is deliberately unavailable.** It is a Coming soon route, not a local read-only
  specialist. `src/views/__tests__/SettingsPanel.defaultProvider.test.ts` and
    `src/views/__tests__/AgentBuilderPanel.test.ts` cover its UI exclusion, while the host rejects unavailable
    routes before backend construction. No local Codex model process,
    write, command, delegation, or PM path is shipped or claimed. The E4/E4R results are cloud-runner
    acceptance inputs, not evidence of a local approval bridge.

- **2026-07-13 — discarded local Codex Track-A candidate research.** The following observations were made
  against a candidate that was superseded when Codex Headless became Coming soon. The current release does
  **not** start `codex exec --json` or any Codex CLI process; no Codex API key is stored by UnodeAi.
  - **Consent before each model turn — stated precisely.** Before every `codex exec` **model process**, the
    backend calls its egress-consent hook; a declined hook produces **zero model-process spawns** (proved by
    the spawn-boundary test). **Two short preflight subprocesses run earlier, at session start, and they are
    NOT behind that gate:** `<binary> --version` and `<binary> login status`, used to verify the CLI is a
    supported version and is authenticated. **They send no prompt, no code, and no workspace content.**
    Whether `login status` performs a network token refresh is **UNVERIFIED**. They are deliberately not
    gated: they carry no user content, and prompting *"may we send your prompts and code to this host?"* in
    order to run a local `--version` check would ask for far more than the action needs — the over-asking
    defect fixed in v0.9.29, which trains a user to click through the prompt that *does* matter.
    The exact network hosts and transport used by a logged-in, stable Codex CLI in a real editor session are
    **UNVERIFIED**; this release does not describe that unmeasured transport as mediated.
  - **No UnodeAi command mediation:** Codex `command_execution` is inside Codex's own `-s read-only`
    sandbox, not `CommandPolicy`, `unode.commandApproval`, or `unode.allowedCommands`. An App Server
    approval bridge (Track B) is **not shipped**. Its effect-level E4 probe on stable `codex-cli 0.144.3`
    found two blocking paths: the resident server connected to a non-loopback host before any turn or
    approval, and an App Server turn read a synthetic file outside `runtimeWorkspaceRoots` without a
    command approval. Direct command/network decline rows passed only for their exact tested paths; file,
    timeout/disconnect, replay, subagent, MCP, unified-exec, and other required paths remain
    `INCONCLUSIVE` or `UNVERIFIED`. Therefore **no Track-B approval path is claimed as shipped or generally
    mediated.** *(The earlier
    reason given — "no authenticated stable CLI was available" — was itself wrong: a stable, logged-in
    `codex-cli 0.144.3` is present via the npm global install; C5 looked only at the VS Code extension's
    unauthenticated alpha. The environment is no longer the blocker; the measured App Server behavior is.)*
  - **Measured sandbox result, with its limit:** on Windows with `codex-cli 0.137.0`, effect probes blocked a
    write and a network connection, but a read-only sandbox read `~/.codex/auth.json`. Folder grants and `-C`
    therefore do not establish read confinement. The same write/network result on other operating systems or
    CLI versions is **UNVERIFIED**.
  - **Runtime guard, not just a grep:** the final argv is rejected before `spawn()` if it includes any known
    sandbox-bypass flag, including `flag=value` spelling. Behaviour tests inject each forbidden final arg and
    prove zero spawns; the source scan is only a lint for stray literals and explicitly exempts the declaration
    that drives the runtime guard.
  - **Windows CLI launch:** the official npm `codex.cmd` wrapper is never run through a shell. When selected
    by its absolute path, UnodeAi resolves only its adjacent official native `codex.exe`; an absent native
    binary fails closed with an actionable setup error.
  - **Model selection:** a Windows `codex-cli 0.144.3` smoke turn with a ChatGPT login rejected forced
    `gpt-5-codex` (HTTP 400), while the same fixed prompt completed when the CLI chose its own default.
    The shipped Codex provider therefore uses the `codex-cli-default` sentinel and omits `-m`; whether a
    user-selected model is accepted remains account- and CLI-version-specific.
  - **Found in review and fixed before release: `unode.codexCliPath` was not a restricted configuration.**
    It names the absolute path of a binary UnodeAi **spawns**, and `verifyCodexCli` runs `<binary> --version`
    **before** validating the version — so the binary executes first and is judged second. Because
    `.unode/team.json` now accepts `backend: "codex"`, a repository could have shipped a `.vscode/settings.json`
    naming any absolute path plus a Codex agent, and had that path executed on preflight **when the user started
    that Codex agent in the untrusted workspace**. (Restoring a roster only *creates* sessions — it does not
    start them — so merely opening the folder was not sufficient; an earlier draft of this entry overstated the
    trigger, and the overstatement was itself the kind of error this log exists to catch.) The gap is real
    either way: a repository must never get to choose which binary we execute.
    `unode.verifyCommand` — which names only a *command* — was already restricted; a setting
    naming a *binary* is strictly more dangerous and was the one we missed. It is now in
    `capabilities.untrustedWorkspaces.restrictedConfigurations`, and a test asserts the **rule** rather than the
    instance: every setting whose value is a path we execute or a host we contact must be in that list.
  - **Found in review and fixed before release: `unode.marketplace.skillLibraryUrl` was passed to
    `openExternal(Uri.parse(raw))` unvalidated.** The "Browse the full skill library…" button in the Agent
    Builder read this workspace-configurable string and handed it straight to `vscode.env.openExternal`. A
    repository's `.vscode/settings.json` could therefore point a trusted-looking button at a `file:` URI, a
    custom protocol handler, or an unrelated host; the click requirement lowered exploitability but did not make
    the trust boundary correct. Fixed three ways: the setting is now in `restrictedConfigurations`; the URL is
    resolved through `resolveHttpsExternalUrl`, which requires `https:` and **fails closed** on any other scheme
    or a parse error; and an off-default destination now names its origin in a confirmation before navigation.
    Rule-level tests cover both the restriction and the scheme rejection (`file:`, `vscode:`, `javascript:`,
    `http:` downgrade). The two other `openExternal` call sites were checked and were already safe — the
    Onboarding wizard sanitizes its href, and the Settings panel opens only host-owned URLs keyed from the view.
  - The release also adds role and team templates, provider-scoped Add-Agent metadata consent, and build-chain
    dependency upgrades. These change configuration and build tooling; they add no Codex approval path.

- **2026-07-13 — v0.9.29a: the activation phone-home (the most serious defect this project has shipped).**
  `activate()` called `refreshPrices()` unconditionally, so a fresh install with **no API key, no configured
  provider, and no approved host** issued a live request to two vendor gateways (`/api/pricing`) the moment
  VS Code finished starting. The account-balance lookup had the same shape: a stored key was treated as
  consent to contact the host. Neither passed the egress gate.
  - **This document was wrong.** §1 stated those endpoints were contacted "only if a key is stored" — they
    were contacted regardless. A security document that overstates its own guarantees is worse than no
    document, because it is what a reviewer and a user rely on.
  - **Harm:** an unsolicited beacon to vendor infrastructure on install. It leaks the fact of installation and
    an approximate install-time to the vendor, from users who had approved nothing. It is also the classic
    behavioural signature of unwanted software — and it is, as far as we can tell, the most plausible
    explanation for the v0.9.8 (legacy brand) marketplace takedown, which we were never given a reason for.
  - **Fix, at the root rather than the call site:** the rule is now a pure function, `consentedSources` — *a
    convenience fetch may ride on a host the user already approved; it may never open a network relationship
    with one.* Both conveniences (prices, balance) are filtered through it. A background refresh (activation,
    daily timer) skips **silently** — prompting at startup would merely trade a beacon for a nag. Only a
    user-initiated path (model picker, provider switch, the new **UnodeAi: Refresh Model Prices** command) may
    ask, and it asks with an accurate prompt: this request sends no prompts, code, or workspace content.
  - **Two grants, never conflated.** Model-egress consent (prompts + workspace files) implies metadata consent
    (prices/balance). The reverse never holds — "yes, fetch prices" cannot authorize shipping source code. The
    sets are stored separately and rendered separately in the Security panel, each revocable.
  - **Tests:** `consentedSources` is unit-tested, including the named fresh-install case (nothing approved →
    nothing fetched) and fail-closed on an unparseable URL. `src/__tests__/noPhoneHome.smoke.test.ts` guards
    what a unit test cannot: that no future caller skips the gate, that the consent predicate stays read-only
    (it can never become a startup modal), that the activation and daily-timer calls never pass `interactive`,
    and that a metadata grant is never displayed as a model-egress grant.
  - Found by Codex in the v0.9.29 Marketplace-risk review. It had survived every prior security audit in this
    log, because every one of them asked "is this request gated?" of the request paths we thought about, and
    never asked "what does a fresh install do before the user touches anything?"
  - **Second round, same class.** The first fix gated the *price call site*. Re-review found `ModelCatalog`
    fetching `{base}/models` (with the `Authorization` header when a key is stored) and the configurable
    `unode.modelCatalogUrl` straight past it — so a user could decline the price prompt and still have
    `api.openai.com/v1/models` fetched a moment later, a decline that declined nothing. **The gate therefore
    moved onto the fetch itself** (`consentGatedFetch`): every metadata service is *constructed* with it, so
    there is no ungated path to forget and a future service inherits the rule. The interactive prompt now
    covers every host the picker is about to contact, not just the pricing ones. `unode.modelCatalogUrl` was
    added to `restrictedConfigurations` (a repository's own settings could otherwise name the URL). Regression:
    a declined model picker makes **zero** fetch calls and still renders the static model list.
  - **Hosted skill catalog: unsigned no longer merges, and verification is no longer optional.** It ran
    "warn-only" — an unsigned hosted catalog merged with a console warning. A catalog entry can carry an MCP
    server's stdio `command`/`args`, which makes this the one place remote content can influence what runs on a
    user's machine, so the failure mode of "signing isn't set up yet" must be *the feature is off*, not *the
    protection is off*. Now: blank key → **not fetched at all**; missing signature → rejected; wrong-key or
    tampered-body signature → rejected; valid → merged.
    **Third round of the same lesson.** The first pass fixed the *behaviour* but left `verify` an OPTIONAL
    field checked behind `if (o.verify)`. Both production call sites passed a key, so the code was correct —
    but "an unverified catalog never merges" then rested on every future caller remembering an optional field,
    and one who omitted it would silently re-accept unverified remote MCP `command`/`args`. **An invariant you
    can opt out of by omission is a convention, not an invariant.** `verify` is now required and the check is
    unconditional: there is no branch that reaches `JSON.parse` on unverified bytes. The test that asserted an
    unverified body parses-and-merges was deleted — it was documenting the escape hatch, which is how the
    escape hatch stayed open. A caller that omits `verify` at runtime is refused *without a request*.
  - **The two grants are now separately revocable, as documented.** A host holding both showed one row whose
    single revoke deleted both. Each grant now renders its own row, labelled with what it permits, with its
    own revoke.
  - **The consent prompt was over-asking, which is a security defect and not a UX one.** The first flow asked
    about `pricingSources()` — which always contains both default gateways — so opening the *OpenAI* model
    picker produced three modals: weroam, unodetech, then openai. Two of them were about hosts the action was
    never going to contact. **A prompt that asks for more than the action needs trains the user to click
    through it, and a consent the user clicks through protects nobody.** Replaced with a pure, provider-scoped
    access plan (`src/models/metadataPlan.ts`) shared by the prompt, the enforcement and the tests: one
    aggregate, per-host-selectable question, listing each host's real purposes, covering exactly the hosts that
    action will contact. Escape or unticking grants nothing, fetches nothing, and opens no second dialog; the
    static model list and built-in prices render immediately. A decline is remembered for the session (in
    memory, never persisted) so re-opening the picker does not re-nag.
  - **The Security panel was reporting the setting instead of the behaviour.** `unode.marketplace.fetchCatalog:
    true` rendered as "Catalog fetch: ON" even with a blank signing key — the state this build ships in, in
    which no catalog request is made at all. It was telling the user the opposite of what the extension does,
    on the one screen a user reads *because* they do not want to read the code. It now renders the effective
    state (`describeHostedCatalogStatus`): off / signing-not-configured / enabled-awaiting-verified-fetch /
    verified / unverified. The test that asserted the old badge was deleted — it was asserting the lie.

- **2026-07-13 - v0.9.29 security review.** Three changes in this release touch the security surface. All
  three were reviewed against the boundary they could weaken; none does.
  - **Windows shell-compatibility scoping (`CommandPolicy.compatibleAllowlist`).** When the agent shell is
    `cmd.exe`, PowerShell-only cmdlets are **removed** from the user's command allowlist. This can only ever
    NARROW what is permitted — it never adds a prefix — so a command that was blocked before is still
    blocked. The verb set is deliberately conservative and does not match hyphenated real programs
    (`git-lfs`, `docker-compose`, `pre-commit`). The always-on catastrophic-delete guard is unaffected and
    its 18 regression cases still pass.
  - **Plan mode advertises the full tool list.** Plan mode previously hid write/run tools from the model.
    It now shows them, and refuses them **host-side at execution**. This is the stronger boundary, not the
    weaker one: hiding a tool is a hint to the model, whereas refusing it is enforced by us. The refusal sits
    in `routeToolCall`, **after** cross-model alias mapping, so a write disguised as `Write`/`Edit`/`Bash` is
    still caught. (The change exists because filtering the tool list mutates the cached prompt prefix, which
    re-prices the whole session on every Plan↔Act switch.)
  - **The request-shape degradation ladder can switch an agent to the XML tool protocol.** Verified that this
    does not bypass any gate: both protocols parse into the same `calls` array and execute through the same
    `routeToolCall`, so the plan-mode refusal, the command policy, the approval cards, the workspace-root
    sandbox and the MCP grants apply identically on the XML path. The ladder only ever simplifies the
    **request body**; it never touches tool authorization.
  - **No change to network egress, secret handling, MCP approval, or the workspace sandbox.** The new
    outbound field (`cache_control` on Claude requests) carries no workspace content — it is a two-key marker
    on message blocks already being sent.

- **2026-07-10 - v0.9.28 Claude fail-closed tool gate.** Every Claude native tool call, including calls
  made by native `Agent`/`Workflow` subagents, is now mediated before execution by an inherited matcher-`*`
  `PreToolUse` hook. A real 2.1.206 `-p --input-format stream-json` probe verified top-level Bash, an Agent
  child Bash (`agent_id` present in the gate request), a deny response, an unreachable endpoint (exit 2), and
  `bypassPermissions`. The initial settings format was corrected during that probe: an `env` object makes
  Claude silently ignore the whole hook settings file in print mode, so the final implementation uses a
  private wrapper to set the hook child environment and `ELECTRON_RUN_AS_NODE=1`. The hook has no
  dependencies, talks only to an authenticated `127.0.0.1` callback, and exits **2** on endpoint loss,
  timeout, malformed input/response, or an unhandled error; a missing hook asset prevents Claude from
  starting. `Bash`/`PowerShell` use the existing `CommandPolicy`; native writes honor the write-approval
  card when enabled; external and new tool names require an approval card whose remembered answer is limited
  to that agent session. This replaces the v0.9.26 caveat that native subagent tools, native external
  effects, and user Claude allow rules could bypass UnodeAi's approval path. No new network destination,
  dependency, telemetry, or persistent secret was added. The VSIX boundary check now requires the runtime
  hook asset.

- **2026-07-10 - v0.9.28 structured-delegation evidence (Phase 1).** Delegated completion now carries
  framework-derived metadata only: successful `CheckpointRecorder` paths, framework-visible tool activity,
  and the configured verifier's actual pass/fail result. `TeamTools` presents this as Verified / Replied,
  not verified / No evidence and rejects a worker's self-reported “tests passed” when no recorded verification
  supports it. The metadata stays on the existing local MessageBus and is already bounded to workspace-relative
  checkpoint paths; this adds no command capability, network destination, persistence format, or new data egress.

- **2026-07-10 - v0.9.27 delete safety, pricing, and label batch.** The always-on catastrophic command guard
  now also blocks Windows recursive directory deletes (`rmdir /s`, `rd /s`, PowerShell `Remove-Item -Recurse`)
  when they target `.git`, `.unode`, `..`, a drive root, or `~` — previously only `rm -rf` and `del /s` were
  caught, so an agent could wipe the repo with the Windows-native spelling. An adversarial review of this batch
  then found and we fixed three real bypasses of the new guard before release: abbreviated PowerShell
  `-Recurse` (`-Rec`), a quoted sub-command wrapper (`cmd /c "rmdir /s /q .git"`), and Windows trailing
  dot/space path-equivalence on the new `delete_dir` tool's `.git`/`.unode` refusal (`.git.` → `.git`). Each is
  now regression-tested. `delete_dir` itself resolves+realpaths+bounds-checks like the other file tools and
  refuses `.git`/`.unode` and out-of-root targets. Model prices were scoped per gateway (no security impact;
  correctness). This batch does not otherwise change what executes or what leaves the machine.

- **2026-07-10 - v0.9.27 audit follow-ups.** Fixed the three follow-ups from
  `CODEX_AUDIT_RESULTS_chat_ux_and_sandbox.md`: the shell outside-root detector now treats legal URI
  scheme tokens such as `a://host` and `git+ssh:/host` as URLs rather than drive paths, while preserving
  the `file://c:/...` embedded-drive warning; Windows extended-length paths (`\\?\C:\...`,
  `\\?\UNC\server\share\...`) and forward-slash UNC paths (`//server/share/...`) are detected before the
  glob/regex wildcard skip. The four shell execution paths (`run_command`, PM `run_checks`, completion
  gate, and worktree verifier) now share one shell gate: `CommandPolicy` denials remain final, model-emitted
  commands keep the outside-root approval escalation/refusal behavior, and configured verify commands run
  when otherwise allowed while surfacing a one-time non-blocking outside-root warning per command string.

- **2026-07-10 - post-v0.9.26 main audit.** Re-audited the chat UX and sandbox commits
  `251ef77..fb09504` before continuing release work. The user-message prose preflight that guessed
  out-of-root paths was removed; real file boundaries remain enforced at the tool boundary via
  `path.resolve`/root containment plus realpath symlink checks for `read_file`, `list_dir`, `search_files`,
  `write_file`, `apply_edit`, `delete_file`, `@file` expansion, and the Claude read-only MCP file bridge.
  The shell outside-root detector is documented as a detector, not a sandbox: it no longer self-refuses a
  command that merely names an outside path, and instead forces a human approval prompt with a warning when
  `CommandPolicy` would otherwise permit the command. The follow-up regression fix makes policy denials
  final first, so mode `none`, allowlist misses, and catastrophic command patterns cannot be converted into
  runnable prompts by adding an outside path. URL handling was corrected so a URL *scheme* (`https://...`,
  `git+ssh://...`) is no longer misread as a Windows drive path, while a genuine out-of-root drive path is
  still detected wherever it appears: bare (`C:\...`), glued to a flag (`-oC:\...`), doubled (`C://...`), or
  embedded inside a `file://c:/...` URL (the scheme is skipped, but the `c:/...` it contains is still flagged
  and blocked — verified by test). Known limitation: this detector is intentionally not a
  security boundary and does not catch every shell spelling of an outside file; command execution remains
  controlled by `CommandPolicy`, approval settings, workspace trust, and the process working directory. The
  chat stream Part A change only persists/segments already-emitted assistant narration and reasoning around
  tool cards; it does not add tools, bypass approval gates, or change what executes.

- **2026-07-09 - v0.9.26.** Combined B0 skills and Claude Headless reliability re-audit. `SKILL.md` source
  validation rejects invalid metadata, executable payloads, and symlinks at every tree level; only
  instruction-only skills ship in the bundled VSIX. OpenAI-compatible skills use granted-name L1/L2/L3
  disclosure with realpath confinement. Claude uses an extension-owned, per-agent temporary plugin that
  remains available with Bash/PowerShell and native write tools disabled, as proven live on Claude 2.1.206.
  The release also reads `unode.defaultProvider` for all creation paths, restores actual PM `assign_task`
  delegation through the authenticated loopback MCP bridge, and confines Claude's CLI auto-approval list to
  the three Unode local bridges. The Windows `.cmd` launcher now rejects unsafe variable argv values before
  it starts any loopback bridge or child process. After review, v0.9.26 intentionally removed the brittle
  blanket Claude native-tool deny-list: trusted write+execute agents receive no default `--disallowedTools`;
  read-only/no-write/untrusted agents deny write, shell, native worktree, native external-effect, native
  subagent, and native tool-discovery tools via CLI name filtering; and normal-agent native
  `Agent`/`Workflow` uses are detected with a user warning plus per-agent opt-out. The chat Stop path now
  cancels stuck turns immediately and ignores stale backend
  completions. **Tool-call argument parsing on the OpenAI-compatible path was corrected**, which changes what
  executes there: gateway-normalized *object* `arguments` are now honored instead of being coerced to
  `"[object Object]"` and silently dropped to `{}`, and non-empty unparsable arguments are reported back to the
  model rather than run as `{}`. Arguments reaching a tool this way remain subject to the same
  `CommandPolicy`, folder-scope, write-approval, and MCP grant checks as before. No dependency,
  remote-control, telemetry, native executable, or third-party MCP
  auto-approval surface was added; normal Claude agents still expose disclosed native external-effect paths
  until v0.9.27's hook gate. Both VSIX manifests
  exclude `packages/**`.

- **2026-07-09 — v0.9.25.** Full release re-audit. The first review found that `.vscodeignore` did not
  exclude `packages/**`, so private `@unode/serve` build output and fixtures could enter a raw VSIX. The
  exclusion is now explicit, both public packaging commands build the smaller bundled artifact, and a
  packaging-time boundary check rejects workspace packages, credentials, runtime state, nested VSIX files,
  native executables, and dependency development fixtures. The generated VSIX contains zero
  `packages/serve` entries. The remote companion remains a private, incomplete development preview and is
  not represented as a v0.9.25 extension feature.
  - **Workspace Trust / Folder Access correction:** the audit found Claude could retain a writable `cwd` in
    an untrusted workspace when no explicit folder grant existed. Effective Claude write roots are now
    always empty when untrusted. Claude native tools also honor each role's `allowedTools` ceiling, explicit
    Explicit Folder Access removes Claude shell execution; the historical Codex Track A did not offer Folder
    Access confinement, and verification commands are disabled for
    untrusted or explicitly scoped agents. Realpath/symlink checks, one-write-root Claude enforcement, and
    worktree conflicts remain covered by tests.
  - **Local surface hardening:** the authenticated loopback MCP bridge caps request bodies at 64 KiB. In the
    separate relay preview, frame observation is test-only and off by default, duplicate same-role peers are
    rejected, and connection and WebSocket buffers are bounded.
  - **Documentation accuracy:** network-capable `web_fetch` and approved MCP tools, Claude Plan-mode limits,
    the token-authenticated loopback MCP listener, and AJV's local schema compilation are now disclosed
    precisely instead of being hidden behind absolute claims.
  - **Claude streaming + cost labels:** partial stream-json progress is restored, and subscription-backed
    usage is labeled as an API-equivalent `~$...` estimate rather than a billed amount.

- **2026-07-07 — v0.9.24.** Re-audit ahead of release. Changes were **branding assets, onboarding UI, and
  docs** only. The one behavioral change: choosing **Claude Headless** in the setup wizard now sets Anthropic
  as the default provider — no new surface (the Anthropic/claude-headless backend already existed and stores
  no key/URL; it authenticates via the user's own `claude` CLI login). New logo files are static images. No
  new network destinations, command/exec, MCP, secrets, Workspace Trust, or dependency changes. Packaged VSIX
  re-scanned: zero distinctive old-brand tokens, no internal brand assets, no publishing tokens.
- **2026-07-07 — v0.9.23.** Docs-only release (user manual + wiki refreshed for the 0.9.22 teams and the
  Anthropic CLI-auth note). No source, dependency, network, execution, MCP, secrets, or Workspace Trust
  change from v0.9.22; the v0.9.22 audit below remains current.
- **2026-07-07 — v0.9.22.** Re-audit ahead of release. Changes were **role/model/UI configuration only**:
  two new default teams (Marketing, Sales) with seven new specialist skills and role templates, a team-kind
  classification fix, and a refresh of the Anthropic model dropdown + tier defaults to the current lineup.
  **No new attack surface:** the new skills grant only the already-audited built-in `read`/`write`/`search`/
  `message` tools within the existing sandbox — no `execute`/shell and no `delegate` were added (the roster
  test enforces that specialists never receive `delegate`); writes remain locked to the primary working
  folder. No new network destinations (Anthropic egress endpoint unchanged), no MCP behavior change, no new
  secrets handling, no Workspace Trust change, and no new dependencies. The Anthropic model list is static
  identifier strings passed verbatim to the `claude` CLI (which enforces the user's own plan/model access).
  Packaged VSIX re-scanned: zero distinctive old-brand tokens, no internal brand assets, no publishing tokens.
- **2026-07-06 — v0.9.21.** Re-audit ahead of release, focused on the new **multi-root file access**
  (the biggest new attack surface). Verified the invariant that **writes/edits/deletes and shell commands
  stay locked to the agent's primary working folder**; secondary roots (other workspace folders + opt-in
  `unode.additionalRoots`) are **read-only** and reachable only through the guarded `read_file`/`list_dir`/
  `search_files` tools. `unode.additionalRoots` is off by default, in `restrictedConfigurations`, and
  ignored in an untrusted workspace; every read root gets the same realpath/symlink escape checks as the
  primary sandbox. Claude agents are NOT handed extra dirs via `--add-dir` (which grants write) — cross-root
  READ is provided through a read-only `unode_files` MCP bridge that exposes zero write tools (asserted at
  the MCP RPC layer). An adversarial (Codex) review pass caught and fixed two would-be holes (shell + Claude
  native write reaching read roots) before merge; regression tests lock both.
- **2026-07-05 — v0.9.20.** Re-audit ahead of release. New **chat attachments** feature reviewed: user
  attachments are re-validated host-side (size/MIME allowlists, base64 charset checks, filename
  path-stripping) before ever reaching a model; the webview CSP permits `data:` images; chat history
  persists only display metadata + a capped thumbnail, never full image bytes. Images ride as vision
  `image_url` parts (OpenAI-compatible) or native Anthropic content blocks (Claude headless). Packaged
  VSIX re-scanned: zero distinctive old-brand tokens, no internal brand assets, no publishing tokens.
- **2026-07-05 — v0.9.19.** Full re-audit ahead of the Open VSX release. Verified the shipped package
  contains no publishing tokens or dogfood state (`.vscodeignore` hardened for `.ovsx*`, `*.pat`,
  `*.token`, `.env*`). Confirmed the safe-by-default posture above against source: network egress is
  per-host consent-gated, shell/writes are approval-gated, MCP is default-deny, and provider keys live in
  VS Code SecretStorage (never on disk or in exports). Added the in-editor **UnodeAi: Security** panel and
  a first-run safety checklist so this posture is visible and auditable at a glance.
