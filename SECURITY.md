# UnodeAi — Security Model, Policy & Audit

This document describes exactly what UnodeAi does with your code, your machine, and the network, and the
controls that constrain it. It is intended for security-conscious users and for registry reviewers. Every
claim below is verifiable against the matching source drop in this public repository. A tag gate requires
that allowlisted source drop to match the release candidate before publication; the checker also refuses a
source drop older than the version published on Open VSX.

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
unpinned authority boundaries now have tests; `npm run test:release-authority-canaries` requires a green
baseline and reports 12/12 targeted mutations killed, refusing to count a crash or a missing anchor as a kill.

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
worker's prompt, so a cross-destination dispatch receives its own modal consent before an attempt, persistence,
worker session, or prompt exists. Destination equality uses the resolved privacy domain, falling back to the
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

**Provenance is recorded and never acted on.** Nothing scores, filters, hides, re-orders or discounts a note by
its tier. Whether a caution written under one tier is worth following is the judgement of the agent reading it.
Retention differs by the agent-declared kind, not by tier, and the injected block stays bounded at thirty notes.

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
sensitive: an agent's `env` map is persisted verbatim, exactly as `team.json` already persists it, and the
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
or remotely reachable control service.** Model traffic goes only to a provider you configure and approve;
other network-capable tools are explicit and documented below. Every high-risk capability is off or gated
by default.

---

## 1. Network egress — what leaves your machine, and where

UnodeAi can make outbound requests to these categories of host:

