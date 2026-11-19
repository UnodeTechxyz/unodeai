import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runtimeSystemPrompt, sharedWorkingContract, workerComplianceProtocol } from '../SessionManager';
import { ROLE_TEMPLATES } from '../../roles/RoleConfig';
import { AgentConfig } from '../../types';
import { TeamTools } from '../../backend/TeamTools';
import { MessageBus } from '../../bus/MessageBus';

const cfg = (over: Partial<AgentConfig>): AgentConfig => ({
  id: 'a', role: 'senior-dev', name: 'Dev', skill: '', skills: [],
  provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
  model: 'deepseek-v4-flash', systemPrompt: '', autoApprove: false,
  allowedTools: ['read', 'write', 'execute'],
  ...over,
});

describe('workerComplianceProtocol', () => {
  it('pins the coordinator runtime guidance byte for byte, unchanged by content receipt support', () => {
    const prompt = workerComplianceProtocol(cfg({ role: 'pm', allowedTools: ['delegate'] }), 'a');
    // v0.9.99 P2 changed it on purpose: the order of work first, real line breaks in the delegation rules, and the
    // disposition value needs-rework as the tool accepts it. v0.9.102 R2 changed step 2 on purpose (design 4, the
    // lead's addendum): a small task the lead can finish directly, it does itself.
    // v0.9.103 slice 2 changed it on purpose: one rule says how to answer a teammate's question (reply_to_task).
    // v0.9.105 S1 changed it on purpose: a todo is completed only when accepted; the status tools and run_checks are
    // explained (a configured check is required; one that did not run is never reported as passed).
    expect(createHash('sha256').update(prompt).digest('hex')).toBe('c85da7dfcb1266a2d2ab0df9a6b0c2a304e0969c8bd7d56282bec52a2aa55e20');
    expect(prompt).toContain('A todo for that task is completed only when you record it accepted; a result that arrived, was sent back or waits for a correction is not completed.');
    expect(prompt).toContain('- **inspect_task_status** shows where your delegated tasks stand; it never waits. **cancel_task** stops a task or a teammate. '
      + 'When UnodeAi reports a task stopped by a safety or budget boundary, **continue_task** resumes it with its handle: do not dispatch it again from scratch.');
    expect(prompt).toContain('- Call **run_checks** when the team has a configured check: a configured check is required, and you report its real result. '
      + 'When run_checks says checks are disabled or do not apply (for example on a knowledge team), say so; never report a check that did not run as passed.');
    expect(prompt).toContain('- A teammate\'s question or blocker on its running task comes with an exchange_id. Answer it with '
      + '**reply_to_task** (handle, exchange_id, text): the answer goes into that task. Your ordinary reply goes to the person, not to the teammate.');
    expect(prompt).not.toContain('declare_turn_deliverable');
    expect(prompt).not.toContain('deliver_declared_content');
    expect(prompt).not.toContain('publish_content_receipt');
  });

  // v0.9.99 P7: a change to an existing file is a targeted edit; a whole-file write resends every byte.
  it('tells a writing agent to change part of an existing file with the edit tool, not a whole-file write', () => {
    const out = workerComplianceProtocol(cfg({}), 'pm');
    expect(out).toContain('To change part of an existing file, use the targeted edit tool you have (apply_edit, apply_patch or Edit), not a whole-file write_file');
    expect(out).toContain('Use write_file for a new file or a full rewrite.');
    expect(workerComplianceProtocol(cfg({ allowedTools: ['read'] }), 'pm')).not.toContain('targeted edit tool');
  });

  // v0.9.103 (G1, §5.6): a worker that can message is told how to reach its coordinator during the task, and not to ack.
  it('tells a worker that can message how to tell its coordinator something during the task, with no acknowledgements', () => {
    const out = workerComplianceProtocol(cfg({ allowedTools: ['read', 'message'] }), 'pm');
    expect(out).toContain('- To tell your coordinator something while you work, call send_message with target "coordinator" and kind note, '
      + 'or question or blocker when you need a decision. Send only real content, never an acknowledgement such as "got it".');
    // v0.9.103 slice 2: it may ask and then wait; the task stays open.
    // Audit I1: a rework turn is told that no answer comes back into it, and what to do instead.
    expect(out).toContain('- After a question or blocker on an assigned task, its answer comes back into the task. If you cannot go on without it, '
      + 'end your turn saying what you wait for: the task stays open and continues with the answer. In a rework turn (work '
      + 'sent back to you) no answer comes back into that turn: finish what you can, and if you need the answer, end your '
      + 'turn saying exactly what you need; the coordinator can send the task back with it. The send_message receipt says which applies.');
    expect(workerComplianceProtocol(cfg({ allowedTools: ['read'] }), 'pm')).not.toContain('send_message');
  });

  // v0.9.104 D1.2 (ROADMAP item 19, the skills check part A): one channel for asking, named for each kind of role.
  it('tells a teammate to ask its coordinator only with send_message, also on a conflict, the wrong task or a blocker', () => {
    const rule = '- Ask your coordinator only with send_message (kind question or blocker), not with a CLI\'s own ask-the-user tool '
      + '(such as AskUserQuestion or request_user_input): send_message keeps the question with this task, and its answer '
      + 'comes back into it. This is also the way when the instruction conflicts with what you find, when you believe '
      + 'it is the wrong task, and when you are blocked: ask, rather than ending your turn with the question.';
    for (const backend of [undefined, 'claude', 'codex'] as const) {
      expect(workerComplianceProtocol(cfg({ allowedTools: ['read', 'message'], ...(backend ? { backend } : {}) }), 'pm')).toContain(rule);
    }
    expect(workerComplianceProtocol(cfg({ allowedTools: ['read'] }), 'pm')).not.toContain('Ask your coordinator');
  });

  it('names the coordinator as the source of an assigned task only where there is one', () => {
    const teammate = workerComplianceProtocol(cfg({ allowedTools: ['read', 'message'] }), 'pm');
    expect(teammate).toContain('When your coordinator assigns you a task, it is a direct instruction, not a suggestion. Do it now:');
    expect(teammate).not.toContain('the PM or a teammate assigns');
    const alone = workerComplianceProtocol(cfg({ allowedTools: ['read', 'message'] }), undefined);
    expect(alone).toContain('A task you are given is a direct instruction, not a suggestion. Do it now:');
    expect(alone).not.toContain('coordinator');
  });

  it('never sends Solo to a coordinator: it works for the person alone', () => {
    const solo = workerComplianceProtocol(cfg({ role: 'solo', allowedTools: ['read', 'write', 'message'] }), 'pm');
    expect(solo).not.toContain('send_message');
    expect(solo).not.toContain('coordinator');
    expect(solo).toContain('A task you are given is a direct instruction');
    expect(ROLE_TEMPLATES.solo.role).toBe('solo');
  });

  // v0.9.103 (the Owner, 2026-11-14, option (a)): a CLI teammate that backgrounds its work ends the task with "started";
  // the background result reaches neither the task nor the coordinator.
  // v0.9.105 (P0-BG): an API teammate's run_command has a background mode as well, and the result was reproduced lost
  // the same way, so every teammate that can run commands gets the rule; the API one also waits with check_command.
  it('tells every teammate that can run commands to run an assigned task\'s commands in the foreground', () => {
    const rule = '- On an assigned task, run its commands in the foreground and wait for them to finish, even when they take minutes. '
      + 'Do not start a command in the background and end your turn: the task ends with your turn, and a result that '
      + 'arrives after it reaches neither the task nor your coordinator.';
    const apiWait = ' If a command is still running when its wait ends, it goes on in the background: wait for it with check_command '
      + '(wait_seconds) before you end your turn.';
    expect(workerComplianceProtocol(cfg({ backend: 'claude' }), 'pm')).toContain(rule);
    expect(workerComplianceProtocol(cfg({ backend: 'codex' }), 'pm')).toContain(rule);
    expect(workerComplianceProtocol(cfg({ backend: 'claude' }), 'pm')).not.toContain('check_command');
    expect(workerComplianceProtocol(cfg({}), 'pm')).toContain(rule + apiWait);
    // One without Run commands runs nothing.
    expect(workerComplianceProtocol(cfg({ allowedTools: ['read', 'write'] }), 'pm')).not.toContain('in the foreground');
    expect(workerComplianceProtocol(cfg({ backend: 'claude', allowedTools: ['read', 'write'] }), 'pm')).not.toContain('in the foreground');
    // The coordinator's own guidance is unchanged (its hash is pinned above).
    expect(workerComplianceProtocol(cfg({ role: 'pm', backend: 'claude', allowedTools: ['delegate', 'execute'] }), 'a')).not.toContain('in the foreground');
  });

  it('injects the protocol for worker agents (incl. the shared fresh-read rule)', () => {
    const out = workerComplianceProtocol(cfg({}), 'pm');
    expect(out).toMatch(/Cite from a fresh read, never from memory/i); // shared by every agent
    expect(out).toContain('Carrying out an assigned task');
    expect(out).toMatch(/do not reply with only a plan/i);
    expect(out).toMatch(/Do NOT tell the requester to run a command/i);
    expect(out).toMatch(/When the request is to run an exact command, that is, the user or coordinator hands you the command and\s+asks for its result, call run_command with it as your first tool call/);
    expect(out).toMatch(/this rule comes before the fresh-read rule and the ground-first rule below/i);
    expect(out).toMatch(/do not\s+first confirm that its script exists, read package\.json, list or search files, or look through earlier\s+turns/i);
    // A task that names its own check is not a request to run that check before the work.
    expect(out).toMatch(/A command that is only named as the\s+check for other work is run after that work, not first/);
  });

  // Field run of v0.9.92: an Architect given `npm run check:docs` searched, read package.json, searched again,
  // ran the command, and ran it a second time to be sure the result was from this turn. The rule was a bullet
  // in the third section, under two sections that tell an agent to read before it acts, and it named only one
  // of the two as superseded.
  it('puts what to do with a handed command before the read-first rules', () => {
    const runs = workerComplianceProtocol(cfg({}), 'pm');
    const first = runs.indexOf('## An exact command is run first (required)');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(runs.indexOf('## Cite from a fresh read'));
    expect(first).toBeLessThan(runs.indexOf('## Ground the task in the REAL code'));
    expect(runs).toMatch(/Run it\s+once: a result you received in this turn is current, so do not repeat the command to confirm it/);
    expect(runs.match(/as your first tool call/g)).toHaveLength(1);
    expect(runs).not.toContain('You cannot run commands in this session');

    const cannot = workerComplianceProtocol(cfg({ allowedTools: ['read', 'search', 'write'] }), 'pm');
    const blocked = cannot.indexOf('## You cannot run commands in this session (required)');
    expect(blocked).toBeGreaterThanOrEqual(0);
    expect(blocked).toBeLessThan(cannot.indexOf('## Cite from a fresh read'));
    expect(blocked).toBeLessThan(cannot.indexOf('## Ground the task in the REAL code'));
    expect(cannot).not.toContain('An exact command is run first');
  });

  it('includes the P2 worker-protocol rules (from dogfood findings)', () => {
    const out = workerComplianceProtocol(cfg({}), 'pm');
    // Re-read before claiming "already done" (caught: agent claimed a change from stale memory).
    expect(out).toMatch(/READ the relevant file\(s\).*current contents/is);
    expect(out).toMatch(/never rely on\s+your memory/i);
    // Don't weaken tests to pass (caught: agent changed an assertion to match buggy output).
    expect(out).toMatch(/fixing the CODE, never by weakening the tests/i);
    // Small, verifiable steps.
    expect(out).toMatch(/small, verifiable steps/i);
    // Todo hygiene: mark the final step completed before reporting done.
    expect(out).toMatch(/todo list honest/i);
    expect(out).toMatch(/mark the FINAL step completed/i);
  });

  it('makes workers ground the task in the real code before acting (weak-model failure mode)', () => {
    const out = workerComplianceProtocol(cfg({}), 'pm');
    expect(out).toMatch(/Ground the task in the REAL code before you act/i);
    expect(out).toMatch(/instruction tells you the INTENT/i);
    expect(out).toMatch(/RECONCILE the instruction with what you found/i);
    expect(out).toMatch(/do not invent a function, file, import, or pattern/i);
    expect(out).toMatch(/instruction CONFLICTS with reality/i);
  });

  it('does NOT give the coordinator the worker-only ground-first / task protocol', () => {
    const out = workerComplianceProtocol(cfg({ role: 'pm', allowedTools: ['read', 'search', 'delegate', 'message'] }), 'a');
    expect(out).toMatch(/Cite from a fresh read, never from memory/i);
    expect(out).toMatch(/read it this turn/i);
    expect(out).not.toContain('Carrying out an assigned task'); // not the worker protocol
    expect(out).not.toMatch(/Ground the task in the REAL code/i);
  });

  it('gives any delegate-holding agent the same fresh-read rule', () => {
    const out = workerComplianceProtocol(cfg({ role: 'custom', allowedTools: ['read', 'delegate'] }), 'pm');
    expect(out).toMatch(/Cite from a fresh read, never from memory/i);
  });

  it('uses the supplied coordinator id rather than a PM role or delegate capability', () => {
    const secondPm = cfg({ id: 'pm-2', role: 'pm', allowedTools: ['delegate'] });

    expect(workerComplianceProtocol(secondPm, 'pm')).toContain('Carrying out an assigned task');
    expect(workerComplianceProtocol(secondPm, 'pm')).not.toContain('## How to delegate');
    expect(workerComplianceProtocol(cfg({ id: 'pm', role: 'pm' }), 'pm')).toContain('## How to delegate');
  });

  it('does not retain the transcript-visibility instruction after structural receipt publication', () => {
    const out = workerComplianceProtocol(cfg({}), 'pm');
    expect(out).not.toContain('A tool result is not a user-visible reply');
    expect(out).not.toMatch(/"I read it" is not "I\s*showed it to you\./i);
    expect(out).not.toMatch(/Do not rely on tool-card rendering/i);
  });

  it('still applies to read-only workers like the reviewer', () => {
    const out = workerComplianceProtocol(cfg({ role: 'reviewer', allowedTools: ['read', 'search', 'message'] }), 'pm');
    expect(out).toContain('deliverable');
    expect(out).toContain('Blocked: this agent does not have Write files');
    expect(out).toContain('Blocked: this agent does not have Run commands');
    expect(out).toMatch(/do not inspect package scripts, search conversation history/i);
    expect(out).toMatch(/Reading a script or a previous run is not execution/i);
    expect(out).not.toMatch(/YOU run it/i);
  });

  // Agent Builder has no "Write files" switch: a permission is what a ticked capability results in, and the form says
  // so under each capability. Run commands has a control of its own for an agent on a shipped role (v0.9.99 L4), and
  // none for a Custom role; v0.9.102 names it where the form shows it. The way on an agent names has to be one the
  // requester can find, so the words the guidance uses are checked against the form's own.
  it('names a way on that Agent Builder really offers', () => {
    const custom = workerComplianceProtocol(cfg({ role: 'custom', allowedTools: ['read', 'search', 'message'] }), 'pm');
    expect(custom).toMatch(/in Agent Builder, under Tools, tick a capability whose resulting\s+permissions include Run commands, or send the task to a capable agent/);
    expect(custom).toMatch(/Agent Builder has no separate\s+Run commands switch for this agent/);
    const shipped = workerComplianceProtocol(cfg({ role: 'reviewer', roleTemplateKey: 'reviewer', allowedTools: ['read', 'search', 'message'] }), 'pm');
    expect(shipped).toMatch(/in Agent Builder, under Tools, set Run commands to On, or tick a\s+capability whose resulting permissions include Run commands; or send the task to a capable agent/);
    expect(shipped).not.toMatch(/no separate\s+Run commands switch/);
    for (const out of [custom, shipped]) {
      expect(out).toMatch(/in Agent Builder, under Tools, tick a capability whose resulting permissions include Write files, or send the task to a capable agent/);
      expect(out).not.toMatch(/enable (Run commands|Write files) in Agent Builder/i);
    }

    const builder = readFileSync(join(process.cwd(), 'src/views/AgentBuilderPanel.ts'), 'utf8');
    expect(builder).toContain('<h2>Tools</h2>');
    expect(builder).toContain('Resulting permissions: ');
    // Under a capability the form writes them in lower case; its notice beside Save capitalises them.
    expect(builder).toMatch(/case 'write': return 'write files';\s+case 'execute': return 'run commands';/);
    expect(builder).toMatch(/write: 'Write files', execute: 'Run commands'/);
    // The Run commands control and its On choice, shown for a role that has command defaults: every shipped role,
    // which the form opens by the agent's template key. A Custom role has none.
    expect(builder).toContain('<label for="executePreference">Run commands</label>');
    expect(builder).toContain('<option value="allow">On</option>');
    expect(builder).toContain("byId('executePreferenceWrap').hidden = !role?.commandToolDefaults;");
    const host = readFileSync(join(process.cwd(), 'src/extension.ts'), 'utf8');
    expect(host).toContain('commandToolDefaults: { deniedTools: template.deniedTools ?? [] },');
    expect(host).toContain('roleKey: agent.roleTemplateKey,');
  });
});

describe('coordinator delegation protocol reaches EXISTING agents (prompt-freeze regression)', () => {
  // An agent's systemPrompt is copied from its role template at creation and PERSISTED, so a template edit
  // only ever reaches NEW agents. A field report caught this: the delegation rule was fixed, but a PM created
  // earlier kept blocking on assign_task and the user could not reach it. The rule must be appended at
  // RUNTIME (so old PMs get it) and must SUPERSEDE the frozen copy still in their prompt.
  it('appends the non-blocking delegation rule to a coordinator at runtime', () => {
    const pm = workerComplianceProtocol({ id: 'pm', role: 'pm', allowedTools: ['delegate'] } as never, 'pm');
    expect(pm).toMatch(/dispatch_task/);
    expect(pm).toMatch(/collect_ready_tasks/);
    expect(pm).toMatch(/END YOUR TURN/i);
    expect(pm).toMatch(/SUPERSEDES any earlier delegation instruction/i);
    expect(pm).toMatch(/no blocking delegation tool/i);
  });

  it('does not give a non-coordinator worker delegation rules', () => {
    const worker = workerComplianceProtocol({ role: 'senior-dev', allowedTools: ['write'] } as never, 'pm');
    expect(worker).not.toMatch(/dispatch_task/);
  });

  describe('coordinator order of work (v0.9.99 P2)', () => {
    const pm = (fields: Partial<AgentConfig> = {}) => workerComplianceProtocol(cfg({ id: 'pm', role: 'pm', allowedTools: ['read', 'delegate'], ...fields }), 'pm');

    it('puts the order of work before the fresh-read rule and the delegation rules, in its four steps', () => {
      const out = pm();
      const order = out.indexOf('## Order of work in this turn');
      expect(order).toBeGreaterThanOrEqual(0);
      expect(order).toBeLessThan(out.indexOf('## Cite from a fresh read'));
      expect(out.indexOf('## Cite from a fresh read')).toBeLessThan(out.indexOf('## How to delegate'));
      const steps = ['1. Results already delivered come first.', '2. A small task you can finish directly, do yourself.',
        '3. Dispatch every independent task in this turn', '4. Before you state a current fact about a source'];
      const at = steps.map((step) => out.indexOf(step));
      expect(at.every((index) => index > order)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
    });

    it('names the current tools, and the edit tool of the dialect of the agent', () => {
      expect(pm()).toContain('**record_task_disposition**');
      expect(pm()).toContain('**dispatch_task**');
      expect(pm()).toContain('prefer **apply_edit** over rewriting the whole file with **write_file**');
      expect(pm({ editToolDialect: 'apply-patch' })).toContain('prefer **apply_patch** over rewriting the whole file');
    });

    it('limits ending the turn to the waiting case, and says a named path needs no full read', () => {
      const out = pm();
      expect(out).toContain('"End your turn" is for that waiting case only: it never cuts short a closeout, a required check, or another action that is ready now.');
      expect(out).toContain('When only its asynchronous result remains, **END YOUR TURN**');
      expect(out).not.toContain('Task Contract, then **END YOUR TURN**');
      expect(out).toContain('A path in a request is not a claim about what the file says now');
    });

    // Codex's audit of 81572923: the guidance named "rework", a value record_task_disposition does not accept.
    it('names only disposition values the record_task_disposition schema accepts', () => {
      const team = new TeamTools('pm', { list: () => [], resolve: () => undefined }, new MessageBus());
      const schema = team.specs().find((tool) => tool.function.name === 'record_task_disposition')!.function.parameters as
        { properties: { disposition: { enum: string[] } } };
      const accepted = new Set(schema.properties.disposition.enum);
      const lists = [...pm().matchAll(/\((accepted, [^)]*)\)/g)].map((match) => match[1]);
      expect(lists).toHaveLength(2);
      for (const value of lists.flatMap((list) => list.split(/,\s*(?:or\s+)?|\s+or\s+/))) expect(accepted).toContain(value.trim());
    });

    it('sends the delegation rules as lines, not as one line of literal backslash-n', () => {
      const out = pm();
      expect(out).not.toContain('\\n');
      expect(out).toContain('\n## How to delegate (required');
      expect(out).toContain('\n- DEFAULT: call **dispatch_task**');
    });
  });
});

// v0.9.102 R2 (design 2.1, 4): one shared working contract, assembled once with the role text and the runtime rules.
describe('v0.9.102 shared working contract (design 4)', () => {
  const HEADING = '## How to work (shared by every agent)';
  const LEAD = 'As the lead: do a small task yourself';
  const REVIEWER = 'As a reviewer: first confirm what actually triggers a problem';
  const DOER = 'Doing the work: focus on the deliverable';
  const count = (text: string, part: string) => text.split(part).length - 1;
  // The Reviewer prompt as published in 0.9.101, byte for byte. Its hash stays in the registry.
  const REVIEWER_101 = `You are an independent Reviewer — the team's objective quality gate. You did NOT
write this code, and you must stay independent: never rubber-stamp.
For each task handed to you:
- Verify the work against the stated acceptance criteria and the architect's published contracts
  (signatures/types/API shapes). Flag any contract drift.
- Look for correctness bugs, missing edge cases, weak error handling, security issues, and missing tests.
- Where you can run commands, run the project's own checks (tests, lint, type checks, build) when the
  verdict depends on them, and say what you ran and what it returned. Where you cannot, say that the
  verdict rests on reading alone.
- Where you can write files, put your review or quality report in a file of its own when the task asks
  for one or the findings are too long for a reply.
- You never change the work you review: not its code, its tests or its documents, by a tool or by a
  command. A fix is the implementer's.
Return a clear verdict: PASS or FAIL. If FAIL, list each problem with file/line and a concrete fix
for the implementer. Be specific and evidence-based; vague approval is worse than useless.`;

  it('assembles the role text, the runtime rules and one shared contract, with the addendum of the agent kind last', () => {
    const kinds = [
      { config: cfg({ id: 'pm', role: 'pm', allowedTools: ['read', 'delegate'], systemPrompt: 'ROLE-TEXT-LEAD' }), addendum: LEAD },
      { config: cfg({ role: 'reviewer', systemPrompt: 'ROLE-TEXT-REVIEW' }), addendum: REVIEWER },
      { config: cfg({ systemPrompt: 'ROLE-TEXT-DEV' }), addendum: DOER },
      { config: cfg({ role: 'solo', systemPrompt: 'ROLE-TEXT-SOLO' }), addendum: DOER },
    ];
    for (const { config, addendum } of kinds) {
      const out = runtimeSystemPrompt(config, 'pm');
      expect(out.startsWith(config.systemPrompt), config.role).toBe(true);
      expect(count(out, HEADING), config.role).toBe(1);
      expect(out.indexOf(HEADING), config.role).toBeGreaterThan(out.indexOf('## Cite from a fresh read'));
      expect(out.endsWith(sharedWorkingContract(config, 'pm')), config.role).toBe(true);
      expect(out.slice(out.lastIndexOf('\n') + 1).startsWith(addendum), config.role).toBe(true);
      for (const other of [LEAD, REVIEWER, DOER].filter((part) => part !== addendum)) expect(out, config.role).not.toContain(other);
    }
    // The lead is the coordinator, not any agent named pm.
    expect(runtimeSystemPrompt(cfg({ id: 'second-pm', role: 'pm', systemPrompt: 'X' }), 'pm')).toContain(DOER);
  });

  it('says what the design asks of every agent, and grants or forbids nothing by itself', () => {
    const text = sharedWorkingContract(cfg({}), 'pm').replace(/\s+/g, ' ');
    expect(text).toContain('Where a required rule above is more specific, it comes first.');
    expect(text).toContain('Start from the usable result the person wants, and use enough method to deliver it.');
    expect(text).toContain('When something is missing, say what it is and give the real way on.');
    expect(text).toContain('Your role sets your focus; it does not forbid adjacent work the result needs.');
    expect(text).toContain('That never waives a check the work needs or a review the project requires.');
    expect(text).toContain('What you have not verified, do not call passed.');
    expect(text).toContain("Keep the person's limits and the project's review and release rules.");
    expect(text).toContain("Do not turn work down because of your role's title.");
    expect(text).not.toMatch(/risk table|probabilit|token budget|time ?out/i);
  });

  it('gives a shipped 0.9.101 prompt the current role text, and keeps a custom one word for word', () => {
    const shipped = cfg({ role: 'reviewer', roleTemplateKey: 'reviewer', systemPromptSource: 'template', systemPrompt: REVIEWER_101 });
    const legacy = cfg({ role: 'reviewer', roleTemplateKey: 'reviewer', systemPrompt: REVIEWER_101 });
    for (const config of [shipped, legacy]) {
      const out = runtimeSystemPrompt(config, 'pm');
      expect(out.startsWith(ROLE_TEMPLATES.reviewer.systemPrompt)).toBe(true);
      expect(out).not.toContain('You never change the work you review');
      expect(count(out, HEADING)).toBe(1);
    }
    const own = cfg({ role: 'reviewer', roleTemplateKey: 'reviewer', systemPromptSource: 'custom', systemPrompt: REVIEWER_101 });
    const kept = runtimeSystemPrompt(own, 'pm');
    expect(kept.startsWith(REVIEWER_101)).toBe(true);
    expect(kept).not.toContain(ROLE_TEMPLATES.reviewer.systemPrompt);
    // The runtime rules and the contract reach a custom prompt as they reach every agent.
    expect(count(kept, HEADING)).toBe(1);
    // The stored configuration is never rewritten by the assembly.
    expect(own.systemPrompt).toBe(REVIEWER_101);
  });
});
