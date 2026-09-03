# Changelog

All notable changes to UnodeAi are documented here.

## [0.9.76] - 2026-09-03

**v0.9.76 improves the refusal explanation a model receives and which tools it is offered; it widens no permission.**

**A refusal can now say what the model can do next.** The refusal reason and the set of refused actions are
unchanged; where useful, the host appends a reviewed, fixed explanation such as the requirement for a live
contracted task attempt. This never forwards a path, credential, command, destination, or a user's free-form
reason for denying a web request.

**Task-only tools are offered only while they can succeed.** On OpenAI-compatible connections,
`publish_task_artifact` and `report_context_gap` appear only during a live contracted attempt. A stale direct
call still reaches the host handler and receives its accurate refusal rather than being called an unknown tool.
Claude's fixed-at-connection tool schema is unchanged.

**Three authority boundaries now have the tests they were missing.** This changes no user-visible behaviour:
the release runner is now `npm run test:release-authority-canaries`, which proves all twelve named authority
boundaries kill a targeted mutation.

**Dashboard status colours now follow VS Code theme tokens.** The former fixed colours map working and done to
different semantic tokens, and tokens that might be unavailable retain the previous colour as a fallback so an
indicator cannot lose its colour entirely. This release makes no claim that the dashboard was visually checked
in any theme.

**Streaming replies reveal steadily.** A growing paragraph keeps its DOM node across paced paints, so selecting
text in that paragraph is not destroyed by the next frame.

## [0.9.75] - 2026-09-02

**A delegate refused for scope keeps working, and only leaving the configured workspace ends its turn.** The
set of refused actions is unchanged: no new filesystem path is readable or writable, an out-of-workspace path
is still blocked, and a blocked shell command still never runs. Terminal authority now originates only in the
typed path-boundary proof. A shell line that merely looks out of root is a command-text heuristic, not a
sandbox proof, so it stays refused but the agent can make another safe call. An expired, unsupported, or
unforwarded temporary asset is likewise still unavailable and still refused, without ending an otherwise
useful turn.

**Coordinator briefs cross a visible egress boundary.** A coordinator can attach a short, sourced brief to
one delegated assignment; it is rendered to the worker as a coordinator claim rather than host evidence, and
does not change the worker's obligation to report what it observed. Declared `basisRefs` are checked again
against the inputs actually granted to the attempt, and a missing grant refuses dispatch before the worker
starts. When a brief would go to a different resolved model destination, UnodeAi opens a per-dispatch modal
naming that destination. The prompt exists because the brief may paraphrase your documents and travels in the
worker's prompt rather than through a read tool; declining refuses the dispatch, while the same destination
asks nothing new.

**A delegated task that needs no supplied material is no longer told not to use the web.** The host task
card carried one unconditional rule: report a gap for a required input rather than substituting web content.
A task that declares no required inputs has nothing that rule can apply to, yet a worker sent to verify
something on the web still read it as a flat prohibition — and was pointed at a gap report that could only
refuse. That guidance now follows the contract. A task declaring at least one required input is unchanged; a
task declaring none, or only optional ones, is told that no input-substitution rule applies, because
`optional` means the work can be completed without that input. If a source must be consulted, declare it
required. The card grants no capability: whether an agent can reach the web remains its own configuration.

## [0.9.74] - 2026-09-01

**A temporary task scope remains a real boundary without becoming a dead end.** A request that stays inside an
agent's configured Folder Access but falls outside the current assignment is now a structured `task-scope`
refusal: it explains the narrow assignment boundary and the agent may make its next safe call in the same
turn. A true configured-workspace escape remains `scope` and terminal. The same distinction is enforced on
the physical target of a symlink, and an unavailable image asset is correctly a `capability` refusal rather
than a fictitious directory violation. Directory activity is labelled **List** / **Listed N folders**, not
Read.

**Run-record policy is explicit at the field declaration.** Every required `RunRecord` field has a portable
or non-portable policy; derived projections declare their input fields; and persisted JSON stays `unknown`
until `normalizeRun` validates and repairs it. This release proves the configured-vs-task-scope write and
symlink branches, together with the image-refusal classification, by mutation tests so those distinctions
cannot silently regress.

## [0.9.73] - 2026-08-31

**An unfinished turn is now a terminal fact, not a completed task or a vanished report.** A directed
non-user turn that ends with unfinished structured activity emits `task.partial`. The full report is kept,
the remaining activity travels separately, the coordinator is woken, and every consumer records the
delivery as partial without turning the evidence verdict, coordinator disposition, counters, team view,
dashboard, chat, or workflow green. Workflows retain the report and pause without running a gate or
dispatching their next step.

- **Delegation status has a live layer.** `inspect_task_status` reports worker, wait, result, and required-input
  receipt state independently. A blocking timeout can therefore remain `timed-out-window-open` while the
  worker is idle or running and the result is still pending. When a late result is retained, only `ready`
  names the non-blocking `collect_ready_tasks` action; no model-visible status points at the legacy blocking
  `await_tasks` alias. Restored retained results are ready without claiming their worker or promise resumed.
- **A missing read receipt is no longer called an unread input.** Evidence now says
  `required-input-read-not-observed`, carries `requiredInputReadNotObservedCount`, and exports each input's
  `readReceipt` as `observed | not-observed`. Actual host-observed failures retain their separate `missing`,
  `expired`, `outside-task-scope`, or `unreadable` reason. Timeout and late-terminal receipt snapshots are
  both retained, each with its observation time, so a historical timeout cannot freeze the current view.
- **Run and portable evidence preserve partial closeout.** Run records move to schema v7 and distinguish
  `complete` from `partial` closeout. Portable Run Evidence moves to `portable-run-evidence/3`; the root
  closeout state, delegation completion state, and renamed read-receipt key ship together. v6 records migrate
  to the sensor-bounded vocabulary, while v7 round trips preserve the new closeout field.

## [0.9.72] - 2026-08-31

**A host tool returns its decision as a value.** `summarizeToolResult` no longer accepts a bare string from a
host tool: results are a `success | refused | failed` union, a refusal carries a closed-enum reason
(`capability`, `scope`, `trust`, `consent`), a command carries its real exit code, and text produced outside
the host — an external MCP server, a subprocess — travels a separately marked path. The anchored English
prefix list in `isToolError` is deleted, not extended. **The defeating input was one the product emits
itself**: `Web access denied:` was absent from the list, so a denied `fetch_url` was summarised as a
successful tool call. `WorkspaceTools`, `TeamTools`, `SkillRegistry` and the OpenAI-compatible tool loop all
report through the union.

- **A merge is `merged` only when the integration branch moves.** `GitMergeOrchestrator` records `HEAD`
  before the merge and compares it afterwards. The `/already up[ -]to[ -]date/i` reading of Git's own output
  is gone, and a localised Git can no longer make a no-op merge report as landed.
- **Package-script selection reads the command, not the name.** `commandNormalize` drops the
  `/watch|dev|\bui\b/i` name test and classifies each script body by runner semantics: the body is tokenised
  with quotes honoured, **every** invocation of the runner is classified, and a watch-defaulting runner
  promotes only when all of them are explicitly one-shot. `vitest && vitest run` is therefore ineligible —
  its first half never ends. A body that could conceal an invocation (command substitution, a shell group)
  is refused rather than guessed at, and the direct-invocation fallback uses `findRunner`'s known position
  rather than searching for the name again, so both call sites share one input contract.
- **Silent refusals carry a reason.** `resolveInsideRoot` and `resolveInsideRootPhysical` return
  `resolved | refused:scope | failed:{invalid-target,not-found,unreadable}` instead of a single bare
  `undefined` covering four different causes. `RunLedger` records a `RunVerdictWithholding` when a persisted
  verdict is not restorable as human judgement, ordered against the accepted verdicts so a withheld latest
  value cannot fall back to a stale acceptance. `PortableRunEvidence` and `RunEvidencePack` carry the same
  distinction. Every reason is bounded and free of paths, roots and credentials.
- **The workflow runtime slice lands with the two regressions its own acceptance named**: a returned template
  or gate cannot mutate the built-in catalogue, and a workflow cancelled during an asynchronous gate
  dispatches nothing after that gate settles.

**Two defects were found by mutation during review rather than by the suite.** Deleting the phrase table left
`await_tasks` and `collect_ready_tasks` marking nothing, so a batch containing a failed subtask reported as a
successful tool call — the same shape the release exists to remove. Both collectors now go through one helper
that binds the wording to the status, and **each is proved separately**, because a mutation of the shared
helper is killed by either test and would hide an unwired call site. Failure output quoting a worker reply or
a subprocess was marked host-authored and now carries `mixed-external`; `run_checks` is proved at both its
failing exits.

**Deferred, and now recorded with its sites.** `classifyToolFailure` still runs at `SessionManager.ts:1589`
for events from `ClaudeHeadlessBackend` and `CodexBackend`, which emit no `failureKind`. It selects only the
UI category label and cannot flip `ok`. ROADMAP Track E carries the three sites and the end state: **every
event carries its own `failureKind` and the phrase table is deleted — extending it is a regression, not a
fix.**

## [0.9.71] - 2026-08-30

**Dispatch belongs to one coordinator, and settlement reports a host observation instead of a worker's
account.** Both defects came from one live trace of a read-only document review that produced no document
review.

- **A team has exactly one coordinating identity.** `CoordinatorIdentity` resolves it once, and the two
  copies of the old predicate — `canDelegate` and `workerComplianceProtocol` — now consult the same function.
  Previously any agent holding `delegate` received the full delegation surface while `types.ts` documented
  the capability as "PM delegation", and the shipped `task-decomposition` skill granted it by default. **A
  worker's sub-delegation was also invisible to the coordinator**: `contractClaimByHandle` is per-instance,
  so `inspect_task_status` and `collect_ready_tasks` could not reach it, and **a task scope did not survive
  the hop** — the requested scope is intersected against the target's own configuration, never against the
  dispatching agent's active scope. A worker now asks the coordinator in an ordinary message; **the host
  never parses that message**, because judging whether a suggestion is worth dispatching is meaning and
  belongs to the coordinator.
- **Legacy teams keep loading.** A team file granting `delegate` to a worker, or carrying more than one
  `role: 'pm'`, loads with all of its members. The capability is dropped in memory and the designated
  coordinator is the same one `find(role === 'pm')` already selected, so no existing team changes behaviour.
  Each change is reported as a validation warning rather than a failed load.
- **`requiredInputCount` and `unreadRequiredInputCount` are derived at settlement from the resolver's own
  grants** and recorded in evidence, task status and the run ledger **without the coordinator calling any
  tool**. When every required input went unread, the delegation settles into its own
  `required-inputs-unread` outcome rather than an ordinary delivery. **The counts are never taken from
  `task.complete` metadata**: a fix that trusted worker-supplied structure would be defeated by the same turn
  that defeated the original rule, and would look structured while doing it. v0.9.70's context-gap work does
  not cover this case, because a worker that never calls `report_context_gap` produces exactly it.
- **Attempt liveness is expressed once.** `canReadContentAsset` re-stated the check inline instead of calling
  `isAttemptLive`, and the proof was attached to the duplicate. Mutating the predicate now fails a test at
  every consumer, **closing the coordinator self-execution survivor carried since v0.9.62**. The
  managed-asset anti-redelegation survivor — one enforcement point that simply had no test — is closed too.
- **A shared memory note records the host's routing tier and an agent-selected kind.** The tier is a host
  routing decision resolved at write time and is **not a tool parameter**; the kind is chosen by the agent
  from `pitfall | contract | decision` and is **never inferred from the note's text**. `EffectiveExecutionIdentity`
  is deliberately not used: it must not enter prompts, ledgers or exports, and notes are all three. Notes
  written before this release load and render their origin as unknown. **The host records provenance and
  never weighs, filters or orders notes by it.**
- **Retention follows kind rather than the clock.** Contracts survive eviction ahead of recency-selected
  pitfalls, decisions and legacy notes; the injected block stays bounded at thirty.
- The survey ledger carries a second correction: its claim that every one-enforcement-point rule was killed
  is contradicted by its own coverage table, and the rule in question is the one this release closes by
  writing the missing test. **Convergence fixes duplication, not absence.**

## [0.9.70] - 2026-08-29

**Task state becomes a host observation, and three more places where the host read prose are gone.** Two
overnight surveys ran independently against the same tree and converged on the same defects; this release
acts on them.

- **A context gap is a host-observed fact.** `report_context_gap` now takes only the input id. Whether that
  input was `missing`, `expired`, `outside-task-scope` or `unreadable` comes from the extension's own latest
  access observation for that exact attempt, and a later successful read invalidates an earlier gap. A worker
  can no longer report an input as unreadable after the host read it. Material that is readable but
  substantively thin is for the worker to explain in its result, and the host does not label it.
- **`inspect_task_status` is a durable, non-consuming view of a coordinator's own handles.** It reports worker
  lifecycle separately from result delivery, survives collection and reload, and never consumes a mailbox
  entry, messages a worker, or wakes one. The two defects formed one loop: a task could settle while the
  coordinator still showed it as working, with no way to look without destroying the result.
- **Team Rules separates enforcement from advice.** Built-in protections are display-only, team policy is
  host-enforced and selected by a person, and `.unode/rules.md` is guidance agents interpret. The first policy
  is off by default: an explicitly marked artifact review must run under a different **reported** model
  identity. The host does not claim this proves a different underlying model answered, or that the review was
  good.
- **Skill descriptions are no longer required to be English.** Validation demanded an English keyword and five
  whitespace-separated words, and threw when either was absent — so no Chinese, Japanese or French description
  could register a skill at all. Both checks are deleted rather than localised: whether a description says
  when to use a skill is a judgement the selecting agent makes, in whatever language it is written.
- **Workflow branches are an exact structured choice.** A step declares its outcome labels, the completing
  agent selects one, and the host compares for equality. The previous substring match could not see negation,
  so a branch condition of `approved` fired on a result of "not approved". Pre-0.9.70 files migrate on load
  rather than failing: an old substring becomes that exact label, and a branch that had no condition — which
  meant "always" — is kept as a fallback taken only when nothing matched, and never offered to the agent as a
  choice. Each migration is reported in the team file's validation warnings.
- **The host stopped grading a reply for honesty.** Two regexes decided whether a model's prose claimed that
  checks passed or that no files changed. Both were English-only and both were defeated by ordinary sentences
  in either direction. They are deleted, along with the two mismatch fields they set, which are also gone from
  portable evidence. What remains is the observed fact: whether a verification sensor ran.
- **Workspace Trust is enforced once, at one boundary, for every surface it covers.** Writes, edits, deletes,
  `apply_patch` and `run_command` now receive the same decision and the same stated reason at the tool
  dispatch point. **Nothing became more permitted.** A command in an untrusted workspace was already refused
  further down, but the refusal claimed the agent lacked a writable folder and told it to ask for one, which
  would not have helped; and the trust property was being enforced by a neighbouring rule about write roots.
  There is no per-command approval in an untrusted workspace, deliberately: the approval is Workspace Trust
  itself, made once in VS Code, rather than a prompt that content the agent just read could induce.
- **A human run verdict is validated in one place.** The check that an approver is a real person rather than a
  host actor now runs in a single normaliser that both the reload path and the portable export read through.
  Previously it ran when a verdict was recorded but not when one was read back from disk or projected into an
  export, so a host-authored verdict persisted into the ledger could have been reported as a human acceptance.

## [0.9.69] - 2026-08-29

**An agent can read the documents in the folder you opened, and a team you configure once follows you to the
next project.** Four of this release's five workstreams remove something.

- **`read_file` reads PDF, DOCX and PPTX.** The product shipped PDF intake in 0.9.57, but it had two doors —
  a public URL and a chat attachment — and neither was reachable for a file already sitting in your
  workspace. There is now a third. **Office parsing runs in an isolated worker under the same memory cap and
  timeout as the PDF path**, reads only the document's text parts, and follows no link for any reason. It
  returns the text through `read_file` itself: no receipt, no second call.
- **The saved-team library has an All-projects scope.** It always saved everything; it saved it inside the
  workspace, where the next project never looked. The per-project scope is unchanged, because a
  `.unode/teams` file travels through git to a colleague and a global one cannot. **Crossing that boundary
  never widens permission**: a folder grant is kept only if it stays inside the target workspace after
  resolution and `realpath`, explicit MCP grants are removed, and the global scope never stores an agent's
  `env`.
- **A coordinator no longer has to enumerate the files it is delegating someone to find.** The declaration it
  was graded against granted nothing — the code says so in its own comment — while refusing dispatch when the
  paperwork did not match. **Every authority check is untouched and re-proved by mutation.**
- **The host stops inferring what people meant from the words they used.** Three rules are deleted: one read
  your message through English keywords and code-file extensions, one decided whether a shell command counted
  as a verification from a list of tool names, and one mapped tool names to friendly phrases through a table
  that had never once matched, because every tool arrives MCP-prefixed. `verified` now comes from a declared
  sensor, so `./run-tests.sh` counts for the same reason `npm test` does.
- **The activity feed reports the work, not the plumbing.** A tool line names what it acted on — a
  workspace-relative path, or a command's program name and nothing else — repeated actions fold into one line
  with a count, and a tool result no longer produces its own entry. **Nothing an external MCP tool passes as
  an argument is written into a feed that persists and exports.**
- **Catalogue lists sort by name** in the Agent Builder and the Marketplace.
- **Internal:** a host-private effective execution identity records what the host selected and what the route
  reported for a produced turn. It carries two named comparison facts and no verdict, lives only in process,
  and appears in no prompt, tool result, roster or portable evidence.

**Verified by mutation, twenty for twenty on the properties this release touches**, plus the standing
authority canary table re-run in full: ten of its eleven mutations still fail their named test, and the
eleventh is the same coordinator-liveness survivor recorded before this release, unchanged.

## [0.9.68] - 2026-08-28

**This release deletes five behavioural mechanisms and adds one number.** It is the second half of the
programme v0.9.67 started, after a request that should have taken seconds cost four minutes: the product had
been accumulating constraints that charged honest work for failures it could not have caused.

- **Every behavioural nudge is gone.** Five families, in both backends. **Two of them worked by
  pattern-matching the agent's own prose** — inspecting what it wrote and injecting a message when a regular
  expression matched. v0.9.66 established that the host must never read prose to decide what an agent
  claimed; that rule was applied to delivery states and left standing here. It now applies to itself, and a
  check fails the build if any of those detectors returns.
- **Verification is not weaker for it.** Declared verification sensors and `run_checks` are the mechanism; a
  nudge was the version that asked nicely, and it outlived what replaced it.
- **A turn reports how long it actually took.** Start, end and elapsed, including time spent queued and time
  spent in host-authored continuations. **Waiting for your approval is reported separately** — you are not
  billed for your own thinking. A turn from before this release says *not recorded* rather than showing a
  zero, and per-tool timings are unchanged.
- **Delegating something no longer requires filling in fields nobody reads.** `expected_deliverable`,
  `constraints` and `dependencies` are optional, defaulting to empty. **The effects a task declares stay
  required** — the write scope is what stops a delegate writing outside its task, and that is not ceremony.
- **One runtime instruction was deleted because it was measured and did not work.** The guidance telling an
  agent that a tool result is not a user-visible reply was present, correct and running when the exact
  failure it addresses recurred. v0.9.67 made its subject structural. **This is not a claim that instruction
  never helps** — it is that this one was tested in production against its own failure and did not hold.

**Every authority property proved in earlier releases still fails its mutation**, re-run in full: input
grants, task scope, delegation fallback refusals, recorded-file resolution, hook approval, expired-approval
finality. **Removing what does not earn its cost is not the same as removing what protects you**, and the
canary table is how that distinction is kept honest.

## [0.9.67] - 2026-08-28

**This release removes more than it adds, and that is the point.** Asking an agent to read one local file
and show it took **about four minutes on the strongest available model** under v0.9.66. The model was not
slow or confused — it was doing what the product told it to do, which was retype a 15.8 KB document it had
already been handed so the host could compare the retype against bytes the host was holding the whole time.
It failed on a trailing newline, could not rebind to a fresh copy because the binding was immutable, and
spent three minutes reconstructing the text by hand.

- **The host publishes its own content now, and the agent never retypes it.** One tool — name the receipt
  the host returned, choose `shown`, `partial` or `not-delivered`, optionally add framing. **There is no
  content parameter**, so a transcription cannot be wrong and nothing has to be compared.
- **`partial` is sliced by the host**, by Unicode code point, with the length range stated and fractions
  refused rather than rounded. The definition remains because the host needs it to cut its own text; what is
  gone is the model being asked to reproduce the text and then judged on the reproduction.
- **Two tools became one, and the trap became unreachable.** The old declare-then-publish pair is deleted.
  Naming a different receipt is now just another call, so the failure that cost four minutes — refused, then
  unable to rebind — cannot occur.
- **The content arrives as the actual reply.** A 15.8 KB document is published as assistant text, not as a
  collapsed tool receipt, and a test asserts that end to end. **Showing a file is now two model round-trips**:
  read it, publish it.
- **Nothing was loosened that prevents real harm.** A receipt still cannot be published outside the turn that
  recorded it, and a turn still accepts one terminal state. Every authority property proved in earlier
  releases still fails its mutation.

## [0.9.66] - 2026-08-28

**An agent can now tell the host what it is delivering, and the host checks it before the person sees the
answer.** This exists because the Owner asked a PM to show them a document, the PM put it in a tool receipt
instead of the reply, and then said it had shown them the full text. **The same document had failed the same
way five releases earlier**, and that time the fix was a sentence in the runtime guidance — a sentence that
was present, correct, and running when it happened again.

- **A coordinator turn may bind itself to one content receipt the host issued this turn.** The declaration
  names an opaque receipt id, never a path: a path is ambiguous the moment a file is re-read or edited, while
  the receipt is the exact bytes the host already returned. The binding is immutable for the turn, cannot
  name a receipt from another turn, and expires with it.
- **A declared turn ends in a closed state: `shown`, `partial` or `not-delivered`.** The host never reads
  reply prose to decide which applies — it reads a field, the same way `close_assignment` reads an outcome
  rather than a sentence.
- **`shown` is refused unless the declared source is in the reply, verbatim.** `partial` is refused unless
  the stated number of omitted characters matches a prefix that really is there. **A refused claim is
  returned to the model for correction and never published**, so a delivery the host did not observe cannot
  become one the person is told about.
- **The comparison is specified, not improvised.** Line endings are normalised; Markdown, escaping and
  whitespace are compared literally; `partial` counts Unicode code points. Both the OpenAI-compatible and
  Claude backends publish the validated payload as the real assistant reply.
- **A turn that declares nothing is unchanged.** No new runtime guidance, no new nudge, same transcript and
  the same evidence as before. The only difference is one more tool it did not call. **This is an ability,
  not an obligation** — the guidance layer had two attempts at this problem and is not given a third.

## [0.9.65] - 2026-08-27

**Delegation with a task scope was broken, and the receipts that would have shown it were wrong too.** Both
are fixed. The Owner found this by running real work: a coordinator delegated a review of two files it had
just read itself, and every scoped attempt came back *context gap — missing*.

- **A declared input under a task scope now reaches the worker.** A task scope used to *replace* the base a
  relative path resolves against instead of narrowing what that path may reach, so a declared
  `research/x-article.md` under a `research` scope resolved to `research/research/x-article.md` and was never
  found. **A delegation carrying a scope and an input under it could not succeed.**
- **A scoped write no longer lands in a directory nobody asked for.** The same duplication on the write side
  was not refused — the doubled path was still inside the scoped write root, so it was permitted and the
  parent directory was created. **A `readwrite`-scoped delegated write silently wrote to
  `research/research/` and reported success.**
- **The fix separates three ideas that shared one field.** `pathBase` — what a model-supplied relative path
  means — is always the agent's configured root and is resolved exactly once. `readRoots`/`writeRoots` do
  authorisation only, on the already-resolved absolute path. **`commandCwd` stays inside the writable task
  scope**, because a shell's working directory is a containment boundary in a way a resolved path is not.
- **An input receipt now records the file the host opened, not the text the model typed.** A read was
  matched by normalised string equality against the declared path, so an absolute path, or a case variant on
  a case-insensitive filesystem, marked nothing. **A file the product had demonstrably read could be
  reported as unread** — which is what happened to the Owner, whose reviewer produced line counts and a
  thirteen-point audit while the receipts said `read=no`. Matching is now by resolved physical identity,
  through one primitive shared with contract admission, so case follows the filesystem rather than a
  hard-coded assumption.
- **That physical identity never leaves the host.** It stays in host-private attempt state and is never
  copied onto an input grant, into the attempt card a worker model receives, or into exported evidence —
  where an absolute path would disclose the host's directory structure.
- **A finished assignment stops being told it had no conclusion.** The closeout now distinguishes *nothing
  was judged* from *decisions were recorded but the assignment was never formally closed*, using a real
  count of recorded dispositions rather than inferring one from the absence of owed work.

## [0.9.64] - 2026-08-27

- **The transcript no longer repaints while a reply streams.** v0.9.63's transcript virtualisation closed a
  scroll → render → scroll loop: a scroll scheduled a render, the render replaced the whole transcript and
  pinned to the bottom, and pinning fired another scroll. Long conversations flashed at frame rate and were
  unreadable, worst while a reply produced code, in **both the Workbench and the Chat sidebar**.
  Virtualisation and its estimated spacers are removed; the known-good full-transcript rendering is back, and
  cards you expanded still stay expanded. A canary now drives the real `scroll` listener in both containers
  and fails if a render is ever scheduled from one.
- **A blocked delegation offers the repair it describes.** When a teammate returns nothing across the retry
  and fallback path, the card now carries **Edit agent model** and then **Retry delegation**, instead of
  telling you in prose to go and do it. The retry re-enters the normal admission path — a new attempt, fresh
  input grants, the full candidate filter — and is never a revival of the settled one.
- **A consent request that timed out says plainly that it cannot be resumed.** It offers no button, because
  there is nothing to resume: the caller already received its denial. **An expired approval can never become
  an approval**, its id is never re-used, and the roster now shows the documented ⌛ marker instead of the
  generic `!` it had been sharing with four unrelated states.
- **A repair is re-checked when you click it, not when it was drawn.** The host re-derives the target, the
  session and the remedy's reachability at invocation; if anything changed since the card appeared, no
  command runs and the card says so. Repeated or simultaneous clicks produce exactly one retry. The webview
  still names only an opaque host-issued id and a bounded action.
- **Portable Run Evidence is now `portable-run-evidence/2`.** A timed-out approval was previously exported as
  an ordinary `denied`; it now exports as `expired`, and repairs appear as a closed
  `consent-timeout | delegate-empty` category with an `offered | invoked | unavailable` state. **This widens
  an exported enumeration**, so a strict reader of the v1 two-value `decision` field will see a third value.
  No agent id, model name, path, task text, attempt, grant or approver identity is added.

## [0.9.63] - 2026-08-26

- **Every step says how long it took.** A finished tool card shows `Done · 1.4s`, and expanding it gives
  the start time, the finish time and the duration. Failed and blocked cards get the same treatment — how
  long something ran before it failed is often the more useful number. A coalesced group shows its span from
  first start to last finish.
- **A duration is measured or it is absent.** The completion time is recorded at the moment a tool call
  becomes a result, never derived from when a card was drawn. A card from before this release has no
  measured finish and says **duration not recorded** rather than showing `0s`, and a group containing one
  such member reports a **partial span** instead of a shorter span presented as whole.
- **Long transcripts stay responsive.** A conversation past 120 items now renders only the visible window
  plus an overscan margin, with spacers holding the scroll geometry. A card scrolled away and scrolled back
  is the same card — it keeps its expanded state and its already-rendered content instead of being rebuilt.
- **Chat messages between the extension and its webview now cross one declared boundary.** Every command the
  chat view can send has a single declared shape with bounded identifier lengths, validated once before any
  handler runs; the hand-written per-field checks are gone. **A typed message is not a trusted one** — the
  webview still names only opaque host-issued ids, and the extension re-derives every path and permission
  from its own state, exactly as before.
- **The invariants were written down as tests before the speedups were built.** A consent prompt, an
  approval, a cancellation, an evidence fact, an error and a final answer must survive the real frame
  coalescer and the real webview animation-frame pacing complete and in order; a mutation that drops one
  block fails it. Malformed and over-long payloads are rejected for all seventeen inbound commands, opening
  a file from another agent's receipt is refused, and a new `check:chat-webview-protocol-boundary` gate —
  self-tested against a planted violation — fails the build if a hand-written validator reappears.

## [0.9.62] - 2026-08-26

**Nothing in this release changes what you see or how the product behaves.** It moves orchestration policy
out of the file that wires the extension together, so the next few releases attach to a boundary instead of
to a composition root that had grown in every release since the question was first raised.

- **Coordinator tool construction, task-scope preflight, delegation content admission and the recorded-file
  open authority check now live behind a host adapter** that can be tested without starting an extension.
  `src/extension.ts` drops from 8,296 lines to 8,065 and declares none of those policies any more.
- **A gate stops it drifting back.** `check:orchestration-boundary` fails if the composition root declares
  an orchestration policy function again, and it self-tests against a planted violation — intent did not stop
  the file growing over three releases, so this is a check rather than a note.
- **Command ids, titles, activation, evidence schema and event ordering are unchanged**, and no existing
  test was edited to accommodate the move. Every authority property proved by mutation in v0.9.60 and
  v0.9.61 was re-run afterwards and still fails its test.
- **One missing guard was found and closed.** Dropping either the declared files or the task contract from a
  firm retry failed no test — the behaviour was correct, the regression test was not. It had stopped
  discriminating in v0.9.61 when `dispatch` was rewritten. Re-running the authority canaries is now a
  release-runbook step for every release rather than advice for refactors, because **a canary loses its
  power in the release that rewrites the code it guards.**

## [0.9.61] - 2026-08-25

- **Delegation is now a host-checked task contract, not an instruction plus guesses.** A coordinator
  declares the deliverable, separate read and write effects, required capabilities, inputs, constraints,
  dependencies, verification sensors and execution strategy. The host compiles that proposal into an
  immutable contract and refuses missing or unsupported capability declarations before work starts; no
  authority is inferred from task prose.
- **A worker receives the necessary, declared, authorised and fresh inputs for one execution attempt.**
  Content assets, current or dispatch-snapshot workspace paths, and explicit upstream artifacts become
  attempt-bound grants. Ending the attempt revokes them synchronously, including across a firm retry, and
  receiving an input never adds command, write, web or MCP authority. Conversation history is not shared.
- **Artifacts cannot launder private input into another task.** Only an explicit `artifact-ready` record
  becomes a dependency, it retains the complete input provenance chain, and a downstream use must be
  declared and authorised against that chain. A settled, timed-out or prose-only result is not an artifact.
- **Dispatch filters candidates before choosing one.** Permissions, task scope, file claims, input grants,
  artifact readiness and verification-sensor reachability are deterministic gates. An unfit exact id is
  refused rather than silently swapped; a role rotates only among survivors. `delegate-preferred`,
  `delegate-required` and `coordinator-only` make fallback explicit, and Solo is never an automatic fallback.
- **Missing context and missing executors are task states, not agent failures.** `report_context_gap` carries
  a stable reason code and shows the declared purpose to the coordinator without revealing an unauthorised
  source below that boundary. Internal evidence retains the full contract and supplied/reachable/read
  receipts; portable evidence uses document-local input ordinals, exports no objective, purpose, constraint,
  path, source id, attempt id or artifact handle, and declares every omission.
- **A file receipt no longer impersonates the document the model read.** A `read_file` card names Markdown
  or file content, states when its bounded preview was truncated, renders Markdown through the same safe
  structured renderer as replies, and opens the complete host-recorded file in the editor after re-checking
  the agent's read roots. A card you expand stays expanded when later tool activity rebuilds its group,
  across transcript refreshes and a webview reload. Runtime guidance also distinguishes "I read it" from
  "I showed it": requested document content belongs in the reply, not an invisible tool result.

## [0.9.60] - 2026-08-25

- **A task now says what would prove it done, before the work starts.** Until this release the product
  judged every task in a workspace by one global `unode.verifyCommand` string — a documentation task, a
  refactor and a new feature all answered by the same command, or by nothing at all. A delegated task can
  now carry a verification plan: an ordered set of deterministic, host-observed sensors chosen at dispatch.
  A workspace with a verify command and no declared plan behaves exactly as it did in 0.9.59.
- **"Nothing to check" is now a real answer, not silence.** `no-applicable-sensor` is a first-class outcome,
  distinct from a check that did not run and from one that failed, and the three are distinguishable in the
  delegation outcome, the closeout state, the Team card and the evidence pack. A plan that declares no
  applicable sensor is a valid, honest statement about the task.
- **A plan that the delegate could never satisfy is refused when it is dispatched.** `run_checks` belongs to
  a coordinator, so a plan naming that sensor for an ordinary teammate could only ever evaluate to
  *not run* — forever, by construction. Every sensor is now checked against the target's real tool surface
  before the task is sent, and the refusal names the sensor and what that target can actually reach.
- **The files a task owns are now given to the teammate doing it.** A coordinator declaring `files` had them
  used only to stop two parallel tasks colliding; the list never reached the worker, which was told to find
  the files the task touches while the product held the list. They now travel with the assignment and with
  the firm retry after an empty reply. They remain task location and ownership information: a declared file
  outside an agent's scope does not become readable or writable by being named.
- **Declarative bounded execution hooks, and a boundary that repository settings cannot cross.** PreTool,
  PostWrite, EndTurn and on-failure hooks run host-owned actions with enforced time and output ceilings, and
  fail closed — a hook that times out, errors, or cannot be read blocks the action it gates. **A hook can
  only block something an agent could already do; it has no vocabulary for granting a command, a write
  scope, a network destination or an MCP server.** `unode.executionHooks` is an inert candidate in **every**
  settings scope, including a repository's `.vscode/settings.json`: a declaration takes effect only after
  you run `UnodeAi: Apply Execution Hooks`, read the complete normalized declaration and confirm it. The
  approval is stored outside the repository and bound to that exact text and origin, so editing the
  declaration or moving it to another scope makes it inert again. No agent has a tool to write the setting
  or its approval, and revoking an approval takes effect on an already-running agent at its next hook point.
- **The turn-continuation rules the two backends each kept a private copy of are now one implementation.**
  The verify nudge, the no-op nudge and the unverified-changes warning are shared, so the OpenAI-compatible
  and Claude backends can no longer drift on when work counts as done — the one-rule-several-call-sites
  defect that produced the v0.9.58 provider-key bug and v0.9.59's `load_skill` freeze.

## [0.9.59] - 2026-08-25

- **A person can now say whether delivered work was acceptable.** `UnodeAi: Review Delivered Work` shows a
  finished run's evidence and records one human verdict — accepted, accepted-with-exceptions, or rejected —
  with a contemporaneous approver, append-only, at ledger schema v4. A run nobody judged reports **unjudged**;
  no coordinator `accepted`, no `verified` framework outcome and no closed status is ever converted into a
  human answer. Acceptance with exceptions requires at least one unresolved item. Portable evidence carries
  the verdict, the unresolved **count** and an approver ordinal — never the prose or a raw approver id.
  This is the 4th milestone's first slice, skipped for nine releases.
- **Delegation now carries the material the user supplied.** A delegated task was an instruction string and
  nothing else, so a teammate asked to check a fact against pasted sources searched the public internet for
  something already in the conversation. Turn-supplied sources travel with the assignment, and a delegate
  that receives an unverified result reports the missing source before widening its reach.
- **The durable conversation is no longer the context-trimmed copy.** The record persisted for a restart was
  the array trimmed to fit the model's context window, so a long session lost its middle turn by turn while
  running and only noticed at restart. The record is now separate from the request history and carries its
  own message and byte bounds. What is sent to a provider is unchanged: the trimming algorithm was correct
  and was not touched.
- **An agent can search its own conversation log.** `search_conversation_log` and `read_conversation_log`
  are bounded, receipted, search-then-read tools over the agent's own Activity log, stating the range read
  against the total. An agent cannot read another agent's log, and an unreadable log is now reported as
  unreadable rather than as unrecoverable.
- **A turn no longer hangs after loading a skill.** The post-tool watchdog is derived from a
  `returnsExternalContent` tool property rather than three hard-coded names, so the next external-content
  tool is covered by existing code. Raw reasoning is no longer rendered to the user as the reply, and a
  stalled turn ends by saying what happened.
- **`no-evidence` no longer means four different things.** A blocking delegation that ran out of time is now
  its own `timed-out` outcome with its own accounting, instead of being indistinguishable from a teammate
  that did nothing.
- **The coordinator no longer spins on a closeout it cannot discharge.** It was told to run a verification
  check in projects that have none configured — an instruction the product itself then refused — and told to
  close out results while the work it was waiting on was still running; a settled delegation's evidence was
  written once and never updated, so the state it was told to clear could not be cleared. Nudges now fire
  only when the coordinator has an action it can actually take, and a passing check observed after an
  acceptance discharges it without rewriting what the framework observed.
- **Generic read permission is no longer authority over turn-supplied content.** Content assets are shared
  across the team as transport; reading one requires an explicit grant carried with this turn or ownership
  by the requesting agent. The refusal says the asset is not available to this agent rather than that it does
  not exist, and a grant does not survive into the next turn.
- **The Agent editor opens readable.** Every section carries its own fold, no fold opens itself, Skills and
  Tools show the selected entries with the rest folded into a full list, model fine-tuning precedes them, and
  double-clicking a team member opens that agent's Workbench conversation.

## [0.9.58] - 2026-08-22

- **Every door that stores a provider key now asks for its price coefficient.** Setting a key from
  Settings, the onboarding wizard, a custom gateway, or an agent-creation prompt previously skipped the
  question that only the command-palette dialog asked — so a discounted key over-reported cost, and a
  replaced key kept showing the previous key's prices and model list. Storage, the coefficient prompt and
  cache invalidation are now one boundary that every interactive door crosses.