| Destination | What is sent | When |
|---|---|---|
| **The AI provider/gateway route you select** (registered endpoints such as `api.openai.com` and `openrouter.ai`, or a named Custom gateway's locally stored HTTPS endpoint) | Your prompt + any workspace files the agent includes + the model name | Only when an agent runs, **and only after you approve the destination host** (see §2). A workspace agent file cannot replace a registered connection's endpoint or secret identity. |
| **A vision route you select, carrying bytes of a stored image asset** (same provider/gateway host as above) | The image bytes of one temporary `content-N` asset, for one request | Only when an agent calls `send_image_asset_to_model`, the exact route is known to support vision (`unknown` is refused), **and** you approve a separate modal naming the media class, provider, host, byte count and any published input-cost estimate. This grant is stored per host **and** per purpose — approving vision never approves transcription — and neither public-download approval (§1) nor model-egress approval (§2) authorises it. The asset is attached to that one request, never to history, and is dropped when the request settles, including on failure or cancellation. |
| **Provider billing / model-metadata endpoints** (`/api/pricing`, balance, `{base}/models`, `unode.modelCatalogUrl`) | Your API key in the `Authorization` header if one is stored — **no prompts, no code, no workspace content** | To populate the model picker and show prices/balance. **Only for a host you have already approved** — either for model traffic, or by answering the separate "fetch live prices from *host*?" prompt. Never on install, never in the background for an unapproved host. Enforced on the fetch itself (`consentGatedFetch`), not at each call site. |
| **Opt-in hosted skill catalog** (a URL you set) | Nothing (a GET request) | Only if you set a catalog URL, enable `unode.marketplace.fetchCatalog` (default **off**), **and** the catalog is validly signed. With no signing key configured — the state this build ships in — it is **not fetched at all**. |
| **A public URL or search requested through `fetch_url`, Claude `WebFetch`, or Claude `WebSearch`** | The URL or search query and normal HTTP request metadata — not an automatic workspace upload | Only when the agent has `read` and the public-web policy allows it. `unode.webAccess` defaults to **ask**, which presents a human approval card; `allow` permits it and `off` denies it. A session approval is crew-wide but is not persisted. Private, loopback, link-local, and cloud-metadata URL targets are blocked on the gateway `fetch_url` path. |
| **Claude native external-effect tools** (`Artifact`, `CronCreate`/`CronDelete`, `RemoteTrigger`, `PushNotification`, `ScheduleWakeup`, `SendMessage`) | Tool-specific content/arguments to Claude/claude.ai features | Only after a UnodeAi approval card for that tool effect; the inherited fail-closed `PreToolUse` hook also applies inside native subagents |
| **An MCP endpoint you configure and approve** | Tool-specific arguments defined by that MCP server | Only after that server is approved and granted to the agent; MCP is default-deny |

There is **no telemetry, analytics, crash reporting, or phone-home endpoint.** Model turns go to the provider
you select — which can be a self-hosted / in-VPC endpoint — only after the model-egress consent prompt. An
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
host you approved.

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

## 2. Model egress consent — no model request leaves until you approve the destination

Before **any** model request is sent, UnodeAi shows a one-time modal per gateway host: *"UnodeAi is about
to send this agent's prompt — and any workspace files it includes — to `<host>` … Allow?"* Nothing is
transmitted unless you click **Allow**; the decision is remembered per host. Enforced at every egress
point — the OpenAI-compatible request path
([`OpenAICompatBackend`](src/backend/OpenAICompatBackend.ts) `fetchOnce`/`fetchStreamOnce`), the chat
summarizer, and before the Claude CLI is spawned ([`ClaudeHeadlessBackend.start`](src/backend/ClaudeHeadlessBackend.ts))
via the `onBeforeEgress` hook. Declining aborts the turn with "no prompt or code was sent." Codex Headless is
Coming soon in this release and no available route starts a Codex model process.

The **`UnodeAi: Security`** panel lists every gateway host you've approved and lets you **revoke** any of
them (it will be re-prompted before the next request), alongside a live summary of Workspace Trust,
command/write approval, MCP, and which providers have a key.

---

## 3. Code execution — off or gated by default

| Capability | Default | Control |
|---|---|---|
| **Shell commands** | *Ask / deny* | `unode.commandApproval` prompts per command; catastrophic patterns are always blocked. OpenAI-compatible `run_command` and every Claude `Bash`/`PowerShell` call, including a native subagent's, use the same [`CommandPolicy`](src/backend/CommandPolicy.ts). **A chain runs without a prompt only if every one of its segments is independently allowlisted.** `&&` and `;` are the only separators split on; empty segments (`npm test &&`) are rejected rather than ignored, and everything else that changes what executes — `\|`, backticks, `$(…)`, `${…}`, `>`, `<`, `&`, newlines — still forces the prompt outright. So `npm test && npm run lint` is silent and `npm test && npm publish` is not. The optional, user-only `unode.debug.promptedCommandLog` is off by default; when enabled it retains only local `CommandPolicy` template frequencies for prompts actually shown. Templates are redacted before they are stored — **filesystem paths become `<path>` and any value attached to a flag becomes `<redacted>`**, so no raw command line, absolute path, or inline credential is retained. It has no network path and is never transmitted. |
| **File writes / edits / deletes** | Checkpointed | Workspace write/edit/delete operations create restorable checkpoints; `unode.writeApproval` can require per-write diff approval; guarded file tools cannot escape their configured roots (realpath, traversal, and symlink checks). |
| **MCP servers** (local `stdio` subprocess / remote) | **Default-deny** | Any subprocess/remote/env server requires explicit one-time approval before mounting ([`shouldRequireApproval`](src/mcp/McpApproval.ts)); an agent sees only servers it was granted. |
| **Agent Skills** | **Extension-owned, read-only** | Instruction-only `SKILL.md` files are validated at build time and progressively disclosed only when an agent's `playbooks` grants them. |
| **Plan mode** | Backend-specific | OpenAI-compatible planning turns receive no write/run/delegate/MCP tools. Claude Headless receives planning guidance; use read-only Folder Access when you need CLI-enforced native write/shell/worktree/external-effect denies. |
| **Codex Headless** | **Coming soon (not runnable)** | The current release does not offer setup/default/start for Codex Headless. A persisted or forged Codex route is rejected by the host before backend construction; historical local-CLI probes below are future-runner research, not an active security boundary. |

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

### Codex Headless — Coming soon; historical local-runner research

Codex Headless is **not runnable in this release**. The registry marks it `coming-soon`; the Agent Builder,
Add Agent picker, setup wizard, and Settings default action do not offer it, and the shared host capability
guard rejects a persisted or forged Codex route before a backend is constructed. This is covered by the route
contract/UI tests; it is not a claim that the legacy CLI adapter itself is a sandbox.

The following Track-A observations are retained as scoped research for the future cloud runner. They do not
describe a Codex process launched by this version.

The discarded Codex Track-A candidate was a **read/search/analyse/review** backend. Each candidate turn's final argv was checked at
the spawn boundary and refuses `danger-full-access`, the approval-and-sandbox bypass, and the hook-trust
bypass (including `flag=value` forms); no setting, including `autoApprove`, can select those escapes. A
`command_execution` card reports what Codex ran inside its sandbox; it is not an UnodeAi approval and is not
governed by `unode.commandApproval` or `unode.allowedCommands`.

**Do not treat Folder Access as a Codex read boundary.** A Windows `codex-cli 0.137.0` effect probe read
`~/.codex/auth.json` from a `read-only` sandbox, so a Codex agent must be treated as able to read files your
user account can read and send material it reads to OpenAI as model context. `-C` sets a working directory;
it does not prove read confinement. The CLI exposes `read_roots`, but its current standalone sandbox command
requires a host-supplied sandbox-state document; UnodeAi has not verified a portable way to supply that state
and therefore does not claim one. The Agent Builder and Security panel repeat this limitation wherever folder
grants would otherwise imply read confinement. Write and network blocking were measured only on Windows
`codex-cli 0.137.0`; their effect on macOS, Linux, and other CLI versions is **UNVERIFIED**.

**Unshipped App Server confirmation (E4, 2026-07-14).** On Windows `codex-cli 0.144.3`, an isolated
App Server probe with both `runtimeWorkspaceRoots` and `writableRoots` limited to a disposable workspace
read a synthetic marker in a sibling directory without emitting a command-approval request. The same build
also held a non-loopback TCP connection before initialization or a turn. These are not shipped Track-A
capabilities or a claim about every App Server path; they are effect-level reasons the planned App Server
bridge is blocked. The shipped route boundary is instead established by
`src/routes/__tests__/RouteContracts.test.ts`, which exercises route resolution and rejects a runtime envelope
whose endpoint or credential identity differs from the selected route.

### Agent Skills

Skills are shipped as extension-owned `skills/<category>/<name>/SKILL.md` files. The validator enforces
lowercase kebab-case names, reserved-word rejection, descriptions that state both purpose and use case, and
an instruction-only tree: scripts, executable payloads, and symlink escapes are rejected. The bundled VSIX
boundary check requires `skills/**/SKILL.md` to be present while also rejecting executable files and
directories under `skills/`.

OpenAI-compatible agents receive only L1 names/descriptions until they call the read-only `load_skill` or
`read_skill_file` tools. Both are limited to that agent's granted names; L3 resolves the requested path with
`realpath` and refuses anything outside the individual skill directory. This deliberately reads extension
resources rather than extending workspace read roots.

Claude Headless materializes a temporary, per-agent `--plugin-dir` containing only granted skills. It never
writes a `.claude` directory in the workspace or user home, and deletes the temporary plugin on process exit.
Every granted Claude agent receives that plugin, including read-only and folder-scoped agents. A live Claude
2.1.206 check confirmed that skill bodies load with `Bash`, `PowerShell`, `Write`, `Edit`, and
`NotebookEdit` disabled; the plugin therefore does not widen filesystem, shell, or write access.

On Windows, the global Claude launcher is a `.cmd` shim. Before any loopback bridge or Claude process starts,
UnodeAi rejects model and reasoning-effort values containing shell metacharacters; the temporary plugin path is
held to the same command-safe character set. The long user and role prompts are streamed on stdin, never placed on
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
pins `ELECTRON_RUN_AS_NODE=1` before launching the hook. The endpoint applies `CommandPolicy` to
`Bash`/`PowerShell`; honors `unode.writeApproval` for native `Write`/`Edit` previews; asks before
external-effect tools; and asks before a native tool name it does not recognize. "Always allow this tool"
lasts only for that running agent session.

Read-only, no-write, and untrusted scopes retain their CLI-level tool denies as defense in depth while the
hook mediates every observed call. The native-subagent notification remains as a visible control: it now
reports that the subagent is mediated and still offers Stop agent or Disable native subagents for this agent.

**Caveat:** MCP servers are separate processes with their own filesystem access. Folder rules constrain the
agent's built-in tools and Claude native tools, not what an approved MCP server can reach.

## 4. VS Code Workspace Trust

UnodeAi declares `capabilities.untrustedWorkspaces: "limited"`. In an **untrusted** workspace it runs
**read-only**: agents can chat, plan, read, and search, but shell commands, file writes/edits/deletes,
Claude native worktree/external-effect tools, MCP servers, and the verify command are all disabled until you
trust the workspace. Security-sensitive
settings (`unode.allowedCommands`, `unode.commandApproval`, `unode.verifyCommand`, gateway URLs, catalog
settings) are `restrictedConfigurations`, so a repository's own settings cannot silently re-enable them.
Virtual workspaces are unsupported. Enforcement is at every chokepoint and checked live.

---

## 5. Secrets

API keys are stored through VS Code SecretStorage — never in `.unode/team.json`, settings, chat exports,
logs, or source control. `${VAR}` placeholders in MCP configs are resolved from SecretStorage at spawn
time, never from arbitrary process env. The Claude team/file/permission MCP bridges and the native-tool gate
use random, bearer-authenticated loopback endpoints. Their temporary configuration is written under the
**gitignored** `.unode/` directory with owner-only permissions (`0600` where supported) and cleaned up on
teardown; request bodies are capped at 64 KiB. The gate URL/token are passed only in the hook process
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
non-runnable repair and no legacy key is read. In a trusted workspace, a host-authored preview and confirmation
are required before the host copies a legacy key or writes migrated routes. The old key and setting are retained
for later workspaces; malformed, missing-key, unknown, and archived records remain visible repairs with zero
model-content egress.

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
means the "reads files → sends to a remote host" pattern cannot occur without an explicit, per-host
approval.

---

## 8. Dependency audit

**As of the v0.9.33 G2 dependency-hygiene pass (2026-07-24), `npm audit --omit=dev` reports 0
vulnerabilities.** This is the audit that covers production dependencies that can contribute to the bundled
VSIX. A plain, non-force `npm audit fix` raised dev-only `postcss` from 8.5.15 to 8.5.23 (and its `nanoid`
dependency from 3.3.12 to 3.3.16). It deliberately retained `@modelcontextprotocol/sdk` 1.29.0; the unsafe
`--force` alternative would downgrade that SDK to 1.24.3.

`npm audit` still reports five high-severity *dev-toolchain* entries. They are all projections of
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

**Note on coverage.** v0.9.57 and v0.9.58 are recorded in the review section above but were not appended
here; the practice lapsed for those two releases and is resumed with v0.9.59 rather than backfilled, since a
reconstructed audit entry is not an audit.

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

  **What the file does carry is stated rather than glossed.** An agent's `env` map is persisted verbatim.
  That is not new — `team.json` has always done it — but this release adds a file whose whole purpose is to
  be kept and possibly handed to a colleague, so a user needs to know before they copy one. The manual says
  it. `.unode/` is in the `.gitignore` UnodeAi writes at `git init`, which means a saved team is never
  committed by accident and sharing one is a deliberate copy out of that folder.

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
  the same agent appeared in both. `UnodeAi: Export Run Evidence Pack` writes one run to a Markdown file the
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