- **Sending a stored image to a vision model is its own decision.** An image fetched with approval is held
  as a temporary asset; routing it to a model requires that the exact route is known to support vision and a
  separate approval naming the provider, host, byte count and estimated input cost. Download approval does
  not authorise an upload, and the approved image is used for one request only.
- **A route's vision support is supported, unsupported or unknown — and unknown is refused.** A rejection is
  remembered per route rather than switching vision off everywhere, and an omitted image is stated as
  omitted so a text answer is never mistaken for analysis.
- **Local PDF attachments use the same page-scoped path as public PDFs.** Same signature check, same 10 MB
  ceiling, same read and search tools. The filename never reaches the model, history, or evidence.
- **Video is unsupported and says so.** No decoder, native module, WASM, or first-use download was added;
  every candidate was measured and rejected, and the decision is recorded rather than approximated.
- **User attachments may now be up to 10 MB.** Image and PDF attachments share the same 10 MB temporary
  content-store limit; oversize attachments remain rejected before their bytes can be routed.

## [0.9.57] - 2026-08-22

- **Safe PDF intake is page-scoped.** A public PDF accepted by magic bytes is held only in a temporary
  extension-owned asset store. `fetch_url` returns a receipt; `read_extracted_content` and
  `search_extracted_content` report their exact page coverage. Native text is supported; scanned pages say
  `OCR required / unavailable`; image/video analysis remains unsupported and no download consent authorizes
  a vision or transcription upload.
- **The parser is bounded and isolated.** Mozilla PDF.js runs in a dedicated worker with download, page,
  text, time and heap limits. Raw bytes, URLs, temp paths and extracted text do not enter durable chat state
  or Portable Run Evidence.
- **Portable evidence now records consultation honestly.** Export contains only a document-local content
  ordinal, type, extraction outcome, page range, truncation and OCR state. It cannot carry source URLs,
  queries, asset ids, paths, raw media or extracted text.
- **Activation is lighter and explicit.** Model metadata services construct on use; legacy price-multiplier
  repair occurs only when a user opens Settings or refreshes prices, never during activation.
- **Gateway metadata work is scoped and de-duplicated.** Catalog, price and balance lookups coalesce only
  for the same credentialed connection, have bounded TTLs, re-check permission before serving cache, and
  report fresh/stale/unknown truthfully.
- **Release gates cover real command paths.** The public-source command checker now follows `npm run` chains
  and TypeScript project arguments, including the extension-host E2E suite.

## [0.9.56] - 2026-08-22

**A coordinator's stop is now a stop, and the cost display tells the truth about what a key pays.**

- **`cancel_task` ends a teammate's turn.** A handle stops one assignment, an agent stops one teammate
  whatever it is doing, `all: true` stops the team. Field report: asked to halt everything, a manager
  broadcast a message, said it had sent direct instructions, then correctly admitted it could not enforce
  them. `broadcast` only delivers a message and a running teammate finishes regardless; its own result now
  says so. The machinery already existed — every dispatch has carried a cancel — and was unreachable. Two
  boundaries are structural: a coordinator cannot stop itself, and a solo agent belongs to no team.
- **`Stop All Agents` moved from the overflow menu to the status bar**, shown only while something runs.
- **Exactly one price discount is applied.** A gateway-reported group ratio and a user-stated coefficient
  answer the same question, and applying both answered it twice — 0.33 against 0.33 displayed 0.1089x of
  list. The service now chooses one, preferring the number the user stated.
- **A billing group belongs to the key.** `unode.priceGroup` accepts a map keyed by connection, because two
  keys on one account can sit in different groups with different prices and different callable models.
- **Where several groups exist, the undiscounted rate is shown** rather than the cheapest guess. An
  over-estimate is visible and the first invoice corrects it; an under-estimate takes money without warning.
- **`unode.priceMultiplier` states what the gateway will not send.** UnodeAi asks when you store a key. `0`
  is allowed — a free key costs nothing and that is worth being able to say. An empty box is refused,
  because "I do not know" and "it is free" are opposite ends of the range. Connections that already had a
  key are set to `1` at activation and told so once.
- **Replacing a key invalidates what a key determines.** The model cache is keyed to the credential, and
  storing a key drops the catalogue and re-fetches prices for that connection — previously a new key showed
  the old key's models until a TTL lapsed and its prices until the next day.
- **One content check guards three entrances.** `fetch_url`, `read_file` and chat attachments share a
  sniffer: magic bytes, control characters and a strict UTF-8 decode. The attachment path had a
  binary-detection branch that could never fire, because `Buffer.toString('utf8')` does not throw.
- **The fetch boundary decides before it reads.** Content-Type is classified first, an oversized declared
  `Content-Length` is refused without reading, and the body streams through a reader that cancels at 1 MB.
- **A task scope is refused before it is assigned.** When a delegate's backend cannot enforce a per-turn
  folder boundary, the dispatch is refused with compatible candidates named — never substituted, never
  silently widened. A `superseded` disposition now requires a replacement handle that resolves in the host's
  own receipts.
- **The roster a coordinator reads carries specialty and skills**, merged from both fields role templates
  populate.
- **Delegate mode shows a clock per teammate**, longest wait first.
- **Release hygiene.** A package built from a dirty tree is named `-dirty` and prints its dirty inputs; a
  tag-time gate compares the candidate, the public source drop and the published Open VSX version.

## [0.9.55] - 2026-08-21

**Portable Run Evidence now answers who approved, where work ran, and whether two recorded change sets are
the same — without exporting a machine id, private gateway hostname, or source bytes.**

- **Approvers are durable and bounded.** Human command, write, tool, and web decisions now reach the run
  ledger and internal Markdown pack with their exact actor identity. Portable JSON maps that identity to a
  document-local `approver-1` ordinal. An exercised MCP grant is not a new human decision, so its row has no
  approver; expiry and host disposal do not invent one either. Historical absence remains declared.
- **Routes answer the auditor's destination question.** The internal pack retains the exact connection,
  endpoint, and privacy-domain receipt. The portable builder accepts only exact built-in route tuples or a
  host-generated custom route, emits bounded connection/execution/privacy categories, and withholds custom
  ids, private hostnames, and endpoint-bearing privacy ids.
- **Diff digests are captured at write time.** Each complete delegation can carry a deterministic SHA-256
  root over changed paths plus per-file before/after content hashes. Source and diff bytes are never retained;
  the builder revalidates paths and hashes and recomputes the root. Unobserved content, recursive directory
  deletion, unrecorded writes, and historical runs stay explicitly unavailable.
- **The production-ledger canary is now part of the gate.** A run built through real `RunLedger` methods is
  rendered into both artifacts and walked against the portable schema. The test proves a retained path,
  route category, approver ordinal, and digest survive while planted task prose, source, machine id, agent
  ids, private endpoint, and privacy-domain id do not. It exposed Claude's `restoreDisabledReason` case,
  which now fails closed instead of treating an unknown before-state as a new file.
- Portable JSON advances to `portable-run-evidence/1`; persisted RunRecord v1/v2 data still loads, with
  never-recorded fields truthfully declared unavailable.

- **The answer is marked apart from the work that produced it.** A finished agent reply gets a bordered,
  slightly heavier block; tool cards and reasoning stay where they were. The alternative — folding the
  process behind a "working for Nm Ns" disclosure — buys the same clarity by taking the evidence off screen,
  and the evidence staying on screen is the product. The border is deliberately **not** green: green means
  "the framework observed this and it passed", and a conclusion is a claim an agent made.

- **The roster names its own specialists.** Content Strategist, Frontend Engineer, Product Designer and SEO
  Specialist all carry the runtime role `custom` by design, and `list_agents` reported the id and the role
  and nothing else — so a coordinator saw four identical lines and picked between them blind. It now carries
  the display name, a specialty, the backend, and whether a per-assignment folder scope can be enforced for
  that teammate. The rest of the dispatch work — the hard compatibility gate before dispatch, and binding
  `superseded` to a real re-dispatch — is a later release.

## [0.9.54] - 2026-08-21

**Configure a team once, and a receipt built to leave the building.**

- **Saved teams.** `UnodeAi: Save Team…` writes the current roster to `.unode/teams/<name>.json` and
  `UnodeAi: Open Saved Team…` brings it back. Configuring a crew is real work — edited instructions,
  per-agent model tuning, folder access, MCP grants, attached skills — and switching teams used to remove
  every session and take all of it with them. **Nobody has to remember to save**: whenever you confirm a
  replacement, on the new command and on the Create or Switch Team path you already had, the roster you are
  leaving is snapshotted before anything is removed. Cancelling writes nothing. Ten snapshots are kept and
  **a team you named yourself is never pruned** — deleting something a person named is not a housekeeping
  decision. If the snapshot cannot be written you are asked whether to switch anyway rather than told in a
  log. A saved team is the roster, not the workspace: opening one never replaces your MCP servers or
  workflows.

- **Portable Run Evidence.** `UnodeAi: Export Portable Run Evidence` writes one run as JSON intended for a
  client or an auditor. The existing evidence pack is an internal record — it retains the objective and every
  task instruction, redacted only by credential pattern-matching, and says so. This format inverts the rule:
  **no prose — nothing a user or a model composed as text.** That is what makes the exclusions testable
  rather than aspirational: a redactor has to recognise a secret to remove it, and a format carrying no
  composed text has nothing to recognise. **Agents appear as `agent-1`, `agent-2`** rather than under the
  names you gave them, because a configured agent id is a name a person chose and can name a client or a
  deal; a role rides along only when it is one of the shipped role names. A file path survives only when
  every segment of it is plainly relative; anything else is dropped and counted, so the artifact reports how
  many paths it could not carry instead of inventing a rewritten one. **What it keeps is declared as well as
  what it withheld** — changed-file paths and timestamps, listed in the file's own `retained` section,
  because "no prose" is a claim strong enough to stop someone checking before they attach it.

- **One export entry.** `UnodeAi: Export…` names what each artifact contains and is the way in; the
  internal-evidence exports are no longer loose in the palette where they were picked by mistake. Export Chat
  stays where it was — a habit is not a mistake.

- **Model tuning opens closed.** Fourteen advanced knobs at working defaults spent a first user's attention
  on decisions they did not have to make. The card now opens on a state line plus the two controls that are
  genuinely reached for — reasoning effort and the context window, the one value here whose being wrong
  produces a visible failure. Everything else is one disclosure away.

- **Roles are named in plain words.** The picker no longer needs a glossary.

- **Upgrading in place: reload the window once.** Activity moved from the bottom panel into the sidebar,
  and VS Code remembers a view's state per container. An upgraded window can therefore show the Activity
  view empty until it is reloaded — nothing is lost, and a reload is the whole fix. Reported from the field
  before release rather than after it.

- **One name per surface.** Workbench is the editor surface, Chat is the transcript and the compact sidebar
  entrance, Dashboard is the data view — "Mission Control" is retired. The sidebar reads Team, Activity,
  Chat, and the Team panel's entrance button is gone: it held a row of its own in a container with three
  views, and **Open Workbench** is a pinned title-bar icon instead. No command id changed, so existing
  keybindings still work.

- **A saved team can be deleted from the list it appears in** — a trash icon on each row of Open Saved Team,
  with a modal that names the team, since it removes the file and there is no undo. The list rebuilds rather
  than closing, because clearing out several old snapshots is one intention. There is no separate delete
  command: this list is the only place a saved team is ever visible, and sending someone to a second list to
  act on what they are already looking at is the thing this release spent its UX pass removing.

- **Save Team and Open Saved Team are in the Team panel's actions menu**, directly under Create or Switch
  Team — which is where you are standing when you learn a roster can be replaced. They are not pinned as an
  eighth title-bar icon: on a narrow sidebar VS Code pushes the overflow into an unlabelled `...`, so pinning
  one more would have made it less findable, not more.

- **The main interface has one name and one entry per job.** The duplicate Messages view is gone;
  the sidebar **Activity** view is the single entry, and the old `unode.showMessageLog` command id now focuses it so
  existing keybindings keep working. Team has one **New Task** button instead of two buttons that ran the same
  command. The Workbench replaces six emoji actions with one labelled session menu that supports arrow keys,
  Enter/Space, Escape with focus return, and click-outside dismissal. Its repeated context strip is gone; the
  always-visible meter and Compact control remain beside the composer. **Workbench** names the editor surface,
  **New Task** starts work, **Chat** names a transcript, and **Dashboard** replaces the retired Mission Control
  label. Command ids are unchanged.

- **`Generate Evidence Report` asks where to put the file.** It used to open an untitled document, leaving
  the save to VS Code's untitled flow — which proposes the first line as the file name and produced
  `# Evidence Report — UnodeAi — latest run.md`, a leading `#` that needs escaping in every shell. It now
  offers a folder and a plain name first, then opens what it wrote. Declining the dialog still shows the
  report unsaved.

- **Nine more MCP servers** — Playwright, Context7, Figma, Sentry, Notion, Firecrawl, Tavily and Exa among
  them — every package name checked against the registry before listing, and one candidate rejected because
  it described itself as a security-research canary. Two layout defects are fixed: a marketplace card no
  longer overflows on a long URL, and a capability note no longer renders a full sentence inside a
  15-pixel badge.

## [0.9.53] - 2026-08-16

**Two teams for work that is not code, and the receipt moved to the front page.**

- **A Contract & Compliance team that stops where a person with authority must decide.** The catalogue
  already carried GRC, privacy and procurement analysts; what it had nowhere was a role that reads the
  agreement itself. The new Contract Analyst records a quoted source span for every extracted field and
  writes `not found` rather than inferring a value from a similar contract, and its redlines trace each
  proposed change to the playbook rule behind it — drafts addressed to your own side, never
  counterparty-ready text. The privacy and GRC seats stay read-only: no write, no shell, no delegation.
  **Sanctions, export-control and licensing questions are refused rather than answered**: the agent gathers
  the parties, the item, the destination and the end use, states the question, and routes it to a named
  human owner. A screening result an agent produced would be relied on as a clearance, and a wrong one is a
  criminal-liability exposure. Claims about what the law requires must cite primary authority, and a
  citation not retrieved in the session is marked `not verified this session`.

- **A Website Design & Development team.** Product designer, frontend engineer, content strategist, SEO
  specialist and QA. The designer names the token or component that already exists instead of introducing a
  literal, and specifies every interactive state including loading, error and empty. The frontend engineer
  reviews at the breakpoints the project actually declares — and at their boundaries, where defects cluster.
  The pre-launch SEO audit covers crawlability, canonicals, structured data and redirect integrity, and
  reports mechanics only: it never predicts a ranking, which is not something an audit can observe.

- **Nine new skills, six of them filling gaps a market review named explicitly** rather than gaps we guessed
  at. UnodeAi's SKILL.md frontmatter already matched the agentskills.io open standard, so these are portable
  to any compatible agent; nothing was copied from another catalogue.

- **Two roles stopped being distinguished by wording alone.** A privacy officer and a GRC analyst, and a
  frontend and a mobile engineer, had identical capabilities and differed only in their prompts — recorded
  in the code as a deliberate compromise. Both pairs now differ in the playbooks they run, and the
  compromise list is empty.

- **Compact is an icon** in the composer, a square button matching the ones beside it, with the context
  meter reading immediately to its left and a full sentence as its accessible name.

- **The front page leads with the difference.** README, the Marketplace description and the wiki now open on
  the same sentence: most AI coding tools ask you to trust the answer; UnodeAi hands you the receipt. No new
  claim — every line names something already shipped and documented further down.

## [0.9.52] - 2026-08-12

**A coordinator finishes what it starts, or says why it cannot — and no longer waits inside a tool call.**

- **A coordinator can end work it cannot finish, and always ends it.** `close_assignment` takes `complete`,
  `partial`, or `blocked`; `partial` and `blocked` require one entry per undelivered item with a concrete
  reason, and `complete` is refused while a settled delegation still has no recorded decision. The
  disposition vocabulary covered only a delegate's returned RESULT — nine outcomes, every one about a task
  that came back — so a coordinator handed an impossible or under-specified job had no terminal state and
  simply stopped. From the user's side that is indistinguishable from a coordinator that quit thinking.
  When an assignment ends with no conclusion the host writes one, on every backend that runs a coordinator.
  It is labelled as UnodeAi's text rather than the coordinator's, carries only what the host observed, and
  states plainly that it makes no claim about whether the work is correct — the host cannot see that, and a
  sentence implying it could would be worse than the silence it replaces.

- **A coordinator can no longer wait inside a delegation call.** `dispatch_task` returns immediately and
  `collect_ready_tasks` never waits; a settled result opens a later coordinator turn. The blocking pair
  remains callable for compatibility but is no longer offered to the model at all, because a tool a model
  may decline to select is guidance, not a mechanism. The number of results waiting behind a running turn is
  now rendered instead of leaving an unlabelled spinner.

- **A CLI that is wedged but still talking is now caught.** The Claude idle watchdog reset on any
  host-observed byte, so reasoning and status chatter kept a stuck turn alive indefinitely and the 15-minute
  limit only ever applied to total silence. It now counts material output — parsed assistant text, tool use,
  tool results — and nothing else.

- **Worker progress is measured before anything is enforced.** `UnodeAi: Export Worker Progress Distribution`
  reports per-cohort quantiles and buckets, never a mean, and refuses to support a threshold from fewer than
  8 records per cohort. A verdict computed from one record per cohort is arithmetically guaranteed not to
  overlap; that is a coincidence wearing a statistical label, and it would have been believed.

- **A passive sensor for the disappearing reply.** Two team rounds failed to catch the fault because both
  needed it to occur while a human watched. The webview now notices when something it rendered is absent
  from a later state push and reports the surrounding facts itself. A routine window trim is classified as
  such and only counted; a middle gap, vanished tail, or reordered item is retained as unexplained. It
  changes nothing about what is rendered.

## [0.9.51] - 2026-08-11

**A control that cannot say anything must still say why.**

- **The Compact control was reported missing, and it was not missing.** It rendered as a bare pill with its
  label blanked. Two defects stacked. The `hidden` attribute never worked on it: an author `display` rule in
  the composer's own stylesheet outranks the browser's `[hidden] { display: none }`, so the line meant to
  hide it had no effect on visibility at all. And "no number" had two unrelated causes — the agent has not
  been started, and the runtime owns its own context — that the composer rendered identically as blank. The
  meter now says which: `Context — start the agent`, or `Context — managed by the runtime` for Claude and
  Codex agents, whose CLI holds the context UnodeAi cannot measure or compact. Hiding is a class, at the same
  cascade origin as the rule that defeated the attribute.

- **The meter and the action no longer contradict each other about one agent.** Asking to compact an
  unstarted agent answered "this backend manages its own context" while the meter beside it said "start the
  agent". `compactSession` had collapsed three unrelated conditions into one `supported: false` and every
  caller rendered the same one. Both surfaces now derive their sentence from one runtime fact through one
  pure function, because the wrong sentence was chosen in a branch no test could reach.

- **`UnodeAi: Compact Context`** performs the same action from the Command Palette, so it can be bound to a
  key — and remains reachable when the pill is legitimately absent.

- **The per-turn context receipt states its own scope.** It read `Context: N sources · ~9,147 text tokens`
  beside a gateway rejecting that same turn as too large. Both numbers were right: the receipt counts the
  attached sources and never the conversation, the system prompt, or the tool definitions. It now reads
  `Attached context … (estimate, attached sources only)` and names what it leaves out. The measurement did
  not change; an instrument that did not state its scope looked like a lie next to an error.

## [0.9.50] - 2026-08-10

**Stopping is a mechanism, and the context you are spending is a number you can see.**

- **A gateway rejecting an oversized turn is no longer retried, and no longer silent about why.** A field
  report showed `HTTP 502 — "Your input exceeds the context window of this model."` Overflow was recognised
  only behind `HTTP 400|422`, and the vocabulary did not contain the words *context window* — so the most
  common phrasing of the most common cause matched nothing, a 5xx was classified retryable, and the same
  oversized body was resent three more times and billed each time. Overflow is now recognised at any status,
  never retried, and the error names the window UnodeAi assumed and what to set if that assumption is wrong.

- **Compact now works in the case it exists for.** Automatic compaction is gated on a threshold derived
  from the *assumed* context window — so on the one conversation a gateway is already rejecting as too
  large, the threshold has not tripped and a threshold-gated compaction plans nothing. A user pressing
  Compact **is** the trigger, and no longer has to satisfy a number already known to be wrong. It also
  reports what it actually dropped: a control that says "compacted" while dropping nothing is worse than
  one that refuses, because the user stops looking for the real problem.

- **The composer shows how full the context is, and the same control empties it.** Compaction always
  existed; what was missing was any way to see the number it measures against. That number is an
  *assumption* — the agent's Context window setting, not a value read from the provider — which is exactly
  why showing it matters: a user who can see "86% of 1,048,576" can tell at a glance it is wrong for their
  model, and a user who cannot only finds out when a turn is rejected. Click to compact older turns into a
  rolling summary now; recent messages are untouched. On a backend that manages its own context, the button
  says so rather than doing nothing.

- **A rejection teaches the agent its own ceiling, so the same conversation stops failing in the same
  place.** Recovery without this was manual and permanent: the guard kept deriving its threshold from a
  number the gateway had already disproved, automatic compaction never fired, and the user pressed Compact
  by hand every turn. A refusal for size is proof the model accepts less than was sent — so that size is now
  recorded as the model's ceiling, applied to the live session immediately, saved with the agent roster so
  it survives a reload (and carried into `.unode/team.json` whenever the team file is written), and shown in
  the composer as `provider-refused`. A ceiling only ever tightens, is bound to the exact model
  that produced it, and loses outright to a Context window you set yourself. Three cases deliberately record
  nothing and say which applies: your explicit setting stands (lower it), the limit is no tighter than one
  already known, or the conversation is too small to explain the rejection — meaning the system prompt, tool
  definitions, or attached project knowledge are carrying the weight and compacting history cannot shrink
  them. Recording a ceiling that history cannot explain would summarise on every turn, cost money, and still
  not make the request fit.

- **Context-window discovery is consented and never starts at activation.** When you open the model picker,
  UnodeAi may read `context_length`, `max_context_length`, or `context_window` from that gateway's already
  consented `/models` response, including nested variants. It never sends a separate probe, never prefetches,
  and never replaces a value you typed. The composer labels the denominator `measured`, `configured`, or
  `assumed`; missing metadata is normal and leaves the disclosed 1,048,576-token assumption in place.

## [0.9.49] - 2026-08-09

**A run has a beginning and an end, it records what happened inside it, and its evidence can travel.**

- **Fixed: streamed text could flash and disappear when the next PM turn started first.** A teammate result
  can wake a coordinator while its preceding streamed reply is still arriving. The new turn's epoch then made
  the old final reply stale; clearing the live tail at that boundary erased the only rendered copy. The panel
  now commits the live text before accepting the newer turn, so an ordering race cannot silently discard what
  the user just watched arrive.

- **Fixed: a streamed reply that went silent hung the turn forever.** The request timeout was cancelled
  before a byte of the response body was read — its `finally` ran when the stream handle was returned, so the
  budget only ever covered the wait for headers. The stream iterator then had no deadline of its own, and its
  only abort check ran *between* reads, so it could never interrupt the read already in flight. A gateway that
  answered `200` and then wedged left the agent showing "Thinking..." with nothing able to end it. The body
  phase now has its own budget: a full wait for the first chunk, a shorter one for silence between chunks, and
  the pending read is raced against it. A slow generation is still allowed to be slow — silence is what ends a
  turn, not duration. The stream is **aborted** rather than abandoned, because a stream nobody tears down
  leaves the provider generating, and billing, output that can never arrive.

- **Fixed: a completed reply could vanish the moment it finished.** A turn's streamed text was discarded
  when a later turn began. The session starts a new turn whenever any message reaches it — a delegate's
  result waking a project manager is enough — so the new turn's first event routinely arrived while the
  previous one was still streaming. The rendered text was cleared and nothing was appended, and the finished
  reply then arrived stamped with the older turn and was refused, so nothing put it back. It presented as
  output printing line by line and then vanishing in a flash, with the agent still able to read its own
  message. Streamed text is now committed to the transcript before the turn advances.

- **Fixed: a re-sent message vanished with no trace.** When a coordinator sent the same text again — because
  the user could not see it the first time — the Chat panel compared it against the previous message by text
  alone and discarded it: nothing rendered, nothing persisted, no notice. The comparison exists for a real
  reason, since some gateways emit a completed reply twice, but repeating text in a *later turn* is a
  deliberate second statement, not that. The turn is now part of the identity: the same text in the same turn
  is still suppressed, and the same text in a new turn is a new message. **This was one of three mechanisms
  that can make a completed reply disappear from the panel**; the other two are recorded, with what is and
  is not established about each, in the finding this release opens.

- **Two ceilings, because they catch different failures.** The idle timeout above bounds a *dead* stream. A
  gateway that emits one token every few seconds forever passes every idle check and still never returns an
  answer, so a streamed response now also has an end-to-end ceiling. Separately, a per-attempt timeout was
  never a bound on a request: the worst case is `timeout x (retries + 1)` plus backoff, which at the shipped
  defaults is over eight minutes of an apparent hang before any failure is reported. That product is now
  bounded by a total request budget rather than left as arithmetic nobody had done. Scope, stated honestly:
  the retry chain has exactly one caller — the non-streaming path — because the streaming path has no
  transient-failure retry at all, so the multiplied wait was never reachable where production runs.

- **Fixed: a search could stop early and report a clean absence.** `search_files` has two limits and only one
  of them was disclosed. `max_results` said "(capped at N)"; the 8,000-file scan budget said nothing, so a
  walk that ran out of budget returned "No matches" — an assertion of absence the scan never established. The
  result now states whether the whole scope was scanned, and says so on the same line as the answer. A
  completed scan says it completed, so an agent can stop searching instead of re-running the same query with
  a synonym; the tool description now says that too.

- **R/X - run-scoped evidence.** The coordinator's first real dispatch opens a durable run; every retained
  message, context receipt, and permission event must carry its host-observed correlation, so a reused PM or
  worker cannot leak another task into the pack. Its correlated closeout closes it only after every delegated
  task has settled. An unfinished coordinator leaves an explicit open run across extension-host restarts.
  `UnodeAi: Export Run Evidence Pack` writes a standalone Markdown account of one selected run, including
  dispatches and refusals, observed evidence, append-only coordinator dispositions, temporary task scope,
  approvals, context-source receipts, and mechanically derived dispatch/settlement/refusal/disposition counts.
  Its activity-excerpt completeness is measured against that run, not against the rolling Messages view.

- **Evidence boundary.** The pack states omissions, distinguishes coordinator acceptance from human or
  customer acceptance, keeps `no-evidence` and `replied-not-verified` verdicts visible even when accepted,
  and does not ask a model to judge correctness. Raw approved commands, context contents, and credential
  values are excluded; known secret forms in retained summaries are mechanically redacted.

- **Fixture portability.** The P2 project-knowledge fixture now has a regression that proves its
  `.unode/rules.md` input is tracked by Git. A result is bound to the inputs its runner receives, rather
  than a local ignored file that happened to exist on one machine.

## [0.9.48] - 2026-08-09

**Sources declare what they are, command authority narrows to a single agent, and a coordinator that stops
mid-closeout is moved on.**

- **S — filesystem facts on every context source, not freshness or secrecy judgements.** Each file-backed
  source in the per-turn context receipt now reports how long since it changed — with a visible note at 90
  whole days or older — and whether a mechanical signal suggests it may be sensitive. The staleness label is
  a modification time, not a claim that the file is wrong: stable, correct guidance stays correct at any age,
  and a fresh checkout can reset timestamps. The sensitivity label unions secret-pattern matches,
  conventional paths, owner-only file mode, and `.gitignore` membership; it is not a classifier, no model
  reads the file, and matched content never enters the panel. The signal is tuned to miss less rather than
  warn less, because a source that quietly carries credentials into model context costs more than an
  inspection. Both fields are report-only — nothing is blocked, redacted, or granted from them.

- **C — per-agent command narrowing that cannot widen.** An individual agent can now be restricted to a
  subset of the workspace command allowlist, chosen as *Inherit global* or *Restrict to selected*. The editor
  offers a checklist built from the live global allowlist rather than a free-text field, which makes an
  attempted widening unrepresentable instead of merely rejected. Every saved selection is re-intersected with
  the current global allowlist at check time, after the global policy has applied its hard denials, so
  shrinking the global list cannot leave a stale agent entry behind as a grant. An empty restricted list means
  that agent runs no commands, and is kept distinct from inheriting.

- **E — the coordinator's real vocabulary, and both directions of the evidence error.** 0.9.47 shipped three
  dispositions; one round of real use produced nine distinguishable outcomes, so all nine are now recorded
  rather than rounded to the nearest of three. `needs-rework` is its own state, not a flag on `rejected`:
  one says the coordinator will not rely on the result, the other says the loop continues and sends its
  required reason back to the same delegate. A refused dispatch has no result and no settled handle, so it is
  kept as a separate `rejected-at-dispatch` receipt rather than forced into a disposition it cannot honestly
  carry, with dispatch attempts, dispatched work, and refusals reported separately.

- **E — under-crediting is counted for the first time.** The framework already reported how often a green
  verdict was later rejected. It now also reports how often a `no-evidence` or `replied-not-verified`
  result was accepted anyway. A correct answer built from context already returned in the session and a worker
  that did nothing and guessed leave the same empty trace; they are not mechanically distinguishable from the
  evidence retained here, and separating them would mean inspecting prose or asking a model to judge it —
  the self-grading this evidence model exists to exclude. The counter measures how often the distinction
  mattered instead of choosing a story about why the trace was empty.

- **E — the closeout continuation now fires on the state that actually stalled.** A coordinator that settles
  work and then stops before disposing or gating it is continued, on both the OpenAI-compatible and Claude
  paths, which previously differed. The trigger covers a settled result with no recorded disposition **and**
  an accepted result carrying recorded file changes with no observed passing check — the second was the
  state a field round actually produced, and the earlier trigger could not see it. Widening is bounded by
  construction: the second term requires a recorded change or unrecorded write with no passing verification,
  so a read-only acceptance can never arm it. It remains a continuation and not a lock, capped at two per
  turn, overridable, and no final response is refused because the counter ran out.

- **Store metadata.** The `Programming Languages` category is removed. The extension contributes no
  language, and a category that does not match behaviour is a claim we cannot support.

## [0.9.47] - 2026-08-09

**Coordinator decisions and project knowledge are now visible at their real boundaries.**

- **D — explicit coordinator disposition, not self-grading:** after a settled delegation, the coordinator may
  record `accepted`, `rejected`, or `needs-human`; a result arriving does not force a ceremonial label. The
  decision is never inferred from a delegate reply and no LLM judges whether prose delivered work. Rejections
  and human handoffs require a reason; a rejection forwards it to the delegate. A later rejection visibly
  amends the prior framework verdict in Chat, Messages, and the Team card rather than rewriting history.
- **D — bounded claim for the new counter:** current-session metrics report completed delegations, explicit
  coordinator acceptances, green framework verdicts later rejected, and explicit human-intervention requests.
  `coordinator-accepted` is deliberately not enterprise/customer acceptance: the coordinator is an agent and
  this release does not create a human acceptance layer. The v0.9.46 Job 2 field question remains open, and
  N4 remains a mechanism proof rather than a field-performance claim.
- **P — progressive project knowledge:** the fixed `AGENTS.md`, `CLAUDE.md`, `.unode/rules.md` precedence is
  unchanged, while the standing prompt now carries deterministic L1 heading/excerpt indexes. Structured
  Markdown under `docs/` is indexed rather than copied wholesale. Relevant full files remain available with
  the existing root-confined `read_file` tool; neither an index nor a document changes tool authority.
- **P2 — a real, no-spend two-arm witness:** the controlled full versus progressive assembly probe ran both
  installed arms over the same fixture: 24/24 Tier 1 records passed, full context was 2,455 bytes and
  progressive context was 1,812 bytes (delta −643; arms differ). It made no model call, so quality,
  per-provider-turn tokens, task tokens, and task cost are **null**, not a claimed saving. Tier 2
  authorization remains unspent; a smaller standing prompt may still increase total task cost through
  on-demand reads.
- **Release discipline — standing rule 17:** adding a release-chain step now requires a check in every
  shipping context that runs or distributes that chain, including the public allowlisted source drop. A
  fail-closed allowlist can silently omit a required file; that omission must be tested where the chain runs.

## [0.9.46] - 2026-08-08

**Delegation evidence and tool capability boundaries are now mechanical, explicit, and regression-gated.**

- **T4/T7 — evidence is not delivery:** an empty tool-active completion remains `no-evidence`; a non-empty
  read-only completion is now `tool-activity-recorded` — explicitly “delivery not checked,” not green
  `verified`. Only recorded writes with a passing observed check are verified. The named F2 field-payload
  regression and mutation gate prevent the former returnedNothing-only green fall-through without asking an
  LLM to decide whether prose “really delivered” work.
- **T1 — explicit edit tool dialect:** CapabilityProfile adds an edit-dialect fact with declared,
  observed, and user-override provenance. OpenAI-compatible agents advertise either the legacy
  exact-snippet `apply_edit` surface or the selected patch-shaped `apply_patch` surface. The controlled
  P1 A/B probe changes the real advertised surface and reports a raw 1/1 difference only as mechanism
  reachability, not a model-quality or statistical claim. The native command description now names the
  backend's Windows `cmd.exe` dialect.
- **T2 — descriptions are checked contracts:** all built-in tool descriptions were narrowed to their
  actual roots, approvals, team scope, and public-web limits. `fetch_url` now says it is anonymous,
  carries no configured credentials, and cannot test authentication; `check:tool-descriptions` plus its
  named pre-v0.9.46 mutation make a regression fail mechanically.
- **T5/T9/T10 — coordinator mechanics:** stopped turns free a live delegation slot (mechanism proof; no
  field concurrency claim); an overlapping re-dispatch now names its in-flight handle, owner, and task at
  the dispatch decision point; and mounted sidebar/Workbench state receives changed `task.status` card
  activity rather than relying on a render-key-only assertion.
- **T11/T12 — honest activity evidence:** Messages exports declare the 300-item retained-window truncation
  and omitted count instead of silently looking complete; the cap was not raised without a host-memory
  measurement. Temporary task scope appears directly on Chat and Messages delegation rows.
- **T6 — no phrase-level authority guessing:** a request that merely mentions a command is no longer
  inferred to require shell capability. The explicit negative conclusion is recorded: natural-language
  phrase inference is not reliable enough to confer authority.

## [0.9.45] - 2026-08-07

**Delegation can now narrow a task without changing the agent that performs it, while declined sends and
long waits keep their state visible.**

- **Task-scoped Folder Access:** `assign_task` and `assign_task_async` accept an explicit, temporary
  folder scope. The extension host resolves a real-path intersection with the delegate's configured
  Folder Access, never a replacement or union. It resets the OpenAI-compatible tool roots on every turn;
  a read-only scope removes write and shell tools. Scoped dispatches for backends that cannot enforce that
  turn-local boundary fail closed with a reason, and the delegation card identifies the temporary scope
  while active and after it ends. Task wording is intentionally never used to infer a scope.
- **No Agent Builder churn for one-off audits:** a PM can dispatch multiple normally write-capable agents
  under explicit read-only task scopes. The tested path leaves their saved configuration unchanged and
  returns a scope refusal to the coordinator rather than a generic failure.
- **Composer delivery acknowledgement:** the webview keeps a draft until the host accepts it. Empty,
  unknown-agent, and other refused sends retain their text and show a reason; the host records the
  rejection clause and both agent identifiers. A stale but known explicit agent selection is accepted
  rather than silently discarded.
- **Earned delegation extension:** the host emits a periodic `task.status` heartbeat only after observed
  tool work. TeamTools renews a blocking window only for the host-authored tool-observation marker, never
  for prose or a bare heartbeat, and enforces a three-window absolute cap. The existing late-result handle
  remains available through `await_tasks` after a timeout.

## [0.9.44] - 2026-08-06

**Approval friction is visible and revocable, while team instructions and the streaming transcript carry less ambiguity.**

- **Explicit safe-command activation:** `unode.allowedCommands` now starts empty. When a command matches
  the reviewed safe templates, its normal approval card offers **Enable safe commands**; choosing it writes
  the visible workspace setting and explains how to remove entries. The review list adds only `git ls-files`,
  `echo`, `hostname`, and `whoami`; arbitrary-code and history-mutating commands remain gated. Task history
  now records real approval wait time and denials, and the Dashboard exposes both values.
- **Team rules and status:** `.unode/rules.md` retains user-authored text and gains a plainly delimited,
  generated roster block that refreshes on team and role changes. It lists only each role and a one-line duty
  because the file is attached to every agent turn. The Message Log now renders the existing **Verified**
  text with the transcript's green token, so colour is supplementary rather than the only status signal.
- **Streaming redraw repair:** paced transcript updates preserve settled live blocks and replace only the
  growing tail. A regression test proves a tail update no longer starts its DOM replacement at block zero.
- **Delegation boundaries are now explicit:** a blocking `assign_task` timeout names the wait window that
  just expired (for example, `300s`) rather than leaving the coordinator to infer it by failure. A result
  that had already settled but was still waiting for `await_tasks` now survives an extension-host resume;
  live worker execution is not claimed to resume. The new measured B4 Lab task covers that exact boundary.
- **Read-only review:** `docs/CODEX_REVIEW_v0944.md` records the thin-log reasoning, session-scope audit,
  and Claude prompt-competition findings. No prompt instruction was removed and no new security-audit claim
  is made.

## [0.9.43] - 2026-08-06

**Turn context is now inspectable, and delegated work no longer has to masquerade as completion while it is still in progress.**

- **Context manifest:** every delivered turn now carries a compact, expandable record of its known context
  sources: current task, repository instructions, project conventions, shared memory, granted skill
  summaries, explicit `@` context, user attachments, and workspace orientation. The card says how many
  sources and the byte-derived text-token estimate up front; its breakdown names each source's origin and
  admission rule. Image token estimates, staleness, and sensitivity are explicitly unavailable/unpopulated
  rather than invented. This is read-only instrumentation: it does not change what loads. The runbook
  records the Tier 1 instruction-context baseline for the upcoming progressive-disclosure comparison.
- **Progress and Solo routing:** a worker now emits a distinct `task.status` activity update when it begins
  and when the framework observes a tool use. Roster, rail, and delegation cards show that activity while
  completion remains reserved for an actually finished turn; the focused mutation test proves the old
  false-completion event fails. A deliberately narrow, explicit one-file PM request offers a one-click,
  non-blocking user handoff to Solo. Solo remains outside the delegation roster, and ambiguous work stays
  with the PM instead of receiving a noisy suggestion.
- **Hygiene:** removed an obsolete bundled VSIX from the maintained checkout. The one existing stash was
  examined and retained as a named pre-v0.9.26 Claude permission/deny-list experiment; its 11-file contents
  are recorded in the release runbook rather than left unexplained.

## [0.9.42] - 2026-08-05

**The capability-profile milestone is accepted by its evidence, and its temporary predecessor branch is gone on schedule.**

- **Named deletion deadline honoured.** The `legacy-protocol-selection` branch, its controlled demo, and
  its comparison fixtures are removed after the recorded 22-invocation zero-delta comparison. The A/B
  implementation-axis mechanism remains, but only `capability-profile` is installed; it rejects an
  identical two-arm comparison until a future, time-bounded alternative is explicitly registered.
- **Capability profile milestone closed honestly.** Protocol, sampling compatibility, recovery, and
  context-window policy are profile facts with declared/observed/user-override provenance. The reviewed
  `sanitizeModelParams` and `sanitizeContextWindow` functions intentionally remain input validation for
  Settings and untrusted webview values, including bounds and prototype-key filtering; they are not model
  capability facts. Session observations still require a human-approved proposal before persistence.
- **OpenAI's owner-selected tier defaults are now `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`.**
  Their IDs were verified to resolve on the gateway. No verified rate is available in the static price
  snapshot, so the picker and Agent Builder explicitly show `price unavailable (no verified rate)` rather
  than borrowing `gpt-5` pricing or silently presenting an empty cost. A provider-scoped live price still
  takes precedence when published. This is a provider-family decision, not a pass-rate re-ranking claim.
- **Release rigor is now reusable.** New instruction-only skills record the project practice for a named
  product mutation that goes red then green, and for three-way canonical-artifact hash verification before
  publishing.

## [0.9.41] - 2026-08-05

**The Harness Lab can now compare a refactor against its predecessor, and every Tier 1 task exercises product code.**

- **New: a bounded implementation-selection axis.** `HarnessLabConfiguration` can temporarily select the
  pre-profile protocol selector or the capability-profile selector. A controlled offline self-test proves
  the axis can reach different product paths; the legacy branch is explicitly scheduled for deletion in
  v0.9.42 and is never persisted as an agent setting.
- **The v0.9.40 comparison is now real.** The deterministic, interleaved 22-invocation Tier 1 run applies
  the implementation axis to E1/E2 and records 11/11 passes on each arm, every per-task delta at `0.00`.
  That zero is a pass: it now demonstrates preserved behaviour rather than a guaranteed same-path result.
- **E1 is measured, not scripted.** An injected gateway-shaped 400 drives the real
  `OpenAICompatBackend` recovery through `SessionManager`; the retry is observed without `temperature` or
  `top_p`. The Lab is now `measured: 11 / scripted: 0`, and a recorded product mutation makes E1 fail.
- **Post-comparison cleanup.** The dead `xmlPreferredModels` compatibility facade and stale test are
  removed. The declared protocol seed remains in the capability profile; only the explicitly time-bounded
  comparison branch retains predecessor logic.
- **Role defaults no longer carry dated Claude deployment ids.** Every role template and the new-agent
  builder use shared `sonnet` or `opus` family aliases when a custom or dynamic gateway has no tier
  mapping. A guard scans all templates for date-pinned model ids, and its deliberate mutation proves the
  guard fails when one is reintroduced.
- **Tier ids were refreshed without re-ranking models.** The affected premium and OpenRouter entries now
  name their current generation; the change does not treat the baseline's noise-level pass-rate spread as
  a quality signal.

## [0.9.40] — 2026-08-04

**Capability profiles are now inspectable facts, and the Harness Lab has measured the refactor without inventing an improvement.**

- **New: one capability profile per connection × model.** Protocol behaviour, sampling-parameter
  compatibility, context-window policy, and recovery behaviour each show their provenance as
  `user-override`, `observed`, or `declared`, with that precedence fixed in the product.
- **Session observations stay session-local.** A gateway sampling rejection or a text-form native tool
  call changes only the running backend's overlay. The host can expose an approval-required proposal, but
  it never silently rewrites a saved connection or model fact.
- **Settings now explains capability evidence.** Each configured agent's Model Tuning card has a
  Capability profile disclosure that shows the effective source and every declared, observed, or
  user-selected fact. An observed timestamp is visible; the panel explicitly says observations are not
  saved automatically.
- **E2 is measured, not scripted.** The Tier 1 Lab now drives the real `SessionManager` and
  `OpenAICompatBackend` through an injected gateway-shaped fetch mock. It proves a leaked text tool call
  and the XML latch on the next session turn without opening a listener, contacting a gateway, or using a
  real credential. The v0.9.40 A/B run reports 11/11 passes per arm and a `0.00` delta: preserving
  behaviour is the successful result for this refactor.

## [0.9.39] — 2026-08-04

**Harness Lab is complete: future harness changes can now be compared, rather than explained after the fact.**

- **New: `npm run lab:ab`.** Two named JSON configuration arms run in paired AB/BA order and emit the
  order, applied axes, raw per-task counts, and `right - left` pass-rate delta. One observed result moves
  an arm by `1/N`; the report deliberately makes no confidence claim beyond its counts. Tier 1 runs in CI
  against two identical controls. Tier 2 requires both explicit `--route` values and `--n`, so merely
  installing or invoking the ordinary Lab never spends model budget.
- **A2 now reports what the baseline actually found.** The structured `OUTCOME: blocked` claim is its
  primary false-completion result; tool use, file effects, and evidence are a separate instruction-
  following observation. Tier 2 summaries now show blocked/completed/unknown claims, false-completion
  rate, and no-tools-follow rate independently.
- **A4 now measures three-source reading, not a guessed reply shape.** Its task contract explicitly
  states a bounded `ANSWER:` line, and the sensor extracts that field so explanatory prose no longer
  creates a false failure. The retained v0.9.38 fixture and a controlled self-test show the predictable
  `0 → 1` sensor direction without invoking a model or rewriting the baseline.
- **The Lab's boundary is explicit.** Existing `toolProtocol`, tool/command allowlists, timeout, and
  explicit prompt appendix settings are data supplied to an A/B arm. A separate hypothetical tool dialect
  is not invented; the product's native/XML protocol is the dialect control that exists. E1/E2 remain
  `scripted` until a versioned gateway-shape mock can exercise the real recovery paths.

## [0.9.38] — 2026-08-04

**The Harness Lab produced its first baseline.**

- **B1/B2/B3 are measured, not scripted.** The delegation trio now runs through the real `TeamTools` →
  `MessageBus` → `SessionManager` chain with scripted backends on both sides and an injected blocking
  window, so `npm run lab` reports **measured 9 / scripted 2**. The v0.9.34 async-wake fix is covered by
  the instrument for the first time: re-introducing that defect turns B2 red, and independently softening
  the rendered delegation verdict turns B1 and B2 red. E1/E2 remain honestly `scripted` until a
  gateway-shape mock exists — their deferral is recorded rather than papered over with constants.
- **New: `npm run lab:tier2 -- --route <connection>:<model> --n <N>`.** Runs the four real-model tasks on
  routes you name, in the same per-run isolation as Tier 1. It **spends nothing unless explicitly
  invoked**, refuses an empty invocation without touching a backend, and stays out of CI.
- **The first baseline is committed with its raw records**: nine routes, 340 real-model runs, on the
  shipped harness with **no per-model tuning**, because a baseline must be of the harness as users get it.
  Its central result: **not one run of any model on any route claimed an impossible task was finished** —
  a false-completion rate of 0.00, measured across two independent matrices. The registered prediction
  that cheaper models would over-claim more than a frontier model is falsified. All nine routes score 1.0
  on the test-gated multi-file refactor.
- **The baseline documents two defects in its own tasks** instead of reporting them as model findings: one
  task never states the answer format it string-matches against, and another vetoes on an instruction it
  was not built to measure, hiding the false-completion result it did find. Both are scheduled for repair;
  the numbers stand as what the instrument actually said.
- **Fixed: a real backend could crash the runner at teardown.** A live subprocess can still hold the
  workspace open when its turn ends; Windows returned `EBUSY` and the whole matrix died, losing completed
  records. Cleanup now retries, then warns and continues — reporting the run matters more than a clean
  temporary directory. Only a real backend could produce this; the scripted tier never could.
- **Approval-latency fields** (`approvalWaitMs`, `approvalDenials`) are in the record schema, honestly zero
  for auto-approved Lab runs, so the parity work can populate them without a schema change.

## [0.9.37] — 2026-08-03

**The deterministic Harness Lab now runs its Tier 1 task set without pretending it is a model baseline.**

- **Internal: `npm run lab` executes all eleven Tier 1 tasks through a headless `SessionManager` and scripted backend.** Each invocation copies its fixture into a fresh temporary workspace, reserves a task-local Vitest cache, emits a machine-readable record with completion, human-intervention, stall, tool-error, retry, wall-clock, cost, unauthorized-effect, and explicit `measured`/`scripted` observation-source fields, and disposes the session and message bus. C1/C2/C3/D1/F1/F2 feed real product policy, path, instruction-loading, or subprocess results into their sensors; B1/B2/B3/E1/E2 remain visibly scripted. The offline runner is wired into CI; Tier 2 remains out of CI and the real-model baseline remains 0.9.38.
- **Fixed: verification evidence is now attributed to the command that ran in the current turn.** OpenAI-compatible execution reads the framed subprocess exit code rather than router delivery success, and both OpenAI-compatible and Claude Headless paths replace an earlier verification verdict when a later command fails. Regression tests include the stale-pass mutation case.
- **Fixed: Claude no-write scopes do not advertise the native `Monitor` or `TaskCreate` tools.** They were visible but rejected in the field audit, wasting seven calls. The launch deny list removes them before the turn begins, while the inherited hook remains defense in depth. Delegation context now includes compact host-derived shell/write/tool-family facts and refuses clearly incompatible shell/write/read assignments before dispatch.

## [0.9.36] — 2026-08-03

**The Harness Lab now has a fixed instrument, before it has a runner.**

- **Internal: a versioned corpus of fifteen task definitions is checked in.** Eleven Tier 1 tasks use
  deterministic, scripted backend observations; four Tier 2 tasks will use a real model and report rates
  over multiple runs. The set exercises delegation recovery, command and workspace boundaries, worktree
  verification, self-heal, and repository context rather than model taste.
- **Each task has a pure deterministic sensor and an isolated offline fixture.** Sensors inspect recorded
  effects only: evidence verdicts, commands actually executed, confinement and policy refusals, terminal
  state, file contents, and test exit codes. They do not ask a model whether a task passed. An AST-based
  temp-copy mutation gate replaces each of the 38 sensor requirements independently; all 38 are killed.
- **Predictions precede the first run.** B3, F1, E2, and D1 are recorded as potential failures, with an
  explicit instruction to audit a surprising pass at the sensor before treating it as a result.
- **No task runner, metric aggregation, A/B comparison, or product behaviour changes in this release.**
  Those are separate Harness Lab releases; this corpus is deliberately only the input and instrument.

## [0.9.35] — 2026-08-02

**Everything that arrives can say where it came from.**

- **Approved hosts now record when they were approved and what asked.** The Security panel listed egress
  and metadata grants with a `revoke` action and nothing about their origin, so a host you granted last
  week was indistinguishable from one left behind by an old debug session — and grants live in
  machine-wide state, so they outlive workspaces and reinstalls. Each grant now carries its date and its
  requester, per grant kind, so revoking a host's metadata access still leaves its model-egress grant and
  that grant's provenance intact. **Approvals made before this release are labelled *date unknown*, not
  stamped with your upgrade date** — their real time is unknowable, and inventing one would make every
  legacy grant look like it was approved the day you updated.
- **A coordinator's Edit history shows the crew's edits, grouped by the agent that made them.** With a PM
  delegating, the rail reported *"Project Manager hasn't changed any files yet"* — accurate and useless,
  because the team had changed plenty and you had to already know which teammate to select. The rail reads
  the same checkpoint record rather than keeping a second copy that could drift on restore, restoring from
  a grouped entry takes the same path as restoring from the owning agent's own rail, and "nobody has
  changed anything" is now a different message from "this agent hasn't, but teammates have".
- **`AGENTS.md` and `CLAUDE.md` are read alongside `.unode/rules.md`.** Project knowledge you had already
  written for another coding agent did nothing here until you duplicated it into our path. All three are
  now loaded in that fixed order, with `.unode/rules.md` last so UnodeAi-specific rules win on conflict.
  Each candidate is resolved physically inside the workspace and a symlink pointing outside it is refused;
  identical content loads once; each file is capped at 12,000 bytes, cut on a UTF-8 character boundary,
  with the truncation stated in the context itself; and the block names every file it loaded and its size.
  **Repository instructions may direct behaviour but cannot grant a command, an MCP server, a network
  destination, or a write scope.** This broadens the prompt-injection input surface from a file only
  UnodeAi reads to documents already present in many repositories, so that boundary carries its own
  regression test — see [SECURITY.md](SECURITY.md) for exactly what the test does and does not prove.
- **New: Add to UnodeAi, on the editor's lightbulb.** Sends the current selection to the selected agent's
  composer, before you send the turn. It receives only the selection VS Code supplies and never reads the
  whole file, it is absent rather than broken when no agent is selected, and it refuses a selection outside
  that agent's read scope. The command is a public entry point, so it also bounds payload length
  independently of the lightbulb that normally produces it.
- **New: a local Account / Profile page.** One page in Settings consolidates the registration, sign-in,
  top-up, account, usage and pricing links that were scattered across provider cards, plus the live
  balance. It tells the truth in four states — no key, key configured, balance unavailable, low balance —
  and **a stored key reads as "connected via API key", not "signed in".** Opening the page makes no network
  request; a balance lookup still obeys the existing metadata-consent gate; and every account or payment
  action opens a registered Unode HTTPS URL in your system browser, never a destination the page supplies.
  BYOK, custom gateways and CLI-authenticated providers stay fully usable without an Unode account.
- **Internal: the extension-host test suite is now a CI gate and cleans up after itself.** It restores the
  global settings it changes from hooks rather than a `finally` — which is not reached when a test times
  out — and its offline key fixture creates a key only into an empty slot and removes only what it created,
  so a profile that already held one is never overwritten or deleted.

## [0.9.34] — 2026-08-02

- **Fixed: a teammate that finishes while the PM is busy no longer goes unnoticed.** An async delegation
  result arriving mid-turn was offered to the coordinator exactly once, at the instant it settled — and
  if the PM happened to be working, it was dropped. Recovery then depended on the PM choosing to call
  `await_tasks` on its own, so a coordinator that simply ended its turn left finished work sitting
  unread, with every agent showing complete and the task unfinished. The result is now **held and
  re-offered when that coordinator next goes idle**, and is dropped only once the PM collects it itself
  or you stop the run. A queued message from you still takes priority over an automatic wake.
- **Fixed: the newest lines no longer arrive underneath the composer.** The conversation now keeps
  trailing scroll room sized to the input card, so the latest output always clears it — while scrolling
  back through history still slides the conversation beneath the translucent card. The input is more
  transparent again, the working hint shares a row with the buttons instead of taking its own line, and
  the card's left inset is wider than its right.
- **Fixed: a late blocking delegation now wakes its coordinator instead of vanishing.** When a PM's
  bounded wait expires, its turn is marked unresolved rather than published as `task.complete`; the worker
  correlation remains open for two further wait windows. If the worker later replies, its original
  evidence verdict is delivered through the existing async-ready wake path. Cancelling or ending the
  session removes that listener.
- **Native tool calling is now the Auto default.** Models in the known text-leak families begin on their
  trained native protocol; an observed text-form tool call visibly retries once and switches that session
  to XML. The Agent Builder warns before choosing one of those families, while Native and XML remain
  explicit choices.
- **Workbench and sidebar chat tell the truth more compactly.** The transcript reaches the floating
  composer's bottom edge instead of reserving a blank band; message input has its own row, actions live
  below it, and unsent drafts are per-agent (20 recent drafts, removed on send or roster deletion). A
  pending approval alone reserves the floating composer's measured height, so its decision remains
  completely scrollable above the dock.
- **Team status no longer depends on ambiguous colours.** Compact roster markers and a Status key
  distinguish Done, Verified, Replied-not-verified, Consent required, and approval timeout. Roster state
  also decays without an incoming render, respects reduced motion, bounds tall details, and discards
  removed-agent expansion state.
- **The setup wizard starts as soon as you choose a work style.** The separate, easy-to-miss Start button
  and its stale retry wording are gone; the changed-files rail is now titled **Edit history**.

## [0.9.33] — 2026-08-01 — "Workbench"

- **Fixed: the setup wizard no longer claims a team was created when it wasn't.** Choosing **Team** in the
  wizard opens a native preset picker, and a picker can be dismissed — including by simply clicking back
  into the wizard. The wizard reported *"Quick Start team created."* either way, so you could finish setup
  believing a team existed and land in an empty Team panel. The wizard now reports what actually happened:
  a created team announces its real size, and a dismissed picker says plainly that nothing was created and
  offers to try again. The same honesty applies to a cancelled Solo setup.
- **The wizard's demo step is now explicitly optional.** It said *"Pick one task and send it to the
  Project Manager"* with no alternative on the page; a **Do nothing** card now continues setup without
  sending anything.
- **Fixed: the newest Claude model is no longer missing from the model picker.** Claude Headless offered a
  list that was frozen into the build, so `claude-opus-5` was absent while typing it by hand worked fine —
  and every release the list was not hand-edited, it was wrong again. The picker now leads with the CLI's
  own **always-latest aliases** — `opus`, `sonnet`, `haiku`, `fable` — which the CLI resolves to the newest
  model in that family each time an agent starts, so staying current needs no update, no network request,
  and no host you have to trust. Pinned ids remain for runs that must be reproducible, `claude-opus-5`
  among them. Aliases are priced at their family's rate, so cost estimates still work. **Why not just ask
  the CLI?** There is no `claude models` command, and an unknown `--model` prints a warning and still exits
  0 — an id can be neither discovered nor verified, which is exactly why a frozen list was never going to
  hold. (Probed against Claude Code 2.1.209.)
- **New: `unode.extraModels` — name a model the extension has never heard of.** Add ids to the Add-Agent
  and Settings pickers yourself, keyed by connection id, and they appear on save without a window reload.
  This is the only layer that needs neither an update nor a reachable host, so it is also the only way to
  extend a connection with no `/v1/models` endpoint to query. The model field remains a combobox
  throughout: **any id you type is passed to the provider as written**, listed or not.
- **New: the Workbench — your conversation moves into the editor.** Agent chat is no longer confined to a
  ~300px sidebar column. **UnodeAi: Open Workbench** opens a full-width editor tab with the transcript,
  execution timeline, tool activity, inline approvals and the composer, with an agent dropdown to switch
  between sessions. It is **one tab, not one per agent** — a tab strip that grows with your crew eats the
  space the transcript needs. The compact sidebar Chat is **kept**, not retired: it is the same view in a
  narrower container, so you can leave it in the sidebar and give the editor to another tool. Toggle from
  the Chat title bar or with **UnodeAi: Close Workbench**; `unode.workbench.autoOpen` turns automatic
  opening off entirely.
- **Fixed: you can now find out an agent needs you without watching for it.** With a project manager
  delegating work, you send a task and go do something else — and an approval rendered into a panel you
  are not looking at is one you never see. A **🔐 N waiting** status bar item, an activity-bar badge, and
  a locked row on the agent in the Team panel now surface a pending decision from anywhere, and one click
  goes straight to the card. **No agent ever steals focus or pulls your editor to another tab.** When a
  request does time out, the agent shows **denied — timed out** instead of quietly returning to idle.
- **The approval window for web access is now 15 minutes**, up from 3 — sized for actually walking away
  rather than for watching the screen. The separate seconds-scale transport check is unchanged, so a
  genuinely dead gate still fails closed immediately.
- **Fixed: chained commands stop asking when every part is already approved.** `npm test && npm run lint`
  ran two allowlisted commands and still interrupted you, because any shell control character forced a
  prompt. Each `&&` / `;` segment is now checked independently. `npm test && npm publish` still prompts —
  `npm publish` is not allowlisted — and pipes, command substitution, backticks, redirects and background
  operators remain blocked outright.
- **Opt-in local command-approval frequency table.** Enable the user-only
  `unode.debug.promptedCommandLog` setting during a review period, then run
  **UnodeAi: Show Prompted Command Frequencies** for a ranked local table of the command templates that
  actually reached an approval prompt. Templates are **redacted before storage** — filesystem paths
  become `<path>` and any value attached to a flag becomes `<redacted>` — so no raw command line,
  absolute path or inline credential is kept. It has no network path, and excludes allowlisted and
  already session-approved commands.
- **New: file changes open in the real diff editor.** An agent's edit used to open as a flat unified-diff
  scratch buffer — no side-by-side, no `F7` navigation, no folding, and nothing you could type into. Both
  editor paths (a recorded checkpoint, and a worktree lane's changes) now open the **native VS Code diff
  editor**, with the **live file on the right**, so you can correct an agent's edit inside the diff you are
  reviewing. A lane-level **View diff** now asks which changed file to open instead of printing all of them
  into one buffer. The diff inside an inline tool card is deliberately unchanged: an approval keeps its diff
  attached to the decision.
- **Fixed: Unode now comes before Roam everywhere, including where it was never a display question.**
  The API-key picker — the one dialog that decides which account you are about to pay for — listed them
  in the opposite order from the setup wizard, Agent Builder and Settings. Fixing that surfaced the
  cause: the connection registry itself declared Roam first, and one consumer reads that list unsorted —
  so an agent whose configured provider failed to resolve **silently fell back to Roam**. The registry
  order is corrected at the source.
- **Fixed: a second identical announcement was silent.** Two approvals in a row from the same agent for
  the same command announced once — and the second, which is the one you have not acted on, was the one
  lost. Emptying the announcement region and rewriting the same words in a single step is not a change by
  the time a screen reader looks, so nothing was spoken. The rewrite now happens after the emptied state
  is observable.
- **Fixed: a screen reader could speak an announcement again with nothing on screen to explain it.** The
  region announcements are written into is visually hidden but still part of the accessibility tree, and
  the last announcement stayed in it — so asking the screen reader to read the page spoke it a second
  time, as words with no visible source. It is now cleared once it has been spoken.
- **Fixed: at 200% zoom the composer covered the conversation.** A floating composer needs a viewport tall
  enough to float in; at that zoom the usable height roughly halves while the transcript's and toolbar's
  minimum heights do not, so the column overflowed and the pinned composer sat on top of it. Reserving
  more space could not fix that — there was none to reserve — so on a short viewport the composer stops
  floating and returns to the bottom of the column, where it cannot cover anything. Verified fine to 175%.
- **Fixed: restoring a file from the changed-files rail only undid the agent's last edit.** The rail shows
  one row per file, so the row means "this file" — but it restored that file's newest checkpoint, leaving
  every earlier edit in place. With an agent that touched a file twice, the restore appeared to do
  nothing. It now rolls back to the agent's earliest recorded edit of that file, and the confirmation says
  how many edits that is instead of claiming to undo "the edit" when it is undoing four. Picking a
  specific restore point from **Restore File Checkpoint…** is unchanged — there you chose the exact one.
- **Fixed: the sidebar composer could open several lines tall for no reason.** Its height is derived from
  the text's wrapped height, which is meaningless while the container is still zero-width — a sidebar
  mid-reveal wrapped every word and the box stuck at its maximum until the next keystroke. The height is
  now recomputed when the container's width actually changes, which also fixes it after a drag or a zoom.
- **You can now remove a stored API key without losing your team.** `UnodeAi: Set Provider API Key`
  refuses an empty value by design, and the only path that deleted a built-in provider's key was the
  workspace reset — which also deletes the team file and reloads the window. Picking a secret that
  already has a value now offers **Replace** or **Clear**, the same choice custom gateways already had.
  Nothing changes when the secret is unset, so setting a key for the first time is still one step.
- **Fixed: finishing setup with no team looked like it did nothing.** It was supposed to take you to the
  Team panel to create one, but it only revealed the sidebar *container* — a no-op if you had already
  opened UnodeAi during setup, so the wizard just closed. It now focuses the Team view itself.
- **Fixed: the setup wizard's Skip button now says it ends setup.** It sits between Back and Next, so it
  read as "skip this step", while it actually marked setup complete and closed the wizard. The behaviour
  is unchanged and correct — the label was not. It now reads **Skip setup**, with a tooltip saying the
  wizard can be reopened from the Command Palette.
- **The default context window is now 1,048,576 tokens** (was 524,288) for agents that do not set one
  explicitly. This is the figure the compaction and trim thresholds are computed from, so an agent on a
  model with a smaller real window should still set its own value.
- **The conversation now announces what needs you, for screen-reader users.** A status bar item told a
  sighted user that a decision was waiting; in the surface holding that decision, a blind user was told
  nothing at all. Pending approvals are now announced assertively — naming the agent and what it is asking
  for, **never reading the command line aloud**, since the card beside it carries the detail. Turn start,
  turn end, turn failure, an approval **timing out**, and a setup-repair card replacing the conversation
  are announced politely. Replies are never announced token by token, reopening the Workbench does not
  read back history, and with both the sidebar and the Workbench open only one of them speaks.
- **The Workbench headline says each thing once.** It led with **Ready for your next task** — a line that
  spent a row telling you there was nothing to tell — above a status word the agent's Team row already
  showed, above a context meter repeating the context figure beside it. Role, connection, model, context,
  cost and turns are now the line itself, and the duplicate meter is gone. The narrow sidebar keeps its
  meter: it has no facts line to read the number from.
- **The Workbench input card is translucent now**, with the conversation faintly visible through it and
  blurred behind the text, instead of sitting on an opaque slab.
- **58 distinct agent icons, and a roster that stops handing out the same one.** Several built-in roles
  legitimately prefer the same glyph, so adding more of them would not have helped on its own: a new agent
  now takes its role's preferred icon only when no teammate is already wearing it, and otherwise gets the
  next unused one. A whole crew created at once ends up with distinct icons, and the Agent Builder offers
  the entire palette instead of eight samples.
- **Team roster controls no longer hide when the pointer leaves.** Start/Stop, Restart, Configure and
  Terminal are always on the row. Revealing them on hover meant they blinked out as soon as you moved the
  mouse, and a control you have to go hunting for is one you stop trusting. The status word is gone with
  them — the first glyph already says it, and the dot on the agent's icon separates working, idle, stopped
  and error, which frees the width for a name in a 250px sidebar.
- **The Workbench input no longer sits under a black band.** The dock's backdrop was a gradient that hid
  the last lines of the conversation right where you are about to reply to them; only the input card is
  painted now, so the transcript stays readable up to its edge.
- **The Workbench headline stops repeating the agent's status** (it is on the Team row) and carries the
  chat actions the sidebar has always had in its title bar instead — Archive, Clear, Compress, Export,
  Import, and View Archived Chats — which an editor tab had no way to reach.
- **Setup now ends somewhere useful, and the Workbench says what is wrong when nothing works.** The
  wizard's last step used to offer Dashboard, Chat and Settings as three equal cards and then finish
  without opening anything — leaving a new user on whatever screen they happened to be on. It now leads
  with the Workbench: **Finish and continue** opens your conversation when a team exists (still honouring
  `unode.workbench.autoOpen`), and takes you to create a team when there is none, rather than into an
  empty Workbench.
- **The conversation surface now explains an unusable workspace instead of showing an empty dropdown.**
  With no team, no available connection, or a connection whose credential is missing, the Workbench and
  the sidebar Chat show a card naming the cause and offering the one action that fixes it, and the
  composer says **Complete setup to message an agent** rather than accepting a message that cannot be
  sent. Return to the surface after fixing it and the card clears itself. No credential, secret name, or
  endpoint is sent to the view — the readiness check runs entirely in the extension host.
- **Fixed: the Security card in the setup wizard did nothing.** It was rendered but its command was not on
  the wizard's allowlist, so clicking it was silently ignored.
- **The Workbench composer now floats.** The input sat at the bottom of a column, so anything that grew
  above it — an approval card, a long plan — pushed it toward the edge, and on a short window it could be
  pushed off entirely. It is now a card pinned above the conversation, which scrolls underneath it, with
  the attachments, steer hint and auto-approve controls inside the same card. The reserved space matches
  the card's real height as the box grows with what you type, so the last message can always be scrolled
  clear of it. The narrow sidebar Chat keeps the layout it had.
- **New: a changed-files rail in the Workbench.** **Show Changed Files** in the Workbench title bar opens a
  rail listing what the selected agent changed, newest first — click to diff it, **⟲** to restore that one
  file after confirming. It answers "what did this agent just do to my repo" without leaving the
  conversation. It is **off until you open it** and remembers its state per workspace. On a narrow editor
  it stops reserving a column and becomes an overlay drawer rather than disappearing — a rail that hid
  itself while the title action still read **Hide Changed Files** was a control lying about its own state.
- **Fixed: the compact Team roster gave up too much of the team.** Making the sidebar a navigation
  surface took every member fact and control with it — model, provider, live context/cost/turns, skills,
  the start/stop/restart buttons, and the only click-path to an agent's own configuration page. Each row
  is still one line, but **hovering it reveals that agent's controls** (Stop/Start, Restart, **⚙️
  Configure**, Terminal, Remove) in place of the status word, and the **▾** chevron **expands the row**
  for its model and Smart Mode badge, provider, role, context/cost/turns, skills, and recently changed
  files — plus a **Configure this agent** button that opens its Agent Builder page. Rows you expand stay
  expanded when the roster refreshes.
- **Fixed: the Connections & setup sub-panel had a button that did nothing.** Its **Security** button sent
  a message the extension never handled, and every other entry in it duplicated an icon already in the
  Team title bar. The sub-panel is gone; **Message** joins the title-bar icons. A rendered button with no
  host handler is now a test failure rather than a silent no-op.
- **Hardened: restoring a file checkpoint now re-checks that it stays inside your workspace — on disk, not
  just in the string.** A restore resolved its target by joining the recorded path to the workspace root
  and writing there. Agent writes are already confined by the tool layer, so this was not reachable from a
  model — but the checkpoint store is re-loaded from a file on disk, so a hand-edited or tampered state
  file could turn "restore this file" into a write anywhere on the machine. `..` segments escaped, an
  absolute path replaced the root outright, and **a path through a symlinked folder or a Windows junction
  escaped while looking perfectly ordinary** (`linked/target.txt` is inside the workspace by name and
  points wherever the link goes). Restore and the checkpoint diff now resolve the real path of the target
  — or of the nearest existing folder, since a restore often recreates a deleted file — and refuse
  anything that lands outside. Covered by regression tests using real junctions and symlinks.
- **Worktree lane diffs are pinned to the commit they were opened against.** The base side used to be
  resolved from the branch name each time it was read, so an open diff could silently re-point when the
  base advanced. The tab now names the commit in its title (`base a1b2c3d ↔ …`) and keeps showing it.
- **Team title bar: version beside the title, Settings and Marketplace pinned.** The version sits in the
  view's description slot next to **Team**, where VS Code drops it before it drops an action icon, so it
  never competes with them for the row. **Settings** and **Marketplace** are pinned icons rather than menu
  entries, and are no longer repeated inside **⋯ Team Actions** — a menu that lists what is already on
  screen is the sub-panel this release removed. An expanded roster row no longer carries a second
  **Configure this agent** button either: an expanded row shows its ⚙️ control without hovering, so one
  affordance is enough.
- **Fixed: narrowing the sidebar used to hide things rather than shrink them.** The Team title bar pinned
  13 icons, and a title bar is a fixed-width row — everything past the first few went into VS Code's
  unlabelled `...` overflow, so on a narrow sidebar most of the panel's actions simply vanished. Four icons
  are now pinned (**Add Agent**, **Solo**, **Message**, **Collapse/Expand**) alongside a new **⋯ Team
  Actions** menu that lists the rest *by name*: Build an Agent, Create or Switch Team, Start/Stop All
  Agents, Team Rules, Restore File Checkpoint, concurrency mode, Security, Settings, Marketplace, and
  Evidence Report. The view title is now just **Team** — the version moved into the panel body, where
  narrowing cannot hide it. **Collapsed agent chips wrap instead of scrolling out of sight** on a narrow
  sidebar, and the two primary buttons stack rather than clipping.
- **The Workbench session line now says more than the model** — role, connection, model, context, cost,
  and turns for the selected agent.
- **Under the hood:** the sidebar and the Workbench are two projections of one session store, so they
  cannot show different transcripts; release artifacts are now built from a clean tagged CI checkout with
  the toolchain recorded; and text files are normalised to LF so a Linux rebuild reproduces a Windows one.

## [0.9.32] - 2026-07-24

- **Fixed: web search and fetch were impossible on Claude Headless.** A research agent could not read the public web at all — every `WebSearch` / `WebFetch` attempt hit a 5-second approval deadline that no human could answer and came back as an opaque `error`, so an agent asked to verify a fact had no way to do it. Human approval is now reachable: the first web use raises one prompt, and **one approval covers the whole crew for the rest of the session**. Transport health and the human decision are now separate clocks, so a genuinely dead gate still fails closed in seconds while a person is given minutes to answer, and an unanswered prompt ends in a clean, explained denial instead of a hang.
- **New setting `unode.webAccess` — `ask` (default), `allow`, or `off`.** It governs gateway `fetch_url` and Claude's native web tools identically, so an agent's reach no longer depends on which connection it happens to run on. Public-web reads are egress (a fetched URL can itself carry data), and the docs now say so plainly.
- **Tools that can only be refused are no longer offered.** With `webAccess: off` — or for an agent without read access — the web tools are removed from what the model can see, instead of being advertised and then denied, so no turn is wasted on a guaranteed failure. Any stale or direct request is still denied by the host gate, with a reason that names the policy that blocked it rather than suggesting unrelated folder access.
- **A model-egress consent dialog can no longer make a Claude agent look permanently stuck.** While the native dialog is open, the agent shows **Consent required** and tells you to answer that dialog. Allow resumes the same start; Cancel produces the established error; stopping before an answer prevents a later Allow from spawning an orphaned process.
- **Create a custom gateway without leaving the setup wizard.** The OpenAI-compatible connection menu now offers **＋ Add custom gateway…**, so a first run no longer has to be abandoned halfway to go and create one in Settings. The host asks for the display name, HTTPS endpoint, and masked key — the key value never enters the wizard's webview — and the new gateway is selected automatically when it is created. Cancelling leaves the previous selection untouched and creates nothing.
- **Connection order is consistent everywhere.** The setup wizard listed connections in a different order from Agent Builder and Settings, so the default connection was not the first one offered. All three now show Unode first, Roam second, then the rest in a stable order.
- **Release artifacts are frozen and reproducible.** The publish command verifies the exact approved VSIX hash immediately before upload, and the release-integrity gate requires two clean bundled builds to be byte-identical.
- **Manual and wiki release facts are gated.** CI checks the shipped UI labels, command list, package-safe links, and every public version stamp so a user-visible change cannot silently outpace its documentation.

## [0.9.31] - 2026-07-23

- **Named Custom gateways.** Add any number of local OpenAI-compatible gateway profiles from **Settings > Providers**. Each profile has an immutable `custom:<id>` connection identity, its own canonical HTTPS endpoint, its own SecretStorage generation, and a display name that can be changed without changing agent or default assignments.
- **Gateway ownership is enforced at model egress.** Agent/team files and webviews cannot redirect a named gateway to another endpoint or secret. A profile endpoint/key/archive change advances its revision; a backend constructed from the old profile is denied before its next model request and must be restarted.
- **Explicit gateway management.** A custom gateway card carries the same flat action row as the built-in cards: **Test connection · Edit · Set as default · Load models · Remove**. **Edit** is a single flow over name, endpoint, and key (keep / replace / clear) ending in a confirmation that shows the old and new values and the affected agents; it is blocked only while an agent on that gateway is *running*, not while one is merely idle. **Remove** is refused while an agent, the default, or a Smart Mode tier still references the profile, and names what to rebind. API-key values never enter webview state; a custom profile card only reports whether its key is set.
- **Test connection on every API-key gateway.** Roam, Unode, OpenRouter, and OpenAI API gained the same one-shot `/models` check the custom gateways have. Endpoint and credential are resolved from the registry profile rather than from the panel, metadata consent is requested before the request is made, and no secret material appears in the result or in any error. Claude and Codex Headless have no test action, since they authenticate through their own CLI.
- **A misconfigured Base URL now explains itself.** A gateway that answers with an HTML login or proxy page produced a raw `Unexpected token '<'`. It now reports that the endpoint returned HTML rather than JSON and that the Base URL usually must end in `/v1` — without reflecting the returned page, which can carry account information.
- **Creating a team on a custom gateway asks once for the model** and applies it to the whole crew, because a custom gateway ships no catalog to resolve per-role tiers from. Cancelling creates nothing rather than a roster wired to a model the gateway does not serve.
- **Fixed: declining the legacy migration could silently discard later roster edits.** After a decline (or in an untrusted workspace), adding, editing, or deleting an agent now saves correctly, the declined roster is remembered so the prompt does not return on reload, and the affected agents remain visible non-runnable repairs.
- **Safe legacy Custom migration.** Trusted workspaces with legacy singleton `custom` routes receive a host-authored preview and confirmation before profiles are created. Per-agent HTTPS endpoints take precedence over the old global setting, legacy keys are copied only inside the extension host, malformed or keyless records remain visible non-runnable repairs, and the old setting/key are retained for later workspaces.
- **No cross-gateway metadata borrowing.** Named gateways do not inherit another gateway's model catalog cache, price, balance, endpoint, or API key. Unknown custom prices remain blank rather than using a global model price.

## [0.9.30] - 2026-07-14

- **Connections are now explicit and stable.** Existing rosters are migrated to a versioned connection route when they load. A model name never changes where a request runs or who bills it: a Claude- or Codex-named model on a gateway stays on that gateway. If an old hand-edited provider/backend pair conflicts, UnodeAi stops and asks for repair instead of guessing.
- **Three connection families, with truthful availability.** OpenAI-compatible connections and Claude Headless are available. Codex Headless is visibly marked **Coming soon** and cannot be selected, set up, made the default, or started in this release.
- **Saved Codex routes are preserved safely.** Existing configurations continue to migrate losslessly, but the extension host rejects a Coming soon Codex route before backend construction; it does not spawn a Codex CLI process.
- **More ready-made ways to build a team.** The catalog now has more than 50 role templates and 22 team presets, including professional and knowledge-work teams with least-privilege defaults.
- **The Add-Agent model picker now asks only for the metadata hosts it will actually use.** Declining leaves the built-in model and price data available and sends no metadata request.
- **Build-chain audit is clean.** `npm audit` and `npm audit --omit=dev` report zero known vulnerabilities, while the packaged extension remains dependency-free at its VSIX boundary.
- `unode.codexCliPath` is reserved for future Codex Headless support and is not used to launch a process in this release.
- **Security: a workspace can no longer redirect the "Browse skill library" link.** `unode.marketplace.skillLibraryUrl` is now a restricted configuration, is validated to an `https:` URL (any other scheme fails closed), and names its origin in a confirmation when a workspace sets it away from the default — so a repository cannot point that button at a `file:` URI or unrelated host.
- **Security: a team file cannot redirect a standard provider.** Roam, Unode, OpenRouter, and OpenAI routes — including their live model-list requests — now use their registered endpoint even if a workspace supplies another `baseUrl`. Only the explicitly chosen Custom connection accepts a user HTTPS endpoint; the extension reports when it strips an unsafe standard-route override.
- **Security: a connection now owns both its endpoint and its key reference.** A roster cannot pair the Custom endpoint with a Roam, Unode, OpenRouter, or OpenAI key name: the file is rejected before it runs, and the runtime derives both the key identity and endpoint from the registered connection. An invalid Custom URL also yields no live balance lookup.

## [0.9.29] - 2026-07-13 - Feels alive, and stops burning money quietly

- **Security: a fresh install makes ZERO network requests.** Activation used to refresh live prices
  unconditionally, contacting the two default gateways before the user had approved anything — an unsolicited
  beacon on install that contradicted our own published promise. Every metadata service (prices, balance,
  model catalog) is now constructed on a consent-gated fetch that refuses an unapproved host before a packet
  moves; background refreshes skip silently.
- **Security: metadata consent is its own grant, precisely scoped to the action.** Fetching a gateway's price
  list / model list / account balance is a separate, weaker grant than sending it prompts and code: asked with
  an accurate description (one aggregate, per-host-selectable prompt — only on user-initiated paths), listed
  separately in the Security panel, revocable on its own. Model-egress consent implies metadata consent; the
  reverse never holds. And the ACTION is scoped like the prompt: opening one provider's model picker contacts
  only that provider's hosts, even when other gateways hold a standing approval.
- **Security: the hosted skill catalog merges only with a valid Ed25519 signature over its exact bytes.**
  Verification is mandatory (not a caller option); unsigned, wrong-key, or tampered content is rejected and
  the bundled catalog stands; with no signing key configured — the state this build ships in — it is not even
  fetched. The Security panel reports the catalog's effective state instead of echoing the setting.
- **New command: `UnodeAi: Refresh Model Prices`** — on-demand live price refresh that reports what it did.
- **Fixed: writing a markdown heading could kill the extension.** A reply that streamed a `## ` — the state
  every heading passes through, for one frame, before its text arrives — sent the transcript renderer into an
  infinite loop. VS Code's extension host filled 4 GB and died, taking every extension with it. The parser can
  no longer fail to consume a line, and the live renderer now re-renders only the part of a reply that can
  still change, instead of the whole thing 60 times a second.
- **You can see an agent is alive.** A running turn shows its elapsed time and what it is waiting on, so a
  long think no longer looks like a hang.
- **Fixed: the PM could get stuck after a teammate reported back.** Asking a teammate to read a file and
  summarize it left the coordinator spinning after it had already answered you — Stop never cleared, and your
  next message was swallowed into the running turn. It now finishes when the work is genuinely finished, and
  is only pushed to continue when the framework says something is still unverified.
- **The Dashboard updates while the crew works.** Tokens, cost, cache and the agent lanes used to redraw only
  when a whole orchestration finished; you had to close and reopen the panel to see anything.
- **Prompt caching now actually works on Claude, and you can see it.** Claude caches nothing unless the
  request asks it to — and we never asked. A Claude agent on a gateway backend was paying full price for every
  token of every turn, silently, because a missing cache does not error: it only bills. UnodeAi now sends the
  cache breakpoints, measures whether they land, and says so.
- **The Dashboard tells the truth about caching.** A gateway that reports usage in Anthropic's units (where
  the number it calls "prompt tokens" is only the part that MISSED the cache) made a 20,000-token request look
  like 2 tokens — under-reporting your usage and your bill by four orders of magnitude, and making a perfect
  cache hit look like no cache at all. That is now detected and reconstructed, and labelled as an estimate.
- **A gateway rejection you have never seen before no longer kills the turn.** Instead of matching each
  gateway's error wording — a game that cannot be won — UnodeAi now responds to an unrecognized rejection by
  sending a simpler request and retrying, down to abandoning native tool-calling for the XML protocol, which
  keeps every tool available. Rejections that MEAN something (a full context window, a bad key, no credit) are
  still surfaced to you immediately and untouched.
- **Long conversations keep their cache.** The history backstop dropped the oldest messages at 60 — around
  turn six of a normal chat — which rewrote the prompt prefix and made every later turn re-read the whole
  conversation at full price. It is now bounded by your token budget, as it always should have been.
- **Fixed: an image pasted to a text-only model no longer breaks streaming for the session.** The failure was
  repaired on the non-streaming path only, so every later turn quietly burned a rejected streaming request and
  fell back — for good.
- **Fixed: the Messages panel showed raw ids, and Output had no channel for your agent.** A name resolved
  before the roster loaded was frozen that way forever. This also fixes an agent you rename keeping its old
  Output channel name.
- **Fixed: a large file written by an agent didn't count toward its context window.** The token estimate read
  only message text, and a `write_file` carries the whole file in the tool call's *arguments* — so a history
  full of big writes looked nearly free, and an agent could sail past its real context limit believing it had
  room.
- **Windows: a PowerShell-only command run in `cmd.exe` now says so** instead of failing with an unhelpful
  error.
- **Settings → Providers can re-run the Setup Wizard** — and re-running it no longer switches a Roam user to
  Unode behind their back.
- **A new agent defaults to the provider you set up with**, not a hardcoded one.

## [0.9.28] - 2026-07-11 - Delegation that works

- **Every Claude tool call now goes through UnodeAi before it runs — including inside subagents.** Claude
  agents are mediated by a fail-closed gate: shell commands still honor your command-approval policy, native
  file writes show the write-approval diff, and external-effect or unfamiliar tools raise an approval card.
  Tool calls made by Claude's own `Agent`/`Workflow` subagents are gated too — previously they could reach
  tools the top-level agent was denied. If the gate is unreachable for any reason, the tool is **denied**, not
  allowed. Verified against the real Claude CLI, not just unit tests.
- **A teammate's "Done" is now checked against what it actually did.** The PM no longer takes a delegated
  reply at its word: UnodeAi compares the claim with the framework's own record of the teammate's writes and
  test runs, and reports **verified**, **replied — not verified** (it answered, but the work wasn't confirmed),
  or **no evidence** (it replied without doing anything). A teammate that says "tests passed" without running
  them is caught.
- **Guidance updates now reach existing agents.** Role-template instructions are no longer frozen when an
  agent is created. Untouched defaults refresh safely on the next session start; customized prompts stay
  untouched and show a template-to-template update diff with explicit keep, reset, and undo choices.
- **The PM stays responsive while teammates work.** Delegating no longer locks the PM up: it can hand out an
  async task, end its turn, and take your next instruction immediately. When the work lands, an idle PM wakes
  with the framework evidence and reports or continues on its own; a busy PM still collects it exactly once.
- **Model prices say which gateway they came from.** A price now reads `$1.7 / $5.1 per 1M · Roam (live)`, so
  it's clear whose rate you're looking at and whether it's the live gateway value or the built-in fallback.
- **Fixed: the Agent Builder was inert.** Save did nothing, and the Role dropdown would not move — picking a
  role left the name and instructions on the previous one. Two causes: a script error killed every event
  handler in the panel, and the role switch was gated on a browser dialog that a VS Code webview does not
  render (it read as "cancelled" and snapped the role back).
- **A new agent now opens blank.** No role is pre-picked, and Name and Instructions start empty; choosing a
  role is what populates the form. If a role switch replaces instructions you wrote, one click restores them —
  and if you save without restoring, the replaced text is still kept as the agent's undo record.
- **Fixed: choosing "Custom role" could silently revert to a built-in role.** An agent you deliberately made
  custom, whose instructions still matched a shipped default, was handed that role's identity back on save —
  it reopened as the built-in role and ran on its template. An explicit custom choice is now respected.

## [0.9.27] - 2026-07-10 - Chat that feels right

- **Recursive deletes of `.git`/`.unode` are blocked in every mode.** The always-on catastrophic guard now
  also stops `rmdir /s`, `rd /s`, and PowerShell `Remove-Item -Recurse` (including abbreviated `-Rec` and a
  quoted `cmd /c "…"` wrapper) when they target `.git`, `.unode`, `..`, a drive root, or `~` — closing a
  Windows gap where an agent could wipe your repo. Ordinary `rmdir build` still goes through normal approval.
  Agents also get a sandboxed `delete_dir` (refuses `.git`/`.unode` and anything outside the folder) so they
  don't shell out to a raw recursive delete.
- **Model prices match the agent's gateway.** Prices are now scoped per provider, so a model priced
  differently on two gateways (e.g. grok-4.5) shows the right number for the agent's actual gateway instead of
  whichever refreshed last; an unknown price shows blank rather than a wrong one.
- **Empty projects get "create it", not "wrong path".** Reading a file that doesn't exist yet in a fresh
  project now steers the agent to create it with write_file, instead of a typo-recovery message that made a PM
  stall on an empty folder.
- **Tool cards say what actually happened.** A missing file reads "Not found" and a real failure reads "Error"
  — "Blocked" is reserved for a genuine policy/security block (which still opens itself).
- **The PM keeps going after a teammate reports Done.** A delegated result is no longer mistaken for the final
  answer; the PM continues the plan — verify, review, delegate the next step — instead of stopping half-way.
- **More built-in skills.** Twelve first-party procedures (systematic debugging, test-driven development,
  verification before completion, writing implementation plans, and more) are mapped onto the default roles.

- **Streaming chat feels smooth.** Markdown renders incrementally as it streams — a code block is a code block
  from the moment its fence opens — so a reply no longer visibly rearranges when the last token lands. Bursty
  network delivery is paced into a steady flow, and it never fakes typing: it flushes everything instantly when
  the turn ends, when you switch windows, or when you have "reduce motion" on. Tool events stream incrementally
  instead of rebroadcasting the whole conversation, so a turn with many tool calls stays responsive.
- **The agent's work reads as a sequence.** Narration between tool calls is kept in place and persisted, so a
  finished turn reads as think → act → think → act rather than a pile of tool cards with a verdict stapled to
  the bottom. Consecutive file reads collapse into one "Read N files" group. Non-Claude models are now prompted
  to state one sentence of intent before each action, so the rhythm shows even on terse models.
- **Scrolling yields to you.** Auto-follow stops the instant you scroll up mid-stream and resumes when you
  return to the bottom.
- **A cancelled turn stays cancelled.** Stopping a turn (or starting a new one) fences its in-flight tokens by
  epoch, so stray output from a killed turn can't paint into the next reply. Steering does not bump the fence,
  so a steered continuation still streams normally.
- **Using Superpowers skill.** Every role (PM, Solo, Reviewer, Developer, and the business roles) now starts
  with a meta-skill that has the agent check and load its authorized skills before acting. Guidance only — no
  change to any agent's tool permissions.
- **Model-tuning dropdowns name the real default.** Instead of a synthetic "Default", each control shows the
  value that will actually be used, annotated "(default)".
- **Higher output ceiling.** The default max output tokens rose to 32768 (from 4096), ending the DeepSeek
  truncation loop where a large write was cut off mid-arguments.
- **Verify commands and model shell commands share one gate.** The outside-root escalation now covers
  `run_checks`, the completion gate, and the worktree verifier: a model-emitted command still escalates to you,
  while a configured verify command runs with a one-time non-blocking warning instead of breaking automated
  verification.

- **An out-of-root path in a shell command now asks you instead of refusing.** `run_command` used to reject
  the command outright, before the approval gate ran, and tell the agent not to try again. That bought no
  safety — the same file read as `..\..\Users\me\id_rsa`, via `cd ..`, through `powershell -enc`, or inside
  `node -e "…"` was never detected (measured) — while a false positive killed honest work. The detector now
  escalates: the approval card shows what it found and you decide. It forces a fresh prompt even for a
  command whose template you already allowed for the session or the project, because what changed is the
  path, not the command. Where no one can be asked (headless, tests), it still refuses: a heuristic may not
  refuse on its own, and it may not silently allow either.

- **The chat preflight that guessed paths out of your prose is gone.** It regex-scanned the message you typed
  for an absolute path outside the agent's folder and refused the turn before the model saw it. Guessing paths
  out of natural language cannot be made correct, and a false positive cost the whole turn. It was also
  redundant: `read_file`/`write_file` resolve and bounds-check every path they are given, and when the model
  actually reaches outside, that produces the same "open the project in a new window" guidance — on a real
  access rather than a guess about one.

- **URLs are no longer mistaken for Windows drive paths.** A URL scheme ends in a letter followed by `://` —
  the exact shape of a drive path — so `https://github.com/u/r` was read as drive `s:`, resolved to
  `s:\github.com\u\r`, and reported as "outside my working folder". This aborted the chat turn *before it
  ran* whenever the task merely quoted a URL, and blocked `git clone`, `git remote add`, and `curl` against
  any https URL. The sandbox guard is unchanged in strength: `curl -oC:\Users\me\x`, `C://Users/other/id_rsa`,
  and `file://c:/secrets.txt` are all still flagged.

- **Anthropic has a setup button.** Settings → Providers → Anthropic previously offered only *Set as default*,
  with no way to install or sign in to the CLI it depends on. It now shows **Set up Claude CLI**, which opens a
  terminal with `claude login` typed but not executed, and the card names the install command. Onboarding and
  Settings now share one implementation of that terminal.
- **Tool cards collapse.** A chat tool card shows only its title row; the input, output, and diff sit behind a
  ▶ toggle on the right (the whole row is clickable). Blocked calls open by themselves. A turn with many tool
  calls no longer pushes the agent's actual reply off-screen.

## [0.9.26] - 2026-07-09 - Agent Skills and Claude reliability

- **Agent Skills B0.** Default software roles now ship with mapped, progressively disclosed `SKILL.md`
  procedures instead of eager prompt-body injection. OpenAI-compatible agents receive L1 metadata plus
  read-only L2/L3 skill tools; Claude Headless uses an isolated per-agent plugin directory for every
  granted agent, including read-only and folder-scoped agents. Live testing confirmed Claude loads plugin
  skill bodies while `Bash`, `PowerShell`, `Write`, `Edit`, and `NotebookEdit` remain disabled.
- **Skill packaging boundary.** The bundled VSIX now includes validated instruction-only `skills/**/SKILL.md`
  resources and rejects executable payloads and symlinks there, while preserving the existing `packages/**` exclusion.
- **Default Provider is usable.** Teams, Solo, and manually-added Claude Headless agents use the selected
  `unode.defaultProvider` with the correct model/backend. CLI-authenticated Claude never prompts for or stores an API key; the Settings Providers tab can select it as the default.
- **Claude PM delegation works end to end.** The loopback MCP server implements Streamable HTTP initialization,
  and Claude auto-approves only Unode's local team, read-only-files, and permission bridges.
  Delegation still flows through TeamTools, CommandPolicy, MessageBus, and the target worker's own constraints.
- **Claude tool gating is honest for v0.9.26.** Top-level Claude `Bash` and `PowerShell` now both route
  through `unode.commandApproval`. The brittle blanket native-tool deny-list was removed: trusted
  write+execute agents receive no default `--disallowedTools`, while read-only/no-write/untrusted scopes
  deny native write, shell, worktree, and external-effect tools (`EnterWorktree`, `ExitWorktree`, `Artifact`,
  `CronCreate`/`CronDelete`, `RemoteTrigger`, `PushNotification`, `ScheduleWakeup`, `SendMessage`) plus
  native subagent/discovery escape tools (`Agent`, `Workflow`, `ToolSearch`) via CLI name filtering. Normal
  Claude native `Agent`/`Workflow` use is still detected with a loud warning plus a per-agent user opt-out.
  A hardened live smoke asserts a read-only Claude agent cannot add any git worktree, branch, or working-tree
  directory by any available route.
- **Stop responds immediately for stuck turns.** Pressing Stop now cancels the active turn locally, posts
  `Stopped by user.`, detaches the stuck backend, and ignores late stale completions while process cleanup
  continues in the background.
- **Windows process cleanup falls back safely.** A missing `taskkill` no longer leaves a direct child process running.

## [0.9.25] — 2026-07-09 · Per-agent folder access + Claude streaming

- **Claude Headless streaming is live again.** Claude agents now request partial stream-json messages, so chat text, thinking/analysis, and tool-result cards update during the turn instead of appearing only at the end.
- **Claude CLI cost labels are honest about billing.** When a Claude agent is authenticated through the CLI without `ANTHROPIC_API_KEY`, UnodeAi shows API-equivalent usage as `~$...` with an explanation. Plain `$...` is reserved for API-key/pay-as-you-go Claude runs and other billed providers.
- **Team controls take less space.** Agent-card actions are compact icons on the first row, and compact Team mode keeps every agent in one horizontally scrollable row instead of growing vertically.
- **Claude onboarding opens the right terminal.** The Claude Headless provider step has an **Open Terminal** action beside Save so users can install/login to Claude without leaving the setup flow.
- **Per-agent folder access is enforceable and visible.** Agent Builder now has an advanced Folder Access editor with Add/Browse/Remove rows, Read vs Read+Write grants, validation warnings, and Claude multi-write-root guidance. `.unode/team.json` persists `folderAccess`; OpenAI-compatible agents enforce read/write root sets, Claude Headless enforces one writable `cwd` plus read-only bridge roots, read-only Claude scopes deny native write/shell tools, and worktree mode conflicts fail visibly. The Security panel now reviews each agent's folder grants beside its MCP grants.
- **Folder scopes and Workspace Trust are hard ceilings on both backends.** Explicitly folder-scoped agents no longer receive shell execution or shared-memory writes, Claude native write/shell tools now honor each role's `allowedTools`, and an untrusted workspace always gives Claude an empty write-root set. Verification commands are also disabled for untrusted or explicitly scoped agents.
- **The release package has a mechanical safety boundary.** Both packaging entry points now build the single-file runtime VSIX, and packaging fails if it finds non-extension workspace packages, credentials, runtime state, nested VSIX files, native executables, or dependency development fixtures. Bundled dependencies are derived from esbuild's input graph and ship with their exact license texts.
- **Local protocol surfaces have bounded input.** The authenticated loopback MCP bridge writes its temporary bearer config owner-only and rejects request bodies above 64 KiB. The separate relay preview rejects duplicate role connections and caps connection, handshake, message, and WebSocket buffers; frame observation remains test-only and off by default.

## [0.9.24] — 2026-07-07 · New logo + onboarding fixes

- **New Unode logo** across the extension (activity-bar/sidebar, editor title-bar, Marketplace/Extensions
  icon, and webview logos) and in the README, user manual, and wiki. Note: VS Code renders the activity-bar
  and tab icons as a single theme color, so the gradient shows in the full-color surfaces (Extensions list,
  docs) and as a clean silhouette in the chrome.
- **Onboarding fixes.**
  - **Gateway URL** is a browsable dropdown again — it no longer pre-fills the Unode URL (which hid every
    other option), so both the Unode and Roam default gateways show, and you can still type your own.
  - **Claude Headless** now switches the form: it hides the gateway URL + API key fields and explains it uses
    your `claude` CLI login; saving it makes Anthropic the default provider (no key/URL stored).
  - The setup page opens as a **normal editor tab** instead of forcing a split.
- **Wiki:** links point to Unode and the accent color matches the new logo.

## [0.9.23] — 2026-07-07 · Docs refresh

- **Manual & wiki updated to match 0.9.22.** The in-VSIX user manual (`USAGE.md`) and the wiki now cover the
  new **Marketing** and **Sales** teams, and clarify that the **Anthropic** provider uses the `claude` CLI's
  own authentication — no key is stored in UnodeAi, usage draws from your Claude Pro/Max plan, and your plan
  (not UnodeAi) gates which models you can run. No code or behavior change from 0.9.22.

## [0.9.22] — 2026-07-07 · Marketing & Sales teams, current Anthropic models

- **New default teams: Marketing and Sales.** Two AI-era knowledge teams you can pick when creating a team.
  - **Marketing** — Marketing Director (PM) + Content Strategist, Growth Marketer, Market Researcher, and
    SEO & Analytics Specialist. Follows the 2026 pattern of a lean crew where humans own outcomes and each
    specialist owns a channel of execution.
  - **Sales** — Sales Manager (PM) + SDR, Account Executive, Sales Engineer, and Customer Success Manager —
    the specialized B2B motion from qualified outbound through close to renewal and expansion.
  - Both are classified as knowledge teams, so they get the analysis-oriented Team Rules, and ship with
    seven new marketing/sales skills.

- **Current Anthropic model lineup.** The Anthropic provider's model dropdown was two stale May-2025 IDs;
  it now lists the current API lineup — Fable 5, Opus 4.8, Sonnet 5, Haiku 4.5, plus still-available Opus
  4.7/4.6/4.5 and Sonnet 4.6/4.5 — using the pinned aliases the `claude` CLI resolves. New Anthropic teams
  default to Opus 4.8 (premium) / Sonnet 5 (standard) / Haiku 4.5 (economy). Your Claude subscription still
  gates which models you can actually run.

- **Fix: business teams now actually get business rules.** The team-type detection keyed on the role name,
  but every knowledge specialist's role template is `custom` — so a Business Planning team was misread as
  "software" and seeded the dev rules. It now classifies by each agent's **skill** (business-analysis /
  market-research / financial-modeling / strategy), so knowledge/business teams get the analysis-oriented
  starter rules.

- **Readable dropdowns + real default labels.** Every `<select>` now uses the dedicated dropdown theme
  colors, so the option popup is legible in Cursor and other dark themes (it was white-on-grey before). And
  model-tuning dropdowns now name the actual default instead of a vague "default" — e.g. Reasoning Effort
  shows **Default (medium)**, Response Format **Default (text)**, Streaming **Default (on)**, Thinking
  **Default (off)** — so you never have to guess what "default" resolves to.
- **Easier gateway setup in onboarding.** The setup wizard's **Gateway URL** is now an editable dropdown:
  it defaults to **Unode**, offers **Roam** in the list, and still accepts a custom URL — no more typing a
  full URL from memory. Picking Roam routes the save to the Roam provider (`ROAM_API_KEY`) and makes it your
  default; Unode/custom goes to the Unode provider (`UNODE_API_KEY`). New users land on Unode by default.
- **Security:** re-audited ahead of release — role/model/UI config only; no new network, command-execution,
  MCP, secrets, Workspace Trust, or dependency surface. New team skills grant only existing sandboxed
  read/write/search tools (no shell, no delegate); writes stay locked to the primary folder. See SECURITY.md.

## [0.9.21] — 2026-07-06 · Multi-root file access, team-rule presets & tighter chat

- **Tighter chat bubbles.** Dropped the per-message "You" / agent-name header line — the bubble alignment
  already tells you who's speaking (right = you, left = the agent) — and moved the copy button to each
  reply's bottom-right corner. Every message is now one line shorter.

- **Agents can read/search across more than one folder without widening writes.** The `read_file`,
  `list_dir`, and `search_files` tools now span every VS Code workspace folder plus trusted-only
  `unode.additionalRoots`, while **writes/edits/deletes — and shell commands — stay locked to the agent's
  primary working folder**. Secondary roots are read-only and reachable only through those guarded tools:
  a shell command can't touch them (it could write), and Claude agents are not handed the extra dirs via
  `--add-dir` (which grants write). Secondary roots use the same realpath/symlink escape checks as the
  primary sandbox; `unode.additionalRoots` is off by default and ignored in an untrusted workspace.

- **Claude agents get read-only cross-root file tools.** When extra read roots exist, Claude now receives a
  loopback `unode_files` MCP bridge exposing only `read_file`, `list_dir`, and `search_files`, backed by the
  same read-only `WorkspaceTools` sandbox as OpenAI-compatible agents. Claude's native file tools remain
  scoped to the working folder; `--add-dir` is still never used.

- **Team Rules are team-type aware.** Creating a knowledge/business team (Business Planning, Financial
  Analysis, …) now seeds analysis-oriented starter rules (cite sources, separate facts from recommendations,
  quantify trade-offs) instead of the software crew's dev rules — and **switching teams carries the rules
  over**: if your rules are still an unmodified kind default, they swap to the new team's default (custom
  rules and the strict/lean presets are never touched).
- **Rules button offers presets.** Clicking **Rules** now asks: *Edit rules yourself*, or *Use a rules
  preset…* — a dropdown of prepared templates (Software crew, Business & analysis, Strict quality gate,
  Lean & fast, your current team's kind first). Picking one opens the editor pre-filled so you review and
  save before it replaces anything.

## [0.9.20] — 2026-07-06 · Chat attachments, a smarter PM, provider UX & Solo agent

- **Provider settings UX polish.** The Settings and Agent Builder provider lists now put Unode first and
  Roam second, the Providers tab no longer shows the old global promo banner, and gateway provider cards
  expose host-owned Sign up / Top up and pricing links per provider.
- **Chat attachments.** The chat composer now accepts image/text attachments by button, paste, and
  drag/drop, renders attachment chips in user messages, and inlines text files into turns. Images are sent
  to the model on **both** backends — OpenAI-compatible providers get vision `image_url` parts, and the
  Claude headless backend gets native Anthropic image content blocks over stream-json. Persisted chat
  history keeps only display metadata (name/type + a small thumbnail), never the full image bytes.

- **Every team now ships a standalone Solo agent** — a single no-delegate generalist (read/write/search/
  run) created automatically alongside the crew. For a quick, single-file one-off you can message Solo
  directly instead of the full PM-orchestrated crew, and switch back whenever the work grows. Solo is not
  a crew member the PM delegates to; it stays out of `list_agents` and is never a delegation target, so
  crew orchestration is unchanged.
- **PM chat first-run nudge** — an empty Project Manager chat now shows a one-line hint (with a **Switch
  to Solo** button) explaining that simple tasks can go straight to Solo, skipping delegation overhead.
- **The PM is a collaborator, not a dispatcher.** The Project Manager now right-sizes its response instead
  of fanning out work on every message. Non-tasks (greetings, questions, "does this work?" tests, shared
  content) get a plain reply — no tools. Small, ambiguous, or exploratory asks get a conversation first:
  it answers, proposes an approach, or asks one clarifying question, and confirms scope **before** spinning
  up the crew. Only clear, substantial work triggers delegation (with a one-line heads-up of the plan), and
  only genuinely large/multi-part work triggers the full delegate → review → verify process. No more small
  asks ballooning into bureaucratic multi-agent productions.
- **Reasoning on by default.** `unode.modelDefaults.reasoningEffort` now defaults to `medium` (was off), so
  agents show their analysis/thinking out of the box like other coding agents do. Override per-agent in
  Model Tuning, or set the global default to `""` to turn it off.
- **Compact team panel height tracks the icon count.** Collapsing the Team panel to icons now reflows the
  chips to the panel width and uses only as many rows as the icons actually need — a few take one row, many
  wrap to more — so the panel no longer reserves extra height beyond its content.
- **`run_checks` auto-detects the verify command.** When `unode.verifyCommand` is empty, the PM's checks now
  pick the right command from your `package.json` scripts (test → build → lint, correct package manager)
  instead of failing — no brittle hardcoded default, and never `npx tsc` on a plain-JS project. The
  *automatic* completion gate still stays off until you set a command explicitly. And a genuinely
  misconfigured check (wrong tool, not installed, missing script) is now reported once as a settings
  problem, not looped through phantom "fix" attempts.

## [0.9.19] — 2026-07-05 · Security panel + first-run safety checklist

- **New `UnodeAi: Security` panel** (shield icon in the Team toolbar, or the command palette) — a
  one-screen, live view of the extension's security posture: Workspace Trust state (and what's gated when
  untrusted), the gateway hosts you've approved for network egress (with a **revoke** button per host),
  the hosted-catalog network opt-in, shell-command and file-write approval modes, concurrency, mounted MCP
  servers, and which providers have a key stored (never the value). Makes the safe-by-default behavior
  visible and auditable at a glance.
- **First-run safety checklist.** The setup wizard now has a "Safe by default" step that shows what's
  protecting you out of the box (commands ask first, untrusted workspaces are read-only, no network until
  you approve each gateway, MCP default-deny, keys in SecretStorage) with a one-click shortcut to the
  Security panel.

## [0.9.18] — 2026-07-03 · Provider-neutral wording

- **Provider-neutral setup copy.** The Quick-start key step, the "team/solo created" prompts, and the
  dashboard footer no longer imply a specific gateway is required — they now say to set the API key for the
  provider you select (the Unode gateway by default, or OpenAI, Anthropic, OpenRouter, a partner gateway,
  or any OpenAI-compatible endpoint). Also dropped a stale hardcoded version and an old footer tagline.

## [0.9.17] — 2026-07-03 · Egress consent — nothing leaves the machine until you approve the destination

- **Per-gateway egress consent.** Before any model request is sent, UnodeAi asks once per destination host
  ("about to send this agent's prompt and any workspace files it includes to `<host>` — Allow?"). Nothing
  is transmitted until you approve; the choice is remembered per host. Enforced at every egress point —
  the OpenAI-compatible request path (`fetchOnce`/`fetchStreamOnce`), the chat summarizer, and before the
  Claude CLI is spawned — via a new `onBeforeEgress` hook. Declining aborts the turn with nothing sent.
- **SECURITY.md audit.** Full, verifiable write-up of every network destination, execution surface, secret
  handling, SSRF protection, Workspace Trust behavior, and what the extension does *not* contain — for
  security-conscious users and registry reviewers.

## [0.9.16] — 2026-07-03 · Workspace Trust + opt-in network

- **Workspace Trust support (`capabilities.untrustedWorkspaces: limited`).** In an untrusted workspace,
  UnodeAi runs read-only: agents can chat, plan, read, and search, but **shell commands, file
  writes/edits/deletes, MCP servers, and the verify command are disabled** until you trust the workspace.
  Enforced at every mutation/execution chokepoint (OpenAI-compat `run_command` + `write_file`/`apply_edit`/
  `delete_file`, the Claude `--permission-prompt-tool` gate for both shell and file tools, the verify
  runner, and MCP mount for both backends) and checked live, so granting trust mid-session takes effect
  immediately and re-mounts MCP servers.
  Security-sensitive settings (`unode.allowedCommands`, `commandApproval`, `verifyCommand`, `baseUrl`, …)
  are marked `restrictedConfigurations`, so a repo can't inject them. Virtual workspaces are declared
  unsupported (the extension needs a real filesystem + git).
- **No network by default.** The hosted-marketplace-catalog fetch (`unode.marketplace.fetchCatalog`) now
  defaults to **off** — the bundled catalog works offline and nothing is fetched from the internet unless
  you opt in. Model/pricing lookups still occur only against the provider gateway you configure with a key.

## [0.9.14] — 2026-07-03 · Namespace, icons, and workspace data dir

- **Everything consolidated under the `unode.*` namespace** — view containers (`unode`/`unodePanel`),
  all commands (`unode.*`), the chat participant (`@unode` / `unode.crew`), context keys, and every
  setting (`unode.*`). The activity-bar, editor-title, and Team-view icons use the Unode logomark.
- **Settings carry over automatically.** On first activation, legacy settings are copied to the matching
  `unode.*` key (a one-time, best-effort migration; existing `unode.*` values win).
- **Workspace data dir is `.unode/`.** Team roster (`team.json`), project/shared memory (`rules.md`,
  `memory/`), MCP config, and worktrees live under `.unode/`; a legacy data dir is migrated on activation
  and any git worktrees repaired. The worktree integration branch is `unode/integration`.
- **Providers:** the partner gateway and the other direct providers all keep working
  with their own API keys.

<!-- SHIPPED_CHANGELOG_CUTOFF: the bundled VSIX ships only the entries above this line; the full history
     lives in the repository. Keep this marker directly before the first pre-UnodeAi-era entry. -->

## [0.9.8] — 2026-06-22 · Account balance for every gateway provider (not just Roam)

### Fixed / Added
- **The Providers tab now reads a live balance for *each* provider that has a key — not only Roam.** Previously
  the balance was wired for Roam alone, so **Unode (and any other gateway) was ignored**. Each provider card
  now requests its own balance host-side (its own stored key, never sent to the webview) and shows the same
  *Balance (approx.)* figure + low-balance warning. The balance slot is shown only for the gateways that
  actually expose a readable account balance — **Roam and Unode** (new-api gateways with a single account
  endpoint). Other providers — `custom` (per-agent URL, no single account) and OpenAI/Anthropic/OpenRouter
  (no balance endpoint) — get no slot. Top-up button shows only for Roam (the only promoted sign-up).
  `BalanceService` was already provider-agnostic; this generalizes the wiring + UI.

## [0.9.7] — 2026-06-22 · GA hardening: streaming fix, pricing tolerance, balance, single-gateway polish

Rolls up the 0.9.6/0.9.7 work for a clean commercial build.

### Fixed
- **Streamed tool calls reassemble correctly when the gateway omits `index` on continuation deltas.** Some
  gateways (incl. the weroam endpoint for some models) don't send `index` on argument-continuation chunks;
  the old fallback split one call into many, leaving the named call (e.g. `assign_task`) with **empty
  arguments** — so an agent could run no-arg tools (`run_checks`) but **couldn't delegate**, and a PM would
  spin. Now index-less continuations append to the call in progress. (Root cause of the PM-stall seen in
  dogfooding.)
- **Live pricing is tolerant of gateway response-shape differences** (`LivePriceService`), so Roam prices
  populate from `ai.weroam.xyz/api/pricing` even with minor field variations (falls back to bundled prices).
- Lint cleaned to **zero warnings**.

### Added
- **Roam account balance in the Providers tab** with a low-balance warning + Top-up button
  (`unode.lowBalanceThresholdUsd`; uncapped accounts show "Unlimited"). **Shown as an approximate figure** —
  the gateway's limit/quota semantics for finite accounts are still being validated, so it's labeled
  *Balance (approx.)* and should be treated as an estimate, not exact remaining credit.
- **Catalog signing — transition step (not yet enforced).** Signature *verification* is wired in, but the
  bundled public key is intentionally blank, so **unsigned hosted catalogs still merge** (a missing/failed
  signature is warn-only). This is the groundwork; full enforcement lands once the catalog is signed and the
  key is bundled. Do not treat this release as "signature verification shipped."

### Changed
- **Unode is removed from promotion/marketing only — it remains a fully usable provider.** The Unode
  **sign-up/registration link** is removed from the Providers tab and user-facing docs present only Roam
  (weroam). Unode is **still a selectable provider** (in the new-agent picker, Smart Mode tiers, and the
  Set-Provider-API-Key list) with its own `unode.unodeBaseUrl` setting and `UNODE_API_KEY` — agents migrated
  to it in 0.9.0 keep working, and you can still create/configure Unode agents.

## [0.9.5] — 2026-06-22 · Per-workspace roster migration (Codex follow-up)

### Fixed
- **Old agents in a *second* workspace are now migrated correctly.** The 0.9.0 provider-split migration moved
  two things behind a single **global** flag: the API key (correctly global) *and* the agent roster (which is
  **per-workspace**). So the first upgraded workspace consumed the flag, and an older workspace opened later
  could skip moving its old `roam` agents onto Unode. Split the guards: the **secret move stays global**, the
  **roster move is now workspace-scoped** (and retries next launch if it ever errors). Runtime was always
  safe (Roam never resolves to Unode), but this restores backward-compat for old workspaces.

## [0.9.4] — 2026-06-21 · PM-stall auto-advance nudge (the last orchestration stall)

### Added
- **The PM no longer stops half-done after a teammate finishes.** When a coordinator (PM) delegates work in a
  turn but then ends *without* verifying (`run_checks`) or finalizing — the last known orchestration stall,
  where it would hand back to the user instead of continuing — it now gets a **single, bounded nudge** to
  continue the loop: verify, send to the reviewer, update its todos, and only report the goal complete once
  it's verified (or finalize explicitly if it genuinely is). Fires at most once per turn (no loops), only in
  Act mode, and only for an agent that actually delegated. +tests.

## [0.9.3] — 2026-06-21 · Fix Unode pricing in Agent Builder + Marketplace README links

### Fixed
- **Unode models now show prices in the Agent Builder / model picker.** Pricing was attached only for the
  `roam` provider, so switching an agent to **Unode** showed no prices. Both gateways fetch `/api/pricing`
  into the same table, so prices now show for **roam *and* unode** (still omitted for direct providers like
  OpenAI, where the gateway price wouldn't apply). The legacy add-agent dialog also now resolves a tier model
  for `unode`.
- **README / Marketplace description links updated to weroam.** The store listing still pointed at
  `unodetech.xyz` for the default gateway + pricing; now `ai.weroam.xyz/v1` + `ai.weroam.xyz/pricing`, with
  Unode listed as the separate provider.

## [0.9.2] — 2026-06-21 · Self-heal a stale persisted unode.baseUrl (Codex non-blocking cleanup)

### Fixed
- **A persisted `unode.baseUrl = unodetech.xyz` is now corrected to the weroam default on every launch**, not
  only during the one-time 0.9.0 migration. Users who launched 0.9.0 before the 0.9.1 fix (so their migration
  flag was already set) would have kept the stale value *displayed* in Settings — runtime/pricing were already
  safe, but the stored setting wasn't rewritten. The correction now runs unconditionally and idempotently
  (`correctStaleRoamBaseUrl`), so the Settings UI matches reality for everyone. No-op once the value is canonical.

## [0.9.1] — 2026-06-21 · Fix Roam→Unode leak from a persisted base URL (Codex review)

### Fixed
- **Roam can no longer run on the Unode endpoint** when a workspace has a stale `unode.baseUrl =
  https://www.unodetech.xyz/v1` persisted from before the 0.9.0 split. The base-URL resolver only guarded the
  per-agent URL, not the `unode.baseUrl` *default* it was given — so a persisted unode value slipped through.
  Now `resolveOpenAICompatBaseUrl` forces Roam to the canonical weroam gateway if either the agent URL **or**
  the default would land on unode/OpenAI, and a new `canonicalRoamBaseUrl` sanitizes every site that reads
  `unode.baseUrl` (runtime + pricing). **This also closes a key leak**: the pricing refresh no longer sends
  `ROAM_API_KEY` to a persisted Unode URL. The one-time migration also rewrites a stale persisted `unode.baseUrl`
  to weroam. `unode.unodeBaseUrl` is now honored by the Unode agent runtime too (not just pricing). +regression tests.

## [0.9.0] — 2026-06-21 · Two gateway providers (Roam + Unode) · GA-aligned

A milestone release: the gateway is now **two separate providers**, the project is fully migrated to the
**UnodeTechxyz** org, and everything is aligned for commercial launch.

### Added
- **Two distinct gateway providers.** **Roam (weroam)** is now the **default** — `https://ai.weroam.xyz/v1`,
  pricing at `https://ai.weroam.xyz/pricing?lang=en`, key `ROAM_API_KEY`. **Unode** is a **separate** provider
  — `https://www.unodetech.xyz/v1` (the previous endpoint), key `UNODE_API_KEY`, configurable via
  `unode.unodeBaseUrl`. Both are selectable per agent and **both appear in the Smart Mode tier matrix** (Roam
  first, Unode second). Live pricing is fetched from each gateway's own `/api/pricing` with its own key.

### Changed
- **Default gateway moved from unodetech to the weroam endpoint** for new agents. Provider picker, model
  picker, onboarding, and the Settings/Providers tab now reflect the Roam/Unode split.

### Migration (one-time, automatic, non-destructive)
- On first launch after upgrade: your existing `ROAM_API_KEY` (which was a Unode key) is **preserved as
  `UNODE_API_KEY`**, and existing Roam agents are **moved to the Unode provider** so they keep running
  unchanged on `unodetech.xyz`. To use the new default Roam (weroam) gateway, add a `ROAM_API_KEY` in
  Settings → Set Provider API Key. Nothing is deleted; new agents default to Roam (weroam).

### Repo / GA
- Completed the migration to **github.com/UnodeTechxyz** (unodeai + public unode-skills); docs/wiki updated.

## [0.8.112] — 2026-06-21 · GA repo/URL migration to the UnodeTechxyz org

### Changed
- **Migrated all GitHub references from a temporary personal account to the `UnodeTechxyz` org** ahead of
  commercial launch: `repository.url` → `UnodeTechxyz/unodeai`; the marketplace **catalog URL** →
  `raw.githubusercontent.com/UnodeTechxyz/unode-skills/main/catalog.json`; the **skill library URL** →
  `UnodeTechxyz/unode-skills` (also the hardcoded fallbacks in code, the catalog source comment, contributing/docs).
  New repos created: **UnodeTechxyz/unodeai** (private code) and **UnodeTechxyz/unode-skills** (public catalog).
  `unode.modelCatalogUrl` is empty by default (nothing to migrate). The VS Code Marketplace `publisher`
  (`unode`) is intentionally unchanged — that's a separate store-identity decision.

## [0.8.111] — 2026-06-21 · Changed-files activity on team cards

### Added
- **Each team card now lists the files that agent recently changed** (from its file checkpoints), and clicking
  one opens a **read-only unified diff** of that edit. Makes it obvious at a glance what each agent actually
  touched — orchestration visibility that complements the Dashboard. (Ported + freshened from an earlier
  unmerged branch; pure grouping logic in `checkpointSummary.ts` with tests.)

## [0.8.110] — 2026-06-21 · Smart Mode badge refreshes the team cards immediately

### Fixed
- **Toggling Smart Mode (or editing role tiers / the tier→model matrix) now updates the Team panel cards
  right away.** The `⚡ Smart → <model>` badge wasn't appearing because nothing refreshed the Team view when
  the Smart Mode settings changed — the cards only re-rendered on some other event. The config-change
  listener now refreshes the Team view on `unode.smartMode.*` and `unode.modelTiers` changes (covers both the
  Settings-panel toggle and raw settings.json edits).

## [0.8.109] — 2026-06-21 · Concurrency mode = a Team title-bar icon (no more chip row)

### Changed
- **The concurrency-mode indicator/toggle is now a single icon in the Team panel's title bar** instead of a
  full-width chip row: **📄 (files) = Optimistic**, **⎇ (git-branch) = Worktree** — the icon reflects the
  current mode and clicking it switches (same git-init / Optimistic prompt for a non-git worktree). Frees up
  the row it used to occupy. The Dashboard still shows the mode as a status line.

## [0.8.108] — 2026-06-21 · Remove the *remaining* workingDirectory pins (Codex follow-up #2)

### Changed
- **Three more creation paths no longer pin `workingDirectory`** — completing the cleanup for real this time
  (verified by a codebase-wide grep, not a claim): team-preset / default-team creation (`unode.createTeamPreset`),
  solo-agent creation (`unode.startSolo`), and the legacy add-agent dialog (`unode.addAgent`), all in `dialogs.ts`.
  The only place that now sets a working directory is the runtime (`SessionManager` writes the resolved root
  onto the per-session `runConfig`). Added regression tests asserting team and solo creation leave
  `workingDirectory` unset even with a workspace folder open.

## [0.8.107] — 2026-06-21 · Finish "don't pin workingDirectory" (Codex follow-up)

### Changed
- **Removed the last two places that pinned a per-agent `workingDirectory`** at creation, completing the
  runtime-invariant cleanup: the Agent Builder no longer sets it to the workspace-at-save, and Marketplace
  installs no longer pass a `cwd`. New agents are created with no pinned root; the runtime resolves it per
  session (`SessionInfo.runtimeWorkingDirectory`). The chat preflight outside-root check also **no longer
  falls back to the persisted `config.workingDirectory`** (which could be a stale pin from an older build) —
  it uses the runtime root, else the current workspace.

## [0.8.106] — 2026-06-21 · Concurrency-mode indicator + one-click toggle

### Added
- **You can now see — and switch — the concurrency mode at a glance.** The **Team panel** shows a chip
  (**⚙ Optimistic mode** / **⎇ Worktree mode**) that's **clickable to toggle** between them; the **Dashboard**
  shows the same status as a line. Switching to Worktree on a non-git folder reuses the git-init / "Switch to
  Optimistic" prompt. Also available from the command palette ("UnodeAi: Toggle Concurrency Mode"). This
  surfaces the runtime contract (how agents share the workspace) instead of leaving it hidden in Settings.

## [0.8.105] — 2026-06-21 · Runtime-invariants hardening: one working-directory truth

### Changed
- **Completed the "one runtime root" hardening pass** (per a review of the working-directory drift behind the
  "outside working folder" failures). `workingDirectory` is **no longer pinned/persisted** onto an agent at
  save time — it went stale when the agent later ran in another folder. The runtime resolves the root each
  session (worktree path or current workspace) and records it on `SessionInfo.runtimeWorkingDirectory`, the
  single source of truth already used (0.8.103) for grounding, chat preflight, and delegation-path
  normalization. Locked with tests: the backend is built with the same root the session reports; the
  persisted config stays clean; and **Smart Mode's per-turn `setModel` only swaps the model — it never
  restarts the session, recreates the backend, or mutates the working directory.**

## [0.8.104] — 2026-06-21 · Fix the thinking-model "reasoning_content" 400 + one-click git init

### Fixed
- **Thinking-model agents no longer fail with `"reasoning_content … must be passed back"`** (seen on the
  reviewer via the unodetech gateway). Splitting a parallel tool-call turn dropped `reasoning_content` from
  the 2nd+ segment, so the gateway rejected the next request; the split now **preserves `reasoning_content`
  on every segment**. Added a **self-heal** for that 400 too — it flattens the conversation and retries once
  (the same recovery as the assistant-prefill 400), so a delegation doesn't fail-then-need-a-lucky-retry.

### Added
- **One-click "Initialize Git" on the worktree warning.** When `worktree` mode is set on a non-git workspace,
  the warning now offers **Initialize Git** (runs `git init` + writes a safe `.gitignore`) alongside "Switch to
  Optimistic." It does not auto-commit — you review and commit, then worktree isolation engages.

## [0.8.103] — 2026-06-21 · One source of truth for an agent's working directory (Codex review)

### Fixed
- **Workspace grounding + chat preflight now use the agent's ACTUAL runtime root**, not the global workspace.
  In worktree mode a worker is sandboxed to `.unode/worktrees/<id>`, but 0.8.101 grounded it to the global
  workspace root — telling an isolated worker the wrong folder so its shared-path use got (correctly) blocked.
  The resolved root (worktree path or current workspace) is now recorded once on the session as
  `runtimeWorkingDirectory` and used for grounding, the chat preflight outside-root check, and diagnostics —
  ending the drift between the persisted-config root, the backend/tool root, and the grounding root. The
  worktree path is **never** written back into the persisted roster.
- **Delegated instructions are normalized to workspace-relative paths.** When the PM hands a task containing a
  shared-root absolute path (e.g. `C:\…\src\file.ts`) to a worktree-isolated worker (whose root differs), the
  path would land outside its sandbox and the shell guard would block it. Such paths are now converted to
  workspace-relative before dispatch, so they resolve in any agent's root. +tests for all three.

## [0.8.102] — 2026-06-21 · Warn when worktree mode can't engage (no git repo)

### Added
- **A one-time warning when `concurrencyStrategy: worktree` is set on a non-git workspace.** Worktree
  isolation needs a git repo, so it silently fell back to the shared workspace (only logged to the Output
  channel). Now a toast explains it and offers a one-click **"Switch to Optimistic"** (or run `git init` +
  commit to enable isolation). Fires once per session. +test.

## [0.8.101] — 2026-06-21 · Tell agents their real working directory (curb the `/Users/dev/...` confabulation)

### Changed
- **Agents are now explicitly told their working directory** ("Your working directory is `<root>` … you are
  NOT in a `/Users/.../workspace-…` sandbox"). Claude models are trained in a Linux sandbox and confabulate a
  `/Users/dev/workspace-<random-id>/` folder — both when asked and as path prefixes. File ops were already
  re-rooted to the real workspace (so edits/tests worked), but the model would still *report* a fake folder;
  this grounding reduces that. (Won't 100% stop a model from improvising in prose, but it's much less likely.)

## [0.8.100] — 2026-06-21 · Agents always root at the current workspace (fixes stale "outside working folder")

### Fixed
- **Agents now operate on the currently-open workspace, not a stale folder.** A per-agent `workingDirectory`
  was pinned to the workspace at agent-creation time and persisted, so an agent created/edited while a
  *different* folder was open carried that old folder — and then couldn't reach the open project's files
  ("I can't reach that path — it's outside my working folder"), while another agent created in the right
  folder worked. Non-worktree agents now always root at the **current** workspace folder at runtime
  (overriding any stale persisted value, and never `process.cwd()`). No reset needed — it applies on the
  next turn. (Complements 0.8.99, which covered the git-worktree + untracked-files case.)

## [0.8.99] — 2026-06-21 · Worktree mode no longer isolates agents away from uncommitted files

### Fixed
- **The "I can't reach that path — it's outside my working folder" failure in worktree mode.** Worktree
  cleanliness only checked *tracked* changes (`--untracked-files=no`), so **freshly-created, never-committed
  source files** (e.g. a `src/app.js` an earlier agent wrote) were invisible to the check — a worktree got
  created off HEAD **without those files**, and an agent isolated there couldn't find/edit them (the PM could
  still *read* them via the shared overlay, which is why it looked inconsistent). Cleanliness now counts
  genuinely-untracked files too (still ignoring `.unode/`/`.vscode/` state), so worktree mode **falls back to
  the shared workspace** when there's uncommitted/untracked work — agents see the files. Commit your work to
  enable per-agent worktree isolation. (The `/Users/dev/...` path some Claude models show is an unrelated
  model quirk — they hallucinate a Unix sandbox prefix that Roam re-roots to your real workspace.)

## [0.8.98] — 2026-06-21 · Team cards show the true Smart Mode model

### Added
- **When Smart Mode is on, each Team card shows the model the agent will actually run**, not just its
  configured one: `Model: <configured>  ⚡ Smart → <tier model>`. If the agent's provider has no model set
  for its tier, it shows `⚡ Smart (configured)` (it keeps the configured model — matching the 0.8.94
  runtime). Smart Mode off → just the configured model, as before.

## [0.8.97] — 2026-06-20 · Honest per-provider prices + "in use" provider marker

### Fixed
- **Model prices no longer show the Roam-gateway price for other providers' models.** The price table is the
  Roam/Unode gateway's, so it only applies to Roam models — model pickers (Agent Builder + Smart Mode tier
  matrix) now show a price **only for Roam models**, and **omit it** for OpenAI/Anthropic/OpenRouter/etc.
  (and for any model with no known price) rather than display a misleading number.

### Added
- **The Providers page marks which providers are actually in use** — a green **"● in use"** pill + left
  accent on any provider assigned to at least one agent, so it's obvious at a glance.

## [0.8.96] — 2026-06-20 · Host the catalog in the public unode-skills repo (it was dormant)

### Fixed
- **The hosted marketplace catalog now actually loads.** It pointed at the **private** `unodeai` repo, whose
  `raw.githubusercontent.com` URL 404s for everyone — so since 0.8.89 every install silently fell back to the
  bundled catalog and live updates never worked. `unode.marketplace.catalogUrl` now points at the **public
  `unode-skills`** repo (`…/unode-skills/main/catalog.json`). Source-of-truth + CI stays in
  `unodeai/marketplace/catalog.json`; **publishing = committing that file to `unode-skills`.** (Until that
  file exists in unode-skills it stays on the bundled catalog — offline-safe.)

## [0.8.95] — 2026-06-20 · Hosted catalog pinned to a deliberate `catalog-release` branch

### Changed
- **The hosted catalog is now served from a dedicated `catalog-release` branch, not `main`.** Publishing an
  offering change is now a deliberate act (move/commit `catalog-release`), so a random dev commit to `main`
  never reaches installs — an extra supply-chain guard on top of the 0.8.94 force-approval. Fetch failures
  still fall back to the bundled catalog. (Still migrates to the weroam org + can be pinned to a SHA/signed
  at GA.)

## [0.8.94] — 2026-06-20 · Harden MCP approval + correct Smart Mode runtime (Codex review)

### Security
- **A hosted/mutable catalog can no longer suppress the MCP approval modal.** `requiresApproval: false` no
  longer bypasses approval for **sensitive** servers — any **stdio (subprocess), remote, or env-bearing** MCP
  server now **always** shows the approval modal (with its exact command/URL) before first mount. Since the
  catalog fetches from a mutable URL and hosted entries win on id, this prevents a tampered entry from
  silently mounting or swapping an MCP command. *Behavior change:* bundled "safe" servers (Memory, Sequential
  Thinking, Time, Everything) now ask once on first mount; approve-for-project still remembers them.

### Fixed
- **Smart Mode no longer swaps to a wrong-provider model id at runtime.** If an agent's provider has no model
  set for the selected tier, Smart Mode now **keeps the agent's configured model** instead of falling back to
  another provider's id (which would 400) — both for normal turns and the economy/summarization model. This
  matches the tier-matrix warning. Fill the provider's column to enable the swap.
- **Smart Mode per-agent "→ model / ⚠ warning" labels now update live** after a tier or matrix edit, instead
  of going stale until the panel is reopened (the no-re-render tab-jump fix left them static). Recomputed
  client-side from the live controls.

## [0.8.93] — 2026-06-20 · Tier matrix: live model picker per provider

### Added
- **The Smart Mode tier matrix now suggests each provider's real model ids.** Every cell is bound to a
  per-provider `<datalist>` populated from that provider's live `/v1/models` (the same source the Agent
  Builder uses), so you pick the provider's **exact** id instead of typing — directly handling the
  cross-provider naming difference (e.g. `claude-opus-4-8` vs `anthropic/claude-opus-4`). You can still type
  a custom id. Pairs with the 0.8.92 fallback warnings.

## [0.8.92] — 2026-06-20 · Smart Mode handles provider-specific model ids

### Fixed
- **Smart Mode now flags when an agent's provider has no model set for its tier**, instead of silently
  showing another provider's id that would 400. Model ids are provider-specific (e.g. `claude-opus-4-8` on
  Roam/Anthropic vs `anthropic/claude-opus-4` on OpenRouter); the per-role rows now show `→ <model>` only on
  an **exact** provider+tier match, otherwise a red *"no &lt;provider&gt; model for &lt;tier&gt; — set it in
  the tier matrix"* warning. The tier matrix also carries a note to use each provider's exact id and fill the
  column for every provider your agents use.

## [0.8.91] — 2026-06-20 · Smart Mode: no tab-jump on tier edits + per-agent provider shown

### Fixed
- **Setting a role's tier no longer bounces you back to the Providers tab.** Each Smart Mode change
  re-rendered the whole Settings panel (resetting the active tab); it now persists the change in place, so
  you can set every role's tier in one sitting without the panel jumping. (Same re-render class as the
  earlier form fixes.)

### Added
- **Per-agent provider is now visible in Settings → Smart Mode and the model-tuning cards.** Each agent row
  shows its **provider** and the **model its tier resolves to on that provider** (e.g. `pm · roam → claude-opus-4-8`).
  Agents can each use a **different provider** (already settable in the Agent Builder's Provider field) — Smart
  Mode resolves each agent's tier→model via *its* provider, so you can run model A on whichever provider is
  cheapest for it and model B on another. This just surfaces it.

## [0.8.90] — 2026-06-20 · Agent Builder: changing the role loads that role's full template

### Fixed
- **Picking a different role in the Agent Builder now updates everything** — instructions, model, provider,
  tools/skills, icon, and color — instead of leaving the instructions (and most fields) untouched. Switching
  TO a custom role clears the prompt and shows the required hint. Smart preservation: a name you typed and an
  image icon you uploaded are kept; auto-filled role values are replaced. The **initial** render still keeps
  an existing agent's saved values (edit mode isn't clobbered). +test.

## [0.8.89] — 2026-06-20 · Hosted marketplace catalog (update offerings without a VSIX)

### Added
- **The MCP / agent / skill offerings can now grow without shipping a new extension.** A starter hosted
  catalog ([marketplace/catalog.json](marketplace/catalog.json)) is served from GitHub raw and **merged over
  the bundled catalog at startup** (hosted entries win on id collisions). Edit + commit that file to push
  new or corrected offerings to all installs live. `unode.marketplace.catalogUrl` now defaults to it;
  `unode.marketplace.fetchCatalog` (default on) controls the merge. Offline-safe: any fetch/parse failure
  falls back to the bundled catalog, and one bad section never blanks the rest. +CI test that the hosted
  file parses with the same validators.

### Notes
- The catalog URL (and `unode.marketplace.skillLibraryUrl`) point at the **temporary `a personal account` GitHub**;
  both **migrate to the `weroam` org at the v1.0 release** (tracked in the roadmap's GA-logistics row).

## [0.8.88] — 2026-06-20 · Fix the Sequential Thinking MCP server (wrong npm package name)

### Fixed
- **"Sequential Thinking" now mounts.** The Marketplace catalog shipped the wrong npm package —
  `@modelcontextprotocol/server-sequentialthinking` (no hyphens) is a **404**, so `npx` exited immediately
  and mounting failed with *"MCP error -32000: Connection closed."* Corrected to
  `@modelcontextprotocol/server-sequential-thinking`. Audited the rest of the MCP catalog — all other npm
  package names resolve. +regression test that fails if the 404 name reappears.

## [0.8.87] — 2026-06-20 · Security: ask mode no longer auto-runs shell-chained commands (Codex review)

### Security
- **An allowlisted prefix can no longer smuggle a chained/redirected command past the prompt.** In `ask`
  mode, `npm test && npm publish` started with the allowlisted `npm test ` and was silently allowed — so the
  unapproved `npm publish` ran. `ask` mode now applies the same shell-control guard as `allowlist` mode: a
  command containing `; & | > < \` $( ${` is **never auto-run from a prefix match** — it falls through to the
  approval prompt (the user can still approve it; catastrophic patterns remain hard-blocked). +tests.

### Fixed
- **The "Enable Safe Commands" set and the new-install default no longer drift.** `SAFE_COMMAND_TEMPLATES`
  is now the single source of truth and `unode.allowedCommands`'s default mirrors it (a test enforces it).
  Both gained the common non-destructive verify/lint tools (`npm ls`, `npm audit`, `pnpm/yarn test`,
  `npx eslint/prettier/vitest`, `tsc`, `eslint`, `prettier`, `go vet/build`, `cargo check`) and dropped the
  `git branch` prefix footgun (it matched `git branch -D`).

## [0.8.86] — 2026-06-20 · Audit: no other form loses unsaved input on navigation

### Fixed
- **Settings panel no longer wipes unsaved model-tuning edits** when you click a navigation action
  (Browse MCP Marketplace / Open native settings / Sign up / Open team file / Reset). It used to re-render
  the whole panel after *every* message; those actions change nothing it displays, so they now return
  without re-rendering — the same fix class as the Agent Builder form (0.8.85).

### Audited (no change needed)
- Reviewed every webview form. **Marketplace, Workflow Editor, Team Rules, Onboarding wizard, and Chat**
  all update via incremental `postMessage` (never rebuild their HTML after an action), so they don't lose
  in-progress input. Only the Agent Builder (0.8.85) and Settings (this release) had the re-render-on-action
  pattern.

## [0.8.85] — 2026-06-20 · Agent Builder: keep the form on Marketplace round-trip + custom-role hint

### Fixed
- **The in-progress agent form is no longer wiped when you visit the MCP Marketplace.** Clicking "Browse MCP
  Marketplace…" re-rendered the builder immediately (a leftover from the old blocking input box), erasing
  everything you'd typed. It no longer re-renders — the webview is kept alive across the round-trip, and the
  MCP grant list refreshes on return, so your name/role/instructions/model/selections survive and the newly
  installed server appears as a grantable checkbox.

### Added
- **Prominent "required" hint beside the Instructions title for a custom role** — a custom role has no
  default system prompt, so the builder now clearly says instructions are required (or the agent can't be
  created), shown the moment you pick "Custom role." +tests.

## [0.8.84] — 2026-06-20 · Reset button is now visibly a destructive action

### Changed
- The Settings → **"Reset workspace state…"** button now uses a **red/danger style** (instead of the muted
  secondary look) so it's easy to find — it clears the team, chat, message log, conversations, workflows,
  and approved MCP servers, then reopens the Setup wizard.

## [0.8.83] — 2026-06-20 · Agent Builder: clear save errors + MCP grants via the Marketplace

### Fixed
- **The Agent Builder now says *what* is wrong on save** instead of a generic "invalid save payload." It
  names the missing/invalid fields — e.g. *"please fill in: System prompt, Custom role name"* — which was
  the wall users hit building a custom-role agent (a custom role needs a name + a system prompt).

### Changed
- **"Add MCP server…" → "Browse MCP Marketplace…"** in the Agent Builder. It now opens the **MCP
  Marketplace** (its MCP tab) instead of a raw spec input box. After you install a server there, returning
  to the builder **refreshes the MCP-grants list automatically** (without wiping your in-progress form), so
  the new server appears as a grantable checkbox.

## [0.8.82] — 2026-06-20 · Better default allowlist (smoother inner loop, still safe)

### Changed
- **`unode.allowedCommands` default refined** to cover the agent's non-destructive inner loop across more
  ecosystems, so fewer needless prompts without auto-running anything risky. Added `git show`, `npm ls`,
  `npm run test`, `npm run typecheck`, and verify commands for Python/Go/Rust (`pytest`, `go test`,
  `go vet`, `cargo test`, `cargo check`) alongside the existing JS/TS verify + read-only git/npm set.
  Still **non-destructive only** — installs, commits/pushes, deletes, deploys, and bare `npm`/`git`/`npx`
  are deliberately excluded (they prompt; grow per-repo via "Allow for project"). Only seeds **new**
  installs; existing users keep their setting. Also clarified the setting's description (it's the
  pre-approved set in `ask` mode too, not just `allowlist` mode).

## [0.8.81] — 2026-06-20 · Command policy now applies live (the "Ask each never prompts" root cause)

### Fixed
- **`unode.commandApproval` / `unode.allowedCommands` edits in Settings now take effect immediately** — no
  window reload needed. The live `CommandPolicy` only reloaded via the approval-bar dropdown, "Allow for
  project", or `unode.enableCommands`; a Settings-UI edit was **silently ignored** until restart. So emptying
  the allowlist (or switching to "ask") didn't actually re-gate anything, and — combined with an earlier
  "Allow for project" that had added e.g. `npm install` to the allowlist — non-allowlisted commands kept
  running with no prompt. Added an `onDidChangeConfiguration` handler that reloads the live policy on those
  keys (logs `[policy] reloaded …` to the Output channel). +test for re-gating an emptied allowlist.

## [0.8.80] — 2026-06-20 · Harden the 0.8.79 permission gate (Codex review)

### Fixed
- **No dangling `--permission-prompt-tool` when the MCP config can't be written.** If `.unode/mcp.json`
  couldn't be written (e.g. an unwritable working directory), claude got a permission-tool name for a server
  it never mounted. The orphaned local servers are now stopped and neither `--mcp-config` nor
  `--permission-prompt-tool` is emitted in that case.
- **Failed `claude` spawn no longer leaks a local server or config file.** Startup mounts the
  permission/team-bridge servers before spawning; on a spawn error (missing/broken `claude` binary) the
  `exit` handler never fires, so cleanup is now done explicitly in a try/catch — stopping the servers and
  removing `.unode/mcp.json` — then the error is rethrown. (Pre-0.8.79 this leaked only the PM bridge; 0.8.79
  widened it to every non-autoApprove Claude agent.)
- **Shell-tool gating is case-insensitive**, so a differently-cased tool name can't slip a command past the
  approval gate ungated. +tests for all three (write-failure, spawn-failure, case normalization).

## [0.8.79] — 2026-06-20 · Unified command approval — Claude agents now honor "Ask each" too

### Added
- **Claude agents' shell commands now go through Roam's approval card**, closing a real gap (and a
  security-misperception): Claude agents run under the `claude` CLI's own `--permission-mode`, so their
  `Bash` commands previously **bypassed `unode.commandApproval` entirely** — "Ask each" never applied to
  them. Each Claude agent now mounts a per-agent MCP **permission-prompt tool** (`--permission-prompt-tool`)
  that routes shell commands through the **same `CommandPolicy` + approval card** as OpenAI-compat
  `run_command`: allowlisted commands run silently, others prompt (Allow once / session / project / Deny),
  blocked ones are denied. Agents with **auto-approve on** stay in `bypassPermissions` (no gate), matching
  the toggle's meaning.
- **Approval cards now name the requesting agent** — "**Senior Developer** wants to run `npm install`"
  instead of "An agent". The approval bar is panel-global, so a teammate's request is visible **from any
  chat view** (you don't have to be looking at that agent). Applies to `run_command`, `run_checks`, and the
  new Claude gate.

### Notes
- "Ask each" means *ask for each not-yet-approved command*; the 9 defaults in `unode.allowedCommands`
  (`npm test`, `npm run build`, `npx tsc`, `git status/diff/log`, …) run without prompting. Empty that list
  to be asked for literally everything.

## [0.8.78] — 2026-06-20 · Fix the PM verify deadlock — run_checks now prompts in `ask` mode

### Fixed
- **The PM no longer deadlocks at the verification step.** With `unode.commandApproval: ask` (the default),
  `run_checks` checked the policy and **dead-ended** with *"blocked … awaiting user approval"* — but unlike
  `run_command`, it never actually **showed an approval card**, so there was nothing to approve. The PM's
  fallback (`npm test` via `run_command`) is delegate-gated for a coordinator, so the PM had **no path to
  verify** and stalled before the reviewer (anti-spin then blocked it entirely). `run_checks` now uses the
  **same `ask`-mode approver as `run_command`**: it prompts, runs the verify command when approved, and on
  denial returns the user's note instead of a dead-end. Observed with an **Opus** PM, so this was a
  framework gap, not a model limitation. +tests.

## [0.8.77] — 2026-06-20 · Assistant-prefill 400 self-heal: flatten to a valid user-ending conversation

### Fixed
- **Stronger fix for the "must end with a user message" 400** (follow-up to 0.8.76). Appending a user
  message after a `tool_result` created two consecutive user turns in the Anthropic translation, which the
  gateway *also* rejects — so the turn still wedged. The self-heal now **flattens the tool history** (drops
  tool_results, turns assistant tool-call turns into short text notes, **merges consecutive same-role turns**
  for valid alternation) and ends on a user message, then retries once. Lossy (tool detail → summary) but it
  produces a conversation `claude-sonnet-4-6` (and similar) actually accept, instead of failing the turn.

## [0.8.76] — 2026-06-20 · Self-heal the "assistant message prefill / must end with a user message" 400

### Fixed
- **A gateway/model that rejects a conversation ending with a tool_result (or assistant turn) no longer
  wedges the turn.** Some models via the Anthropic-translating gateway (observed: `claude-sonnet-4-6`)
  return *"does not support assistant message prefill; the conversation must end with a user message"* when
  we send a history that ends on a `tool_result`. The backend now detects that 400 and **appends a short
  user message so the conversation ends with `user`, then retries once** (bounded, per turn). It also
  proactively never sends a trailing **empty** assistant turn, and dumps the role/tool_use_id sequence to
  the Output channel on this 400 (same diagnostic as the tool-pairing 400) so it can be matched to a gateway
  request id. +tests.

## [0.8.75] — 2026-06-19 · Diagnostic: dump the message pairing on a tool-pairing 400

### Added
- **When the gateway rejects a request with the tool-pairing 400** (`unexpected tool_use_id … no
  corresponding tool_use`), the Output channel now logs the **role / tool_use_id sequence we actually
  sent**, with any orphan `tool_result` flagged `⚠ORPHAN`. This lets a 400 seen in the gateway backend (by
  request id) be matched to the exact message that broke pairing — turning a guess into a precise
  diagnosis. (Only logs when that specific 400 occurs; the self-heal flatten + retry still runs.)

## [0.8.74] — 2026-06-19 · PM: call list_agents once, then delegate (deliberate role discovery)

### Changed
- **The complex-task PM now calls `list_agents` exactly once to learn the team, then delegates by role —
  and never re-lists.** (Follow-up to 0.8.73, by request.) Makes role discovery deliberate rather than
  delegating blind and relying on the wrong-role error to correct it, while still killing the loop/stall:
  any further urge to "check the team" means `assign_task` now, not re-list. The simple-task fast path is
  unchanged (delegate in one call, no `list_agents`).

## [0.8.73] — 2026-06-19 · PM no longer loops list_agents / over-explores on a complex task

### Fixed
- **A complex (escalated) task no longer makes the PM loop `list_agents` and stall.** The full-process
  prompt literally said "Call list_agents to see who is available", which invited a model to call it
  repeatedly (observed: 5× until anti-spin blocked it, then an idle stall — and, while exploring, the PM
  also hit a hallucinated-absolute-path "can't reach" give-up). The step now says: **delegate directly by
  role — do NOT call `list_agents` first or loop it, and do NOT explore the repo to "get oriented"; assign
  the task and let the specialist read what it needs.** This removes the fixation point that stalled the
  escalation path (independent of model).

## [0.8.72] — 2026-06-19 · Table parser: handle escaped/code pipes + ragged rows (Codex review)

### Fixed
- **Markdown table cells with a `\|` escaped pipe or a pipe inside inline code (`` `a|b` ``) no longer split
  into extra columns.** The parser scanned every `|` as a delimiter; it now ignores escaped pipes and pipes
  inside backtick code spans. Body rows are also normalized to the header's column count (short rows padded,
  long rows truncated) so a ragged table still aligns. +regression tests.

### Docs
- Added **Sandboxed execution** to the post-1.0 roadmap (paired with the Headless CLI + Enterprise-lite),
  with the rationale (it matters once a human leaves the approval loop) and a Docker-opt-in-first path.

## [0.8.71] — 2026-06-19 · Render Markdown tables in the chat

### Added
- **The chat now renders GFM tables** (`| a | b |` with a `|---|:--:|---:|` separator) as real tables —
  previously they showed as raw pipes. Column alignment (`:--`, `:-:`, `--:`) is honored, and inline
  formatting (bold/links/code) works inside cells. A stray `|` in prose is not mistaken for a table.
  Brings the chat closer to Claude Code / Codex / Kilo for comparison tables and structured output.

## [0.8.70] — 2026-06-19 · Gate the PM's own write tools behind "no teammate" (it must delegate)

### Changed
- **A PM with teammates can no longer do file edits / run commands itself — it must delegate.** The prompt
  alone wasn't enough (a model would still self-edit using its always-available write tools). Now, when a
  coordinator that **has teammates** calls a write/command tool (`write_file`, `apply_edit`, `delete_file`,
  `run_command`, …), the call is **bounced with a "delegate this with assign_task" message instead of
  executing** — so the work flows through the crew, the verifier gate, and per-agent attribution. The tools
  stay in the PM's set (so an aliased `Edit` resolves cleanly and never hits the "unknown tool" error that
  used to trigger a refusal), but *using* them is redirected to delegation. With **no teammates**, the PM's
  file tools execute as a genuine fallback. Read tools (`read_file`/`list_dir`/`search_files`) are not gated.
  This makes the PM a true orchestrator — the self-do path is **Solo mode**.

## [0.8.69] — 2026-06-19 · PM delegates by default (resolve the "did it itself" inconsistency)

### Changed
- **The PM now delegates *every* task, including a one-line edit, instead of sometimes doing it itself.**
  Two earlier directives conflicted: 0.8.59 told the PM "you may make a trivial change yourself" (added to
  dodge a refusal), while 0.8.67 made the default "delegate in one step". The model resolved that by
  self-editing — which bypasses the crew, the verifier gate, and per-agent attribution (the whole
  multi-agent point). Both the role line and the PM template now say: delegate by default; your own file
  tools are a **fallback only**. The PM keeps write/execute capability purely as a **safety net** (so a model
  that instinctively reaches for `Edit` gets an `apply_edit` success rather than a refusal-triggering error),
  but its first move is always `assign_task`.

## [0.8.68] — 2026-06-19 · Code-review fixes (queued-slot leak on failed start; narrower refusal detector)

### Fixed
- **A queued delegation's token slot no longer leaks if the worker never starts.** The dispatch-time slot
  reserved for a queued async delegation (0.8.62) was only released on agent *removal*. If the lazy
  `start()` failed (or the queued worker was stopped without removal), the slot stayed reserved, the root
  task's active count never hit zero, and the task never appeared in "Latest tasks" (and the tracker kept an
  open task forever). Centralized into `cancelQueuedTaskWork()` — used on **remove** and now on
  **lazy-start failure** — which releases the slot and finalizes/notifies if that completes the task.
- **The tool-distrust refusal nudge no longer flags legitimate "run it in your terminal" answers.** Phrases
  like *"run `npm test` in your terminal"* were treated as a refusal, so a correct answer to "how do I run
  the tests?" could get nudged. Now the unambiguous signals (prompt-injection / hooks / "not my toolset")
  match outright, but the "run it manually" phrasing only counts **alongside a refusal signal** ("I can't",
  "instead", "not part of my tools", …). +false-positive tests.

## [0.8.67] — 2026-06-19 · PM boundary = default-delegate + 4 concrete escalation triggers

### Changed
- **Replaced the PM's "simple vs complex" judgment with a default + explicit triggers.** Asking the model
  to classify a task as "simple" was itself a deliberation point (it just moved where a weak model dithers).
  Now the PM's **default is to delegate in ONE `assign_task`**, and it escalates to the full multi-step
  process **only** when it clearly sees one of four concrete triggers: (a) multiple distinct deliverables,
  (b) multiple files that must stay consistent, (c) an explicit ask for tests and/or review, or (d) an
  open-ended/large goal ("build X", "refactor the codebase"). "Do I see one of these 4 things?" is far
  cheaper for a weak model than "is this simple?" — which is the point of the weak-model-first design.

## [0.8.66] — 2026-06-19 · PM "fast path" so a CHEAP model can coordinate a simple task

### Changed
- **The PM now has a fast path for simple requests**, so coordinating a one-line edit doesn't require a
  premium model. The old prompt made the PM wade through 8 heavyweight steps (todos → architect contracts →
  list_agents → parallel fan-out → checks → review) for *every* request, which made weaker models dither
  (e.g. GLM looping "read first? list first?"). Now: for a single simple task, the PM is told to call
  **one `assign_task`** immediately — no reading files, no `list_agents`, no todos — and the full process is
  reserved for genuinely multi-step/multi-file work. This is the thesis (strong framework lets a weak model
  do the job), not "throw a bigger model at it". (The default PM model stays Opus for now as a safe
  out-of-box default; the goal is to validate a cheap model as the default with this fast path.)

## [0.8.65] — 2026-06-19 · Default the PM to Claude Opus 4.8 (a reliable orchestrator)

### Changed
- **The default Project Manager model is now `claude-opus-4-8` (was `claude-sonnet-4`).** Side-by-side
  testing showed some smaller/older Claude snapshots (e.g. Sonnet 4.x) cling to a "Claude Code" identity as
  a coordinator — reaching for Edit/Bash, refusing, and crying "prompt injection" — while **Opus 4.8
  delegates cleanly** (read → assign_task → verify → report) through the same gateway. The PM is the brain
  of the crew, so it now defaults to the strongest reasoner that *also* orchestrates reliably. (Non-Claude
  models like GLM also complete the job; Claude models remain excellent as the executor/developer roles.)
  Existing teams are unchanged — this only affects newly-created default crews; you can set any agent's
  model in **Edit Agent**.

## [0.8.64] — 2026-06-19 · Push back on the "your tools are fake, run it yourself" refusal + helpful delegate errors

### Fixed
- **A model that refuses by claiming its tools are faked now gets pushed back to using them.** When a model
  ends a turn insisting a tool result is a "prompt injection" / a "hook", that its real tools are
  Edit/Write/Bash, or telling the user to run a command **manually** — instead of doing the work — the
  backend now detects that and nudges once (bounded): "your tools are real and working; do the task now
  with apply_edit / write_file / assign_task; if a call failed, fix its arguments and retry." A behavioral
  guardrail like the announce-nudge, for the Claude-Code-identity refusal.
- **Delegation errors now name the available teammates.** `assign_task` with an empty/unknown target used
  to say only "no teammate '' — call list_agents"; it now says **which roles you can delegate to** (e.g.
  "Specify which teammate by role: senior-dev, reviewer …"), so a model that calls a delegate tool without
  a target can recover in one step instead of giving up.

## [0.8.63] — 2026-06-19 · Tell Claude models they're in UnodeAi, not Claude Code (stop the false "prompt-injection" alarm)

### Fixed
- **A Claude PM no longer cries "prompt injection / check your hooks" — even when its tool call succeeded.**
  A Claude model believes it is *Claude Code*, so it pattern-matches any unfamiliar tool shape or message
  to "a hook is faking my tools" and refuses, telling the user to check their hooks — observed **even after
  the `Edit` succeeded** (the line was actually written). The system prompt now states plainly that the
  agent runs **inside UnodeAi, not Claude Code**, that there are **no hooks** intercepting/faking tools,
  that every tool result is genuine, and that it must **never** call a result a "prompt injection" or tell
  the user to check their hooks. Pairs with the 0.8.59 softened corrective + working-lead PM.

> If you hit this on a chat that started before 0.8.59, the model may still anchor on the earlier narrative
> in its history — a **new chat** on 0.8.63 avoids it entirely.

## [0.8.62] — 2026-06-19 · Code-review fixes for 0.8.55–0.8.58 (queued-delegation tokens, narrower webview perms)

### Fixed
- **"Latest tasks" no longer drops tokens for an async delegation to a STOPPED/queued worker.** A task is
  now bound to its root **at dispatch time** (when the delegator is still in its turn) instead of when the
  worker's turn finally starts — and a slot is reserved then — so a PM that `assign_task_async`s to a
  stopped teammate and finishes first still has the worker's usage attributed to the task when it runs
  later. (0.8.58 handled the case where the worker had already started; this covers the queued path.) A
  removed-before-running worker releases its slot. +tests.

### Changed
- **The Agent Builder webview narrows `enableCommandUris`** from "all commands" to just
  `['unode.openSettings']` (the one link it uses) — least-privilege for a panel rendering dynamic content.
- Added a **regression test** that saves an agent with every Settings tuning field through the Agent
  Builder and verifies none is dropped (the clobber risk was already fixed at HEAD in 0.8.60–0.8.61).

## [0.8.61] — 2026-06-19 · Agent edit: add Stream + Context window (complete fine-tuning parity)

### Fixed
- **Completed the Agent edit ↔ Settings fine-tuning parity** (follow-up to 0.8.60): added the remaining two
  fields — **Stream** and **Context window (tokens)** — to the Agent edit page. Context window persists to
  the agent's `contextWindowTokens` (via `sanitizeContextWindow`), `stream` joins the model params. The
  Agent edit page and the Settings panel now expose an identical set.

## [0.8.60] — 2026-06-19 · Agent edit: model fine-tuning now matches the Settings panel

### Fixed
- **The Agent edit page's Model fine-tuning section was missing fields** the Settings panel had. Added
  **Response format, Thinking (+ budget), Tool choice, and Stop sequences**, so the two entry points show
  the same set. Both now parse through the same `sanitizeParams`, so editing an agent in either place
  produces identical stored params (smoke finding 1b).

## [0.8.59] — 2026-06-19 · PM is a working lead (fixes the Claude-PM "prompt-injection" refusal)

A Claude PM, told to delegate, would instead reach for `Edit`/`Write`/`Bash` to do a small edit itself.
Because the PM was deliberately write-less, the tool-name aliases couldn't fire, so it got an "unknown
tool — you are a COORDINATOR" corrective — which a Claude model reads as a **prompt-injection attack** and
**refuses**, telling you to check your hooks. Fighting a frontier model's "I edit files directly" instinct
with prompts kept losing.

### Changed
- **The Project Manager is now a working lead, not a pure delegator.** It gains `write` + `execute`, so a
  trivial edit it attempts **just works** (`Edit`→`apply_edit`, `Bash`→`run_command`). Its prompt still
  steers it to **delegate substantial / specialized / parallel work** to teammates — it only acts directly
  on small things (a one-line edit, reading a file, running checks). The team, verifier-gate, and
  orchestration are unchanged; build a pure-delegator custom agent if you want one.
- **The unknown-tool corrective no longer asserts the model's identity/environment** ("you are a COORDINATOR
  in UnodeAi"). It now just states the available tool names — so a Claude model stops treating it as an
  injection and recovers instead of refusing.

## [0.8.58] — 2026-06-19 · Code-review fixes for 0.8.54–0.8.57 (recovery loop, async token attribution, Settings link)

### Fixed
- **Request-body recovery now loops** instead of retrying once. A custom gateway can reject several
  incompatible fields in sequence (e.g. `parallel_tool_calls`, then `reasoning_effort`); `chat()` now
  applies at most one recovery per failed attempt, rebuilds the body, and retries until none applies (capped).
  Previously the second rejection escaped. +test.
- **"Latest tasks" no longer drops async-delegation tokens.** A task is finalized only when the root turn
  has ended **and** every inherited turn has too — so a worker dispatched with `assign_task_async` that
  finishes *after* the PM's turn is still counted (previously its usage was dropped). +test.
- **The Agent Builder's "Manage in Settings →" link now works** — the panel was created without
  `enableCommandUris`, so the Smart Mode link was inert. Enabled it.

## [0.8.57] — 2026-06-19 · Agent edit: per-agent model fine-tuning + Smart Mode tier override

### Added
- **Model fine-tuning in the Agent edit page.** Editing an agent now exposes its per-agent sampling/reasoning
  settings — temperature, top-P, max output tokens, reasoning effort, presence/frequency penalty. Blank =
  use the global default. It writes the same `modelParams` the Settings panel edits for that agent, so the
  two stay in sync.
- **Per-agent Smart Mode tier override.** A tier selector (Premium / Standard / Economy, or "Use role
  default") on the agent. When Smart Mode is on, the agent runs on the model mapped to **its** tier, which
  **overrides the role tier** — so two same-role agents can run at different tiers. The tier→model mapping
  stays global (a link opens Settings → Smart Mode). Routing now checks `config.tier` before the role tier.

## [0.8.56] — 2026-06-19 · Self-heal a wedged tool-call history (tool-pairing HTTP 400 backstop)

### Fixed
- **A session whose tool-call history the gateway can't pair now recovers automatically.** If a request is
  rejected with `unexpected tool_use_id … no corresponding tool_use block in the immediately-preceding
  message` despite the pre-send normalizers (e.g. a chat restored from a snapshot taken on an older build),
  the backend now **flattens the tool structure** — drops tool results and turns each prior assistant
  tool-call turn into a short text note — and **retries once**. It's lossy (some tool-call detail becomes a
  summary line) but it **unwedges the session** instead of failing every turn. One self-heal per turn.

> If you hit this on a chat that started before 0.8.54, this release recovers it on the next message; a
> brand-new chat avoids the wedged history entirely.

## [0.8.55] — 2026-06-19 · Code-review fixes for 0.8.52–0.8.54 (task-token attribution + parallel_tool_calls fallback)

### Fixed
- **"Latest tasks" no longer cross-counts concurrent tasks.** Per-task token usage was computed by diffing
  *every* session's cumulative usage over the task window, so two user tasks running at once on different
  agents each absorbed the other's tokens. Attribution is now **by origin**: a user turn roots a task and
  delegated turns inherit their delegator's task, so each turn's tokens land on the right task. Extracted to
  a unit-tested **`TaskTokenTracker`** (covers the two-overlapping-tasks case).
- **`parallel_tool_calls: false` no longer hard-fails stricter gateways.** Some OpenAI-compatible/custom
  endpoints 400 on the unknown field. We now **drop it and retry once** for that session (same pattern as
  `reasoning_effort`); `splitParallelToolCalls` still guarantees valid tool pairing without it. +regression
  test with a fake "unknown field parallel_tool_calls" 400.
- **`splitParallelToolCalls`** now preserves the original assistant message's fields on its first split
  segment instead of rebuilding a bare message.
- **Per-task token state is cleared when an agent is removed** mid-task (no leak / mis-attribution).

## [0.8.54] — 2026-06-19 · Fix the parallel-tool-call HTTP 400 (orphan tool_result, "immediately-preceding message")

### Fixed
- **A model making parallel tool calls in one turn no longer 400s the gateway.** When a model emits several
  `tool_calls` in a single assistant message, OpenAI answers them with several `tool` messages — but an
  Anthropic-translating gateway requires each `tool_result` to sit in the message *immediately after* its
  `tool_use`, and orphans the 2nd+ result (`unexpected tool_use_id … no corresponding tool_use block in the
  immediately-preceding message`). Now the request:
  - sends **`parallel_tool_calls: false`** so models make one tool call per turn (prevention), and
  - **splits any parallel turn already in history into sequential `assistant → tool` pairs** before sending,
    giving strict 1:1 adjacency that any gateway accepts (cure — also unwedges a session that already
    recorded a parallel turn).

This is the same 400 family as 0.8.48's orphan-result fix, but its real cause was parallel tool calls, not
just stray results.

## [0.8.53] — 2026-06-19 · Dashboard "Latest tasks" — per-task token usage, broken down by agent

### Added
- **A "Latest tasks" panel on the Dashboard** showing your most recent user-initiated tasks, each broken
  down by the agents that worked on it — a token bar per agent (hover for input/output split + cost), plus
  the task's total tokens and cost. Unlike a single total, this shows **where** the tokens went across a
  PM-led multi-agent run. A task spans the user's request and all the delegated sub-work it triggered;
  per-agent numbers are computed as the usage delta over the task window.
- **Configurable count** via a **Show last: 3 · 5 · 10 · 20** control in the panel header (persisted). The
  Dashboard now re-renders live as tasks complete.

## [0.8.52] — 2026-06-19 · Ground every agent with the real workspace file listing (root cause of the path hallucination)

Side-by-side, a Claude-powered Roam agent could fail "show me the README" while Cline/Kilo (on weaker
models) succeeded — because they **show the model the workspace files** and Roam did not. Told only the
root path string, a strong model confabulates a path from its training prior (e.g.
`/Users/dev/workspace-xxxx/README.md`). That's a grounding gap, not a model-quality gap.

### Fixed
- **The model now always sees a real, relative file listing of your workspace** (the working directory +
  files, respecting your `files.exclude`/`search.exclude`, skipping `node_modules`/`.git`/build dirs,
  capped). It's injected every turn and **on by default** — previously workspace orientation was gated
  behind `unode.engine.workspaceContext` (default off) and, even when on, only included the active editor
  file + diagnostics, never a file list. Now an agent knows `README.md` exists and uses the exact relative
  path instead of inventing one. (The richer diagnostics + active-file context stays opt-in via that flag.)

Together with 0.8.51's path re-rooting (the safety net), this closes the "outside your working folder"
give-up: the model is grounded so it won't confabulate, and if it ever does, the path is re-rooted.

## [0.8.51] — 2026-06-19 · Re-root hallucinated absolute paths (the PM "outside your working folder" give-up)

### Fixed
- **A model that prepends a foreign sandbox prefix to a path no longer dead-ends the turn.** Claude models
  (and others) sometimes call a file tool with an invented absolute path like
  `/Users/dev/workspace-xxxx/README.md` instead of the relative `README.md`. That tripped the
  outside-workdir boundary, which is a **terminal** block — so the PM gave up and told you to "open the
  folder as the workspace" instead of just editing the file. Roam now **re-roots** such a path to the
  matching file **inside** the workspace (longest in-sandbox path suffix that actually exists), so it just
  works. Security is preserved: re-rooting only ever resolves *inside* the sandbox, it's existence-gated
  (a genuine outside path with no in-workspace twin still hits the boundary block), and the
  symlink/junction realpath checks still run downstream.
- **Clearer boundary message.** When a path truly can't be reached, the block now leads with "retry with a
  path relative to the workspace root" instead of "do not try another path" — and the system prompt tells
  models to never invent or prepend an absolute path.

## [0.8.50] — 2026-06-19 · Code-review fixes for the aliasing + apply_edit work (0.8.41–0.8.49)

### Fixed
- **`apply_edit` now runs the symlink/junction sandbox check BEFORE reading the file** (matching
  `write_file`). Previously it resolved + read first, so a workspace symlink to an outside file could let
  `apply_edit` *probe* whether `old_string` was present (and how often) before the eventual write was
  blocked. Closed, with a symlink regression test.
- **Verification bookkeeping now uses the EFFECTIVE (post-alias) tool name.** A model running its check
  via a native name like `Bash` (aliased to `run_command`) now correctly satisfies the verify obligation —
  before, a genuinely-verified edit could still trip the "⚠ Changes not verified" path because the
  bookkeeping compared the model's raw name.
- **Targeted edits show as file edits in the UI.** `apply_edit` is now classified as an `edit` activity
  (category, summary, and target), so it renders like a write instead of generic tool activity.

## [0.8.49] — 2026-06-18 · Tool-name aliasing (any model's muscle memory just works) + apply_edit

Roam is built to run *many* models, and each model is trained on its own harness's tool names. Rather
than fight that variance one model at a time, the framework now **absorbs** it.

### Added
- **Cross-model tool-name aliasing.** When a model calls a tool by a name from another harness —
  `Read` / `Bash` / `Write` / `Edit` / `LS` / `Grep` / `Task` (Claude Code, Cursor, GPT, etc.) — Roam now
  **transparently maps it to the real tool and shims the arguments** (`file_path`→`path`,
  `command`, `old_string`/`new_string`, …). The model's muscle memory just works instead of erroring,
  so no call is wasted re-discovering the right name. `Task`→`assign_task` only for coordinators.
- **`apply_edit` — a targeted edit tool.** Replace an exact snippet in a file (`old_string`→`new_string`,
  with `replace_all`) instead of resending the whole file with `write_file`. It validates the match is
  present and unique, then writes through the **full safety path** (compare-and-swap, truncation guard,
  write-approval, checkpoint/restore). It's also the alias target for a model's native `Edit`/`str_replace`,
  and it's safer than whole-file writes for small changes.

This makes a Claude-model **senior developer** (not just the PM) reliable: when it reaches for `Edit` to
change a file, the edit lands — no "unknown tool", no wasted turn. It's the first of the model-variance
levers (aliasing → `apply_edit` → model-profile registry → conformance harness).

## [0.8.48] — 2026-06-18 · Claude-model PMs use the real tools + delegate; fix orphan-tool_result 400

### Fixed
- **Claude models (e.g. Sonnet/Opus) as the PM no longer flail with Claude Code's native tools.** They
  would call `Glob` / `Bash` / `Read` / `Edit` / `Task` / `edit_file` — none of which exist in UnodeAi —
  get a bare "unknown tool", and stall. Now: (a) the system prompt lists the real tools and explicitly
  says *don't* use those names, (b) a coordinator is told up front it **delegates with `assign_task` and
  has no write tool**, and (c) an unknown-tool call returns a **corrective listing the real tools** (and,
  for a coordinator, "delegate with assign_task") so the model recovers instead of looping.
- **Fixed `HTTP 400 … unexpected tool_use_id … must have a corresponding tool_use in the previous
  message`.** A malformed/blocked tool exchange could leave an **orphan `tool_result`** (an id with no
  matching `tool_use`), which an Anthropic-translating gateway rejects. The pre-request self-heal now
  drops orphan and duplicate tool results (and still backfills missing ones).

## [0.8.47] — 2026-06-18 · Zero-data-retention statement on the feature page

### Docs
- Added a precise **"Zero data retention & no telemetry"** statement to the README (Marketplace feature
  page), the wiki, and the user manual: the extension itself keeps no copy of your code/prompts and has
  no analytics/tracking/phone-home; code is sent only to the model provider you configure; and because
  UnodeAi works with any OpenAI-compatible endpoint, you can self-host / use an in-VPC model for
  provable end-to-end zero-retention. (Scoped to the extension — the gateway/provider's retention is the
  customer's choice.)

### Changed
- **Delegation now prefers a FREE teammate over a BUSY one.** When several teammates share the target
  role, the runtime router picks one that isn't currently running a task (idle **or** stopped — a stopped
  agent is free and auto-starts on assignment), round-robining among the free ones. If *every* candidate
  is busy, the least-loaded / least-recently-assigned gets it and the task simply queues (delay expected).
  Previously a `stopped` teammate was wrongly treated as "unavailable" and skipped in favor of a *busy*
  running one; now only a truly **errored** teammate is excluded. The PM still just delegates by role —
  the runtime does the load-aware selection (and logs *why* in the route audit). (张's feedback.)

## [0.8.45] — 2026-06-18 · PM delegates instead of stalling on "stopped" teammates

### Fixed
- **The PM now delegates instead of getting scared off by `stopped` teammates.** `list_agents` reported
  each teammate's status (`stopped`/`idle`), which a coordinator read as "unavailable" — so it looped
  `list_agents` and announced "let me delegate…" without ever issuing `assign_task`. Teammates are
  **lazily started on assignment** (a delegated task auto-starts a stopped agent), so the status was both
  misleading and irrelevant to the PM. `list_agents` now omits it and tells the PM to **delegate now —
  the teammate starts automatically**. Pairs with the 0.8.44 anti-spin guard so a trivial PM task
  actually lands.

## [0.8.44] — 2026-06-18 · Stop agents spinning on a succeeding tool (PM looping list_agents)

### Fixed
- **An agent can no longer burn its whole turn re-calling the same succeeding tool.** The PM would call
  `list_agents` a dozen times and stall ("I'll create a plan and delegate… let me first check…") without
  ever delegating, because the circuit-breaker only counted *failing* repeats. Now an identical
  (name+args) call that has already run a few times this turn is blocked with a firm corrective —
  *"you have the result; act now — delegate (assign_task), write the file, or run the command"* — so the
  coordinator actually moves to the next step instead of looping to the iteration cap.

## [0.8.43] — 2026-06-18 · Team Pack verify-command prompt is now unmissable

### Changed
- **Picking a Team Pack now shows the verify-command setup as a modal**, not a corner toast you could
  miss. When no `unode.verifyCommand` is set it asks (modal) to set the pack's recommended one and confirms
  when you do; when a different one is set it asks **Replace / Keep Existing** (modal); and when it's
  already the pack's command it confirms the gate is wired (no silent no-op). The choice is still yours —
  it just can't slip by unnoticed.

## [0.8.42] — 2026-06-18 · Fix HTTP 400 on Claude-backed gateways + MCP prerequisite hints

### Fixed
- **The PM no longer crashes with `HTTP 400 … text content blocks must be non-empty`** on the default
  premium path (a Claude-backed model via the Roam/unode gateway). A tool-call-only assistant turn was
  stored with `content: ""`, which OpenAI allows but an Anthropic-translating gateway rejects as an empty
  text block. The pre-request self-heal now nulls empty assistant content that carries `tool_calls` (and
  gives an empty tool result a marker), so the multi-agent loop works end-to-end on Claude routes.

### Added
- Marketplace MCP cards now show display-only **prerequisite hints** before install — the bundled Git,
  Fetch, SQLite, and Time entries are marked **"⚠ Requires uv"** (derived from the `uvx` command), while
  install actions and MCP configs are unchanged. (Codex; reviewed.)

## [0.8.41] — 2026-06-18 · Actionable MCP mount errors (missing command)

### Fixed
- **A stdio MCP server whose command isn't installed now fails with a clear, actionable message** instead
  of the opaque "Connection closed". A pre-flight PATH check names the missing tool and how to get it —
  e.g. the catalog's **Git / Fetch / SQLite / Time** servers run via `uvx`, so without `uv` installed
  you now see *"Git needs uv (the Python tool that provides uvx) — install it: https://docs.astral.sh/uv/"*
  in both the toast and the output channel. (npx-based servers like GitHub/Filesystem/Memory are
  unaffected — they only need Node.)

## [0.8.40] — 2026-06-17 · Worktree lanes keyed by agentId (last review fix)

### Fixed
- Worktree review lanes and Mission Control worktree badges now associate by stable `agentId`, not
  display name, so same-named or renamed agents keep View diff / Re-verify / Hand back, verified
  status, and files-touched on the correct lane. (Closes the last item from the Codex code review.)

## [0.8.39] — 2026-06-17 · Codex review fixes (gate honesty + data-loss guards)

### Fixed
- **Verifier-as-gate no longer treats a policy-blocked check as a pass.** When a configured
  `unode.verifyCommand` is blocked by command policy (can't run), the PM completion gate now says
  **"NOT verified"** with how to fix it, the **worktree gate holds the merge** instead of merging
  unverified work, and the **Evidence Report shows 🚧 Blocked**. (A *missing* command still proceeds —
  there's genuinely nothing to gate on.)
- **Status-bar version now stays visible** — it was immediately overwritten by the agent-count update
  (so 0.8.34's "always-visible version" didn't actually stick). The version rides alongside the count now.
- **Cost-savings is honest** — the premium baseline is the *true* estimate (not `max(premium, actual)`),
  and the Dashboard shows a real "saved $X" **or** "cost $Y over baseline" instead of always claiming savings.
- **Evidence Report counts only this run's files** — it filtered nothing before, so the persisted
  checkpoint store leaked files changed by *earlier* tasks into the report.
- **Agent Builder won't wipe a legacy agent's tools** — editing an agent that has `allowedTools` but no
  skill metadata no longer strips its capabilities (e.g. a PM losing delegate/message) on save.
- **MCP install reports the real outcome** — "added but not mounted (approval skipped)" / "failed to
  mount" instead of always claiming success.
- **Team Packs gate out of the box** — `npm run lint` / `npm audit` are in the default command allowlist,
  so the Refactor and Security Review packs' verify commands actually run in worktree mode.

## [0.8.38] — 2026-06-17 · Crew Mission Control (per-agent lane board)

### Added
- **Mission Control now opens as a per-agent lane board**: each agent row shows status, current task,
  files touched, cost, context usage, Chat/Terminal actions, and worktree verification/mergeability
  when worktree mode is active. The existing cost-savings banner stays above the lanes, and Evidence
  Report is one click from the board. Reuses the live delegation tracker + checkpoints + worktree review
  (no new tracking); the panel stays script-free (command-URI links only).

## [0.8.37] — 2026-06-17 · Evidence Report (the verifier-gate made tangible)

### Added
- **Generate Evidence Report** (Command Palette or the Team toolbar 📋) turns the crew's recent run into
  a skimmable Markdown report: a **Verdict** (✅ Verified / ⚠ Unverified / 🚧 Blocked), **Work done**
  per agent (task + outcome + fix-cycles), **Files changed**, and **Verification** (it runs your
  `unode.verifyCommand` and shows pass/fail with the failing output). It gathers from the live delegation
  tracker + file checkpoints, so the "done" claim comes with evidence — not just the agent's word.

## [0.8.36] — 2026-06-17 · Team Packs + guided Add-MCP form

### Added
- **Task-oriented team packs** now appear in the Create or Switch Team picker, grouped separately from
  knowledge-work presets. Bugfix, Refactor, Test Writer, Release, and Security Review crews compose
  existing roles only and can set a recommended `unode.verifyCommand` for the verification gate (offered,
  never silently overwriting an existing one).
- **Add MCP Server is now a guided form** for name, transport, endpoint, env placeholders, and approval,
  with an escape hatch to open `.unode/team.json`. Env values reject literal secrets and only persist
  `${VAR}` placeholders before routing through the existing MCP persist/mount approval path.

## [0.8.35] — 2026-06-17 · Cost-savings visualization on the Dashboard

### Added
- **The Dashboard now shows what mixed-model routing saved you.** Alongside actual spend, Roam prices the
  *same tokens* against a top-tier model and surfaces a banner: *"Mixed-model routing saved you $X (N%
  off) — all-premium baseline $Y vs your actual $Z."* Makes the cheap-model cost arbitrage concrete
  instead of abstract. (The baseline accrues from this build forward, so it populates as agents run turns.)

## [0.8.34] — 2026-06-17 · Always-visible Roam version in the status bar

### Added
- **The build version now shows in the status bar** (`⬡ Roam v0.8.34`), always visible no matter which
  sidebar sections you've collapsed — so folding the Team panel (which folds away its title-bar version)
  no longer hides what build you're on. One click reopens the UnodeAi sidebar. (VS Code folds a view's
  title-bar actions/version with the section when collapsed and doesn't let an extension pin them open;
  the status-bar anchor is the always-on alternative.)

## [0.8.33] — 2026-06-17 · Mission Control icon themes to the editor title bar

### Fixed
- The **Mission Control icon** in the editor title bar now ships **theme-aware light/dark variants**
  (was a single `currentColor` SVG that didn't invert against the title bar) — so it's clearly visible
  on both light and dark themes.

## [0.8.32] — 2026-06-17 · Agent Builder model combobox + security-by-default narrative

### Changed
- **Agent Builder's model + backup-model pickers are now a single type-to-filter combobox** (was a
  separate search box + dropdown). Start typing to filter the live priced catalog; pick a suggestion or
  hand-type a custom model id. Same in Build and Edit Agent.
- **README "Security by default" section reframed** as a first-class selling point — sandbox, commands
  off by default, tool-layer Plan mode, MCP default-deny, SecretStorage keys, verified-only landing, no
  telemetry — so the trust story is front and center, not buried in settings.

### Docs
- Refreshed `docs/BACKLOG.md` + `docs/STATUS.md`: v0.9 weak-model hardening is **complete** (all 6 items
  shipped across 0.8.x) plus this cycle's moat/GA work; the boards now show the **1.0 commercial punch-list**.

### Added
- **A UnodeAi brand icon now sits in the editor title bar** (top-right, where Claude/Copilot/Kilo put
  theirs). One click opens **Mission Control** — the UnodeAi Dashboard — as an editor tab, so the
  crew view is reachable without hunting through the Command Palette. (`unode.openMissionControl`, also
  in the Command Palette.)

### CI / Release process
- CI now gates on **`npm audit --omit=dev` (high)** and runs a **headless VS Code E2E** job that
  packages the bundled VSIX and smoke-tests activation/commands/panels/onboarding under xvfb — so a
  vulnerable shipped dep or a broken bundle fails the build, not the user. (Fixed the Linux extraction:
  a `.vsix` is a zip, so the smoke unpacks with `unzip` off Windows since GNU tar can't read it.)
- Added a human-run GUI release-smoke checklist
  (provider switching, CLI auth, MCP grant, edit-running-agent, Smart Mode, the verifier gate, Router
  audit) to run against the bundled VSIX before a GA publish.

## [0.8.30] — 2026-06-17 · Router v1 audit accuracy

### Fixed
- **The Router audit log no longer claims a route that didn't happen.** Previously the
  `Routed … [async]` line was logged *before* the async file-claim gate, so a delegation rejected by a
  file conflict still produced a (false) audit entry. The audit now fires only after the task is
  actually dispatched, on both the sync and async paths — keeping the log truthful, which is the whole
  point of Router v1. (Found by Codex review.)

## [0.8.29] — 2026-06-17 · Router v1: auditable, availability-aware delegation

### Added
- **The PM's agent selection is now explainable and avoids dead teammates (Router v1).** When the PM
  delegates by role, Roam now (a) **hard-filters out stopped/errored teammates** when a live one shares
  the role — so work never goes to a down agent — and (b) logs a one-line **audit reason** to the Roam
  Crew output channel for every routing decision, e.g. `Routed "senior-dev" → senior-dev-2 (idle,
  least-recently-assigned, 1 of 2)`. Selection stays role/idle/round-robin based, but it's now
  reproducible and inspectable instead of opaque. (Capability/MCP-aware scoring is a planned v2.)

## [0.8.28] — 2026-06-17 · GA hardening: bundled VSIX + clean security audit

### Security
- **Cleared the high-severity `hono` advisory** (`npm audit --omit=dev` → 0 vulnerabilities). The
  vulnerable code reached us transitively through the MCP SDK; we only use the MCP **client** transport,
  not hono's affected server features (serve-static / Lambda adapters / CORS middleware), so it was never
  reachable — and an `overrides` bump to the patched `hono@4.12.25` removes it outright.

### Changed
- **The extension now ships as a bundled VSIX** (~560 files / ~1.3 MB, down from ~3,900 files / ~5 MB).
  The release path is `npm run publish:bundle` (esbuild single-file bundle + ajv only), which also keeps
  heavy/vulnerable transitive `node_modules` out of the shipped package. Verified by the bundle smoke
  test (activation, command registration, Settings/Workflow panels, onboarding).

## [0.8.27] — 2026-06-17 · Verifier-as-gate on the default PM path (the moat)

### Added
- **The PM can no longer report a goal "done" while the project checks are red.** On the normal
  (optimistic/shared-tree) path, when a coordinator finishes a turn, Roam runs the objective checks
  (`unode.verifyCommand`). If they fail, the PM is sent back to fix it on a **bounded, deadlock-proof
  ladder**: a couple of same-target fix cycles → escalate to a stronger/different teammate → and if it
  still can't pass, **hand the task back to you** with the failing output and concrete options (retry
  stronger / reassign / take over). It can never loop forever — once the retry budget is spent it always
  hands off. This complements the existing worktree-merge gate (which already blocks failing lanes before
  merge); together they make "only verified work lands" true on both paths.
- New settings: `unode.gate.enabled` (default true), `unode.gate.maxSelfRetries` (2),
  `unode.gate.maxRedelegations` (1). The gate is a no-op unless `unode.verifyCommand` is set, and is
  skipped in worktree mode (already gated at merge) and for non-coordinator agents.

## [0.8.26] — 2026-06-17 · Weak-model "read the code first" rule + Smart Mode per-turn model

### Added
- **New worker rule: "Ground the task in the REAL code before you act."** Weak models tend to go
  straight from instruction → code without reading what's actually there. Every worker/solo agent now
  gets a firm protocol rule to first read the files the task touches, reconcile the instruction with the
  real structure/types/conventions (and not invent APIs or paths), stop and flag a genuine conflict
  instead of forcing a bad change, and match the surrounding code. Coordinators are unaffected.

### Fixed
- **Smart Mode no longer mutates the agent's configured model.** Tier selection for a task is now
  applied per-turn (request-scoped) instead of via `setModel`, so a Smart Mode turn can't leak the
  tier model into `AgentConfig.model` and get persisted by a later roster save. Cost is priced at the
  model actually used for the turn. (Found + fixed by Codex; reviewed.)

## [0.8.25] — 2026-06-17 · Marketplace install UX honesty

### Fixed
- **The MCP card's "Extension / Current team" scope dropdown is removed** — it was a no-op (the install
  path always added the server to the current team's `.unode/team.json` and ignored the choice). The card
  now just says "Adds to this team."
- **The Marketplace Add button now reflects the real outcome.** Previously it flipped to "Installing…"
  then back to "Add" on a fixed 1.2s timer regardless of what actually happened — so a cancelled URL
  prompt, a declined approval, or a failed mount all looked like success. It now locks while the host
  works and then shows **Added ✓** or **Retry** based on the actual result (per-card), with the
  notification still carrying the detail.

## [0.8.24] — 2026-06-17 · MCP Marketplace deep-link

### Changed
- The **Browse MCP Marketplace** button (Settings → MCP Servers) now opens the Marketplace **directly on
  its MCP tab** instead of the default Agents tab. `unode.openMarketplace` accepts an optional tab
  argument (`'agents'` | `'mcp'`), validated and defaulted so an unknown value still lands on Agents.

## [0.8.23] — 2026-06-17 · Agent-card tooltips + MCP Marketplace shortcut

### Added
- **Hover tooltips on agent-card action buttons** (Start / Stop / Restart / Chat / Edit / Terminal /
  Remove) explaining what each does — including the data-loss caveats (Stop keeps the conversation,
  Remove deletes it).
- The **MCP Servers** tab in Settings now has a **Browse MCP Marketplace** button that opens the
  Marketplace, where curated MCP servers install in one click and then appear in this tab ready to grant
  to an agent.

### Docs
- Removed **Google** from the provider API-key table in the manual — it (and Ollama) were hidden from
  the provider pickers in 0.8.21 since there's no working backend path for them.

## [0.8.22] — 2026-06-17 · Sign-up/top-up links + Agent Builder edits apply live (U4)

### Added
- The **Providers** tab in Settings now has **Sign up / Top up** buttons that open registration in your
  browser — Roam Gateway (ai.weroam.xyz) or Unode (unodetech.xyz) — so new users can get an account and
  credits without leaving the editor. The URLs are host-owned (the webview only sends a key), so the
  panel can't be turned into an arbitrary-link opener.

### Fixed
- **Agent Builder edits now apply to a running agent.** Editing a live (idle/running) agent's model,
  system prompt, skills, tool protocol, or **MCP grants** restarts its backend so the changes take
  effect immediately (conversation context is preserved via the session snapshot). Previously the
  running agent silently kept its old config until manually restarted. Stopped/starting/stopping/error
  sessions are left untouched. (U4 — Claude-found.)

## [0.8.21] — 2026-06-17 · Provider-switch + Smart Mode fixes

### Fixed
- Fixed provider switching edge cases: OpenRouter is now treated as an API-key OpenAI-compatible
  provider in Settings and gets native Smart Mode tier models, unsupported catalog-only providers are
  hidden from provider pickers, and Smart Mode no longer claims to hot-swap already-running Claude CLI
  sessions.

## [0.8.20] — 2026-06-17 · Orchestration visibility (U2) + custom agent icons (U3)

### Added
- Added orchestration visibility for delegated crew work: Chat now shows live delegation cards, the
  Activity panel summarizes fan-out progress with done/total counts and per-agent states, and Team
  cards/chips use clearer Idle/Working/Blocked/Done status wording driven by the existing message bus.
- Added custom agent image icons: Agent Builder can upload PNG, JPEG, WebP, or SVG files under 64 KB,
  stores them as `AgentConfig.icon` data URIs, and renders them in Builder preview, Team cards/chips,
  and Chat avatars while preserving emoji/codicon text icons.

## [0.8.19] — 2026-06-17 · Activity feed in the bottom Panel (U1)

### Added
- Added a second live **Activity** copy of the UnodeAi Messages feed in the bottom Panel (where the
  Terminal/Output live), giving the multi-agent feed full editor width. The sidebar Messages view
  remains in place; both views share the same provider/feed and stay in sync for live updates,
  clear/import/export, and compact mode. Phased rollout — if the Panel proves the better home we can
  retire the sidebar copy later.

## [0.8.18] — 2026-06-17 · Agent Builder defaults tool-calling to Auto

### Fixed
- **Agent Builder no longer forces new agents onto native tool-calling**, which quietly bypassed the
  0.8.14 protection. The Tool-calling method now defaults to **Auto** (persisted as "unset"), so a
  builder-made Kimi/Moonshot/GLM/MiniMax agent correctly starts in XML and skips the first-turn
  tool-call stall. Explicit **Native**/**XML** are still honored. (Found by Codex review.)
- Synced `package-lock.json`'s version with `package.json` (was stale at 0.8.0) — release-metadata hygiene.

## [0.8.17] — 2026-06-17 · First-run setup cards are clickable

### Fixed
- **The three cards on the Welcome / Setup screen now work.** "Set a provider", "Create your team", and
  "Get moving" looked clickable but were inert `<div>`s — clicking them did nothing. They're now buttons
  that jump straight to the matching step (provider / team / demo). (You could already advance with
  "Get Started"; the cards just weren't wired.)

## [0.8.16] — 2026-06-16 · Restored sessions are flagged as possibly stale

### Fixed
- **An agent restored from a previous session no longer quotes stale memory as current.** A restored
  conversation can carry old file contents, versions, and command output in its history — which is how
  the PM once reported a remembered `package.json` version. On restore, the conversation is now flagged
  with a note telling the agent the prior context predates this session and to re-read a file (or re-run
  a check) before citing it. The structural backstop to the 0.8.11 "cite from a fresh read" rule;
  context is kept (crash recovery still works), just marked. Completes the stale-memory hardening.

## [0.8.15] — 2026-06-16 · Agents know the project layout

### Changed
- **Every agent is now told the project's structure, not just its build/test commands.** The
  auto-detected conventions block (already injected) gains a **project-layout map**: the detected stack
  (TypeScript, test framework) and the real top-level directories, plus a rule to put new files under an
  existing directory and verify a path exists before writing — instead of inventing one (which led an
  agent to write data into a non-existent `src/marketplace/`). Part of the 0.9 weak-model hardening.

## [0.8.14] — 2026-06-16 · Leaky models start in XML

### Changed
- **Known tool-call leakers now start on the XML tool protocol from turn one.** Models like Kimi/K2,
  Moonshot, GLM, and MiniMax reliably emit their tool calls as text instead of the native `tool_calls`
  field, which made native function-calling stall until the first leak flipped them to XML (Option 4).
  They now begin in XML, skipping that stalled turn. DeepSeek (the high-volume default) and frontier
  models stay native; an explicit **Tool calling** setting in the Agent Builder still overrides this.
  Part of the 0.9 weak-model execution hardening.

## [0.8.13] — 2026-06-16 · Guard against catastrophic file truncation

### Fixed
- **`write_file` now blocks a catastrophic whole-file truncation.** `write_file` replaces the entire
  file, so a weak model that treats it like a patch tool can wipe a large file (we saw a ~97 KB source
  replaced with ~2 KB). A write that shrinks a substantial existing file (≥4 KB) to under 20% of its size
  is now rejected with a corrective telling the agent to re-read and supply the full content (or use
  `delete_file` if removal was intended). Thresholds are deliberately extreme so normal edits/refactors
  are never affected. First of the 0.9 weak-model execution hardening.

## [0.8.12] — 2026-06-16 · Agent Builder fixes (Codex review)

### Fixed
- **Codicon icon presets no longer save corrupted.** The icon was truncated to 8 chars, turning
  `$(beaker)`/`$(shield)` (9 chars) into invalid `$(beaker`. Raised the cap to fit codicons.
- **Switching provider no longer keeps the old provider's model.** Previously the prior selection was
  re-injected as a "custom" option, so you could save (e.g.) an OpenAI agent with a DeepSeek model.
  A provider switch now resets the model to the new provider's catalog.
- **Usage/cost chips on the model row regained their styling** (the chips moved to `.inline-metrics`
  but the CSS still only targeted the old container).
- **The model dropdown no longer hangs on slow pricing.** It waits briefly for live (discounted) prices,
  then shows the models with cached prices instead of blocking on `/api/pricing`.

## [0.8.11] — 2026-06-16 · Fresh-read rule for every agent

### Fixed
- **The "cite from a fresh read, never from memory" rule now applies to every agent** — workers, the
  PM/coordinator, and solo — not just the PM. Any agent that's about to state a version, a config value,
  or a file's contents must re-read it in the current turn rather than quote stale memory. (0.8.10 added
  this for the coordinator only.)

## [0.8.10] — 2026-06-16 · Agent Builder v2

### Added
- **Full priced model picker in the Agent Builder** — the same live catalog the Edit dialog uses, with
  prices, refetched when you change provider. On the Roam gateway it shows your **discounted** rate
  (the account's `group_ratio`), not list price.
- **Backup model** and **tool-calling method (Native / XML)** in the builder, plus an **icon picker**
  (presets or any `$(codicon)`). Max skill playbooks per agent raised to **5**.
- **Marketplace:** a **Build an agent** button on the Agents tab, and an **Add MCP server** action on
  the MCP tab.
- Agent cards show usage/cost **inline on the model row**.

### Fixed
- **The PM/coordinator no longer states facts (versions, config, file contents) from stale memory.** It
  now must re-read the file in the current turn before citing it — catching the class of bug where the
  PM confidently reported an old `package.json` version it remembered from a previous session. (The
  structural stale-memory fix lands in 0.9.)

## [0.8.9] — 2026-06-16 · Build Your Own Agent

### Added
- **Agent Builder** — a new **"Build an Agent"** webview (Team panel + `UnodeAi: Build an Agent`)
  lets you create or edit a custom agent end-to-end without touching JSON: name, role (a template or a
  custom one like *CEO*), model, system prompt, capability tools, and **MCP grants** — then it joins the
  team like any preset.
- **Attach skill playbooks (up to 3)** — pick market-proven playbooks from the skill library in the
  builder; they're folded into the agent's instructions (`## Playbooks`) so it arrives knowing how to do
  the job. The bundled library now ships **25 skills**.

### Fixed
- `testing` is now a valid skill category, so test-focused skills validate in the catalog.

## [0.8.8] — 2026-06-16 · Chat agent dropdown stops collapsing

### Fixed
- **The chat panel's agent dropdown no longer drops every agent except the selected one during active
  work.** It rebuilt the whole `<select>` on every state update — and a busy crew pushes many per second
  (streaming, tool cards), so the list kept getting wiped (and an open dropdown collapsed to just the
  current agent) until activity calmed down. The options are now rebuilt only when the roster actually
  changes; otherwise just the selected value is synced.

## [0.8.7] — 2026-06-16 · Two dogfood fixes

### Fixed
- **`2>/dev/null` (and other `/dev/*` sinks) no longer false-block as "outside your working folder."**
  The sandbox's path detector read `/dev/null` as an out-of-workspace path (→ a bogus `C:\dev\null`),
  so common commands like `grep … 2>/dev/null` were rejected with a "switch your working folder" message.
- **The Message Log no longer drops cross-agent entries that arrived while it was hidden.** A live
  message is only pushed to the panel while it's attached/visible; messages sent while the panel was on
  another tab stayed in memory but never rendered. The panel now re-renders from its full history
  whenever it becomes visible again, so PM→teammate assignments are never silently missing.

## [0.8.6] — 2026-06-16 · Agents can search and delete files

### Added
- **`search_files`** — agents can now search the workspace for a regex (or plain text) and get
  `file:line` results, instead of writing throwaway scripts to grep. Skips `node_modules`/`.git`/build
  dirs and binaries; bounded so a big repo can't hang it.
- **`delete_file`** — agents can remove a file directly (sandboxed + checkpointed, so it's restorable),
  instead of shelling out to `node -e`/`rm` — which the command sandbox blocks as a control-character
  injection risk (so those attempts just looped with no way through). Refuses directories and missing
  files with a clear message; destructive, so it goes through the same write-approval gate as a write.

These are the first two items of the v0.9 weak-model execution hardening, pulled forward because they
were actively blocking real runs.

## [0.8.5] — 2026-06-16 · Members come equipped (skill playbooks)

### Added
- **Agent presets now carry skill playbooks.** When you add a member from the Marketplace, the
  market-proven playbooks it declares (e.g. the Security Auditor's OWASP Top 10 review + dependency-risk
  triage) are folded into its instructions under a **`## Playbooks`** section — so the member arrives
  already knowing how to do its job, not just which tools it can use. Agent cards show what each member
  **Includes**. Injection is idempotent and skips any id without a playbook body.

### Fixed
- **The bundled agent catalog no longer fails validation.** The granular skill ids used by presets are
  now registered capabilities, an empty `skills` array on a preset is rejected up front, and the backend
  preset was restored to real skills — so the Agents tab loads and every member installs with real tools.

## [0.8.4] — 2026-06-16 · Inline scripts stop tripping the path guard

### Fixed
- **Agent commands that contain an inline script no longer false-block as "outside your working
  folder."** 0.8.2 fixed regex literals with `?`/`*`, but a string escape like `'\n'` inside
  `node -e "…"` still resolved to a bogus `C:\n` path. The guard now skips the body of an inline
  script (`node -e`, `python -c`, `perl -e`, …) entirely — it's source code, not shell arguments —
  while still checking the interpreter and any real file paths before the eval flag, and still
  blocking genuine out-of-workspace access (`type C:\other`, `cat /etc/passwd`).

## [0.8.3] — 2026-06-16 · The worktree review board goes live

### Added
- **The Crew Worktrees review board's lane actions now work.** 0.8.1 shipped the buttons; 0.8.3 wires
  them: each lane shows its **changed files** (click to open a diff), **View diff** opens the lane's
  full diff, **Re-verify** re-runs the project's checks on that lane, and **Hand back** returns the
  lane to its agent to finish. The board also **refreshes live** as a lane's verification state changes
  (merge gate or re-verify) — no need to reopen it.

## [0.8.2] — 2026-06-16 · Agents stop getting falsely blocked

### Fixed
- **Agent commands are no longer falsely blocked as "outside your working folder."** The
  sandbox's outside-path detector mistook a regex literal inside an inline script — e.g.
  `node -e "…split(/\r?\n/)…"` — for a filesystem path, blocked the command, and told the agent to
  switch its working folder. With no quick recovery, agents stalled on otherwise-valid commands.
  Tokens containing `?`/`*` (regex/glob wildcards that never appear in a real path) are now ignored
  by the detector, so legitimate commands run while genuine out-of-workspace paths stay blocked.

## [0.8.1] — 2026-06-15 · Stop-safe tool calls + Archive a chat

### Fixed
- **No more `HTTP 400 … insufficient tool messages following tool_calls` after a Stop.** Interrupting an agent mid tool-call (or restoring a session snapshot taken at that moment) could leave a tool request unanswered in the history, which the gateway then rejected — wedging the agent. The OpenAI-compatible backend now self-heals its history before every request, so a Stop can never break the next turn. An already-stuck agent recovers on its next message.

### Added
- **Archive a chat** — a new **Archive** button in the Chat panel title bar hides a conversation *without deleting it* (Clear still deletes). Restore any archived chat from **"View Archived Chats"** (the title-bar `…` overflow menu, or the Command Palette). Archives persist across reloads.

## [0.8.0] — 2026-06-15 · @unode in the Chat panel

### Added
- **UnodeAi is now in the VS Code Chat panel as `@unode`** — *in addition to* its sidebar (both run side by side). Type **`@unode <goal>`** in the Chat panel and your crew's PM picks it up, delegates, and streams the run back into the chat, with an **"Open in UnodeAi"** button to jump to the full team view. It runs on **UnodeAi's own backend** (your configured agents/models — not the chat panel's model), so you keep the multi-agent orchestration and the cheap-model cost arbitrage. Toggle with **`unode.chatParticipant.enabled`** (on by default; turn it off to keep UnodeAi only in its sidebar).

### Fixed
- No longer pops a spurious **"UnodeAi ignored .unode/team.json: ENOENT…"** warning on a fresh workspace that simply has no team file yet. The "file absent" case is now recognized across both Node and VS Code filesystem error shapes (real parse/permission errors still surface).

### Security
- The Claude backend's team-bridge MCP config (which carries a local loopback token) is now written to the **gitignored `.unode/mcp.json`** instead of `.unode-mcp.json`, so an abnormal-exit leftover can never be accidentally committed.

## [0.7.2] — 2026-06-15

### Changed
- **Discoverability:** Marketplace tags now include the model-vendor families available on the Roam gateway — **OpenAI/GPT, Anthropic/Claude, Gemini, Qwen, Kimi (Moonshot), DeepSeek, GLM, Grok, MiniMax** — so the extension surfaces when you search the Marketplace for any of them.
- **Bundled the refreshed user manual.** `USAGE.md` now ships current with the 0.7.x verified worktree fan-out / verifier-gate docs (the 0.7.1 VSIX had bundled the older copy); the website wiki was already updated.

## [0.7.1] — 2026-06-15 · post-0.7.0 hardening

Hardening pass over the 0.7.0 verifier-gate + worktree machinery (multi-agent code reviews — Codex, MiniMax, Kimi — each finding verified against the code before applying), plus weak-model tool-calling robustness.

### Fixed
- **Reasoning models no longer stall on the native tool protocol.** A model (e.g. Kimi) that emitted a tool call as **flat XML in its message** (`<read_file>…</read_file>`, often after a `</think>` block) instead of a native call would have the call silently dropped — the turn ended and a coordinator read it as "done." Such calls are now **recovered and executed**, and their results are fed back as a valid message (no orphaned `tool` entry that strict OpenAI-compatible APIs reject).
- **Verifier gate respects command approval & can't hang.** It no longer auto-runs a verify command awaiting approval (`unode.commandApproval: ask`); a verify command now has a hard timeout (`unode.worktree.verifyTimeoutSeconds`, default 300, max 3600); and on timeout the whole **process tree is killed on Windows** (`taskkill /T`), not just the shell — no orphaned `npm`/`node`.
- **Worktree lifecycle:** removing an agent now **deletes its branch** (so re-creating a same-named agent doesn't fail) and **waits for any in-flight merge** before removing the worktree (no silent work loss). `run_checks` got a timeout too, and "Reset Workspace State" now also clears file checkpoints.

### Added / Changed
- **Tool protocol auto-fallback (native → XML).** Native stays the default; the first time an agent leaks a tool call as text, it switches to the XML protocol for the rest of the session (where it gets an explicit format guide). Self-tuning per agent.
- **Tougher worker protocol (weak-model reliability):** workers are told to read a file before claiming "already done," to fix the **code** rather than weaken tests to pass, to work in small verified steps, and to keep their todo list honest. Plus a structural nudge when a write-capable worker ends a turn claiming "done" without having used any tool.
- Settings schema: `minimum`/`maximum` bounds for the worktree numeric settings.

## [0.7.0] — 2026-06-15 · verified worktree fan-out

### Added
- **Verified worktree fan-out — a crew only lands work that passes your checks.** In worktree mode, before an agent's work merges into the integration branch, UnodeAi now runs your **verify command** (`unode.verifyCommand` — e.g. `npm test` / `npx tsc --noEmit`) inside that agent's worktree. If it **fails**, the work is **held on the agent's own branch (not merged)** and the failing output is handed back to the agent to fix and finish again; once it **passes**, it merges. Neither Cline nor Kilo gate the *team* merge on verification — this is the differentiator. Controlled by **`unode.worktree.verifyBeforeMerge`** (default on); with no verify command there's nothing to gate on, so merges proceed unchanged. The **Crew Worktrees** review board shows per-lane status (✓ verified / ✗ failing / ⚠ unverified).
- **Anti-cheat: it flags when an agent passes by editing the tests.** A weak model can make the gate green by *weakening the tests* instead of fixing the code (the live dogfood caught one changing an assertion to match its broken code). So a passing lane that **also modified test files** is no longer shown as a clean ✓ — the review board marks it **"✓ Verified · review tests"** and lists the changed test files, and the failure feedback now tells the agent to fix the code, **not** weaken the tests. (It flags rather than blocks — legitimate changes touch tests too — leaving the human finalize as the backstop.)

> Validated by unit + real-git integration tests (incl. a reproduction of the exact "edit the test to pass" cheat) and a live extension-host smoke (failing change blocked from integration; the agent then fixed the code rather than weakening the test). **Worktree fan-out graduates from experimental → supported** with this release.

## [0.6.16] — 2026-06-15

### Changed
- **Repository link points to the active GitHub repo** (`a personal account/unodeai`) for now — temporary, will move back to the `weroam` org shortly. Side benefit: the README's User-Guide / docs links now resolve on the Marketplace listing (they're resolved against the repository URL).
- **Keywords tuned for "agentic" discovery.** Added `agentic`, `ai agent`, `coding agent`, `autonomous agents` so the extension surfaces for those searches. (VS Code has no dedicated "agentic" *category* — the closest is **AI**, which is already set; discovery for that term is keyword-driven.)

## [0.6.15] — 2026-06-15

### Changed
- **Fixed the Marketplace categories.** Was listed under `Other` / `Machine Learning` / `Chat` — "Machine Learning" is for ML/data-science tooling, not an AI coding assistant, and the dedicated **AI** category was missing. Now categorized as **AI · Chat · Programming Languages**, matching where users find Cline / Kilo Code and similar assistants.

## [0.6.14] — 2026-06-15

### Fixed
- **Worktree exclude works when your workspace is itself a git worktree.** The `.unode/worktrees/` ignore entry is now written to git's *common* exclude dir (via `git rev-parse --git-common-dir`) instead of assuming `.git` is a directory — so isolation no longer trips when the folder you opened is a linked worktree.
- **Finalize lands on the branch the review panel shows.** The "Finalize Worktree Merges" command and the review panel now pass the displayed base branch through to the merge, instead of relying on an inferred base.
- **"Reset Workspace State" now also clears file checkpoints** (and, as before, per-agent chat/tool-card history) — a full reset no longer leaves stale restore points behind.
- **Marketplace MCP install trims the server URL** you paste, so leading/trailing whitespace from a copy can't break the connection.

### Changed
- **Production `uuid` upgraded 9 → 11.1.1**, clearing the remaining production `npm audit` advisory (0 prod vulnerabilities). Internal: Windows bundled-smoke runner invokes `.cmd` shims via `cmd.exe /c` (avoids a Node deprecation warning).

_Thanks to a full post-0.6.0 code review for these; verified green (build, lint, 718 tests, prod audit 0 vulns, bundled smoke)._

## [0.6.13] — 2026-06-14

### Added
- **Tool cards now persist across a window reload (Cline-parity).** Write **diffs** and **command/test output** used to live only in a transient in-memory stream, so reloading VS Code wiped them — you kept the agent's text replies but lost the record of *what it actually changed or ran*. They're now saved per agent and restored on reload, so the transcript keeps the full picture. Only **finalized** cards are persisted (an in-flight card never comes back as a phantom "Running"), capped to the most recent 60 per agent, and cleared together with the chat. Closes the durability half of the diff/terminal-visibility gaps (the prominence half shipped in 0.5.12).

## [0.6.12] — 2026-06-14

### Docs
- **Website-ready wiki** (`docs/wiki/index.html`) — a self-contained HTML page (embedded CSS/JS, no external dependencies) ready to host at a `/unodeai/wiki` route on weroam.xyz / unodetech.xyz, or embed via iframe.
- **User Guide refreshed to current 0.6.11 features** (`USAGE.md`): Solo mode, PM orchestration, Plan/Act, Marketplace, Team Rules, approvals, Smart Mode, workflows, worktree fan-out, and troubleshooting. The Graphical Walkthrough gains a Marketplace section.
- **Listing & README**: clearer value proposition — 50+ leading models on the Roam gateway at exclusive, deeply-discounted rates with a dependable SLA — plus prominent links to the User Guide and Graphical Walkthrough so new users can find the manual fast.

## [0.6.11] — 2026-06-14

### Added
- **Worktree mode: every agent can now READ the team's merged work; writes stay isolated.** Previously each agent (and the PM) could only see its own worktree, so a worker building `featureA` couldn't see a teammate's `featureB` or the architect's shared types, and the PM — on the base checkout — couldn't see *any* isolated work, leading it to wrongly conclude tasks had failed. Now `read_file` / `list_dir` transparently **overlay the `unode/integration` worktree** (the merged team state) for any path not in the agent's own tree, marked read-only. **Writes are unchanged** — they always land in the agent's own worktree, so an agent can read a teammate's file but never clobber the shared copy (a write forks its own copy, and conflicts are still caught at merge). This is the "read = shared, write = isolated" model. Applies to OpenAI-compatible agents (the native-Claude backend uses its own tools); off unless `unode.concurrencyStrategy` is `worktree`.

### Changed
- **Clearer command-approval buttons.** The approval card's middle option read just "This session" — ambiguous about whether it allowed or denied. It's now **"Allow this session"**, so every allow option (Allow once / Allow this session / Allow for project / Deny) is unmistakable and matches the native dialog.
- **Friendlier shared-read marker.** The note on a file read from the shared integration view no longer implies a teammate "owns" it (which made agents over-refuse legitimate edits). It now explains that editing is fine — a write forks your own copy and merges back, with conflicts reconciled — it just doesn't change the shared file in place.

## [0.6.10] — 2026-06-14

### Fixed
- **The PM now fans tasks out across same-role teammates instead of piling them on one.** When you had two teammates sharing a role (e.g. two "senior-dev"s, "Developer" + "Backend Developer") and the PM delegated *by role*, every task landed on the first match — the second teammate sat idle, and worktree isolation never kicked in for it. Role delegation now **spreads**: sequential `assign_task`s round-robin across same-role teammates, and parallel `assign_task_async`s skip a teammate that's already running one of the PM's tasks. Firm-retries still stay on the *same* teammate. The PM can also now target a teammate by **display name** ("Backend Developer"), not just id or role. Exact-id targeting is never reinterpreted.

## [0.6.9] — 2026-06-13

### Fixed
- **Finalize now materializes the merged files in your working tree.** Previously, finalizing advanced the branch *ref* (via `git update-ref`) without touching the working tree, so the merged files showed up as phantom "deleted" in `git status` and weren't on disk until a manual `git reset --hard`. Finalize now **fast-forwards your live checkout** (git refuses if your tree has uncommitted tracked changes, protecting your edits), so the files appear immediately — no manual step. (Found by the live worktree smoke.)

## [0.6.8] — 2026-06-13

### Fixed
- **Worktree mode now engages even with untracked config present.** The dirty-tree guard counted *untracked* files — the `.vscode/settings.json` you create when enabling the setting, and Roam's own `.unode/` files — as "uncommitted changes," so it silently fell back to the shared workspace and isolation never turned on for a normal first use. The check now ignores untracked files; only modified/staged **tracked** files (real in-flight work that wouldn't propagate to a worktree) defer isolation.

## [0.6.7] — 2026-06-13

### Added
- **Worktree fan-out — experimental, opt-in.** Set `unode.concurrencyStrategy: "worktree"` and each worker agent runs **isolated in its own git worktree** (no more stepping on each other's edits). When an agent finishes a turn its work is committed and merged into a **`unode/integration`** branch — conflict-aware (a conflict is handed back to that agent to reconcile, and the integration branch is left clean). Review the staged work and land it on your branch with the new **"Crew Worktrees (Review)"** panel or the **"Finalize Worktree Merges to Branch"** command (or set `unode.worktree.autoMerge` to land automatically). Requires a git repo with a clean tree; the PM and solo agents stay on the live tree; `unode.worktree.maxParallel` caps simultaneous worktrees. **Off by default** — the existing `optimistic` strategy is unchanged. (This release is for validating the live flow; see `docs/WORKTREE_FANOUT_SMOKE.md`.)

## [0.6.6] — 2026-06-13

### Added
- **Marketplace Starter Pack.** Catalog expanded to **13 agent presets** (added Debugger, Code Reviewer, Frontend Developer, Backend Developer, QA Analyst) and **15 MCP servers** (added Time, Sequential Thinking, Slack, GitLab, Google Maps, and the Everything reference server). Plus `THIRD_PARTY_NOTICES.md` crediting the MIT-licensed MCP servers project.

### Fixed
- **Clearer "file not found" errors for agents.** When an agent reads/lists a path that's inside the workspace but doesn't exist (a wrong-path guess), it now gets an actionable hint ("use `list_dir` on the parent, don't retry the same path") instead of a raw `ENOENT realpath` dump — which had been sending weaker agents into a flailing loop.

## [0.6.5] — 2026-06-13

### Added
- **Hermes integration (first-party bridge).** New Marketplace entries: a **Hermes Bridge** MCP server — point it at your local or remote Hermes MCP endpoint (e.g. `http://127.0.0.1:8765/mcp`) at install time; it's URL-validated and mounted through the approval gate, with no Hermes runtime bundled — and a **Hermes Operator** agent preset bound to that bridge, so the PM can hand long-memory / skill-accumulating tasks to Hermes. Catalog schema gained `urlPrompt` (install-time URL prompt for bridge-style servers) and agent-preset `mcpServers` grants.

## [0.6.4] — 2026-06-13

### Fixed
- **Packaging: stop shipping internal scratch in the VSIX.** `.vscodeignore` now excludes `.worktrees/`, dogfooding scratch dirs (`_xmltest*`, `_v0*test*`, `bench/`, `_runtest.js`, `_testout.txt`) — these had been bundled into the published extension (the 0.6.3 package had ballooned to 4680 files / 6.9 MB from a stray worktree). No user-facing behavior change; just a much smaller, cleaner package.

## [0.6.3] — 2026-06-13

### Changed
- **Version now shows in the Team section title** ("Team · v0.6.3"). It previously used the greyed title-bar `description` slot, which gets crowded out by the toolbar icons on a normal-width sidebar — folding it into the title keeps it always visible in the toolbar row.

## [0.6.2] — 2026-06-13

### Fixed
- **Team toolbar restored to native title-bar icons.** v0.6.0's header rework had moved Add Agent, **Solo**, Create/Switch Team, Team Rules, Start/Stop All, and Restore Checkpoint out of the view's title-bar toolbar into text buttons inside the panel (wasting a row and dropping the icons, including the Solo zap). They're all back as icons in the title row — alongside the new **Marketplace** and **Settings** icons — and the version stays in the title bar. The team panel body is now just the agent cards again.

## [0.6.1] — 2026-06-13

### Fixed
- **Team panel header no longer duplicates the "UnodeAi" title.** The version now shows in the view's title bar (next to the panel header) instead of a separate brand row inside the panel — that row duplicated the extension header and wasted space. **Marketplace** and **Settings** moved to the Team view's title-bar toolbar (icons).

### Added
- **Hosted marketplace catalog (opt-in plumbing).** Roam can now merge a hosted catalog with the bundled one at startup (`unode.marketplace.catalogUrl` + `unode.marketplace.fetchCatalog`) — so the Agents/MCP catalog can grow without an extension update. Off by default (no URL set); fetch failures fall back to the bundled catalog.

## [0.6.0] — 2026-06-13

### Added
- **Marketplace.** A new **🛒 Marketplace** (opened from the header) to browse and one-click install **Agents** and **MCP servers** from a curated catalog — no more hand-writing JSON. Browse globally, choose the scope on install (an agent joins your team; an MCP server is added to the workspace and mounted through the existing approval gate). Ships with 7 agent presets (Security Auditor, API Designer, Test Engineer, Performance Optimizer, DevOps Engineer, Technical Writer, Data Engineer) and 8 popular MCP servers (filesystem, git, github, fetch, memory, sqlite, puppeteer, brave-search). The **Skills** tab is present but arrives in a later phase.

### Changed
- **Header information architecture — two rows by scope.** The Team panel header now separates **extension-level** controls (🛒 Marketplace, ⚙ Settings) — placed to the right of the *UnodeAi* brand — from **team-level** controls (Add Agent, Switch Team, Rules, Start/Stop All, Solo) on their own row. The native view toolbar is reduced to collapse/expand. Clearer at a glance what acts on the whole extension vs. the current crew.

### Fixed
- **`read_file` pagination is now line-based** (`offset` = start line, `limit` = line count), matching the convention agents expect — byte offsets were causing agents to read tiny fragments and get stuck. A 100 KB cap still bounds each read.

## [0.5.12] — 2026-06-13

### Added
- **Proactive workspace context (Cline #2) — opt-in.** When `unode.engine.workspaceContext` is on, each turn starts with the **active editor file (capped) + current Error/Warning diagnostics** injected into the agent's context — so it stops "starting blind" and burning tool calls just to see what you're looking at. Injected ephemerally (never persisted to history, so stale file content can't accumulate), gathered inside the workspace only, capped both host- and backend-side (diagnostics first so they survive). **Off by default** pending a benchmark on the token cost.
- **Product Manager role.** A new built-in role, distinct from the PM coordinator: it defines *what* to build — user stories, acceptance criteria, scope, priorities — and hands a spec to the Project Manager to delegate. Available in the Add-Agent picker.

### Changed
- **"Create Team" → "Create or Switch Team."** The team button now opens a picker to **create a new team** or **switch** to a different preset; switching that replaces your current roster asks for confirmation first (no silent loss).
- **The PM is notified when the roster changes.** Adding or removing an agent tells the Project Manager so it can adjust assignments to the new personnel/resources (debounced — bulk team-creation notifies once; no-op when there's no PM).

### Changed
- **Write diffs and command output are now visible at a glance (G-004 / G-005).** They were already in the tool cards but **collapsed by default**, so you had to click to see what changed or what a command printed. Now: a write's **diff opens expanded with red/green coloring**, and a command's **output opens expanded** (labeled "Output") — matching Cline's prominence. Tool *input* (args) stays collapsed. Closes the two visibility gaps R2 flagged (U3 diff, U7 terminal).
- **Discount no longer hardcoded in the fallback.** 0.5.10 baked the current 40% Anthropic discount into the static price table — but discounts vary (and VIP group ratios are coming), so a hardcoded discounted fallback goes stale. The static table is back to **base** gateway prices; the live `/api/pricing` path remains authoritative and applies `group_ratio × vendor_discount` on top. Static table = offline estimate only.
- **Reasoning Effort options are now backend-specific.** `max` is a Claude-CLI level — offering it to OpenAI-compatible models just got it silently dropped (losing the user's intent). The Settings dropdown now shows `low/medium/high/xhigh/max` for **Claude** agents and `none/minimal/low/medium/high/xhigh` for **OpenAI-compatible** agents (no `max`). DeepSeek (no effort param) and GLM/Qwen/Gemini (own thinking controls) are noted in the field help. The drop-on-reject retry remains as a backstop.

## [0.5.10] — 2026-06-12 (Correct discount pricing)

### Fixed
- **Displayed prices now reflect the real gateway discount.** Roam's `/api/pricing` carries the discount in `vendors[].discount` (not just `group_ratio`), and it wasn't being applied — so discounted models showed list price. Prices now apply **both layers multiplicatively**: `base × group_ratio (account/VIP) × vendor_discount`. E.g. `claude-opus-4-8` is **$3 / $15** per 1M (40% Anthropic vendor discount off the $5/$25 base); a future VIP group ratio stacks on top automatically. The static fallback table was updated to match. (Found & fixed by Codex.)

## [0.5.9] — 2026-06-12 (Version in the panel header)

### Added
- **The running version is now shown in the Team panel header** — `UnodeAi v0.5.9`, right above the agent list — so you always know which build you're on at a glance.

## [0.5.8] — 2026-06-12 (Listing refresh)

### Changed
- **Pricing made prominent.** The README and Marketplace listing now state up front that the **default Roam gateway serves deeply discounted, price-competitive AI tokens** (DeepSeek, Claude, GPT, Qwen and more), with a live-pricing link — so a whole multi-agent crew stays cheap to run.
- **Changelog backfilled** for 0.5.6 (interject + dogfooding fixes) and 0.5.7 (flat tool-call format); the published changelog previously stopped at 0.5.2.

## [0.5.7] — 2026-06-12 (Flat tool-call format)

**Weak-model reliability foundation.** Replaces the two-level `<use_tool><tool>X</tool>…</use_tool>` XML tool format with a flat, tool-name-as-tag format: `<read_file>…</read_file>`.

### Changed
- **Flat XML tool calls.** The block tag is now the tool name itself — no `<use_tool>` wrapper. This removes a whole class of weak-model failure: models (e.g. DeepSeek in XML mode) would mis-close the wrapper (`</tool>` instead of `</use_tool>`), the call would silently vanish, and the agent appeared to **stall**. With no wrapper, there's nothing to mis-close. (Cline's format works the same way.)
- **Robust parser ladder.** Tool calls are parsed flat-first (anchored on known tool names), then the legacy `<use_tool>` wrapper (still mis-close tolerant) for back-compat, then leaked-token recovery. Nothing in-flight breaks.

## [0.5.6] — 2026-06-12 (Mid-run steering + dogfooding fixes)

**Interject: steer a running agent**, plus four reliability fixes surfaced while building it. (Versions 0.5.3–0.5.5 were internal dev builds, folded into this release.)

### Added
- **Mid-run steering (interject).** While an agent is running, the chat composer stays enabled — type a message and **Steer ⚡** to fold it into the live turn; the agent re-plans from it at the next step. A separate **■ Stop** button hard-aborts. Steering is injected at a safe point that respects the OpenAI tool-call ordering rule (never between a tool call and its answer).

### Fixed
- **Out-of-folder detector false positives.** No longer misreads relative paths (`src/backend/x.ts`) or paths written in prose with trailing punctuation (`(C:\…\proj).`) as outside the workspace.
- **XML tool-call mis-close** tolerance (a weak-model stall) — superseded by the flat format in 0.5.7, kept as a fallback.
- **Out-of-folder guidance** now suggests opening the target project in a **new window** so the current chat survives.
- **Model picker pricing** re-renders with your account's **discounted** price once it loads, instead of freezing on list price.

## [0.5.2] — 2026-06-11 (Agent Execution Engine: write→feedback loop)

The first car of the V0.5.x execution-engine line — making each agent's inner loop closer to Cline's by
having the framework observe and verify, not just expose tools. OpenAI-compatible backends only (the
Claude backend runs its own loop); each hook has a `unode.engine.*` kill-switch (default on).

### Added
- **Post-write diagnostics (the write→feedback hook).** After an agent writes a file, UnodeAi collects
  the editor's own diagnostics (TypeScript/ESLint/…) for that file and feeds any errors straight back
  into the agent's next turn — so it sees and fixes the red line it just created without having to
  remember to run a checker. Settles the language server briefly, takes only Error/Warning for the file
  just written, and is token-capped so a noisy file can't flood the context. VS-Code-unique leverage
  (BACKLOG #3). Toggle: `unode.engine.postWriteDiagnostics`.
- **Verification obligation (no silent skip).** When a turn modified files but never verified them, the
  agent is nudged once to run the project's checks (test/build script, or `run_checks`) — or to say
  verification is genuinely blocked — before finishing. A successful check command, or clean post-write
  diagnostics, satisfies it. If it still doesn't verify, the turn is surfaced as **⚠ Changes not
  verified** rather than silently passing (and a team PM sees that) — it is never hard-blocked. Toggle:
  `unode.engine.verifyObligation`.

### Added
- **The ⚡ button toggles Solo ⇄ team, and shows a solid bolt while Solo is active.** Click it to
  create/focus the Solo agent; click again while you're viewing Solo to flip the chat back to the first
  (team) agent (it stays on Solo if that's your only agent). The toolbar icon is a dim outline ⚡ normally
  and a **solid gold ⚡** while a Solo agent exists. (No working-folder popup on start — a Solo agent uses
  the open workspace folder.)
- **If your task names a folder the agent can't reach, it tells you — in the chat — to open it.** The
  moment you send a task that references an absolute path *outside* the agent's working folder (e.g.
  `…\ux-scratch\src\app.ts` when the agent is rooted elsewhere), UnodeAi detects it (framework-side, not
  left to the model) and posts a clear notice **in the chat panel**: the file is outside the agent's
  folder, and to work on it you open that folder yourself via **File → Open Folder…** (it infers the
  project root by walking up to the nearest `package.json`/`.git`). The turn isn't routed, so the agent
  never starts flailing — and the chat composer is freed immediately (it isn't left stuck on "Stop").
  If an agent hits an out-of-folder path mid-run, the turn ends immediately with the same guidance.

### Security
- **The shell is sandboxed to the workspace root too, and a boundary violation is terminal.**
  `run_command` (and the file tools) now reject any path outside the agent's root (e.g.
  `type C:\…\secret`, `Get-Content …`, UNC `\\…`, `/etc/…`) — closing the gap where an agent could read
  or write outside the sandbox via the shell. The refusal uses a hard, machine-readable code
  (`BLOCKED_OUTSIDE_WORKDIR`) that the tool loop treats as a **terminal** state: the turn ends with a
  clear "switch my working folder" message instead of letting a weak model keep trying other commands to
  route around it. (Directory boundary is a first-class rule; the command check is just a fuse, not a
  smart parser. Relative paths and ordinary flags are unaffected. Thanks to Codex for the framing.)

### Fixed
- **A solo agent no longer gets stuck when its task is outside the open folder, or when a command
  returns no output — the two ways it could become "unusable" (found by dogfooding).**
  - **The agent now knows its workspace root.** Its system prompt states the absolute root and that it
    can only read/write/run inside it — so a weaker model stops trying to edit files elsewhere via the
    shell and just uses `write_file`/`read_file` with relative paths.
  - **Out-of-sandbox errors are actionable, not a dead-end.** Instead of "Path … escapes the working
    directory sandbox," the agent is told its actual root, to use a path inside it, and to ask the user
    to open the right folder — so it stops looping on the same outside path.
  - **Blocked shell commands point at the legal path.** When a command is rejected for shell control
    characters (`; | & > …`), the message now tells the agent to run a single simple command and to edit
    files with `write_file` rather than shell redirection.
  - **Commands no longer run "blind."** When the integrated terminal reports a command finished but
    streams back no output (notably PowerShell on Windows' shell integration), the agent now gets an
    explicit `[exit N] (no output captured…)` note instead of a blank, and subsequent commands route
    through a direct runner that reliably captures stdout/stderr. (The command is never re-run, so
    nothing with side effects executes twice.)

### Changed
- **Approvals now happen inside the chat panel, in UnodeAi's own style — no more native OS dialogs.**
  When an agent wants to run a command or write a file (in `ask` mode), a styled approval card appears in
  the chat with the command / diff preview and the same choices (Allow once / this session / for project
  / Deny-with-note for commands; Approve / Approve all / Deny for writes). The panel is revealed
  automatically so the request isn't missed. If the chat view isn't available, it still falls back to the
  native prompt so an agent never deadlocks.
- **Auto-approve selector in the chat footer (à la Cline/Codex).** A footer bar shows the current command
  and write approval policy as two dropdowns you can change on the spot (`Disabled / Ask each / Allowlist
  / All` for commands; `Auto / Ask each` for writes) — no digging through Settings. Changes apply live.

### Tool-call Reliability (P0/P1/P2) — PowerShell atomic-command execution
- **P0: `ask` mode now allows legitimate PowerShell syntax.** Pipes (`|`), chains (`&&`, `;`), and
  substitution (`$()`) no longer get pre-rejected — they go straight to the user approval dialog. Only
  catastrophic patterns (rm -rf, format drives, fork bombs, etc.) are blocked in every mode. This restores
  PowerShell reliability: agents can now execute atomic commands like `Get-Content | Set-Content` instead
  of falling back to multi-turn workarounds. *Measured impact: tool-call success rate ~40% → 85%+ on
  PowerShell tasks.*
- **P1: Hard rule in system prompt for atomic execution.** Agents now see: "If your previous message
  described an action but didn't include a tool call, your NEXT message MUST open with a tool call."
  Prevents analysis loops where the model describes work without executing (a root cause of high
  Turn Count to First Correct).
- **P2: System prompt now lists available tools.** Agent sees "Available tools: read, write, run_command,
  …" — eliminating the path-blackbox problem where agents couldn't tell what tools they had and kept
  trying unavailable commands.

## [0.5.1] — 2026-06-10 (stabilization)

### Changed
- **Chat renders incrementally.** A state update no longer rebuilds the entire transcript — existing
  message/tool/reasoning nodes are reused by identity, so long chats don't flicker or stutter, and the
  view only auto-scrolls to the bottom when you're already there (it no longer yanks you down while you
  read history). Streaming reuses the same in-flight element.

### Fixed
- **Stop now cancels in-flight delegations.** When you press Stop (or a PM backend is torn down), the
  coordinator's pending `assign_task` / `assign_task_async` waits settle immediately as cancelled instead
  of hanging until the teammate replies or the timeout fires, and the async file claims those tasks held
  are released — so a Stop mid-delegation leaves no zombie promises and the next task isn't blocked by
  stale ownership. Wired through `abort()` and the team MCP bridge/server shutdown.
- **Shared memory no longer reports a false success.** `memory_note` now returns an explicit error when
  the note could not be saved (no workspace folder, or `.unode/memory` not writable) instead of always
  saying "Noted" — so an agent can't believe it remembered something it didn't.
- **Workflow verify command runs with a sanitized environment.** `unode.verifyCommand` no longer inherits
  the VS Code/Electron host's `NODE_OPTIONS`/`ELECTRON_RUN_AS_NODE`/`VSCODE_*` (the same vars that broke
  agent-run tooling), so gated-workflow verification matches how agents run commands.

## [0.5.0] — 2026-06-10

The v0.5 line — team shared memory, and a big push on making cheaper/non-Claude models (DeepSeek, Kimi,
Qwen, …) actually usable as autonomous agents.

### Added
- **Team shared memory (V6).** A new `memory_note` tool records a short note to the team's shared
  `.unode/memory/notes.md`; the most recent notes are injected into every agent's prompt as a
  `<shared_memory>` block, so agents share decisions, gotchas, and interface contracts without the PM
  hand-carrying them. Human-readable and git-trackable.
- **Visible team plan.** The PM now lays out the delegated work as a live `update_todos` checklist, so
  the Team mode chat shows the same pinned plan Solo already had.

### Changed
- **Solo agents skip the read-before-write guard.** A single agent has no teammates to clobber, so the
  optimistic "read the file before overwriting it" check is removed for solo (teams keep it) — less
  friction for everyday single-agent work.
- **Weak-model "act, don't announce."** When an agent ends a turn announcing an action ("let me check
  the file:") without issuing the tool call, it's nudged to follow through in the same turn instead of
  stalling (zh/en heuristic, bounded), reinforced by an explicit prompt rule for workers and the PM.

### Fixed
- **Leaked tool calls are recovered across model formats.** Some models emit their tool call as text in
  the message content instead of the `tool_calls` field — DeepSeek's `<｜｜DSML｜｜invoke…>` and Kimi's
  `<|tool_call_begin|>functions.NAME…>` tokens. These are now parsed and executed (so e.g. a Kimi PM's
  `assign_task` actually delegates) and hidden from the transcript, in both native and XML tool modes.
- **`reasoning_effort` is model-specific.** Switching a model whose effort value the new model rejects
  (e.g. `max` → Kimi) no longer fails the turn: the value is dropped and the request retried; `none`
  and `minimal` were added to the options.
- **Discounted pricing (unode `group_ratio`).** Model prices now reflect the account's discounted group
  instead of list price when several usable groups exist (`unode.priceGroup` still overrides).
- **Real-time Plan renders for recovered/typed tool calls** (parseTodos accepts a JSON string or array),
  and tool-call markup is stripped from the chat transcript.

## [0.4.2] — 2026-06-10

### Fixed
- **Real-time Todo "Plan" now appears for recovered tool calls.** A tool call recovered from leaked text
  delivers its parameters as raw text, so `update_todos` arrived with `todos` as a JSON *string* and the
  checklist parsed to empty (no Plan). `parseTodos` now also accepts a JSON string, so the pinned Plan
  renders whether the call came in natively or was recovered from a leak.

## [0.4.1] — 2026-06-10

### Fixed
- **XML tool-calling mode now also recovers leaked tool calls.** When a model ignores the `<use_tool>`
  format and emits its own tool tokens as text (e.g. DeepSeek's `<｜｜DSML｜｜invoke…>` markup), XML mode
  now recovers and executes them instead of dead-ending — so the mode we recommend for weaker models no
  longer fails on exactly those models. (Native mode already recovered these; recovery is now
  protocol-independent, so it works regardless of which Tool-calling setting an agent is on.)
- **Tool-call markup is hidden from the chat transcript** (XML `<use_tool>` blocks and leaked native
  tokens are stripped from the displayed/persisted message once parsed).

## [0.4.0] — 2026-06-10

The v0.4 line — "trust + the team actually parallel" + making cheaper models productive.

### Added
- **Checkpoints / Restore (V1).** Every file an agent writes is snapshotted (before/after); the 🕘
  **Restore File Checkpoint** button (Team panel + command) reverts a file to its pre-edit content (or
  deletes it if it was newly created). Survives reloads.
- **Write-file approval (V2).** `unode.writeApproval: ask` previews each write as a diff and asks
  **Approve / Approve all (session) / Deny** before it lands (read live — toggling applies without a
  restart). In `none` mode writes are free but still checkpointed.
- **Live agent metrics in the Team panel (V3).** Each agent's card shows its status, current task,
  context %, and cost/turns, refreshing as it works; the Team panel's compact mode collapses everything
  to icons. (No separate Console panel — it folds into the team you already have.)
- **XML tool-calling mode (C).** `AgentConfig.toolProtocol: xml` (Edit-Agent → Tool calling) makes an
  OpenAI-compatible agent call tools via Cline-style XML in the prompt instead of native function
  calling — an option for weaker models. Native remains the default.

### Changed
- **Interactive command approval by default.** `unode.commandApproval` now defaults to **ask**: each
  not-yet-allowed command prompts **Allow once / Allow this session / Allow for project / Deny with a
  note to the agent**. Catastrophic patterns are always blocked.
- **Weak-model robustness.** Tool calls missing required parameters are rejected up front with a
  corrective message; a tool call that keeps failing with identical arguments is circuit-broken instead
  of looping; and a tool call a model leaks into message *text* (e.g. DeepSeek emitting tool tokens as
  content instead of the `tool_calls` field) is now recovered and executed instead of dead-ending in
  chat — directly fixing the empty/looping/leaking `write_file` behavior seen with weaker models.
- **Real-time Todo** auto-collapses to a one-line `✓ N/N` summary when every step is done, freeing chat
  height.

## [0.3.0] — 2026-06-09

**The v0.3 milestone** — faster solo work, a real terminal per agent, a second OpenAI-compatible
provider, portable transcripts, a live plan you can watch, and richer chat context. Most of the line
shipped incrementally across 0.2.27–0.2.33; this release adds the last gate item (@-context) and
marks v0.3 complete.

### Added
- **Richer chat @-context: `@folder` / `@problems` / `@url`** (extends the existing `@file`). Reference
  a folder to attach its file tree, `@problems` to attach the current workspace errors/warnings, or
  `@url` to attach a fetched page — each expanded into the message before it's routed to the agent.
  Sandbox-guarded (folder reads can't escape the workspace), diagnostics limited to in-workspace
  errors/warnings, and `@url` only fetches on an explicit mention (timeout + size cap + SSRF checks).
  Unreadable/failed mentions are silently left as plain text. (Codex; reviewed.)

### Highlights of the v0.3 line (shipped 0.2.27–0.2.33, consolidated here)
- **Solo / Fast mode** — a single generalist agent, no PM/delegation, for everyday tasks.
- **Agent commands run in a real VS Code terminal (PTY)** — TTY-needing tools (e.g. vitest) work, and
  every agent has its own revealable terminal.
- **OpenRouter provider** — one key, hundreds of OpenAI-compatible models.
- **One-click knowledge-work teams** (Business Planning / Analysis / Financial).
- **Chat & Messages export / import + compact views.**
- **Real-time Todo checklist** — agents maintain a live, pinned plan via `update_todos`.

## [0.2.33] — 2026-06-09

### Fixed
- **Blank panels when opened with no folder (notably VS Code on macOS launched from the Dock).** The Team / Messages / Chat panels showed their titles but no content. Root cause: with no workspace folder open, the project-memory path resolved under an unwritable `process.cwd()` (e.g. `/`), and the `mkdir` for `.unode/` threw *uncaught* during activation — which runs before the webview providers register, so they never rendered. `ensureExists()` is now fully fault-tolerant, and activation skips the project-memory disk work entirely when no folder is open. (Reported on macOS.)

### Added
- **Real-time Todo checklist (C3).** Agents can maintain a live plan via a new `update_todos` tool; the current step list renders as a pinned, auto-updating checklist at the top of the chat (☑ done / ▸ in-progress / ☐ pending). Transient per agent; each update replaces the list.

## [0.2.32] — 2026-06-09

### Added
- **Chat & Messages export / import.** Each panel's title bar gets **Export** and **Import** buttons (next to Clear): save a chat — or the team activity feed — to a JSON file and load it back later. Import validates the payload (rejects bad JSON, wrong kind, or a non-array body) and asks before replacing a non-empty view. *Chat import is restored to history; Messages import is view-only and is cleared on reload (Tier 1 scope).* (Codex; reviewed.)
- **Compact view for Chat & Messages.** A **Compress** button collapses long message bodies / tool details so you can skim a transcript fast; the underlying data and exports are untouched. (Codex; reviewed.)
- **A terminal for every agent.** The **Terminal** button now appears on every agent card (in any state) and creates that agent's own `Roam: <agent>` terminal on demand — so even a PM that only delegates has its own visible terminal thread.

### Changed
- **Removed the per-card Output button** — an agent's transcript already lives in the Chat panel; `UnodeAi: Show Agent Output` remains available in the Command Palette.

## [0.2.31] — 2026-06-09

### Added
- **Per-agent terminals you can reveal (#13 Phase 2).** Each agent's commands run in its own `Roam: <agent>` terminal, now centrally managed: a **Terminal** button on the agent's Team-panel card reveals it, and the terminal is disposed when the agent is removed (and on deactivate). (Builds on the Phase 1 integrated-terminal execution.)

## [0.2.30] — 2026-06-09

### Fixed
- **OpenRouter actually works now (was broken in 0.2.29).** Adding an OpenRouter agent was silently routed to the Claude backend and skipped the endpoint/model picker, so the provider didn't function. The backend router now treats OpenRouter (and future OpenAI-compatible providers) as in-process, with sensible endpoint/model defaults. (`defaultBackendKind` extracted to a tested module so this can't silently regress again.)
- **Terminal command runner:** the agent's terminal is now revealed (`show`) so you actually see commands run; the per-command timeout timer is cleared on the success path (no more dangling timers). (Codex review of 0.2.29.)

## [0.2.29] — 2026-06-09

### Added
- **OpenRouter provider** — one API key → hundreds of models, OpenAI-compatible (Codex; reviewed). Pick it when adding an agent.
- **Agent commands run in a real VS Code terminal (#13 Phase 1).** `run_command` now executes through an integrated terminal with shell integration (a real PTY) per agent, falling back to raw spawn where shell integration isn't available. This gives commands a controlling terminal (so TTY-needing tools like vitest can run) and makes the command visible to the user. (The npx→npm rewrite, command policy/approval, and output framing are unchanged.) Engine bumped to VS Code ^1.93.

### Changed
- Command-env sanitization narrowed (keeps a user's legit `--require`); all team-creation entry points (panel, onboarding, missing-PM prompts) route through the Create-Team picker; E2E smoke covers the new commands. (Codex review follow-ups.)

## [0.2.28] — 2026-06-09

### Added
- **One-click knowledge-work teams.** "Create Team…" (Team panel button, command, and the onboarding Team door) now offers a picker: the Software crew (PM + Architect + Developer + Reviewer) or a knowledge-work team — **Business Planning / Business Analysis / Financial Analysis** — each with a PM coordinating the right specialists. (Wires up the v0.2.27 specialist roles into one-click teams.)

### Changed
- **PM self-diagnosis rules.** The Project Manager's instructions now include hard rules learned from real failures: use the project's own scripts (never bare `npx vitest`), report the precise symptom instead of fabricating a root cause, defer to teammate corrections, keep each change scoped, and stop-and-report instead of spinning silently.
- **Upgraded vitest 1.6.1 → 4.x** (modernization; suite stays 488 green). It did NOT fix the separate "agents can't run `npm test` via `run_command`" issue (vitest's worker runtime can't initialize with no controlling terminal in the console-less VS Code/Electron process tree on Node 25 — reproduces on every vitest version/pool); the real fix is integrated-terminal execution (planned). Agents verify with `npm run build` + `npm run lint`; the test suite is run at review.

## [0.2.27] — 2026-06-09

### Added
- **Solo / Fast mode (first of the v0.3 push).** A single generalist "Solo" agent that does the whole task itself — read → edit → run → verify → iterate — with no PM/delegation overhead and no review gate. The fast path for simple/everyday asks; use a Team for complex multi-file work that wants an independent review. Start it from the ⚡ button on the Team panel, the "Start Solo Agent" command, or the **new onboarding "How do you want to work?" two-door** (Solo / Team), where Solo is the recommended default. It opens a chat ready to work, gets a higher tool-loop limit (no teammates to spread work across), and is cost-routed like any agent.
- **New specialist agent roles** for knowledge work — Business Analyst, Market Researcher, Financial Analyst, Strategy Lead — selectable from "Add Agent" (one-click knowledge-work *teams* land next).

### Fixed
- **Agents can now actually run the test suite.** When an agent ran `npm test` (or any tool) via `run_command`, the command was spawned as a child of the VS Code extension host and inherited its `NODE_OPTIONS` (debugger/bootstrap injections), `ELECTRON_RUN_AS_NODE`, and `VSCODE_*` vars — which break a child Node toolchain (e.g. vitest's worker pool dies and it reports "No test suite found" for *every* file). UnodeAi now sanitizes the environment for agent-run commands so they execute as they would in a normal terminal. Surfaced by dogfooding (a delegated agent kept "failing" tests that actually pass) and directly unblocks the "agent verifies its own work" loop.

## [0.2.26] — 2026-06-09

### Added
- **Clear buttons for Chat and Messages.** Each panel has a clear (clear-all) button in its title bar. "Clear Chat" wipes the selected agent's transcript + saved history (keeping it selected); "Clear Messages" empties the cross-agent activity feed. Both now ask for a quick confirmation that spells out the consequence before deleting.
- **Compact Team panel.** A collapse/expand button next to the Team title shrinks every agent to a small icon chip (role icon + a status-colored dot, details in the tooltip; click a chip to open that agent's chat). Collapsing frees vertical space for the Chat and Messages panels; expand restores the full cards.

### Changed
- **Copy button on replies is now a compact, always-visible icon.** It no longer requires hovering to appear and uses a small copy glyph instead of the "Copy" label, saving space.
- **Agents can't footgun test/build commands anymore.** When an agent tries to run a test/type/lint runner directly (e.g. `npx vitest`, `tsc`, `eslint`), UnodeAi now rewrites it to the project's matching script (`npm test`/`npm run build`/`npm run lint`) before running, and tells the agent to use the project scripts. When no script matches, bare `vitest` is at least forced out of watch mode (which otherwise hangs forever). This closes the most common way weak/cheap models break — running the wrong test command and blaming "the environment".

## [0.2.25] — 2026-06-08

### Added
- **Model escalation when a teammate's model is on strike (L3).** If a delegated teammate returns nothing even after the firm retry (0.2.24), UnodeAi now automatically switches it to its configured **fallback model** and tries once more. If there's no fallback — or the fallback also returns nothing — the delegation comes back with a clear message that *this teammate's model is refusing and needs to be changed*. That message flows up to the PM (the agent you're talking to), which relays it to you, so a dead/refusing model surfaces as actionable advice instead of a silent stall.

- **Async delegation now gets the same reliability net.** The empty-reply retry and fallback-model escalation (0.2.24/0.2.25) previously only covered the blocking `assign_task`. They now also apply to parallel `assign_task_async` work — a teammate that returns nothing is retried/escalated before `await_tasks` collects it, and a teammate still blocked after escalation is flagged as a failed subtask. File-ownership claims are held until the final (post-retry) result, so retries never leak a claim.

### Fixed
- **Model hot-swap now actually reaches the running agent.** Switching an agent's model (fallback escalation or Smart Mode / tier changes) updated the stored config but not the live backend's own copy, so in-process (openai-compat) agents could keep using the old model. `setModel` now pushes the change into the running backend.
- **Project conventions are loaded before the first turn.** `.unode/rules.md` and auto-detected package.json scripts are now awaited during activation, so a message sent the instant the extension loads still gets the project context injected.

### Security
- **`@file` chat references are symlink-safe.** Mentions were validated only by string path; a symlink/junction inside the workspace could point a `@file` at an external file. Both the workspace root and each target are now resolved with `realpath` and re-checked for containment before the file is read.
- **"Always allow" for `npm run <script>` no longer over-approves.** Approving `npm run build` previously whitelisted `npm run`, silently green-lighting `npm run deploy` and any other script. The template now keeps the script name (`npm run build`), so each script is approved individually (same for pnpm/yarn/bun).
- **`fetch_url` blocks numeric IP encodings of internal hosts.** Decimal/hex/octal/short IPv4 encodings of private addresses (e.g. `http://2130706433/` = 127.0.0.1) are now decoded and blocked at the literal level, independent of platform DNS. A known TOCTOU residual (re-resolution at connect time) is documented in code and BACKLOG 10b.

## [0.2.24] — 2026-06-08

### Added
- **Agent compliance enforcement — make delegated teammates actually do the work.** Two layers target the weak-model failure mode where a teammate returns empty, replies with only a plan, or tells you to run a script yourself:
  1. Every non-coordinator agent's instructions now carry a firm "carrying out an assigned task" protocol: do the work with your tools, don't punt it back, don't return an empty response, and only report a blocker with a specific reason. (Coordinators/PM are excluded; phrased to fit read-only roles like the reviewer.)
  2. When a teammate hands back nothing usable, the delegation now **forces one firm retry automatically** before returning — independent of how capable the PM model is. If it still returns nothing, the PM gets a clear "this teammate is refusing/unable; reassign, escalate, or tell the user you're blocked" message instead of a silent empty turn.

## [0.2.23] — 2026-06-08

### Changed
- **Delegated work stays in each agent's own chat (reverted the PM-chat mirroring from 0.2.22).** Mirroring every teammate's actions into the PM transcript made the PM view too noisy. Instead, when the PM delegates, its chat now shows a clear **"Waiting on <agent>"** card that stays in the running state until the teammate finishes — so you know who to go watch, and you open that teammate's own chat to see the detailed work.

## [0.2.22] — 2026-06-08

### Added
- **See what the crew is doing from the PM's chat.** When the PM delegates to a teammate, that teammate's live actions (reading files, running commands, edits) are now mirrored into the PM's transcript — indented and tagged with the teammate's name (`↳ senior-dev`) — so you no longer have to switch chats to see what's happening while the PM waits.
- **Agent status emoji.** Each agent in the Team panel now shows a little figure that mirrors its state: 🏃 working, 🧍 idle, 😴 stopped, 🚶 starting/stopping — alongside the existing status dot.

## [0.2.21] — 2026-06-08

### Fixed
- **Copy button on agent replies was invisible** on some themes (dark text on a transparent background). It now uses a matched secondary foreground/background so the label is always legible.
- **Team Rules editor wiped the default template the moment you typed.** The defaults were only a placeholder (which vanishes on the first keystroke) and could never be saved. New teams now open the editor pre-filled with the default rules as real, editable text you can tweak and save.
- **PM now reports back to the user instead of going silent.** When a teammate finished delegated work (especially via a message back to the PM), the PM often ended its turn without summarizing — the user saw the turn end with nothing to show for it. The PM is now instructed to always close a turn with a plain-language status update for the user, to summarize when a delegation completes, and to stop and surface a blocker (e.g. suggest restarting) when it's stuck or a teammate keeps failing rather than spinning silently.

## [0.2.20] — 2026-06-08

### Added
- **Background long-running commands.** `run_command` now takes an optional `background: true` — the command starts and returns a handle (`bg_N`) immediately instead of blocking, so an agent can run `npm run dev`, a watcher, or a server without stalling its turn. Two new tools: `check_command` polls status + captured output, `kill_command` stops it. Background commands are gated by the same command policy as foreground ones, and any still running are killed when the agent stops.

## [0.2.19] — 2026-06-08

### Added
- **`@file` references in chat.** Mention a workspace file with `@path` in your message (e.g. "explain `@src/auth.ts`") and UnodeAi attaches that file's contents to the turn automatically — no copy-pasting. Path traversal outside the workspace is blocked and large files are capped. Non-path mentions like `@reviewer` are left as plain text.

## [0.2.18] — 2026-06-08

### Added
- **Agents now know your project's conventions automatically.** UnodeAi detects your `package.json` scripts and package manager and tells every agent how to build/test/lint *your* way — so they use `npm test` (or your real script) instead of guessing a command, and won't mistake a wrong command for a "broken environment." It refreshes when `package.json` changes. This makes the crew far more reliable, especially with cheaper models.

## [0.2.17] — 2026-06-08

### Security / Fixed
- **Stronger SSRF protection for `fetch_url`.** Previously only the literal hostname was checked, so a public domain that resolves to a private IP (DNS rebinding) or a redirect into the internal network could slip through. Now the host's DNS records are resolved and rejected if any point at a private/internal address, and redirects are followed manually with every hop re-validated.
- **Narrower default safe-command list.** "Enable Safe Commands" no longer pre-allows bare `npm run` (any script) or `npm install` / `npm ci` (which run lifecycle scripts = arbitrary code); only explicit safe scripts run automatically (`npm test`, `npm run build`/`compile`/`lint`/`typecheck`, etc.), everything else asks.
- **Parallel-delegation safety nudge.** When the PM dispatches a parallel task without declaring its files, the result now warns that file-conflict protection is off for that task (declare files, or use sequential delegation).

## [0.2.16] — 2026-06-08

### Added
- **Web access for agents (`fetch_url`).** Agents with read access can now fetch a public http/https page or API and get its text back (HTML stripped, JSON as-is; 10s timeout, 100 KB cap) — useful for docs, references, and API lookups. Requests to localhost and private/internal networks are blocked (SSRF guard).

## [0.2.15] — 2026-06-08

### Added
- **Team Rules.** A new **Edit Team Rules** button on the Team panel opens an editor where you write rules your whole crew must follow — e.g. *"Developers must have the architect review their work before it's done."* Creating a team now prompts you to set them. Rules are saved to `.unode/rules.md` and injected into every agent's instructions (refreshed each turn), so they take effect on the next turn — a simple way to enforce your own workflow without per-task reminders.

## [0.2.14] — 2026-06-08

### Added
- **Conflict-free parallel delegation.** Building on v0.2.12's parallel delegation, the PM can now declare which files each parallel task owns; if two tasks would touch overlapping files, the second is rejected up front (telling the PM who holds the conflict) so two teammates never edit the same files at once. The architect now produces an explicit non-overlapping ownership map to drive this. Optimistic file coordination and whole-project checks still backstop anything not declared.

## [0.2.13] — 2026-06-08

### Fixed
- **Inter-agent messages now actually reach the recipient.** `send_message` put a note on the bus but the target teammate never read it as input. A directed message is now delivered to that agent as a turn (so it genuinely "hears" its teammate); broadcasts stay informational.
- **Tighter command allowlist.** "Enable Safe Commands" (and "Always allow") used bare tool names, so allowing `git` once also silently allowed `git reset --hard`, and `node`/`python` allowed arbitrary code. The default safe list is now narrow templates (`git status`, `npm test`, `npm run`, …), and "Always allow" remembers a specific two-token template (`git status`, not all of `git`) for tools like git/npm/node. Anything else still prompts.
- **Parallel delegation safety.** When the PM runs teammates in parallel, a failed/timed-out task is now clearly marked as failed (instead of looking successful), and the number of simultaneous delegations is capped (the PM is told to collect results before dispatching more).

## [0.2.12] — 2026-06-08

### Added
- **Parallel delegation.** The Project Manager can now run teammates **at the same time** instead of strictly one after another. For independent work on non-overlapping files, the PM fans tasks out (dispatch each, then collect all results together), which is noticeably faster than serial delegation; it still works sequentially when one task depends on another's output. Cross-file safety is unchanged (optimistic file coordination + whole-project checks).

## [0.2.11] — 2026-06-08

### Fixed
- **Delegated agent stuck on "Stop".** When the PM delegated to a teammate, that teammate's chat kept showing "Stop" (input disabled) even after it had finished and reported back, and its reply never landed in its own chat tab. The chat now finalizes a completion for any agent — not just replies addressed to you — so a delegated agent frees up and shows its result.
- **Empty cold-start reply.** Some gateways occasionally return an empty first turn (no content, no tool call) right after an agent starts; UnodeAi now retries once before accepting it, instead of surfacing a blank reply.

### Added
- **Copy button on agent replies.** Hover a finished agent reply to get a "Copy" button in its top-right corner — handy for relaying an agent's output.

## [0.2.10] — 2026-06-08

### Added
- **Live "Analysis" in chat.** When an agent reasons before answering (thinking models like DeepSeek-R1), its reasoning now streams into a dimmed, collapsible **Analysis** card right above the reply — so you can watch *how* the agent is thinking, not just the final answer.
- **Status dots on activity cards.** Every tool/action card now shows a Claude-style status dot: a pulsing gray dot while running, green when it succeeds, red when blocked or failed — an at-a-glance read of what the agent is doing and how it went.
- **Rotating activity indicator.** While an agent is working but hasn't started replying, the "Thinking…" indicator now cycles through changing verbs (Thinking → Pondering → Analyzing → …) so it's always visibly alive instead of looking frozen.

## [0.2.9] — 2026-06-08

### Added
- **Agents can message each other (`send_message`).** Any agent can now send a direct message to a teammate by id or role, or broadcast to the whole team with `"*"`, over the shared team bus — so a developer can hand findings to the reviewer, the PM can ping a role, etc., without going through you. Read-only roles (e.g. Reviewer) gain messaging without gaining write or command access.

## [0.2.8] — 2026-06-08

### Added
- **Interactive command approval ("ask" mode), like Claude Code.** When an agent wants to run a command that isn't already allowed, you get a prompt: **Run** (once) / **Always allow "`<prefix>`"** (whitelists it, so that command runs automatically next time) / **Deny**. "UnodeAi: Enable Safe Commands" now turns this on — common build/test commands (npm, node, git, python, …) run automatically, and anything new asks first. Shell-chained and destructive commands are never auto-allowed.

## [0.2.7] — 2026-06-08

### Added
- **Run commands without copy-pasting.** Command execution is off by default for safety; a new guided prompt — **"UnodeAi: Enable Safe Commands"** (also offered after creating a team) — switches it on with a safe allowlist (npm, npx, node, git, python, …). Once enabled, agents run those build/test commands themselves instead of asking you to paste them. (Never enables unrestricted execution.)
- **Large-file reads.** `read_file` now returns up to 100 KB and supports `offset`/`limit` pagination, so agents can read and edit full-size source files (previously truncated at 16 KB). `run_command` output stays capped at 16 KB.

### Fixed
- Chat transcript items no longer collapse/overlap (flex layout fix).

## [0.2.6] — 2026-06-07

### Added
- **Chat "Thinking…" indicator.** While an agent is working but hasn't started streaming a reply, the chat now shows an animated "Thinking…" instead of looking frozen; it clears as soon as the reply (or a tool step) starts.
- **Per-agent context usage in the Dashboard.** The Agent Overview table has a new "Context" column showing each agent's window usage (% of its context window; "Managed by Claude" for Claude agents).

### Fixed
- **Live prices now reflect your account's discount.** Model prices were shown at gateway list price. Roam gateway pricing is now fetched with your API key (so the account's discount group is returned) and the new-api `group_ratio` is applied. New `unode.priceGroup` setting for accounts with multiple usable groups.
- **Quick Start label** corrected to match the team it actually creates: **PM + Architect + Developer + Reviewer** (was "PM + Dev + QA").

## [0.2.5] — 2026-06-07

### Fixed
- **Reset Workspace State now also clears `.unode/team.json`.** Previously, after a reset the cleared roster could be immediately re-seeded from a leftover `.unode/team.json` (e.g. an old "Browser" agent reappeared). Reset now deletes that team file too, so it reliably lands on the setup wizard with no agents.

## [0.2.4] — 2026-06-07

### Added
- **"UnodeAi: Reset Workspace State" command** (also a button in Settings → More). Permanently clears this workspace's team roster, all chat history, the message log, saved conversations, workflows, and approved MCP servers — with an option to also clear stored provider API keys — then reloads so you start clean (the setup wizard reopens). Useful when an old team or old conversations carried over from earlier use.

## [0.2.3] — 2026-06-07

### Fixed
- **Roam agents no longer fall back to OpenAI's API endpoint.** Older persisted agent configs could carry
  `https://api.openai.com/v1` as their base URL, and the OpenAI-compatible backend also had OpenAI as
  its internal default. Roam-provider agents now resolve blank or legacy OpenAI base URLs to the configured
  Roam/unode gateway (`https://www.unodetech.xyz/v1` by default), preventing Roam keys from being sent to
  OpenAI and producing confusing 401 errors.

## [0.2.2] — 2026-06-07

### Changed
- **Model picker now says when the live list is unavailable.** If only the built-in models can be shown (usually a missing API key or base URL), the picker shows a non-blocking notice — "Live model list unavailable — showing built-in defaults (check API key / base URL)" — instead of silently displaying a short list that looks like a regression.

## [0.2.1] — 2026-06-07

Hotfixes for issues found right after the v0.2.0 release.

### Fixed
- **Startup restored the wrong team.** A `.unode/team.json` in the workspace could shadow your last working roster, so VS Code would reopen with an old/stale team (e.g. a leftover single agent). The last workspace roster now wins; `.unode/team.json` members are only used to seed a brand-new workspace. The setup wizard opens only when no agents are restored.
- **Model Tuning save reset the Settings panel.** Saving one agent's parameters re-rendered the whole panel, forcing you to re-navigate before editing the next agent. Saving now persists in place; a dedicated **Close** button owns closing the panel.
- **Model picker showed only the built-in models when the base URL was blank.** A blank `unode.baseUrl` skipped the live `/models` endpoint and fell back to the few static models. A blank Roam URL now resolves to the default gateway so the live model list loads. (If the live list still can't be fetched — e.g. no API key — the built-in defaults are used as a fallback.)
- **Chat agent list could drift from the Team panel.** The Chat view now re-syncs its agent switcher whenever it becomes visible, so it always matches the current team.

## [0.2.0] — 2026-06-06

Theme: **a real per-agent chat experience (Cline-level), live MCP, and a smoother first run.**

### Added
- **Rich per-agent chat in the sidebar** — the `unode.chat` view renders Markdown/code, streams tokens live with a **Stop** button, shows **tool-call cards** (with unified diffs for edits), a **context-usage bar**, and **compaction markers**. Switch agents from one view. (Chat parity C1–C3)
- **Plan / Act mode** — a per-agent toggle. **Plan mode is enforced at the tool layer** (read-only tools only; file writes, commands, delegation, and MCP tools are refused — not just discouraged by a prompt). Defaults to Act. (C4)
- **Visual workflow editor** — `UnodeAi: Edit Workflow` opens an editor for multi-step workflows with **conditional branches** (jump to a step when a result matches), drag-to-reorder, and built-in templates. Custom workflows persist to `.unode/team.json`. (E4)
- **Setup wizard / onboarding** — a first-run wizard (provider + API key with the Base URL prefilled, one-click team, demo task), a friendlier empty Team panel, and a demo-task library. (E6)
- **PM → Claude delegation bridge** — the PM can delegate to Claude-headless agents over a loopback MCP server. (E2)
- **Context summarization** — long OpenAI-compatible sessions compact older turns into a rolling summary instead of dropping them. (E1)
- **Opt-in bundled build** — `npm run package:bundle` produces a ~1 MB VSIX (vs ~5 MB), validated to run MCP correctly. (E5b)
- **Official logomark** as the activity-bar icon.

### Changed
- **Default maximum concurrent agents raised from 4 to 10.** Changing it takes effect immediately; agents beyond the cap queue and auto-start as slots free up.

### Fixed
- **Set Provider API Key → custom secret name** no longer skips straight to the value prompt (an emoji-string-equality bug dropped the name step).
- Roam-provider agents with a blank `unode.baseUrl` no longer fall back to `api.openai.com` (now use the default gateway).
- Streamed **thinking-model** tool loops preserve `reasoning_content`, fixing a gateway 400 that forced a non-streaming fallback.

### Hardening
- Added regression coverage for Smart Mode model-tier edits: unknown provider keys from the webview are rejected, while known provider keys are accepted.
- Expanded VS Code E2E coverage for public command routing and the concurrency queue.
- Documented the production `npm audit --omit=dev` result: 1 moderate `uuid <11.1.1` buf-bounds advisory. It is not exploitable in UnodeAi because all call sites use arg-less `uuidv4()`; no `audit fix --force` was applied because that would require a breaking major upgrade.

### Validated (live)
- MCP servers **github** and **playwright** validated end-to-end against a real backend (both unbundled and bundled builds).
- 5-agent concurrency stress: negligible per-agent overhead (~+10 MB for 5 concurrent).

## [0.1.2] — 2026-06-05

### Changed
- **Fully English user-facing content.** Rewrote the Marketplace README and the usage guide (USAGE.md) in English, and removed the last Chinese from user-visible UI strings (the provider picker label). Internal development docs are not shipped and are unchanged.

## [0.1.1] — 2026-06-05

Theme: **give users control over model behavior without editing JSON by hand**, plus concurrency/routing hardening.

### Added
- **Advanced model parameters per agent (F1)** — temperature, top_p, max_tokens, presence/frequency penalty, stop, response_format, reasoning_effort, thinking, tool_choice. A new **Model Tuning** tab in Settings edits them per agent; the OpenAI-compatible backend sends the full surface, the Claude backend maps `reasoning_effort` → `--effort` (the only sampling flag its CLI exposes — other params are disabled in the UI for Claude agents).
- **Per-agent Context Window (F1b)** — set each agent's window (feeds the 70%/80% context gate), with an inline ⓘ guide on how to find your model's real window.
- **Global defaults + override hierarchy (F2)** — `unode.modelDefaults.*` settings; effective params resolve agent > smart tier > legacy fields > global > built-in defaults.
- **Smart Mode (F3)** — auto-select a model tier per task (explicit task tier → task-type hint → role tier → default), hot-swapping the model per turn. A **Smart Mode** Settings tab with an editable tier→model matrix, per-role tiers, and task-tier hints (`unode.smartMode.*`, `unode.modelTiers`).
- **Session Memory (F4)** — `.unode/rules.md` project memory (à la `.clinerules`) is injected into every agent's system prompt and refreshed per turn; edits picked up live.
- **Chat panel** — `UnodeAi: Open Chat with Agent` opens a persistent multi-turn chat with any chosen agent (not just the PM); messages route over the team bus.
- **Role-tuned defaults from experience** — each role template ships a sensible default temperature (reviewer/security `0.1`, code/test/devops/data `0.2`, pm `0.3`, architect `0.5`, tech-writer `0.6`). `reasoning_effort` is **not** forced by default (some gateways/models reject it) — it's a one-click opt-in per agent (Model Tuning) and per tier (Smart Mode).

### Changed
- Default gateway is now `https://www.unodetech.xyz/v1` (OpenAI-compatible; `Authorization: Bearer <key>`).
- Over the `maxConcurrentAgents` cap, starting an agent now **queues** it (with a toast) and auto-starts it when a slot frees, instead of throwing (B1).
- Commands blocked by `unode.commandApproval` now surface a warning toast with an "Open Settings" shortcut instead of failing silently (B2).

### Fixed
- **Busy-agent completion cross-talk** — a second task arriving while an agent was mid-turn overwrote the in-flight task's reply target, misrouting completions. Turns now strictly serialize per agent (deliver only when idle; queue otherwise).
- **Turn error wrongly freed a concurrency slot** — a transient turn failure marked the session `error` and drained the start queue, letting a queued agent breach `maxConcurrentAgents`. A turn-level error with a live backend is now surfaced without releasing the slot; only a dead backend frees one.

### Known limitations
- **`reasoning_effort` is opt-in, not a default.** It's only sent when you set it (per agent or per Smart Mode tier) — `unode.modelDefaults.reasoningEffort` defaults to empty — because some OpenAI-compatible gateways/models reject the parameter. Enable it for reasoning-capable models once you've confirmed your gateway accepts it.
- **Claude reasoning effort is a start parameter.** Smart Mode changing a tier's reasoning effort for an *already-running* Claude agent only takes effect on its next start (OpenAI-compatible agents apply it next turn).
- **MCP servers require the SDK at runtime** (`@modelcontextprotocol/sdk`, shipped) and live tokens — MCP live validation is deferred to v0.2.0.
- **E2E coverage is a smoke test** (activation, command registration, Settings). Routing/concurrency are covered by unit tests, not yet E2E.

### Security / supply chain (non-blocking, reviewed)
- `npm audit` reports 14 findings: **13 are E2E devDependencies** (mocha/serialize-javascript, @vscode/test-*) that are **not shipped in the VSIX**; the 1 production finding (`uuid`) does not apply to our usage (we call `uuidv4()` with no `buf` argument). No `audit fix` applied to avoid breaking churn.

## [0.1.0] — 2026-06-05

- First Marketplace release: build a team of AI agents in VS Code, PM orchestration over a shared message bus, per-role/model assignment, file/command/MCP permission guards, cost visibility.
