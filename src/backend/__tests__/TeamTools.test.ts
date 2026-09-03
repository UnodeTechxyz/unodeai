import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TeamTools, TeamView, TeamRosterEntry, classifyDelegationEvidence, formatDelegationEvidence } from '../TeamTools';
import { summarizeToolResult } from '../toolSummary';
import { MessageBus } from '../../bus/MessageBus';
import { Message } from '../../types';
import { CommandPolicy } from '../CommandPolicy';
import { TaskClaimRegistry } from '../TaskClaimRegistry';
import { resetShellCommandGateWarningsForTest } from '../ShellCommandGate';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { compileTaskContract, TaskInputResolver } from '../TaskContract';
import type { VerificationPlan } from '../VerificationPlan';
import { join } from 'path';

const commandExitPlan: VerificationPlan = {
  sensors: ['command-exit-zero'],
  noneApplies: 'report-no-applicable-sensor',
};

function taskContract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    objective: 'Complete the declared task.',
    expected_deliverable: 'Return the concrete result.',
    effects: { read_files: [], expected_file_effect: 'none' },
    inputs: [],
    constraints: [],
    dependencies: [],
    required_capabilities: { version: 1, capabilities: [] },
    execution_strategy: 'delegate-required',
    ...overrides,
  };
}

function taskInputResolver(): TaskInputResolver {
  return new TaskInputResolver(new ContentAssetStore(), process.cwd());
}

const roster = [
  { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
  {
    id: 'dev', role: 'senior-dev', name: 'Dev', status: 'idle',
    capabilities: { read: true, write: true, shell: true, verificationSensors: ['command-exit-zero', 'run-checks'], toolFamilies: ['read', 'write', 'execute'], backend: 'openai-compat', taskScope: 'per-turn' as const },
  },
  { id: 'tester', role: 'tester', name: 'Tester', status: 'idle' },
];

const view: TeamView = {
  list: () => roster,
  preflightTaskScope: () => undefined,
  resolve: (ref) => {
    if (ref === 'dev' || ref === 'senior-dev') { return { id: 'dev' }; }
    if (ref === 'tester') { return { id: 'tester' }; }
    if (ref === 'pm') { return { id: 'pm' }; }
    return undefined;
  },
};

describe('TeamTools (PM coordinator)', () => {
  let bus: MessageBus;
  let team: TeamTools;

  beforeEach(() => {
    resetShellCommandGateWarningsForTest();
    bus = new MessageBus();
    team = new TeamTools('pm', view, bus, { timeoutMs: 1000, taskInputResolver: taskInputResolver() });
  });

  it('does not offer a worker any dispatch or dispatch-status surface even when constructed with TeamTools', async () => {
    const worker = new TeamTools('dev', view, bus, { coordinatorId: 'pm', taskInputResolver: taskInputResolver() });
    const names = worker.specs().map((spec) => spec.function.name);

    for (const name of ['dispatch_task', 'assign_task_async', 'collect_ready_tasks', 'inspect_task_status']) {
      expect(names).not.toContain(name);
    }
    await expect(worker.run('dispatch_task', { agent: 'tester', instruction: 'Do the work.', contract: taskContract() }))
      .resolves.toMatch(/dispatch belongs to the coordinator.*Ask the coordinator directly/i);
    await expect(worker.runOutcome('dispatch_task', { agent: 'tester', instruction: 'Do the work.', contract: taskContract() }))
      .resolves.toMatchObject({ source: 'host', status: 'refused', reason: 'capability' });
  });

  it('reports team-tool validation and success through the structured host boundary', async () => {
    await expect(team.runOutcome('close_assignment', { outcome: 'complete' }))
      .resolves.toMatchObject({ source: 'host', status: 'failed' });
    await expect(team.runOutcome('list_agents', {}))
      .resolves.toMatchObject({ source: 'host', status: 'success', contentSource: 'mixed-external' });
  });

  it('refuses a declined coordinator-brief egress before creating an attempt or starting a worker', async () => {
    const resolver = taskInputResolver();
    const approveCoordinatorBriefEgress = vi.fn(async () => ({
      allowed: false,
      reason: 'The user declined this destination.',
    }));
    const consentTeam = new TeamTools('pm', view, bus, {
      timeoutMs: 1_000,
      taskInputResolver: resolver,
      approveCoordinatorBriefEgress,
    });
    const assignments: Message[] = [];
    bus.onType('task.assign', (message) => assignments.push(message));

    const result = await consentTeam.run('dispatch_task', {
      agent: 'dev',
      instruction: 'Investigate the task.',
      contract: taskContract({ coordinator_brief: { text: 'Start with the known acceptance boundary.' } }),
    });

    expect(result).toMatch(/brief dispatch was not approved.*declined this destination/i);
    expect(approveCoordinatorBriefEgress).toHaveBeenCalledWith('pm', 'dev');
    expect(assignments).toEqual([]);
    await expect(consentTeam.runOutcome('dispatch_task', {
      agent: 'dev', instruction: 'again', contract: taskContract({ coordinator_brief: { text: 'again' } }),
    })).resolves.toMatchObject({ status: 'refused', reason: 'consent' });
  });

  it('fails closed when a coordinator brief has no destination-consent surface', async () => {
    const assignments: Message[] = [];
    bus.onType('task.assign', (message) => assignments.push(message));

    await expect(team.runOutcome('dispatch_task', {
      agent: 'dev',
      instruction: 'Investigate the task.',
      contract: taskContract({ coordinator_brief: { text: 'Do not send this without a host consent decision.' } }),
    })).resolves.toMatchObject({ status: 'refused', reason: 'consent' });
    expect(assignments).toEqual([]);
  });

  it('rejects a declared but ungranted brief basis before the worker starts', async () => {
    const assignments: Message[] = [];
    bus.onType('task.assign', (message) => assignments.push(message));
    const result = await team.run('dispatch_task', {
      agent: 'dev',
      instruction: 'Use the source.',
      contract: taskContract({
        inputs: [{
          input_id: 'optional-source', kind: 'contentAsset', asset_id: 'content-404', purpose: 'Optional source',
          required: false, freshness: 'attempt-start', provenance: { kind: 'user-turn', source_refs: [] },
        }],
        required_capabilities: { version: 1, capabilities: ['read'] },
        coordinator_brief: { text: 'This rests on the optional source.', basis_refs: ['optional-source'] },
      }),
    });
    expect(result).toMatch(/coordinator brief cites input "optional-source".*not granted/i);
    expect(assignments).toEqual([]);
  });

  it('keeps a coordinator able to dispatch and inspect its own handles while a coordinator-only attempt is live', async () => {
    const resolver = taskInputResolver();
    const visibleHandles = new Set<string>();
    let assigned: Message | undefined;
    bus.onType('task.assign', (message) => { assigned = message; });
    const scopedView: TeamView = {
      list: () => [
        { id: 'pm', role: 'pm', name: 'PM', status: 'running', capabilities: { read: true, write: true, shell: true, toolFamilies: ['read', 'write', 'execute', 'delegate'], taskScope: 'per-turn' } },
        roster[1],
      ],
      resolve: (ref) => ref === 'dev' ? { id: 'dev' } : undefined,
      preflightTaskScope: () => undefined,
    };
    const coordinator = new TeamTools('pm', scopedView, bus, {
      coordinatorId: 'pm',
      taskInputResolver: resolver,
      onDelegationDispatched: (event) => visibleHandles.add(event.handle),
      inspectTaskStatus: (handles) => (handles ?? []).flatMap((handle) =>
        visibleHandles.has(handle) ? [{ handle, lifecycle: 'active' as const }] : []),
    });

    await expect(coordinator.run('dispatch_task', {
      agent: 'dev', instruction: 'Complete the coordinator-owned atomic step.',
      contract: taskContract({ execution_strategy: 'coordinator-only' }),
    })).resolves.toMatch(/Coordinator execution is authorised/);
    expect(coordinator.currentCoordinatorTaskAttempt()).toBeDefined();

    const dispatched = await coordinator.run('dispatch_task', {
      agent: 'dev', instruction: 'Investigate the independent follow-up.', contract: taskContract(),
    });
    const handle = dispatched.match(/Handle: ([0-9a-f-]+)/i)?.[1];
    expect(handle).toBeDefined();
    await expect(coordinator.run('inspect_task_status', { handles: [handle] }))
      .resolves.toMatch(new RegExp(`handle ${handle}[\\s\\S]*state: active`, 'i'));
    bus.send('dev', 'pm', 'task.complete', { instruction: 'Follow-up complete.' }, 'normal', assigned?.correlationId);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

  it('list_agents shows teammates but not self, and does NOT surface a status that reads as "unavailable"', async () => {
    const out = await team.run('list_agents', {});
    expect(out).toContain('dev');
    expect(out).not.toContain('pm (');
    // A coordinator reads "status: stopped" as "can't delegate" and loops; we omit it and tell it to
    // delegate now (teammates auto-start on assignment).
    expect(out).not.toMatch(/status:/i);
    expect(out).toMatch(/dispatch_task/);
    expect(out).toMatch(/starts automatically/i);
  });

  /**
   * Four specialists a coordinator could not tell apart.
   *
   * Content Strategist, Frontend Engineer, Product Designer and SEO Specialist all carry the runtime role
   * "custom" by design — the role is a capability class, not a job title. list_agents rendered the id and
   * the role and nothing else, so the whole Website team arrived as four identical lines and the choice of
   * specialist was a coin toss the coordinator had no way to win. A writing task landing on the frontend
   * engineer was not a judgement failure; it was the only information anyone had.
   *
   * resolveTarget has always accepted a display name, and its comment claimed the PM sees one here. It did
   * not.
   */
  /**
   * Skills are the field that names the work, and two role templates disagree about where to put them.
   *
   * The Content Strategist declares `skills` and no playbooks; the Frontend Engineer declares playbooks and
   * no `skills`. Sending one field would leave whichever specialist chose the other invisible for exactly
   * the task it exists for.
   */
  it('merges capability skills and playbooks so neither kind of specialist is invisible', async () => {
    const roster = [
      { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
      { id: 'writer', role: 'custom', name: 'Content Strategist', status: 'idle', skills: ['Content marketing', 'Documentation'] },
      { id: 'fe', role: 'custom', name: 'Frontend Engineer', status: 'idle', skills: ['responsive-breakpoint-review', 'design-system-consistency'] },
    ];
    const view: TeamView = { list: () => roster, resolve: () => undefined };
    const out = await new TeamTools('pm', view, bus, { timeoutMs: 1000 }).run('list_agents', {});

    expect(out).toContain('skills: Content marketing, Documentation');
    expect(out).toContain('skills: responsive-breakpoint-review, design-system-consistency');
  });

  // A roster is re-read on every coordinator turn, so an unbounded list is a cost paid forever to say the
  // same thing. Six names identify a specialist; the rest is a count.
  it('bounds a long skill list rather than paying for it on every turn', async () => {
    const many = Array.from({ length: 9 }, (_, i) => `skill-${i + 1}`);
    const view: TeamView = {
      list: () => [
        { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
        { id: 'dev', role: 'custom', name: 'Dev', status: 'idle', skills: many },
      ],
      resolve: () => undefined,
    };
    const out = await new TeamTools('pm', view, bus, { timeoutMs: 1000 }).run('list_agents', {});

    expect(out).toContain('skill-6');
    expect(out).not.toContain('skill-7');
    expect(out).toContain('(+3 more)');
  });

  it('tells two custom-role specialists apart by name and specialty', async () => {
    const roster = [
      { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
      { id: 'writer', role: 'custom', name: 'Content Strategist', status: 'idle', specialty: 'Writes and edits page copy against a factual brief.' },
      { id: 'fe', role: 'custom', name: 'Frontend Engineer', status: 'idle', specialty: 'Builds responsive, accessible pages from approved designs.' },
    ];
    const view: TeamView = { list: () => roster, resolve: () => undefined };
    const out = await new TeamTools('pm', view, bus, { timeoutMs: 1000 }).run('list_agents', {});

    expect(out).toContain('Content Strategist');
    expect(out).toContain('Frontend Engineer');
    expect(out).toContain('specialty: Writes and edits page copy against a factual brief.');
    // The two lines must differ by more than an opaque id.
    const custom = out.split('\n').filter((line) => line.includes('role: custom'));
    expect(custom).toHaveLength(2);
    expect(custom[0].replace('writer', '')).not.toBe(custom[1].replace('fe', ''));
    expect(out).toMatch(/Match the work to the specialty/);
  });

  /**
   * A task scope aimed at a native CLI is refused at dispatch, correctly and fail-closed — but until this
   * fact reached the roster the refusal arrived after the coordinator had already chosen. Failing closed at
   * the wrong end of a decision still wastes the assignment.
   */
  it('says which teammates can have a per-assignment folder scope enforced, before one is dispatched', async () => {
    const roster = [
      { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
      {
        id: 'designer', role: 'custom', name: 'Product Designer', status: 'idle',
        capabilities: { read: true, write: true, shell: false, toolFamilies: ['read'], backend: 'claude', taskScope: 'fixed-session-only' as const },
      },
      {
        id: 'dev', role: 'custom', name: 'Frontend Engineer', status: 'idle',
        capabilities: { read: true, write: true, shell: false, toolFamilies: ['read'], backend: 'openai-compat', taskScope: 'per-turn' as const },
      },
    ];
    const view: TeamView = { list: () => roster, resolve: () => undefined };
    const out = await new TeamTools('pm', view, bus, { timeoutMs: 1000 }).run('list_agents', {});

    expect(out).toContain('backend: claude');
    expect(out).toContain('task scope: fixed-session-only');
    expect(out).toMatch(/CANNOT be enforced/);
    expect(out).toContain('task scope: per-turn');
    expect(out).toMatch(/CAN be enforced/);
  });

  it('surfaces each teammate\'s shell, write, and tool-family facts to the coordinator', async () => {
    const capabilityRoster = [
      { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
      {
        id: 'reviewer', role: 'reviewer', name: 'Reviewer', status: 'idle',
        capabilities: { read: true, write: false, shell: false, toolFamilies: ['read', 'search'] },
      },
    ];
    const capabilityView: TeamView = { list: () => capabilityRoster, resolve: () => undefined };
    const capabilityTeam = new TeamTools('pm', capabilityView, bus, { timeoutMs: 1000 });

    const out = await capabilityTeam.run('list_agents', {});
    expect(out).toContain('shell no');
    expect(out).toContain('write no');
    expect(out).toContain('tool families: read, search');
  });

  it('refuses an explicit shell task for a teammate whose connection has no shell capability', async () => {
    const capabilityRoster = [
      { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
      {
        id: 'reviewer', role: 'reviewer', name: 'Reviewer', status: 'idle',
        capabilities: { read: true, write: false, shell: false, toolFamilies: ['read', 'search'] },
      },
    ];
    const capabilityView: TeamView = {
      list: () => capabilityRoster,
      resolve: (ref) => ref === 'reviewer' ? { id: 'reviewer' } : undefined,
    };
    const routes: string[] = [];
    const capabilityTeam = new TeamTools('pm', capabilityView, bus, {
      timeoutMs: 1000, onRoute: (line) => routes.push(line), taskInputResolver: taskInputResolver(),
    });
    let dispatched = false;
    bus.onType('task.assign', () => { dispatched = true; });

    const out = await capabilityTeam.run('dispatch_task', {
      agent: 'reviewer', instruction: 'Run the configured check and report the result.',
      contract: taskContract({ required_capabilities: { version: 1, capabilities: ['shell'] } }),
    });
    expect(out).toMatch(/no-executor/i);
    expect(out).toMatch(/shell/i);
    expect(dispatched).toBe(false);
    expect(routes).toEqual([]);
  });

  it('does not infer a shell requirement from a read-only request that merely mentions a command', async () => {
    const capabilityRoster = [
      { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
      {
        id: 'reviewer', role: 'reviewer', name: 'Reviewer', status: 'idle',
        capabilities: { read: true, write: false, shell: false, toolFamilies: ['read', 'search'] },
      },
    ];
    const capabilityView: TeamView = {
      list: () => capabilityRoster,
      resolve: (ref) => ref === 'reviewer' ? { id: 'reviewer' } : undefined,
    };
    const capabilityTeam = new TeamTools('pm', capabilityView, bus, { timeoutMs: 1000 });
    bus.onType('task.assign', (m: Message) => {
      bus.send('reviewer', m.from, 'task.complete', { instruction: 'Read-only audit: no command was attempted.' }, 'normal', m.correlationId);
    });

    const out = await capabilityTeam.run('assign_task', {
      agent: 'reviewer',
      instruction: 'Review the packet and report whether you attempted a command. Read/search only.',
    });
    expect(out).toContain('Read-only audit');
    expect(out).not.toMatch(/capability mismatch/i);
  });

  // v0.9.44: a PM read "write yes" on a read-capable teammate as "not in read-only Folder Access" and
  // refused to delegate a read-only audit. Extra capability is NOT a mismatch — these facts are the
  // connection's tool families, and list_agents does not report Folder Access at all.
  it('list_agents labels capabilities as connection tool families, notes extra is not a mismatch, and does not claim Folder Access', async () => {
    const capabilityRoster = [
      { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
      {
        id: 'architect', role: 'architect', name: 'Architect', status: 'idle',
        capabilities: { read: true, write: true, shell: false, toolFamilies: ['read', 'write', 'search'] },
      },
    ];
    const capabilityView: TeamView = { list: () => capabilityRoster, resolve: () => undefined };
    const capabilityTeam = new TeamTools('pm', capabilityView, bus, { timeoutMs: 1000 });

    const out = await capabilityTeam.run('list_agents', {});
    expect(out).toContain('connection capabilities');
    expect(out).toContain('write yes');
    expect(out).toContain('read yes');
    expect(out).toMatch(/NOT Folder Access/i);
    expect(out).toMatch(/not a mismatch for a read-only task/i);
    expect(out).toMatch(/assignable to a read-only audit/i);
  });

  it('dispatches a read-only task to a teammate with extra write capability (extra is not a mismatch)', async () => {
    const capabilityRoster = [
      { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
      {
        id: 'architect', role: 'architect', name: 'Architect', status: 'idle',
        capabilities: { read: true, write: true, shell: false, toolFamilies: ['read', 'write', 'search'] },
      },
    ];
    const capabilityView: TeamView = {
      list: () => capabilityRoster,
      resolve: (ref) => ref === 'architect' ? { id: 'architect' } : undefined,
    };
    const capabilityTeam = new TeamTools('pm', capabilityView, bus, { timeoutMs: 1000 });
    bus.onType('task.assign', (m: Message) => {
      if (m.to === 'architect') {
        bus.send('architect', m.from, 'task.complete', { instruction: 'audit findings' }, 'normal', m.correlationId);
      }
    });

    const out = await capabilityTeam.run('assign_task', { agent: 'architect', instruction: 'Review and audit src/ and report findings.' });
    expect(out).toBe('audit findings');
    expect(out).not.toMatch(/capability mismatch/i);
  });

  it('excludes the standalone Solo agent from delegation (not in list_agents, not resolvable by id)', async () => {
    const withSolo = [
      { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
      { id: 'dev', role: 'senior-dev', name: 'Dev', status: 'idle' },
      { id: 'solo', role: 'solo', name: 'Solo', status: 'idle' },
    ];
    // A resolver that WOULD happily hand back the solo by exact id — TeamTools must still refuse it.
    const v: TeamView = { list: () => withSolo, resolve: (ref) => (ref === 'solo' ? { id: 'solo' } : undefined) };
    const t = new TeamTools('pm', v, bus, { timeoutMs: 1000 });

    const listed = await t.run('list_agents', {});
    expect(listed).toContain('dev');
    expect(listed).not.toContain('solo'); // Solo is the user's direct option, never surfaced to the PM

    // Targeting solo explicitly must NOT route there; it refuses and reports back the delegatable
    // roster hint, which offers only real crew roles (solo is never listed as a delegation target).
    const out = await t.run('assign_task', { agent: 'solo', instruction: 'do it' });
    expect(out).not.toMatch(/done|dispatched/i);
    expect(out).toMatch(/no teammate/i);
    expect(out).not.toMatch(/one of:[^)]*solo/i); // solo not offered as a delegatable role
  });

  it('never makes Solo the only automatic contract-routing candidate', async () => {
    const soloOnly: TeamRosterEntry[] = [
      {
        id: 'pm', role: 'pm', name: 'PM', status: 'running',
        capabilities: { read: true, write: true, shell: true, toolFamilies: ['read', 'write', 'execute', 'delegate'], verificationSensors: [], taskScope: 'per-turn' },
      },
      {
        id: 'solo', role: 'solo', name: 'Solo', status: 'idle',
        capabilities: { read: true, write: true, shell: true, toolFamilies: ['read', 'write', 'execute'], verificationSensors: [], taskScope: 'per-turn' },
      },
    ];
    const routed: Message[] = [];
    const localBus = new MessageBus();
    localBus.onType('task.assign', (message) => routed.push(message));
    const tools = new TeamTools('pm', { list: () => soloOnly, resolve: (ref) => ({ id: ref }) }, localBus, {
      timeoutMs: 1_000,
      taskInputResolver: taskInputResolver(),
    });

    await expect(tools.run('dispatch_task', {
      agent: 'solo', instruction: 'Do not route automatic contract work to Solo.', contract: taskContract(),
    })).resolves.toMatch(/no-executor.*Solo was not used as a fallback/i);
    expect(routed).toEqual([]);
  });

  it('assign_task dispatches to a teammate and returns their result', async () => {
    // Stand in for SessionManager+worker: reply to any task.assign with a task.complete
    // echoing the assign's correlationId (which is what SessionManager does for real).
    bus.onType('task.assign', (m: Message) => {
      if (m.to === 'dev') {
        bus.send('dev', m.from, 'task.complete', { instruction: `done: ${m.payload.instruction}` }, 'normal', m.correlationId);
      }
    });

    const out = await team.run('assign_task', { agent: 'senior-dev', instruction: 'build login' });
    expect(out).toBe('done: build login');
  });

  it('carries only an explicit task scope on the assignment and rejects malformed scopes before dispatch', async () => {
    let assignment: Message | undefined;
    bus.onType('task.assign', (m: Message) => {
      assignment = m;
      bus.send('dev', m.from, 'task.complete', { instruction: 'audit complete' }, 'normal', m.correlationId);
    });

    await expect(team.run('assign_task', {
      agent: 'dev',
      instruction: 'Audit the implementation; do not edit.',
      scope: { folderAccess: [{ path: '.', permission: 'read' }] },
    })).resolves.toBe('audit complete');
    expect(assignment?.payload.taskScope).toEqual({ folderAccess: [{ path: '.', permission: 'read' }] });

    assignment = undefined;
    await expect(team.run('assign_task', {
      agent: 'dev',
      instruction: 'Audit the implementation.',
      scope: { folderAccess: [{ path: '', permission: 'write' }] },
    })).resolves.toMatch(/invalid task scope/i);
    expect(assignment).toBeUndefined();
  });

  it('refuses a named native-CLI scoped dispatch before task.assign and reports compatible candidates', async () => {
    const scopedRoster = [
      { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
      { id: 'designer', role: 'custom', name: 'Product Designer', status: 'idle', capabilities: { read: true, write: true, shell: false, toolFamilies: ['read'], backend: 'claude', taskScope: 'fixed-session-only' as const } },
      { id: 'writer', role: 'custom', name: 'Content Strategist', status: 'idle', capabilities: { read: true, write: true, shell: false, toolFamilies: ['read'], backend: 'openai-compat', taskScope: 'per-turn' as const } },
    ];
    const scopedView: TeamView = { list: () => scopedRoster, resolve: () => undefined };
    const scopedTeam = new TeamTools('pm', scopedView, bus, { timeoutMs: 1000, taskInputResolver: taskInputResolver() });
    const assigns: Message[] = [];
    bus.onType('task.assign', (message: Message) => assigns.push(message));

    const out = await scopedTeam.run('dispatch_task', {
      agent: 'designer',
      instruction: 'Edit the page copy.',
      contract: taskContract({
        effects: {
          read_files: [],
          write_scope: { folder_access: [{ path: 'site', permission: 'readwrite' }] },
          expected_file_effect: 'modify',
        },
        required_capabilities: { version: 1, capabilities: ['write'] },
      }),
    });

    expect(out).toMatch(/no-executor/i);
    expect(out).toContain('taskScope=fixed-session-only');
    expect(out).toMatch(/not substituted/i);
    expect(assigns).toEqual([]);
  });

  it('records an omitted scope as fixed session permissions, never task-level isolation', async () => {
    const receipts: any[] = [];
    const receiptTeam = new TeamTools('pm', view, bus, {
      timeoutMs: 1000,
      onDelegationDispatched: (event) => receipts.push(event),
    });
    bus.onType('task.assign', (message: Message) => {
      bus.send('dev', message.from, 'task.complete', { instruction: 'done' }, 'normal', message.correlationId);
    });

    expect(await receiptTeam.run('assign_task', { agent: 'dev', instruction: 'Review the page.' })).toBe('done');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      requestedAgent: 'dev', agentId: 'dev', scopeMode: 'fixed-session-permissions',
      routing: { taskClassification: 'general', requiredCapabilities: [] },
    });
    expect(receipts[0].routing.compatibilityFilters).toContain('fixed-session-permissions-used');
  });

  it('classifies delegated replies from framework evidence, not the teammate\'s Done text', async () => {
    const evidenceTeam = new TeamTools('pm', view, bus, { timeoutMs: 1000, evidenceEnabled: true });
    let attempt = 0;
    bus.onType('task.assign', (m: Message) => {
      attempt += 1;
      const payload = attempt === 1
        ? {
            instruction: 'Done — tests passed.',
            metadata: { delegationEvidence: { hadToolActions: true, changedFiles: ['src/login.ts'] } },
          }
        : attempt === 2
          ? {
              instruction: 'Done.',
              metadata: { delegationEvidence: { hadToolActions: false, changedFiles: [] } },
            }
          : attempt === 3
            ? {
                instruction: 'Implemented the login flow.',
                metadata: { delegationEvidence: { hadToolActions: true, changedFiles: ['src/login.ts'], verification: { ran: true, passed: true, command: 'npm test', source: 'command-exit-zero' } } },
              }
            : {
                instruction: 'The market has three primary competitors and the cited sources support the comparison.',
                metadata: { delegationEvidence: { hadToolActions: true, changedFiles: [] } },
              };
      bus.send('dev', m.from, 'task.complete', payload, 'normal', m.correlationId);
    });

    const unverified = await evidenceTeam.run('assign_task', { agent: 'dev', instruction: 'implement login' });
    expect(unverified).toContain('[delegation: replied-not-verified]');
    expect(unverified).toContain('changed files (recorded): src/login.ts');
    expect(unverified).toContain('run_checks was NOT run (framework recorded)');
    expect(unverified).not.toContain('claimed verification passed');

    const noEvidence = await evidenceTeam.run('assign_task', { agent: 'dev', instruction: 'do something' });
    expect(noEvidence).toContain('[delegation: no-evidence]');

    const verified = await evidenceTeam.run('assign_task', { agent: 'dev', instruction: 'implement login with tests', verification_plan: { sensors: ['command-exit-zero'], none_applies: 'report-no-applicable-sensor' } });
    expect(verified).toContain('[delegation: verified]');
    expect(verified).toContain('run_checks (npm test) passed');

    const informational = await evidenceTeam.run('assign_task', { agent: 'dev', instruction: 'research the market' });
    expect(informational).toContain('[delegation: tool-activity-recorded]');
    expect(informational).toContain('(none recorded)');
  });

  it('captures an explicit coordinator rejection, forwards its reason, and keeps acceptance counters honest', async () => {
    const dispositions: Array<{ disposition: string; reason?: string }> = [];
    const evidence = new TeamTools('pm', view, bus, {
      timeoutMs: 1000,
      evidenceEnabled: true,
      onDelegationDisposition: (event) => dispositions.push(event),
    });
    bus.onType('task.assign', (m: Message) => {
      bus.send('dev', m.from, 'task.complete', {
        instruction: 'Implemented and checked the feature.',
        metadata: { delegationEvidence: { hadToolActions: true, changedFiles: ['src/feature.ts'], verification: { ran: true, passed: true, command: 'npm test', source: 'command-exit-zero' } } },
      }, 'normal', m.correlationId);
    });

    const result = await evidence.run('assign_task', { agent: 'dev', instruction: 'implement the feature', verification_plan: { sensors: ['command-exit-zero'], none_applies: 'report-no-applicable-sensor' } });
    const handle = /Handle: ([^\s.]+)/.exec(result)?.[1];
    expect(handle).toBeTruthy();
    expect(result).toContain('[delegation: verified]');
    expect(await evidence.run('record_task_disposition', { handle, disposition: 'rejected' })).toMatch(/requires a concrete reason/i);

    const rejection = await evidence.run('record_task_disposition', {
      handle,
      disposition: 'rejected',
      reason: 'The acceptance table is missing from the report.',
    });
    expect(rejection).toContain('visibly amended');
    expect(dispositions).toHaveLength(1);
    expect(dispositions[0]).toMatchObject({
      disposition: 'rejected',
      reason: 'The acceptance table is missing from the report.',
      outcome: 'verified',
    });
    const forwarded = bus.query({ type: 'agent.message', from: 'pm', to: 'dev' });
    expect(forwarded).toHaveLength(1);
    expect(String(forwarded[0].payload.instruction)).toContain('acceptance table is missing');

    const metrics = await evidence.run('delegation_metrics', {});
    expect(metrics).toContain('delegated tasks settled: 1');
    expect(metrics).toContain('complete deliveries: 1');
    expect(metrics).toContain('coordinator-accepted: 0/1');
    expect(metrics).toContain('green framework verdict then coordinator-rejected: 1/1 (100.0%)');
    expect(metrics).toContain('NOT enterprise/customer acceptance');
  });

  it('keeps needs-rework on the same teammate and requires a real new dispatch to supersede a result', async () => {
    const replacementRoster = [
      { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
      { id: 'fe', role: 'custom', name: 'Frontend Engineer', status: 'idle', capabilities: { read: true, write: true, shell: false, toolFamilies: ['read', 'write'], taskScope: 'per-turn' as const } },
      { id: 'writer', role: 'custom', name: 'Content Strategist', status: 'idle', capabilities: { read: true, write: true, shell: false, toolFamilies: ['read', 'write'], taskScope: 'per-turn' as const } },
    ];
    const replacementView: TeamView = { list: () => replacementRoster, resolve: () => undefined };
    const replacementTeam = new TeamTools('pm', replacementView, bus, { timeoutMs: 1000, evidenceEnabled: true });
    const assignments: Message[] = [];
    bus.onType('task.assign', (message: Message) => {
      assignments.push(message);
      bus.send(String(message.to), message.from, 'task.complete', {
        instruction: `${message.to} completed the task.`,
        metadata: { delegationEvidence: { hadToolActions: true, changedFiles: [] } },
      }, 'normal', message.correlationId);
    });

    const first = await replacementTeam.run('assign_task', { agent: 'fe', instruction: 'Write the biography paragraph.' });
    const firstHandle = /Handle: ([^\s.]+)/.exec(first)?.[1]!;
    expect(await replacementTeam.run('record_task_disposition', {
      handle: firstHandle, disposition: 'needs-rework', reason: 'The paragraph repeats the domain list.',
    })).toContain('sent to fe');
    expect(bus.query({ type: 'agent.message', from: 'pm', to: 'fe' })).toHaveLength(1);
    expect(assignments).toHaveLength(1); // rework is a message, never an implicit hand-off

    const second = await replacementTeam.run('assign_task', { agent: 'fe', instruction: 'Write the corrected biography paragraph.' });
    const secondHandle = /Handle: ([^\s.]+)/.exec(second)?.[1]!;
    expect(await replacementTeam.run('record_task_disposition', {
      handle: secondHandle, disposition: 'superseded', reason: 'This is copy work, not frontend work.',
    })).toMatch(/requires replacement_handle/i);

    const replacement = await replacementTeam.run('assign_task_async', { agent: 'writer', instruction: 'Write the corrected biography paragraph.' });
    const replacementHandle = /Handle: ([^\s.]+)/.exec(replacement)?.[1]!;
    expect(await replacementTeam.run('record_task_disposition', {
      handle: secondHandle,
      disposition: 'superseded',
      reason: 'This is copy work, not frontend work.',
      replacement_handle: replacementHandle,
    })).toContain(`Replacement ${replacementHandle} was host-dispatched to writer`);
    expect(assignments.map((message) => message.to)).toEqual(['fe', 'fe', 'writer']);
  });

  it('reports the under-crediting direction and retains the expanded disposition vocabulary', async () => {
    const evidence = new TeamTools('pm', view, bus, { timeoutMs: 1000, evidenceEnabled: true });
    bus.onType('task.assign', (m: Message) => {
      bus.send('dev', m.from, 'task.complete', {
        instruction: 'The answer follows from the prior session context and is complete.',
        metadata: { delegationEvidence: { hadToolActions: false, changedFiles: [] } },
      }, 'normal', m.correlationId);
    });

    const result = await evidence.run('assign_task', { agent: 'dev', instruction: 'answer from already-returned context; do not reread' });
    const handle = /Handle: ([^\s.]+)/.exec(result)?.[1];
    expect(result).toContain('[delegation: no-evidence]');
    expect(evidence.coordinatorCloseoutState()).toMatchObject({ settledButUndisposed: 1, idleWithNoLiveWork: 1 });
    expect(await evidence.run('record_task_disposition', {
      handle,
      disposition: 'accepted-despite-framework-no-evidence',
    })).toMatch(/acceptance despite framework no-evidence/i);

    const metrics = await evidence.run('delegation_metrics', {});
    expect(metrics).toContain('framework no-evidence/timed-out/replied-not-verified then coordinator-accepted: 1/1 (100.0%)');
    expect(metrics).toContain('settled-but-undisposed:');
    expect(metrics).toContain('accepted-but-ungated:');
    expect(metrics).toContain('idle-with-no-live-work:');
    const disposition = evidence.specs().find((spec) => spec.function.name === 'record_task_disposition');
    expect(disposition?.function.parameters.properties.disposition.enum).toEqual(expect.arrayContaining([
      'needs-rework', 'deferred', 'accepted-with-caveat', 'accepted-after-rework',
      'accepted-despite-framework-no-evidence', 'superseded',
    ]));
  });

  it('keeps accepted partial delivery counts independent from evidence under-crediting', async () => {
    const evidence = new TeamTools('pm', view, bus, { timeoutMs: 1000, evidenceEnabled: true });
    let dispatch = 0;
    bus.onType('task.assign', (message: Message) => {
      dispatch += 1;
      bus.send('dev', message.from, 'task.partial', {
        instruction: dispatch === 1 ? 'Verified work remains incomplete.' : 'Incomplete report with no framework evidence.',
        metadata: {
          completionState: 'partial',
          unfinishedActivity: 'Finish the remaining step.',
          delegationEvidence: dispatch === 1
            ? {
                hadToolActions: true,
                changedFiles: ['src/feature.ts'],
                verification: { ran: true, passed: true, command: 'npm test', source: 'command-exit-zero' },
              }
            : { hadToolActions: false, changedFiles: [] },
        },
      }, 'normal', message.correlationId);
    });

    const verified = await evidence.run('assign_task', {
      agent: 'dev', instruction: 'Implement part one.',
      verification_plan: { sensors: ['command-exit-zero'], none_applies: 'report-no-applicable-sensor' },
    });
    const verifiedHandle = /Handle: ([^\s.]+)/.exec(verified)?.[1]!;
    await evidence.run('record_task_disposition', { handle: verifiedHandle, disposition: 'accepted' });
    let metrics = await evidence.run('delegation_metrics', {});
    expect(metrics).toContain('delegated tasks settled: 1.');
    expect(metrics).toContain('complete deliveries: 0.');
    expect(metrics).toContain('partial deliveries: 1.');
    expect(metrics).toContain('accepted partial deliveries: 1/1.');
    expect(metrics).toContain('framework no-evidence/timed-out/replied-not-verified then coordinator-accepted: 0/1 (0.0%).');

    const noEvidence = await evidence.run('assign_task', { agent: 'dev', instruction: 'Produce part two.' });
    const noEvidenceHandle = /Handle: ([^\s.]+)/.exec(noEvidence)?.[1]!;
    await evidence.run('record_task_disposition', {
      handle: noEvidenceHandle,
      disposition: 'accepted-despite-framework-no-evidence',
    });
    metrics = await evidence.run('delegation_metrics', {});
    expect(metrics).toContain('delegated tasks settled: 2.');
    expect(metrics).toContain('complete deliveries: 0.');
    expect(metrics).toContain('partial deliveries: 2.');
    expect(metrics).toContain('accepted partial deliveries: 2/2.');
    expect(metrics).toContain('framework no-evidence/timed-out/replied-not-verified then coordinator-accepted: 1/2 (50.0%).');
  });

  it('reports accepted-but-ungated only for an accepted file-changing result without a passing check', async () => {
    const evidence = new TeamTools('pm', view, bus, { timeoutMs: 1000, evidenceEnabled: true });
    let dispatch = 0;
    bus.onType('task.assign', (m: Message) => {
      dispatch += 1;
      const fileChanging = dispatch === 1;
      bus.send('dev', m.from, 'task.complete', {
        instruction: fileChanging ? 'Changed src/feature.ts; the check failed.' : 'Read-only review complete.',
        metadata: {
          delegationEvidence: {
            hadToolActions: true,
            changedFiles: fileChanging ? ['src/feature.ts'] : [],
            verification: fileChanging ? { ran: true, passed: false, command: 'npm test' } : { ran: false, passed: false },
          },
        },
      }, 'normal', m.correlationId);
    });

    const changed = await evidence.run('assign_task', { agent: 'dev', instruction: 'change the feature' });
    const changedHandle = /Handle: ([^\s.]+)/.exec(changed)?.[1];
    await evidence.run('record_task_disposition', { handle: changedHandle, disposition: 'accepted' });
    expect(evidence.coordinatorCloseoutState()).toMatchObject({ settledButUndisposed: 0, acceptedButUngated: 1, idleWithNoLiveWork: 0 });

    const readOnly = await evidence.run('assign_task', { agent: 'dev', instruction: 'review the feature' });
    const readOnlyHandle = /Handle: ([^\s.]+)/.exec(readOnly)?.[1];
    await evidence.run('record_task_disposition', { handle: readOnlyHandle, disposition: 'accepted' });
    // A read-only acceptance is fully disposed and cannot arm the closeout nudge.
    expect(evidence.coordinatorCloseoutState()).toMatchObject({ settledButUndisposed: 0, acceptedButUngated: 1, idleWithNoLiveWork: 0 });
  });

  it('discharges only acceptances observed before a later passing coordinator check, without rewriting evidence', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-24T10:00:00.000Z'));
      const evidence = new TeamTools('pm', view, bus, {
        timeoutMs: 1000,
        evidenceEnabled: true,
        verifyCommand: 'npm test',
        runCommand: async () => ({ code: 0, output: 'all green' }),
      });
      bus.onType('task.assign', (m: Message) => {
        bus.send('dev', m.from, 'task.complete', {
          instruction: 'Changed src/feature.ts.',
          metadata: {
            delegationEvidence: {
              hadToolActions: true,
              changedFiles: ['src/feature.ts'],
              verification: { ran: true, passed: false, command: 'npm test' },
            },
          },
        }, 'normal', m.correlationId);
      });

      const first = await evidence.run('assign_task', { agent: 'dev', instruction: 'change the feature' });
      const firstHandle = /Handle: ([^\s.]+)/.exec(first)?.[1]!;
      await evidence.run('record_task_disposition', { handle: firstHandle, disposition: 'accepted' });
      expect(evidence.coordinatorCloseoutState()).toMatchObject({ acceptedButUngated: 1 });
      const immutableReceipt = (evidence as any).settledDelegations.get(firstHandle).evidence;

      // A check in the following coordinator turn resolves that earlier acceptance, but does not alter its receipt.
      vi.setSystemTime(new Date('2026-08-24T10:01:00.000Z'));
      expect(await evidence.run('run_checks', {})).toMatch(/\[checks passed\]/);
      expect(evidence.coordinatorCloseoutState()).toMatchObject({ acceptedButUngated: 0 });
      expect((evidence as any).settledDelegations.get(firstHandle).evidence).toBe(immutableReceipt);
      expect(immutableReceipt.verification).toEqual({ ran: true, passed: false, command: 'npm test' });

      // A later acceptance is not retroactively covered by that prior check: this is the second-turn direction.
      vi.setSystemTime(new Date('2026-08-24T10:02:00.000Z'));
      const second = await evidence.run('assign_task', { agent: 'dev', instruction: 'change a second feature' });
      const secondHandle = /Handle: ([^\s.]+)/.exec(second)?.[1]!;
      await evidence.run('record_task_disposition', { handle: secondHandle, disposition: 'accepted' });
      expect(evidence.coordinatorCloseoutState()).toMatchObject({ acceptedButUngated: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  // The coordinator's turn loop reads these verdicts to decide whether anything is still owed. A read-only
  // task can be completed while remaining an explicit mechanism-only record, not a green delivery verdict.
  it('hands the coordinator the framework verdict of each settled delegation, then clears it', async () => {
    const evidenceTeam = new TeamTools('pm', view, bus, { timeoutMs: 1000, evidenceEnabled: true });
    let attempt = 0;
    bus.onType('task.assign', (m: Message) => {
      attempt += 1;
      const payload = attempt === 1
        ? { // read-only research: tools used, nothing written — nothing left to verify
            instruction: 'Read the file; here are my conclusions.',
            metadata: { delegationEvidence: { hadToolActions: true, changedFiles: [] } },
          }
        : { // a write nobody checked — the coordinator still owes verification
            instruction: 'Rewrote the module.',
            metadata: { delegationEvidence: { hadToolActions: true, changedFiles: ['src/login.ts'] } },
          };
      bus.send('dev', m.from, 'task.complete', payload, 'normal', m.correlationId);
    });

    expect(evidenceTeam.takeSettledOutcomes()).toEqual([]); // nothing delegated yet

    await evidenceTeam.run('assign_task', { agent: 'dev', instruction: 'read src/calculator.js' });
    expect(evidenceTeam.takeSettledOutcomes()).toEqual(['tool-activity-recorded']);
    expect(evidenceTeam.takeSettledOutcomes()).toEqual([]); // reading drains — a later turn must not re-see it

    await evidenceTeam.run('assign_task', { agent: 'dev', instruction: 'rewrite the module' });
    expect(evidenceTeam.takeSettledOutcomes()).toEqual(['replied-not-verified']);
  });

  it('records a timed-out delegation distinctly while still nudging the coordinator', async () => {
    const observations: Array<{ outcome: string; completionState: string }> = [];
    const silent = new TeamTools('pm', view, bus, {
      timeoutMs: 20,
      evidenceEnabled: true,
      onDelegationEvidence: ({ outcome, evidence }) => observations.push({ outcome, completionState: evidence.completionState }),
    });
    // No task.assign listener: the teammate never answers.
    const out = await silent.run('assign_task', { agent: 'dev', instruction: 'build it' });
    expect(out).toContain('timed out');
    expect(silent.takeSettledOutcomes()).toEqual(['timed-out']);
    expect(observations).toEqual([{ outcome: 'timed-out', completionState: 'not-observed' }]);
  });

  it.each([
    ['task.complete', 'complete'],
    ['task.partial', 'partial'],
    ['system.error', 'not-observed'],
  ] as const)('maps punctual %s through the production settlement path to %s', async (type, expected) => {
    const localBus = new MessageBus();
    const observed: string[] = [];
    const local = new TeamTools('pm', view, localBus, {
      timeoutMs: 1000,
      evidenceEnabled: true,
      onDelegationEvidence: ({ evidence: record }) => observed.push(record.completionState),
    });
    localBus.onType('task.assign', (message) => {
      if (type === 'task.partial') {
        localBus.send('dev', 'pm', type, {
          instruction: 'Partial report.',
          metadata: { completionState: 'partial', unfinishedActivity: 'Finish checks.' },
        }, 'normal', message.correlationId);
      } else {
        localBus.send('dev', 'pm', type, { instruction: type === 'system.error' ? 'Failed.' : 'Done.' }, 'normal', message.correlationId);
      }
    });

    await local.run('assign_task', { agent: 'dev', instruction: 'Do it.' });
    expect(observed.at(-1)).toBe(expected);
    localBus.dispose();
  });

  it.each([
    ['task.complete', 'complete'],
    ['task.partial', 'partial'],
  ] as const)('preserves timed-out outcome when late %s records %s completion', async (type, expected) => {
    const localBus = new MessageBus();
    const observed: Array<{ outcome: string; completionState: string }> = [];
    const ready: string[] = [];
    const local = new TeamTools('pm', view, localBus, {
      timeoutMs: 20,
      evidenceEnabled: true,
      onDelegationEvidence: ({ outcome, evidence: record }) => observed.push({ outcome, completionState: record.completionState }),
      onAsyncResultReady: (result) => ready.push(result.text),
    });
    let assignment: Message | undefined;
    localBus.onType('task.assign', (message) => { assignment = message; });
    await local.run('assign_task', { agent: 'dev', instruction: 'Do it.' });
    if (type === 'task.partial') {
      localBus.send('dev', 'pm', type, {
        instruction: 'Partial report.',
        metadata: { completionState: 'partial', unfinishedActivity: 'Finish checks.' },
      }, 'normal', assignment!.correlationId);
    } else {
      localBus.send('dev', 'pm', type, { instruction: 'Done.' }, 'normal', assignment!.correlationId);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(observed.at(-1)).toEqual({ outcome: 'timed-out', completionState: expected });
    expect(ready).toHaveLength(1);
    local.consumeAsyncResult(assignment!.correlationId!);
    localBus.dispose();
  });

  it('forwards only opaque current-turn user-source receipts on task.assign', async () => {
    const source = {
      assetId: 'content-41', kind: 'context-mention' as const, label: 'Customer brief', location: '@brief.md',
      textBytes: 814, mediaKind: 'text' as const,
    };
    // This cannot occur through the typed descriptor, but protects the transport boundary if a future
    // caller hands it a richer object: task.assign must still carry ids/metadata only.
    const richerSource = { ...source, text: 'customer secret source body' };
    team.setDelegationContentSources([richerSource]);
    let assignment: Message | undefined;
    bus.onType('task.assign', (message) => { assignment = message; });

    await team.run('assign_task_async', { agent: 'dev', instruction: 'Extract the requested title.' });

    expect(assignment?.payload.delegationContentSources).toEqual([source]);
    expect(JSON.stringify(assignment?.payload)).not.toContain('customer secret source body');
    team.setDelegationContentSources(undefined);
    await team.run('assign_task_async', { agent: 'tester', instruction: 'Run the independent check.' });
    expect(bus.query({ type: 'task.assign' }).at(-1)?.payload.delegationContentSources).toEqual([]);
    team.cancelPending('test cleanup');
  });

  it('returns framework evidence when async work is collected with await_tasks', async () => {
    const evidenceTeam = new TeamTools('pm', view, bus, { timeoutMs: 1000, evidenceEnabled: true });
    bus.onType('task.assign', (m: Message) => {
      bus.send('dev', m.from, 'task.complete', {
        instruction: 'Changed the API.',
        metadata: { delegationEvidence: { hadToolActions: true, changedFiles: ['src/api.ts'] } },
      }, 'normal', m.correlationId);
    });

    await evidenceTeam.run('assign_task_async', { agent: 'dev', instruction: 'change API' });
    const out = await evidenceTeam.run('await_tasks', {});
    expect(out).toContain('[delegation: replied-not-verified]');
    expect(out).toContain('src/api.ts');
  });

  // A worktree-isolated worker has a different root, so a shared-root ABSOLUTE path would land outside its
  // sandbox. The PM's delegation must convert those to workspace-relative before sending.
  it('normalizes shared-root absolute paths in a delegated instruction to workspace-relative', async () => {
    const t = new TeamTools('pm', view, bus, { timeoutMs: 1000, cwd: 'C:\\proj' });
    let received = '';
    bus.onType('task.assign', (m: Message) => {
      received = String(m.payload.instruction);
      bus.send(m.to, m.from, 'task.complete', { instruction: 'ok' }, 'normal', m.correlationId);
    });
    await t.run('assign_task', { agent: 'senior-dev', instruction: 'Edit C:\\proj\\src\\app.js and C:/proj/src/x.ts now' });
    expect(received).toContain('src\\app.js');
    expect(received).toContain('src/x.ts');
    expect(received).not.toContain('C:\\proj\\');
    expect(received).not.toContain('C:/proj/');
  });

  it('Router v1: audits why a delegation went to a teammate (onRoute)', async () => {
    const routes: string[] = [];
    const t = new TeamTools('pm', view, bus, { timeoutMs: 1000, onRoute: (l) => routes.push(l) });
    bus.onType('task.assign', (m: Message) => {
      if (m.to === 'dev') { bus.send('dev', m.from, 'task.complete', { instruction: 'ok' }, 'normal', m.correlationId); }
    });
    await t.run('assign_task', { agent: 'senior-dev', instruction: 'x' });
    expect(routes).toHaveLength(1);
    expect(routes[0]).toContain('Routed "senior-dev" → dev');
    expect(routes[0]).toMatch(/only 'senior-dev' on the team/);
  });

  it('Router: prefers a FREE teammate (idle or stopped) over a BUSY (running) one', async () => {
    const devs = [
      { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
      { id: 'dev-busy', role: 'senior-dev', name: 'DevA', status: 'running' }, // already working
      { id: 'dev-stopped', role: 'senior-dev', name: 'DevB', status: 'stopped' }, // free — auto-starts on assign
    ];
    const v: TeamView = { list: () => devs, resolve: () => undefined };
    const routes: string[] = [];
    const t = new TeamTools('pm', v, bus, { timeoutMs: 1000, onRoute: (l) => routes.push(l) });
    let routedTo = '';
    bus.onType('task.assign', (m: Message) => {
      routedTo = m.to;
      bus.send(m.to, m.from, 'task.complete', { instruction: 'ok' }, 'normal', m.correlationId);
    });
    await t.run('assign_task', { agent: 'senior-dev', instruction: 'x' });
    expect(routedTo).toBe('dev-stopped'); // a stopped teammate is FREE and beats a busy/running one
    expect(routes[0]).toContain('→ dev-stopped');
  });

  it('Router: only an ERRORED teammate is excluded when a usable one shares the role', async () => {
    const devs = [
      { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
      { id: 'dev-err', role: 'senior-dev', name: 'DevA', status: 'error' },
      { id: 'dev-ok', role: 'senior-dev', name: 'DevB', status: 'idle' },
    ];
    const v: TeamView = { list: () => devs, resolve: () => undefined };
    let routedTo = '';
    const t = new TeamTools('pm', v, bus, { timeoutMs: 1000 });
    bus.onType('task.assign', (m: Message) => {
      routedTo = m.to;
      bus.send(m.to, m.from, 'task.complete', { instruction: 'ok' }, 'normal', m.correlationId);
    });
    await t.run('assign_task', { agent: 'senior-dev', instruction: 'x' });
    expect(routedTo).toBe('dev-ok'); // never the errored one
  });

  it('assign_task surfaces a teammate error', async () => {
    bus.onType('task.assign', (m: Message) => {
      if (m.to === 'dev') {
        bus.send('dev', m.from, 'system.error', { instruction: 'compile failed' }, 'normal', m.correlationId);
      }
    });
    const out = await team.run('assign_task', { agent: 'dev', instruction: 'x' });
    expect(out).toMatch(/Error from dev: compile failed/);
  });

  it('assign_task rejects unknown agent and self-assignment', async () => {
    expect(await team.run('assign_task', { agent: 'ghost', instruction: 'x' })).toMatch(/no teammate "ghost"/);
    expect(await team.run('assign_task', { agent: 'pm', instruction: 'x' })).toMatch(/cannot assign a task to yourself/);
  });

  it('assign_task times out if no teammate replies', async () => {
    const out = await team.run('assign_task', { agent: 'dev', instruction: 'silent' });
    expect(out).toMatch(/timed out after 1s waiting for dev/);
  });

  it('does not let a heartbeat without observed tool work renew a blocking deadline (D2 mutation gate)', async () => {
    vi.useFakeTimers();
    try {
      const guarded = new TeamTools('pm', view, bus, { timeoutMs: 100 });
      bus.onType('task.assign', (message: Message) => {
        for (const at of [25, 50, 75, 100, 125]) {
          setTimeout(() => {
            bus.send('dev', message.from, 'task.status', {
              instruction: 'Still working',
              metadata: { progress: { source: 'heartbeat', observed: false } },
            }, 'low', message.correlationId);
          }, at);
        }
        setTimeout(() => {
          bus.send('dev', message.from, 'task.complete', { instruction: 'too late' }, 'normal', message.correlationId);
        }, 140);
      });

      const pending = guarded.run('assign_task', { agent: 'dev', instruction: 'long task' });
      await vi.advanceTimersByTimeAsync(150);

      expect(await pending).toMatch(/timed out after 0s waiting for dev/);
      // Mutation: treating a bare heartbeat as observed progress lets the 140ms completion win.
    } finally {
      vi.useRealTimers();
    }
  });

  it('extends a blocking deadline only for a host-observed tool action, under a hard ceiling', async () => {
    vi.useFakeTimers();
    try {
      const guarded = new TeamTools('pm', view, bus, { timeoutMs: 100 });
      bus.onType('task.assign', (message: Message) => {
        for (const at of [50, 150, 250]) {
          setTimeout(() => {
            bus.send('dev', message.from, 'task.status', {
              instruction: 'Reading project context.',
              metadata: { progress: { source: 'tool', observed: true } },
            }, 'low', message.correlationId);
          }, at);
        }
      });

      let settled = false;
      const pending = guarded.run('assign_task', { agent: 'dev', instruction: 'long task' }).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(299);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatch(/timed out after 0s waiting for dev/);
      // Mutation: remove the absolute deadline and the 250ms observed action pushes this to 350ms.
    } finally {
      vi.useRealTimers();
    }
  });

  it('late result after a blocking timeout reaches the coordinator instead of vanishing', async () => {
    const ready: Array<{ handle: string; ref: string; text: string }> = [];
    const evidence = new TeamTools('pm', view, bus, {
      timeoutMs: 20,
      evidenceEnabled: true,
      onAsyncResultReady: (result) => ready.push(result),
    });
    let assignment: Message | undefined;
    bus.onType('task.assign', (m: Message) => { assignment = m; });

    const timedOut = await evidence.run('assign_task', { agent: 'dev', instruction: 'implement it', verification_plan: { sensors: ['command-exit-zero'], none_applies: 'report-no-applicable-sensor' } });
    expect(timedOut).toMatch(/timed out/);
    expect(evidence.takeSettledOutcomes()).toEqual(['timed-out']);

    bus.send('dev', assignment!.from, 'task.complete', {
      instruction: 'Implemented it and ran tests.',
      metadata: { delegationEvidence: { hadToolActions: true, changedFiles: ['src/feature.ts'], verification: { ran: true, passed: true, command: 'npm test', source: 'command-exit-zero' } } },
    }, 'normal', assignment!.correlationId);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(ready).toHaveLength(1);
    expect(ready[0].ref).toBe('dev');
    expect(ready[0].text).toContain('[late blocking result]');
    expect(ready[0].text).toContain('[delegation: verified]');
    expect(evidence.takeSettledOutcomes()).toEqual(['timed-out']);
    expect(evidence.consumeAsyncResult(ready[0].handle)).toBe(true);
  });

  it('a late blocking result keeps its evidence verdict', async () => {
    const ready: string[] = [];
    const evidence = new TeamTools('pm', view, bus, {
      timeoutMs: 20,
      evidenceEnabled: true,
      onAsyncResultReady: (result) => ready.push(result.text),
    });
    let assignment: Message | undefined;
    bus.onType('task.assign', (m: Message) => { assignment = m; });

    await evidence.run('assign_task', { agent: 'dev', instruction: 'implement it' });
    evidence.takeSettledOutcomes();
    bus.send('dev', assignment!.from, 'task.complete', {
      instruction: 'Done.',
      metadata: { delegationEvidence: { hadToolActions: false, changedFiles: [] } },
    }, 'normal', assignment!.correlationId);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(ready).toHaveLength(1);
    expect(ready[0]).toContain('[delegation: no-evidence]');
    expect(evidence.takeSettledOutcomes()).toEqual(['timed-out']);
  });

  it('a cancelled blocking dispatch does not wake after its timeout', async () => {
    const ready: string[] = [];
    const late = new TeamTools('pm', view, bus, {
      timeoutMs: 20,
      onAsyncResultReady: (result) => ready.push(result.handle),
    });
    let assignment: Message | undefined;
    bus.onType('task.assign', (m: Message) => { assignment = m; });

    await late.run('assign_task', { agent: 'dev', instruction: 'implement it' });
    late.cancelPending('cancelled by test');
    bus.send('dev', assignment!.from, 'task.complete', { instruction: 'too late' }, 'normal', assignment!.correlationId);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(ready).toEqual([]);
  });

  it('a punctual completion still settles exactly once', async () => {
    const outcomes: string[] = [];
    const evidence = new TeamTools('pm', view, bus, {
      timeoutMs: 1000,
      evidenceEnabled: true,
      onDelegationEvidence: (event) => outcomes.push(event.outcome),
    });
    bus.onType('task.assign', (m: Message) => {
      const payload = {
        instruction: 'Changed a file and verified it.',
        metadata: { delegationEvidence: { hadToolActions: true, changedFiles: ['src/feature.ts'], verification: { ran: true, passed: true, command: 'npm test', source: 'command-exit-zero' } } },
      };
      bus.send('dev', m.from, 'task.complete', payload, 'normal', m.correlationId);
      bus.send('dev', m.from, 'task.complete', payload, 'normal', m.correlationId);
    });

    const out = await evidence.run('assign_task', { agent: 'dev', instruction: 'implement it', verification_plan: { sensors: ['command-exit-zero'], none_applies: 'report-no-applicable-sensor' } });
    expect(out).toContain('[delegation: verified]');
    expect(outcomes).toEqual(['verified']);
    expect(evidence.takeSettledOutcomes()).toEqual(['verified']);
  });

  it('assign_task can be cancelled instead of waiting for timeout', async () => {
    const pending = team.run('assign_task', { agent: 'dev', instruction: 'silent' });

    const cancelled = team.cancelPending('delegation cancelled by test');
    const out = await pending;

    expect(cancelled).toBeGreaterThan(0);
    expect(out).toBe('Error: delegation cancelled by test.');
  });

  it('cancels the exact worker handle and records a terminal receipt outside completed results and dispositions', async () => {
    const workerCancels = vi.fn();
    const receipts: Array<{ handle: string; agentId: string }> = [];
    const cancellable = new TeamTools('pm', view, bus, {
      timeoutMs: 1_000,
      cancelDelegatedWorker: workerCancels,
      onDelegationCancelled: (event) => receipts.push(event),
    });
    let assignment: Message | undefined;
    bus.onType('task.assign', (message: Message) => { assignment = message; });

    const pending = cancellable.run('assign_task', { agent: 'dev', instruction: 'silent worker' });
    expect(cancellable.cancelPending('operator cancelled this delegation')).toBe(1);

    expect(await pending).toBe('Error: operator cancelled this delegation.');
    expect(workerCancels).toHaveBeenCalledWith(expect.objectContaining({
      handle: assignment!.correlationId,
      agentId: 'dev',
      reason: 'operator cancelled this delegation',
    }));
    expect(receipts).toEqual([expect.objectContaining({ handle: assignment!.correlationId, agentId: 'dev' })]);
    expect(await cancellable.run('record_task_disposition', {
      handle: assignment!.correlationId,
      disposition: 'rejected',
      reason: 'not a result',
    })).toMatch(/no framework-observed settled delegation/i);

    const metrics = await cancellable.run('delegation_metrics', {});
    expect(metrics).toContain('delegated tasks settled: 0.');
    expect(metrics).toContain('complete deliveries: 0.');
    expect(metrics).toContain('delegated tasks cancelled: 1.');
    expect(metrics).toContain('coordinator-accepted: 0/0.');

    // A delayed worker response cannot turn the cancellation receipt into a completed delegation.
    bus.send('dev', 'pm', 'task.complete', { instruction: 'too late' }, 'normal', assignment!.correlationId);
    expect(await cancellable.run('delegation_metrics', {})).toContain('delegated tasks settled: 0.');
  });

  it('assign_task forces one firm retry when the teammate returns nothing, then uses the real result', async () => {
    const instructions: string[] = [];
    let attempt = 0;
    bus.onType('task.assign', (m: Message) => {
      if (m.to !== 'dev') { return; }
      instructions.push(String(m.payload.instruction ?? ''));
      attempt += 1;
      // First turn: empty (refusal). Retry turn: real work.
      const text = attempt === 1 ? '' : 'done for real';
      bus.send('dev', m.from, 'task.complete', { instruction: text }, 'normal', m.correlationId);
    });

    const out = await team.run('assign_task', { agent: 'dev', instruction: 'build login' });
    expect(out).toBe('done for real');
    expect(instructions).toHaveLength(2);
    expect(instructions[1]).toMatch(/did not do the task/i);
    expect(instructions[1]).toContain('build login');
  });

  it('reports no fallback configured when a teammate keeps returning nothing and no escalation is wired', async () => {
    bus.onType('task.assign', (m: Message) => {
      if (m.to === 'dev') {
        bus.send('dev', m.from, 'task.complete', { instruction: '' }, 'normal', m.correlationId);
      }
    });
    const out = await team.run('assign_task', { agent: 'dev', instruction: 'build login' });
    expect(out).toMatch(/BLOCKED/);
    expect(out).toMatch(/no fallback model is configured/i);
    expect(out).toMatch(/needs a working model/i);
  });

  it('L3: escalates a stuck teammate to its fallback model and uses the result', async () => {
    let attempt = 0;
    bus.onType('task.assign', (m: Message) => {
      if (m.to !== 'dev') { return; }
      attempt += 1;
      // empty (first), empty (L2 retry), then real work after the L3 model switch.
      const text = attempt < 3 ? '' : 'done after escalation';
      bus.send('dev', m.from, 'task.complete', { instruction: text }, 'normal', m.correlationId);
    });
    const escalated: string[] = [];
    team = new TeamTools('pm', view, bus, {
      timeoutMs: 1000,
      escalate: (id) => { escalated.push(id); return { switched: true, reason: 'switched', from: 'cheap', to: 'strong' }; },
    });
    const out = await team.run('assign_task', { agent: 'dev', instruction: 'build login' });
    expect(escalated).toEqual(['dev']);
    expect(out).toContain('done after escalation');
    expect(out).toMatch(/fallback model strong/i);
  });

  it('L3: reports the model is refusing when even the fallback returns nothing', async () => {
    bus.onType('task.assign', (m: Message) => {
      if (m.to === 'dev') { bus.send('dev', m.from, 'task.complete', { instruction: '' }, 'normal', m.correlationId); }
    });
    team = new TeamTools('pm', view, bus, {
      timeoutMs: 1000,
      escalate: () => ({ switched: true, reason: 'switched', from: 'cheap', to: 'strong' }),
    });
    const out = await team.run('assign_task', { agent: 'dev', instruction: 'x' });
    expect(out).toMatch(/even after switching to its fallback model \(strong\)/i);
    expect(out).toMatch(/needs a different, working model/i);
  });

  it('async: an empty first reply is retried, and await_tasks collects the real result', async () => {
    let attempt = 0;
    bus.onType('task.assign', (m: Message) => {
      if (m.to !== 'dev') { return; }
      attempt += 1;
      bus.send('dev', m.from, 'task.complete', { instruction: attempt === 1 ? '' : 'async done' }, 'normal', m.correlationId);
    });
    const disp = await team.run('assign_task_async', { agent: 'dev', instruction: 'work' });
    expect(disp).toMatch(/Handle:/);
    const collected = await team.run('await_tasks', {});
    expect(collected).toContain('async done');
    expect(attempt).toBe(2);
  });

  it('async: escalates to the fallback model when a teammate keeps returning nothing', async () => {
    let attempt = 0;
    bus.onType('task.assign', (m: Message) => {
      if (m.to !== 'dev') { return; }
      attempt += 1;
      bus.send('dev', m.from, 'task.complete', { instruction: attempt < 3 ? '' : 'async after escalation' }, 'normal', m.correlationId);
    });
    team = new TeamTools('pm', view, bus, {
      timeoutMs: 1000,
      escalate: () => ({ switched: true, reason: 'switched', from: 'cheap', to: 'strong' }),
    });
    await team.run('assign_task_async', { agent: 'dev', instruction: 'work' });
    const collected = await team.run('await_tasks', {});
    expect(collected).toContain('async after escalation');
    expect(collected).toMatch(/fallback model strong/i);
  });

  it('async: await_tasks flags the step as failed when even the fallback stays empty', async () => {
    bus.onType('task.assign', (m: Message) => {
      if (m.to === 'dev') { bus.send('dev', m.from, 'task.complete', { instruction: '' }, 'normal', m.correlationId); }
    });
    team = new TeamTools('pm', view, bus, {
      timeoutMs: 1000,
      escalate: () => ({ switched: true, reason: 'switched', from: 'cheap', to: 'strong' }),
    });
    await team.run('assign_task_async', { agent: 'dev', instruction: 'work' });
    const collected = await team.run('await_tasks', {});
    expect(collected).toMatch(/\[tasks FAILED\]/);
    expect(collected).toMatch(/even after switching to its fallback model/i);
  });

  it('reports a failed delegated task as a failed tool call, not merely as failed text', async () => {
    bus.onType('task.assign', (m: Message) => {
      if (m.to === 'dev') { bus.send('dev', m.from, 'task.complete', { instruction: '' }, 'normal', m.correlationId); }
    });
    team = new TeamTools('pm', view, bus, {
      timeoutMs: 1000,
      escalate: () => ({ switched: true, reason: 'switched', from: 'cheap', to: 'strong' }),
    });
    await team.run('assign_task_async', { agent: 'dev', instruction: 'work' });
    const outcome = await team.runOutcome('await_tasks', {});
    expect(outcome.output).toMatch(/\[tasks FAILED\]/);
    // The sections are worker replies, so the failure is a host decision over content the host did not write.
    expect(outcome).toMatchObject({ source: 'host', status: 'failed', contentSource: 'mixed-external' });
    expect(summarizeToolResult('await_tasks', {}, outcome).ok).toBe(false);
  });

  // Deliberately a separate structured assertion, not a second reader of the same helper: a mutation
  // that unwires only this call site must fail here, and the await_tasks test above cannot see it.
  it('reports a failed delegated task as a failed tool call through collect_ready_tasks too', async () => {
    bus.onType('task.assign', (m: Message) => {
      if (m.to === 'dev') { bus.send('dev', m.from, 'task.complete', { instruction: '' }, 'normal', m.correlationId); }
    });
    team = new TeamTools('pm', view, bus, {
      timeoutMs: 1000,
      escalate: () => ({ switched: true, reason: 'switched', from: 'cheap', to: 'strong' }),
    });
    await team.run('assign_task_async', { agent: 'dev', instruction: 'work' });
    const outcome = await vi.waitFor(async () => {
      const collected = await team.runOutcome('collect_ready_tasks', {});
      expect(collected.output).toMatch(/\[tasks FAILED\]/);
      return collected;
    }, { timeout: 4000 });
    expect(outcome).toMatchObject({ source: 'host', status: 'failed', contentSource: 'mixed-external' });
    expect(summarizeToolResult('collect_ready_tasks', {}, outcome).ok).toBe(false);
  });

  it('broadcast sends a broadcast.info to everyone', async () => {
    const seen: Message[] = [];
    bus.onType('broadcast.info', (m) => { seen.push(m); });
    const out = await team.run('broadcast', { message: 'standup at 3' });
    expect(out).toMatch(/Broadcast sent/);
    expect(seen[0].to).toBe('*');
    expect(seen[0].payload.instruction).toBe('standup at 3');
  });

  /**
   * A supervisor with no brake.
   *
   * `activeDispatches` has carried a `cancel` for every dispatch, and `cancelPending` has cancelled all of
   * them since the Stop button needed it. No tool exposed either. Field report, 2026-08-21: asked to stop
   * everything, a PM broadcast a message, reported it had "sent direct instructions", and then correctly
   * admitted it could not enforce them and the user should press Stop themselves.
   *
   * A broadcast is a message. A running teammate finishes its turn regardless.
   */
  /**
   * A coordinator that can start work and not stop it is not a coordinator.
   *
   * Field report, 2026-08-21: asked to stop everything, a PM broadcast a message, then correctly admitted it
   * had no way to enforce it and the user should press Stop in each Workbench themselves. The first fix gave
   * it `cancel_task` for dispatches and honestly reported that a turn begun from a message kept running.
   * Owner: **that limit is the thing to remove, not to document.** So the tool stops the teammate too — the
   * same act the status-bar brake performs, asked for by the supervisor instead of the person watching.
   */
  describe('cancel_task', () => {
    const stopped: Array<{ agentId: string; reason: string }> = [];
    let stoppable: Set<string>;
    let authority: TeamTools;

    beforeEach(() => {
      stopped.length = 0;
      stoppable = new Set(['dev', 'tester']);
      authority = new TeamTools('pm', view, bus, {
        timeoutMs: 1000,
        stopTeammate: (agentId, reason) => {
          if (!stoppable.has(agentId)) { return false; }
          stopped.push({ agentId, reason });
          stoppable.delete(agentId);
          return true;
        },
      });
    });

    it('refuses without a target rather than guessing that the user meant everything', async () => {
      expect(await authority.run('cancel_task', {})).toContain('needs a handle, an agent, or all=true');
      expect(stopped).toEqual([]);
    });

    it('stops a named teammate whatever started its turn — the gap the report was about', async () => {
      const out = await authority.run('cancel_task', { agent: 'dev', reason: 'user asked to stop' });
      expect(out).toContain('Stopped dev');
      // "Ended, not asked to end" is the distinction the broadcast failed to make.
      expect(out).toContain('not asked to end');
      expect(stopped).toEqual([{ agentId: 'dev', reason: 'user asked to stop' }]);
    });

    it('stops every teammate on all=true, including one holding no assignment', async () => {
      const out = await authority.run('cancel_task', { all: true, reason: 'stop everything' });
      expect(stopped.map((s) => s.agentId).sort()).toEqual(['dev', 'tester']);
      expect(out).toMatch(/Stopped 2 teammate/);
    });

    it('says nothing was running rather than claiming a stop it did not perform', async () => {
      stoppable.clear();
      expect(await authority.run('cancel_task', { all: true })).toContain('Nothing was running');
      expect(await authority.run('cancel_task', { agent: 'dev' })).toContain('was not running');
    });

    it('names an unknown teammate as unknown instead of silently doing nothing', async () => {
      const out = await authority.run('cancel_task', { agent: 'nobody' });
      expect(out).toContain('no teammate matches');
      expect(out).toContain('list_agents');
      expect(stopped).toEqual([]);
    });

    it('separates a settled handle from one that never existed', async () => {
      const out = await authority.run('cancel_task', { handle: 'not-a-handle' });
      expect(out).toContain('no assignment with handle');
      expect(out).toContain('collect_ready_tasks');
    });

    // A broadcast used to read as a way to stop people. Its own result now says it is not.
    it('makes broadcast say it is a message and not a stop', async () => {
      const out = await authority.run('broadcast', { message: 'please stop' });
      expect(out).toContain('not a stop');
      expect(out).toContain('cancel_task');
    });
  });

  it('exposes the coordinator tools', () => {
    const names = team.specs().map((s) => s.function.name);
    expect(names).toEqual([
      'list_agents', 'dispatch_task', 'collect_ready_tasks', 'inspect_task_status', 'close_assignment',
      'publish_content_receipt',
      'record_task_disposition', 'delegation_metrics', 'cancel_task', 'broadcast', 'run_checks',
    ]);
    expect(team.has('run_checks')).toBe(true);
    expect(team.has('dispatch_task')).toBe(true);
    expect(team.has('collect_ready_tasks')).toBe(true);
    expect(team.has('inspect_task_status')).toBe(true);
    expect(names).not.toContain('assign_task');
    expect(names).not.toContain('await_tasks');
    // A coordinator needs a way to END work it cannot finish, not only to judge a result that came back.
    expect(team.has('close_assignment')).toBe(true);
    // …and a way to STOP work that is still running. The cancel machinery existed for the Stop button and
    // was reachable by nothing the coordinator could call.
    expect(team.has('cancel_task')).toBe(true);
    expect(team.has('read_file')).toBe(false);
  });

  // The model-facing pair must never keep a PM turn open.
  it('dispatch_task returns a handle immediately and collect_ready_tasks never waits', async () => {
    bus.onType('task.assign', (m: Message) => {
      setTimeout(() => bus.send(String(m.to), m.from, 'task.complete', { instruction: `done by ${m.to}: ${m.payload.instruction}` }, 'normal', m.correlationId), 20);
    });

    const a = await team.run('dispatch_task', { agent: 'dev', instruction: 'build api', contract: taskContract() });
    const b = await team.run('dispatch_task', { agent: 'tester', instruction: 'write tests', contract: taskContract() });
    expect(a).toMatch(/Dispatched contract .* to dev\. Handle:/);
    expect(b).toMatch(/Dispatched contract .* to tester\. Handle:/);
    expect(a).toMatch(/End this turn/i);

    const notReady = await team.run('collect_ready_tasks', {});
    expect(notReady).toMatch(/No requested task result is ready/i);

    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    const out = await team.run('collect_ready_tasks', {});
    expect(out).toMatch(/=== dev \(/);
    expect(out).toMatch(/done by dev: build api/);
    expect(out).toMatch(/=== tester \(/);
    expect(out).toMatch(/done by tester: write tests/);

    // Pending registry is drained — a second await finds nothing.
    expect(await team.run('collect_ready_tasks', {})).toBe(
      'No delegated result is ready for collection. This does not describe historical task status; use inspect_task_status to inspect a handle.',
    );
  });

  it('renders a durable status query without consuming, messaging or disclosing unknown owners (T2f/T2g/T2j/T2l)', async () => {
    const query = vi.fn((handles?: readonly string[]) => (handles ?? []).map((handle) => handle === 'known'
      ? {
        handle,
        runId: 'run-1',
        requestedAgent: 'GRC Analyst',
        lifecycle: 'settled' as const,
        delivery: { state: 'delivered' as const, via: 'auto-wake' as const, observedAt: '2026-08-29T01:00:00.000Z' },
        evidenceOutcome: 'tool-activity-recorded' as const,
        contextGaps: [],
        inputReceipts: [{ inputId: 'order_form', supplied: true, reachable: true, readReceipt: 'observed' as const }],
      }
      : { handle, lifecycle: 'unknown' as const }));
    const statusTools = new TeamTools('pm', view, bus, {
      timeoutMs: 1000,
      taskInputResolver: taskInputResolver(),
      inspectTaskStatus: query,
    });
    const messagesBefore = bus.query().length;

    const first = await statusTools.run('inspect_task_status', { handles: ['known', 'foreign'] });
    const second = await statusTools.run('inspect_task_status', { handles: ['known', 'foreign'] });

    expect(first).toBe(second);
    expect(first).toContain('handle known');
    expect(first).toContain('state: settled');
    expect(first).toContain('delivery: delivered via auto-wake');
    expect(first).toContain('input order_form: supplied yes');
    expect(first).toContain('handle foreign');
    expect(first).toContain('state: unknown');
    expect(first).toMatch(/handle foreign[\s\S]*wait state: not-started[\s\S]*result state: none/);
    expect(first).not.toContain('other coordinator');
    expect(query).toHaveBeenCalledTimes(2);
    expect(bus.query()).toHaveLength(messagesBefore);
  });

  it('distinguishes pre-timeout cancellation and policy refusal from timed-out cancellation', async () => {
    let handle = '';
    bus.onType('task.assign', (message) => { handle = message.correlationId!; });
    const live = new TeamTools('pm', view, bus, {
      timeoutMs: 1000,
      inspectTaskStatus: (handles) => (handles ?? []).map((candidate) => candidate === 'policy-h'
        ? { handle: candidate, lifecycle: 'policy-refused' as const, policyReason: 'Team policy refused it.' }
        : { handle: candidate, agentId: 'dev', lifecycle: 'cancelled' as const }),
      cancelDelegatedWorker: () => true,
    });
    await live.run('dispatch_task', { agent: 'dev', instruction: 'Do it.', contract: taskContract() });
    await live.run('cancel_task', { handle });

    const cancelled = await live.run('inspect_task_status', { handles: [handle] });
    expect(cancelled).toContain('wait state: cancelled-before-timeout');
    expect(cancelled).not.toContain('timed-out-cancelled');
    const policy = await live.run('inspect_task_status', { handles: ['policy-h'] });
    expect(policy).toContain('wait state: not-started');
    expect(policy).toContain('result state: none');
  });

  it('projects live pending, ready, and delivered result states with structured next actions', async () => {
    let assignment: Message | undefined;
    bus.onType('task.assign', (message) => { assignment = message; });
    const live = new TeamTools('pm', view, bus, {
      timeoutMs: 1000,
      taskInputResolver: taskInputResolver(),
      inspectTaskStatus: (handles) => (handles ?? []).map((handle) => ({
        handle, agentId: 'dev', requestedAgent: 'dev', lifecycle: 'active' as const,
      })),
    });

    const dispatched = await live.run('dispatch_task', {
      agent: 'dev', instruction: 'Build it.', contract: taskContract(),
    });
    const handle = dispatched.match(/Handle: ([0-9a-f-]+)/i)![1];
    const pending = await live.run('inspect_task_status', { handles: [handle] });
    expect(pending).toMatch(/worker state: idle[\s\S]*wait state: within-deadline[\s\S]*result state: pending/);
    expect(pending).toContain('next action: end this turn');
    expect(pending).not.toContain('await_tasks');

    bus.send('dev', 'pm', 'task.complete', { instruction: 'Done.' }, 'normal', assignment!.correlationId);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const ready = await live.run('inspect_task_status', { handles: [handle] });
    expect(ready).toContain('wait state: settled-on-time');
    expect(ready).toContain('result state: ready');
    expect(ready).toContain(`next action: call collect_ready_tasks with handle "${handle}"`);
    expect(ready).not.toContain('await_tasks');

    await live.run('collect_ready_tasks', { handles: [handle] });
    const delivered = await live.run('inspect_task_status', { handles: [handle] });
    expect(delivered).toContain('result state: delivered');
    expect(delivered).not.toContain('next action:');
  });

  it('keeps a timed-out late window live, then reports the retained partial result as ready', async () => {
    let assignment: Message | undefined;
    bus.onType('task.assign', (message) => { assignment = message; });
    const live = new TeamTools('pm', view, bus, {
      timeoutMs: 20,
      evidenceEnabled: true,
      taskInputResolver: taskInputResolver(),
      inspectTaskStatus: (handles) => (handles ?? []).map((handle) => ({
        handle, agentId: 'dev', requestedAgent: 'dev', lifecycle: 'timed-out' as const,
      })),
    });

    const timeout = await live.run('assign_task', { agent: 'dev', instruction: 'Build it.' });
    const handle = assignment!.correlationId!;
    expect(timeout).not.toContain('await_tasks');
    const open = await live.run('inspect_task_status', { handles: [handle] });
    expect(open).toContain('wait state: timed-out-window-open');
    expect(open).toContain('result state: pending');
    expect(open).toMatch(/late result window closes at: .* remaining/);

    bus.send('dev', 'pm', 'task.partial', {
      instruction: 'Core report.',
      metadata: { completionState: 'partial', unfinishedActivity: 'Finish checks.' },
    }, 'normal', handle);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const ready = await live.run('inspect_task_status', { handles: [handle] });
    expect(ready).toContain('wait state: timed-out-result-arrived');
    expect(ready).toContain('result state: ready');
    expect(ready).toContain('collect_ready_tasks');
  });

  it('marks a late window expired without claiming a worker result exists', async () => {
    vi.useFakeTimers();
    try {
      let handle = '';
      bus.onType('task.assign', (message) => { handle = message.correlationId!; });
      const live = new TeamTools('pm', view, bus, {
        timeoutMs: 100,
        inspectTaskStatus: (handles) => (handles ?? []).map((candidate) => ({
          handle: candidate, agentId: 'dev', lifecycle: 'timed-out' as const,
        })),
      });
      const waiting = live.run('assign_task', { agent: 'dev', instruction: 'Wait.' });
      await vi.advanceTimersByTimeAsync(100);
      await waiting;
      await vi.advanceTimersByTimeAsync(200);

      const status = await live.run('inspect_task_status', { handles: [handle] });
      expect(status).toContain('wait state: timed-out-window-expired');
      expect(status).toContain('result state: none');
      expect(status).not.toContain('next action:');
    } finally {
      vi.useRealTimers();
    }
  });

  it('distinguishes cancellation after timeout from both expiry and pre-timeout cancellation', async () => {
    vi.useFakeTimers();
    try {
      let handle = '';
      bus.onType('task.assign', (message) => { handle = message.correlationId!; });
      const live = new TeamTools('pm', view, bus, {
        timeoutMs: 100,
        cancelDelegatedWorker: () => true,
        inspectTaskStatus: (handles) => (handles ?? []).map((candidate) => ({
          handle: candidate, agentId: 'dev', lifecycle: 'timed-out' as const,
        })),
      });
      const waiting = live.run('assign_task', { agent: 'dev', instruction: 'Wait.' });
      await vi.advanceTimersByTimeAsync(100);
      await waiting;
      await live.run('cancel_task', { handle });

      const status = await live.run('inspect_task_status', { handles: [handle] });
      expect(status).toContain('wait state: timed-out-cancelled');
      expect(status).toContain('result state: none');
      expect(status).not.toContain('timed-out-window-expired');
      expect(status).not.toContain('cancelled-before-timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores a durable retained result as ready without claiming the worker or promise resumed', async () => {
    const restored = new TeamTools('pm', view, bus, {
      recoveredAsyncResults: [{ handle: 'recovered-h', ref: 'dev', text: 'Recovered report.' }],
      inspectTaskStatus: () => [{
        handle: 'recovered-h', agentId: 'dev', lifecycle: 'timed-out',
        delivery: { state: 'pending', observedAt: '2026-08-31T12:00:00.000Z' },
      }],
    });
    const status = await restored.run('inspect_task_status', { handles: ['recovered-h'] });
    expect(status).toContain('wait state: timed-out-result-arrived');
    expect(status).toContain('result state: ready');
    expect(status).toContain('collect_ready_tasks');
    expect(status).not.toContain('promise resumed');
  });

  it('projects current required-input receipts from the live resolver instead of the timeout snapshot', async () => {
    const resolver = taskInputResolver();
    let attemptId = '';
    const live = new TeamTools('pm', view, bus, {
      timeoutMs: 1000,
      taskInputResolver: resolver,
      onDelegationDispatched: (event) => { attemptId = event.attemptId ?? ''; },
      inspectTaskStatus: (handles) => (handles ?? []).map((handle) => ({
        handle, agentId: 'dev', lifecycle: 'active' as const,
      })),
    });
    const dispatched = await live.run('dispatch_task', {
      agent: 'dev',
      instruction: 'Read package.json.',
      contract: taskContract({
        effects: { read_files: ['package.json', 'tsconfig.json'], expected_file_effect: 'none' },
        inputs: [
          {
            input_id: 'manifest', kind: 'workspacePath', purpose: 'Inspect manifest', required: true,
            provenance: { kind: 'workspace', source_refs: ['package.json'] }, freshness: 'current', path: 'package.json',
          },
          {
            input_id: 'compiler', kind: 'workspacePath', purpose: 'Inspect compiler settings', required: true,
            provenance: { kind: 'workspace', source_refs: ['tsconfig.json'] }, freshness: 'current', path: 'tsconfig.json',
          },
        ],
        required_capabilities: { version: 1, capabilities: ['read'] },
      }),
    });
    const handle = dispatched.match(/Handle: ([0-9a-f-]+)/i)![1];
    const none = await live.run('inspect_task_status', { handles: [handle] });
    expect(none).toMatch(/read receipt state: none-observed[\s\S]*2 read receipt\(s\) not observed/);
    expect(none).toMatch(/input manifest:[\s\S]*read receipt not-observed/);
    expect(none).toMatch(/input compiler:[\s\S]*read receipt not-observed/);

    resolver.noteWorkspaceRead(attemptId, 'dev', 'package.json');
    expect(await live.run('inspect_task_status', { handles: [handle] })).toMatch(/read receipt state: partially-observed[\s\S]*1 read receipt\(s\) not observed/);
    resolver.noteWorkspaceRead(attemptId, 'dev', 'tsconfig.json');
    expect(await live.run('inspect_task_status', { handles: [handle] })).toMatch(/read receipt state: all-observed[\s\S]*0 read receipt\(s\) not observed/);
    live.cancelPending('cleanup');
  });

  it('notifies the host when an un-awaited async delegation settles, and consumes it only on confirmation', async () => {
    const ready: Array<{ handle: string; ref: string; text: string }> = [];
    const t = new TeamTools('pm', view, bus, {
      timeoutMs: 1000,
      onAsyncResultReady: (result) => ready.push(result),
    });
    bus.onType('task.assign', (m: Message) => {
      bus.send(String(m.to), m.from, 'task.complete', { instruction: 'finished work' }, 'normal', m.correlationId);
    });

    await t.run('assign_task_async', { agent: 'dev', instruction: 'work' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(ready).toHaveLength(1);
    expect(ready[0].ref).toBe('dev');
    expect(ready[0].text).toBe('finished work');
    expect(t.consumeAsyncResult(ready[0].handle)).toBe(true);
    expect(await t.run('await_tasks', {})).toMatch(/No pending tasks to await/);
  });

  it('does not auto-notify a result already atomically claimed by await_tasks', async () => {
    const ready: string[] = [];
    const t = new TeamTools('pm', view, bus, {
      timeoutMs: 1000,
      onAsyncResultReady: (result) => ready.push(result.handle),
    });
    let assignment: Message | undefined;
    bus.onType('task.assign', (m: Message) => { assignment = m; });

    await t.run('assign_task_async', { agent: 'dev', instruction: 'work' });
    const collected = t.run('await_tasks', {}); // claims synchronously, before the teammate settles
    bus.send('dev', assignment!.from, 'task.complete', { instruction: 'collected work' }, 'normal', assignment!.correlationId);

    expect(await collected).toContain('collected work');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(ready).toEqual([]);
  });

  it('keeps a notified result for await_tasks when the host does not start a wake turn', async () => {
    const ready: string[] = [];
    const t = new TeamTools('pm', view, bus, {
      timeoutMs: 1000,
      onAsyncResultReady: (result) => ready.push(result.handle), // host is busy: deliberately do not consume
    });
    bus.onType('task.assign', (m: Message) => {
      bus.send(String(m.to), m.from, 'task.complete', { instruction: 'saved for await' }, 'normal', m.correlationId);
    });

    await t.run('assign_task_async', { agent: 'dev', instruction: 'work' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(ready).toHaveLength(1);
    expect(await t.run('await_tasks', {})).toContain('saved for await');
  });

  it('restores a settled uncollected result after a session resume and lets await_tasks collect it', async () => {
    const durable: Array<{ handle: string; ref: string; text: string }> = [];
    const firstBus = new MessageBus();
    const beforeResume = new TeamTools('pm', view, firstBus, {
      timeoutMs: 1000,
      onAsyncResultRetained: (result) => durable.push(result),
    });
    firstBus.onType('task.assign', (m: Message) => {
      firstBus.send('dev', m.from, 'task.complete', { instruction: 'settled before resume' }, 'normal', m.correlationId);
    });

    await beforeResume.run('assign_task_async', { agent: 'dev', instruction: 'work' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(durable).toHaveLength(1);

    const consumed: string[] = [];
    const afterResume = new TeamTools('pm', view, new MessageBus(), {
      timeoutMs: 1000,
      recoveredAsyncResults: durable,
      onAsyncResultConsumed: (handle) => consumed.push(handle),
    });
    const collected = await afterResume.run('await_tasks', {});

    expect(collected).toContain('settled before resume');
    expect(consumed).toEqual([durable[0].handle]);
    expect(await afterResume.run('await_tasks', {})).toMatch(/No pending tasks to await/);
  });

  it('never auto-notifies a cancelled async delegation', async () => {
    const ready: string[] = [];
    const t = new TeamTools('pm', view, bus, {
      timeoutMs: 60_000,
      onAsyncResultReady: (result) => ready.push(result.handle),
    });

    await t.run('assign_task_async', { agent: 'dev', instruction: 'work' });
    t.cancelPending('cancelled by test');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(ready).toEqual([]);
  });

  it('await_tasks reports a partial failure without losing the other result', async () => {
    bus.onType('task.assign', (m: Message) => {
      if (m.to === 'dev') {
        bus.send('dev', m.from, 'task.complete', { instruction: 'ok' }, 'normal', m.correlationId);
      } else if (m.to === 'tester') {
        bus.send('tester', m.from, 'system.error', { instruction: 'tests crashed' }, 'normal', m.correlationId);
      }
    });
    await team.run('assign_task_async', { agent: 'dev', instruction: 'x' });
    await team.run('assign_task_async', { agent: 'tester', instruction: 'y' });
    const out = await team.run('await_tasks', {});
    expect(out).toMatch(/^\[tasks FAILED\]/); // so the tool card marks the step failed
    expect(out).toMatch(/ok/);
    expect(out).toMatch(/Error from tester: tests crashed/);
  });

  // Option B step 2: file-ownership claims push the name and handle of overlapping live work at the
  // conflicting dispatch itself; this must not depend on a later list_agents pull.
  it('pushes the named in-flight overlap at dispatch time, while preserving disjoint fan-out (T9)', async () => {
    const claims = new TaskClaimRegistry();
    const t = new TeamTools('pm', view, bus, { timeoutMs: 1000, claims });
    // No responder → tasks stay in flight, holding their claims.
    const first = await t.run('assign_task_async', { agent: 'dev', instruction: 'implement login', files: ['src/auth/**'] });
    expect(first).toMatch(/Dispatched/);
    const handle = first.match(/Handle: (\S+?)\./)![1];
    // tester wants a file inside dev's claimed subtree → rejected, named holder, not dispatched.
    const conflict = await t.run('assign_task_async', { agent: 'tester', instruction: 'b', files: ['src/auth/login.ts'] });
    expect(conflict).toMatch(/file conflict/);
    expect(conflict).toContain('in-flight task');
    expect(conflict).toContain(handle);
    expect(conflict).toContain('held by dev');
    expect(conflict).toContain('implement login');
    // disjoint files are fine.
    expect(await t.run('assign_task_async', { agent: 'tester', instruction: 'c', files: ['tests/**'] })).toMatch(/Dispatched/);
  });

  it('carries framework evidence to the coordinator on async completion, including the no-trace direction (T8)', async () => {
    const evidence: Array<{ handle: string; agentId: string; outcome: string }> = [];
    const asyncTeam = new TeamTools('pm', view, bus, {
      timeoutMs: 1000,
      evidenceEnabled: true,
      onDelegationEvidence: (event) => evidence.push(event),
    });
    const assignments: Message[] = [];
    bus.onType('task.assign', (m: Message) => assignments.push(m));

    const withTrace = await asyncTeam.run('assign_task_async', { agent: 'dev', instruction: 'inspect the catalogue' });
    const withoutTrace = await asyncTeam.run('assign_task_async', { agent: 'tester', instruction: 'inspect the second catalogue' });
    const tracedHandle = withTrace.match(/Handle: (\S+?)\./)![1];
    const untracedHandle = withoutTrace.match(/Handle: (\S+?)\./)![1];
    const traced = assignments.find((m) => m.correlationId === tracedHandle)!;
    const untraced = assignments.find((m) => m.correlationId === untracedHandle)!;

    bus.send('dev', traced.from, 'task.complete', {
      instruction: 'Searched the catalogue and found the requested entries.',
      metadata: { delegationEvidence: { hadToolActions: true, changedFiles: [] } },
    }, 'normal', traced.correlationId);
    bus.send('tester', untraced.from, 'task.complete', {
      instruction: 'I did real work, but this completion carries no framework tool trace.',
    }, 'normal', untraced.correlationId);

    const collected = await asyncTeam.run('await_tasks', { handles: [tracedHandle, untracedHandle] });
    expect(collected).toContain('[delegation: tool-activity-recorded]');
    expect(collected).toContain('[delegation: no-evidence]');
    expect(evidence.map(({ handle, agentId, outcome }) => ({ handle, agentId, outcome }))).toEqual([
      { handle: tracedHandle, agentId: 'dev', outcome: 'tool-activity-recorded' },
      { handle: untracedHandle, agentId: 'tester', outcome: 'no-evidence' },
    ]);
  });

  it('releases a file claim once the task is collected via await_tasks', async () => {
    const claims = new TaskClaimRegistry();
    const t = new TeamTools('pm', view, bus, { timeoutMs: 1000, claims });
    bus.onType('task.assign', (m: Message) => {
      bus.send(String(m.to), m.from, 'task.complete', { instruction: 'done' }, 'normal', m.correlationId);
    });
    await t.run('assign_task_async', { agent: 'dev', instruction: 'a', files: ['src/auth/**'] });
    await t.run('await_tasks', {});
    // claim freed → a previously-conflicting path can now be claimed.
    expect(await t.run('assign_task_async', { agent: 'tester', instruction: 'b', files: ['src/auth/x.ts'] })).toMatch(/Dispatched/);
  });

  it('Router v1: does NOT audit a route when the async task is rejected by a file conflict', async () => {
    const claims = new TaskClaimRegistry();
    const routes: string[] = [];
    const t = new TeamTools('pm', view, bus, { timeoutMs: 60_000, claims, onRoute: (l) => routes.push(l) });
    expect(await t.run('assign_task_async', { agent: 'dev', instruction: 'a', files: ['src/auth/**'] })).toMatch(/Dispatched/);
    // Overlaps the claim above → rejected before dispatch; must produce NO route audit line.
    expect(await t.run('assign_task_async', { agent: 'tester', instruction: 'b', files: ['src/auth/x.ts'] })).toMatch(/file conflict/);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toContain('→ dev');
    expect(routes[0]).not.toContain('tester');
  });

  it('cancelPending settles an in-flight await_tasks and releases async claims', async () => {
    const claims = new TaskClaimRegistry();
    const t = new TeamTools('pm', view, bus, { timeoutMs: 60_000, claims });

    expect(await t.run('assign_task_async', { agent: 'dev', instruction: 'a', files: ['src/auth/**'] })).toMatch(/Dispatched/);
    expect(await t.run('assign_task_async', { agent: 'tester', instruction: 'b', files: ['src/auth/x.ts'] })).toMatch(/file conflict/);

    const awaiting = t.run('await_tasks', {});
    const cancelled = t.cancelPending('delegation cancelled by user');
    const out = await awaiting;

    expect(cancelled).toBeGreaterThan(0);
    expect(out).toMatch(/^\[tasks FAILED\]/);
    expect(out).toMatch(/Error: delegation cancelled by user\./);
    expect(claims.activeClaims()).toEqual([]);
    expect(await t.run('assign_task_async', { agent: 'tester', instruction: 'c', files: ['src/auth/x.ts'] })).toMatch(/Dispatched/);
  });

  it('cancelPending releases async claims even when no await_tasks call is active', async () => {
    const claims = new TaskClaimRegistry();
    const t = new TeamTools('pm', view, bus, { timeoutMs: 60_000, claims });

    expect(await t.run('assign_task_async', { agent: 'dev', instruction: 'a', files: ['src/auth/**'] })).toMatch(/Dispatched/);
    expect(await t.run('assign_task_async', { agent: 'tester', instruction: 'b', files: ['src/auth/x.ts'] })).toMatch(/file conflict/);

    t.cancelPending('delegation cancelled by user');

    expect(claims.activeClaims()).toEqual([]);
    expect(await t.run('assign_task_async', { agent: 'tester', instruction: 'c', files: ['src/auth/x.ts'] })).toMatch(/Dispatched/);
  });

  it('warns when an async dispatch omits files (conflict protection off), not when files are given', async () => {
    const claims = new TaskClaimRegistry();
    const t = new TeamTools('pm', view, bus, { timeoutMs: 1000, claims });
    const noFiles = await t.run('assign_task_async', { agent: 'dev', instruction: 'a' });
    expect(noFiles).toMatch(/WARNING: no files declared/);
    const withFiles = await t.run('assign_task_async', { agent: 'tester', instruction: 'b', files: ['tests/**'] });
    expect(withFiles).not.toMatch(/WARNING/);
  });

  it('caps parallel delegations and tells the PM to end the turn rather than wait', async () => {
    const capped = new TeamTools('pm', view, bus, { timeoutMs: 1000, maxParallelDelegations: 2 });
    // No responder → tasks stay pending, filling the cap.
    expect(await capped.run('assign_task_async', { agent: 'dev', instruction: 'a' })).toMatch(/Dispatched/);
    expect(await capped.run('assign_task_async', { agent: 'tester', instruction: 'b' })).toMatch(/Dispatched/);
    const third = await capped.run('assign_task_async', { agent: 'dev', instruction: 'c' });
    expect(third).toMatch(/too many parallel tasks in flight \(2\/2\)/);
    expect(third).toMatch(/End this turn/i);
  });

  it('releases a stopped async delegate from the concurrency cap before its retained result is collected (N4)', async () => {
    const capped = new TeamTools('pm', view, bus, { timeoutMs: 1000, maxParallelDelegations: 1 });
    let assignment: Message | undefined;
    bus.onType('task.assign', (m: Message) => { assignment = m; });

    const first = await capped.run('assign_task_async', { agent: 'dev', instruction: 'long-running packet' });
    expect(first).toMatch(/Dispatched/);
    expect(await capped.run('assign_task_async', { agent: 'tester', instruction: 'next packet' })).toMatch(/too many parallel tasks/i);

    // SessionManager emits this terminal error when the user stops the worker. The result remains
    // collectable, but it cannot keep a live-work slot occupied.
    bus.send('dev', assignment!.from, 'system.error', { instruction: 'Agent stopped by user.' }, 'normal', assignment!.correlationId);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(await capped.run('assign_task_async', { agent: 'tester', instruction: 'next packet' })).toMatch(/Dispatched/);
    capped.cancelPending();
  });

  it('lists a retained late delegation as still in flight so the coordinator does not re-dispatch it (N5)', async () => {
    const late = new TeamTools('pm', view, bus, { timeoutMs: 20 });
    await late.run('assign_task', { agent: 'dev', instruction: 'complete the full packet' });

    const roster = await late.run('list_agents', {});
    expect(roster).toMatch(/Still in flight/i);
    expect(roster).toMatch(/dev \(handle /i);
    expect(roster).toMatch(/do NOT re-dispatch/i);
    late.cancelPending();
  });

  it('assign_task_async rejects unknown agent and self without queueing a task', async () => {
    expect(await team.run('assign_task_async', { agent: 'ghost', instruction: 'x' })).toMatch(/no teammate "ghost"/);
    expect(await team.run('assign_task_async', { agent: 'pm', instruction: 'x' })).toMatch(/cannot assign a task to yourself/);
    expect(await team.run('await_tasks', {})).toMatch(/No pending tasks to await/);
  });

  it('await_tasks can collect a specific handle', async () => {
    bus.onType('task.assign', (m: Message) => {
      bus.send(String(m.to), m.from, 'task.complete', { instruction: `done ${m.payload.instruction}` }, 'normal', m.correlationId);
    });
    const a = await team.run('assign_task_async', { agent: 'dev', instruction: 'A' });
    await team.run('assign_task_async', { agent: 'tester', instruction: 'B' });
    const handle = a.match(/Handle: (\S+?)\./)![1];

    const out = await team.run('await_tasks', { handles: [handle] });
    expect(out).toMatch(/done A/);
    expect(out).not.toMatch(/done B/);
    // The other task is still pending.
    expect(await team.run('await_tasks', {})).toMatch(/done B/);
  });

  it('run_checks reports a passing verification', async () => {
    const t = new TeamTools('pm', view, bus, {
      verifyCommand: 'tsc',
      runCommand: async () => ({ code: 0, output: 'no errors' }),
    });
    expect(await t.run('run_checks', {})).toMatch(/\[checks passed\]/);
  });

  it('run_checks runs a config verify command with an outside path but warns once', async () => {
    const root = process.platform === 'win32' ? 'C:\\repo' : '/repo';
    const outside = process.platform === 'win32' ? 'C:\\outside\\secret.txt' : '/outside/secret.txt';
    const command = `type ${outside}`;
    const runs: string[] = [];
    const warnings: string[] = [];
    const t = new TeamTools('pm', view, bus, {
      cwd: root,
      verifyCommand: command,
      commandPolicy: new CommandPolicy('all', []),
      onConfigOutsideRoot: (message) => warnings.push(message),
      runCommand: async (cmd) => { runs.push(cmd); return { code: 0, output: 'no errors' }; },
    });

    expect(await t.run('run_checks', {})).toMatch(/\[checks passed\]/);
    expect(await t.run('run_checks', {})).toMatch(/\[checks passed\]/);

    expect(runs).toEqual([command, command]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(outside);
  });

  it('run_checks reports a failing verification with output for the fix loop', async () => {
    const t = new TeamTools('pm', view, bus, {
      verifyCommand: 'tsc',
      runCommand: async () => ({ code: 2, output: "src/x.ts(3,1): error TS2554: Expected 2 args, got 1." }),
    });
    const outcome = await t.runOutcome('run_checks', {});
    expect(outcome.output).toMatch(/\[checks FAILED\]/);
    expect(outcome.output).toMatch(/error TS2554/);
    expect(outcome).toMatchObject({ source: 'host', status: 'failed', contentSource: 'mixed-external' });
    expect(summarizeToolResult('run_checks', {}, outcome).ok).toBe(false);
  });

  it('run_checks marks a misconfigured command failure as carrying subprocess output', async () => {
    const t = new TeamTools('pm', view, bus, {
      verifyCommand: 'missing-check',
      runCommand: async () => ({ code: 127, output: 'missing-check: command not found' }),
    });
    const outcome = await t.runOutcome('run_checks', {});
    expect(outcome.output).toMatch(/\[checks MISCONFIGURED\]/);
    expect(outcome).toMatchObject({ source: 'host', status: 'failed', contentSource: 'mixed-external' });
    expect(summarizeToolResult('run_checks', {}, outcome).ok).toBe(false);
  });

  it('run_checks tells the PM when no verify command is configured', async () => {
    const out = await team.run('run_checks', {});
    expect(out).toMatch(/No verification command configured/);
  });

  it('run_checks applies CommandPolicy before running verifyCommand', async () => {
    const t = new TeamTools('pm', view, bus, {
      verifyCommand: 'node build.js',
      commandPolicy: new CommandPolicy('allowlist', ['npm test']),
      runCommand: async () => ({ code: 0, output: 'should not run' }),
    });
    const out = await t.run('run_checks', {});
    expect(out).toMatch(/blocked by unode.commandApproval/);
  });

  it('run_checks notifies onCommandBlocked when policy blocks (B2)', async () => {
    const blocked: string[] = [];
    const t = new TeamTools('pm', view, bus, {
      verifyCommand: 'node build.js',
      commandPolicy: new CommandPolicy('none', []),
      onCommandBlocked: (reason) => blocked.push(reason),
    });
    await t.run('run_checks', {});
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatch(/disabled/);
  });

  // The PM-deadlock fix: in 'ask' mode (the DEFAULT), run_checks must PROMPT (like run_command), not
  // dead-end "awaiting user approval" — otherwise the PM can never verify (run_command is delegate-gated).
  it('run_checks prompts in ask mode and runs the verify command when approved', async () => {
    let ran = false;
    let prompted = '';
    const t = new TeamTools('pm', view, bus, {
      verifyCommand: 'npm test',
      commandPolicy: new CommandPolicy('ask', []), // not allowlisted → { allowed:false, ask:true }
      requestApproval: async (cmd) => { prompted = cmd; return { allow: true }; },
      runCommand: async () => { ran = true; return { code: 0, output: 'ok' }; },
    });
    const out = await t.run('run_checks', {});
    expect(prompted).toBe('npm test');           // the user was actually asked
    expect(ran).toBe(true);                       // and the command ran after approval
    expect(out).toMatch(/\[checks passed\]/);
  });

  it('run_checks reports denial (and does NOT run) when the user declines in ask mode', async () => {
    let ran = false;
    const t = new TeamTools('pm', view, bus, {
      verifyCommand: 'npm test',
      commandPolicy: new CommandPolicy('ask', []),
      requestApproval: async () => ({ allow: false, note: 'use the dev instead' }),
      runCommand: async () => { ran = true; return { code: 0, output: 'ok' }; },
    });
    const out = await t.run('run_checks', {});
    expect(ran).toBe(false);
    expect(out).toMatch(/not approved/i);
    expect(out).toMatch(/use the dev instead/);
  });

  it('run_checks still hard-blocks in ask mode when no approver is wired (test/headless)', async () => {
    const t = new TeamTools('pm', view, bus, {
      verifyCommand: 'npm test',
      commandPolicy: new CommandPolicy('ask', []),
      runCommand: async () => ({ code: 0, output: 'should not run' }),
    });
    const out = await t.run('run_checks', {});
    expect(out).toMatch(/blocked by unode.commandApproval/);
  });
});

describe('v0.9.60 task verification contracts', () => {
  it('carries declared files on the first async dispatch and both L2/L3 firm retries', async () => {
    const bus = new MessageBus();
    const team = new TeamTools('pm', view, bus, {
      timeoutMs: 5_000,
      escalate: () => ({ switched: true }),
      taskInputResolver: taskInputResolver(),
    });
    const declared = ['src/contract.ts', 'src/contract.test.ts'];
    const received: Array<string[] | undefined> = [];
    let attempt = 0;
    bus.onType('task.assign', (message) => {
      if (message.to !== 'dev') { return; }
      received.push(message.payload.files);
      attempt++;
      bus.send('dev', 'pm', 'task.complete', { instruction: attempt < 3 ? '' : 'implemented' }, 'normal', message.correlationId);
    });

    await expect(team.run('dispatch_task', {
      agent: 'dev', instruction: 'Implement the contract.',
      contract: taskContract({
        effects: { read_files: declared, expected_file_effect: 'none' },
        required_capabilities: { version: 1, capabilities: ['read'] },
      }),
    })).resolves.toContain('Handle:');
    await expect(team.run('await_tasks', {})).resolves.toContain('implemented');

    expect(received).toEqual([declared, declared, declared]);
  });

  it('keeps the first dispatch payload\'s files and contract on the async L2 firm retry', async () => {
    const bus = new MessageBus();
    const assignments = new Map<string, Message>();
    const payloads: Array<{ files?: string[]; contract: unknown }> = [];
    const team = new TeamTools('pm', view, bus, {
      timeoutMs: 5_000,
      onDelegationDispatched: (event) => {
        const assignment = assignments.get(event.handle);
        payloads.push({ files: assignment?.payload.files, contract: event.contract });
      },
    });
    const declared = ['src/retry-contract.ts', 'src/retry-contract.test.ts'];
    let attempt = 0;
    bus.onType('task.assign', (message) => {
      if (message.to !== 'dev') { return; }
      assignments.set(message.correlationId!, message);
      attempt++;
      bus.send('dev', 'pm', 'task.complete', {
        instruction: attempt === 1 ? '' : 'implemented after firm retry',
      }, 'normal', message.correlationId);
    });

    await expect(team.run('assign_task_async', {
      agent: 'dev', instruction: 'Implement the retry contract.', files: declared,
    })).resolves.toContain('Handle:');
    await expect(team.run('await_tasks', {})).resolves.toContain('implemented after firm retry');

    expect(payloads).toHaveLength(2);
    const [firstDispatch, firmRetry] = payloads;
    expect(firmRetry).toEqual(firstDispatch);
  });

  it('records a host-owned empty-delegation receipt and retries it once through fresh contract admission', async () => {
    const bus = new MessageBus();
    const assignments: Message[] = [];
    const receipts: Array<{ outcomeId: string; correlationId: string; retry: () => Promise<boolean> }> = [];
    let dispatches = 0;
    bus.onType('task.assign', (message) => {
      if (message.to !== 'dev') return;
      assignments.push(message);
      dispatches += 1;
      bus.send('dev', 'pm', 'task.complete', {
        instruction: dispatches <= 2 ? '' : 'implemented after explicit repair',
      }, 'normal', message.correlationId);
    });
    const tools = new TeamTools('pm', view, bus, {
      timeoutMs: 5_000,
      taskInputResolver: taskInputResolver(),
      onDelegationEmptyOutcome: (event) => receipts.push(event),
    });
    const declared = ['src/retry-contract.ts', 'src/retry-contract.test.ts'];

    await expect(tools.run('dispatch_task', {
      agent: 'dev', instruction: 'Implement the retry contract.',
      contract: taskContract({
        effects: { read_files: declared, expected_file_effect: 'none' },
        required_capabilities: { version: 1, capabilities: ['read'] },
      }),
    })).resolves.toContain('Handle:');
    await vi.waitFor(() => expect(receipts).toHaveLength(1));

    const terminal = await tools.run('collect_ready_tasks', {});
    expect(terminal).toContain('[BLOCKED: dev returned nothing across a fresh attempt-bound retry and no usable fallback execution exists.]');
    expect(assignments).toHaveLength(2);
    const [first, second] = assignments;
    expect(receipts[0].correlationId).toBe(first.correlationId);
    expect(first.payload.contract).toEqual(second.payload.contract);
    expect(first.payload.files).toEqual(declared);
    expect(second.payload.files).toEqual(declared);
    expect(first.payload.taskAttempt?.attemptId).not.toBe(second.payload.taskAttempt?.attemptId);

    // The same opaque receipt is idempotent under duplicate/concurrent UI delivery: it emits exactly
    // one new dispatch, while that dispatch owns a new handle, task attempt and input-grant card.
    await expect(Promise.all([receipts[0].retry(), receipts[0].retry()])).resolves.toEqual([true, true]);
    expect(assignments).toHaveLength(3);
    const repaired = assignments[2];
    expect(repaired.payload.contract).toEqual(first.payload.contract);
    expect(repaired.payload.files).toEqual(first.payload.files);
    expect(repaired.payload.taskAttempt?.attemptId).not.toBe(first.payload.taskAttempt?.attemptId);
    expect(repaired.payload.taskAttempt?.attemptId).not.toBe(second.payload.taskAttempt?.attemptId);
  });

  it('settles the first contract attempt before a firm retry receives a fresh lease', async () => {
    const bus = new MessageBus();
    const assignments: Message[] = [];
    let dispatches = 0;
    bus.onType('task.assign', (message) => {
      if (message.to !== 'dev') return;
      assignments.push(message);
      dispatches += 1;
      bus.send('dev', 'pm', 'task.complete', {
        instruction: dispatches === 1 ? '' : 'implemented by the fresh firm retry',
      }, 'normal', message.correlationId);
    });
    const tools = new TeamTools('pm', view, bus, {
      timeoutMs: 5_000,
      taskInputResolver: taskInputResolver(),
    });

    await expect(tools.run('dispatch_task', {
      agent: 'dev', instruction: 'Implement the retry lease.',
      contract: taskContract({
        effects: { read_files: ['src/retry-lease.ts'], expected_file_effect: 'none' },
        required_capabilities: { version: 1, capabilities: ['read'] },
      }),
    })).resolves.toContain('Handle:');
    await vi.waitFor(() => expect(assignments).toHaveLength(2));

    await expect(tools.run('collect_ready_tasks', {})).resolves.toContain('implemented by the fresh firm retry');
    expect(assignments[0].payload.taskAttempt?.attemptId).not.toBe(assignments[1].payload.taskAttempt?.attemptId);
  });

  it('refuses every declared sensor that the resolved target cannot reach before sending the task', async () => {
    const bus = new MessageBus();
    const roster: TeamRosterEntry[] = [
      { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
      {
        id: 'worker', role: 'senior-dev', name: 'Worker', status: 'idle',
        capabilities: {
          read: true, write: true, shell: true, toolFamilies: ['read', 'write', 'execute'],
          verificationSensors: ['command-exit-zero', 'recorded-file-effect'],
        },
      },
      {
        id: 'coordinator', role: 'pm', name: 'Coordinator', status: 'idle',
        capabilities: {
          read: true, write: true, shell: true, toolFamilies: ['read', 'write', 'execute', 'delegate'],
          verificationSensors: ['command-exit-zero', 'recorded-file-effect', 'editor-diagnostics-clean', 'run-checks'],
        },
      },
    ];
    const routed: Message[] = [];
    bus.onType('task.assign', (message) => {
      routed.push(message);
      if (message.to === 'coordinator') {
        bus.send('coordinator', 'pm', 'task.complete', { instruction: 'checks ran' }, 'normal', message.correlationId);
      }
    });
    const team = new TeamTools('pm', { list: () => roster, resolve: (ref) => ({ id: ref }) }, bus, {
      timeoutMs: 5_000, taskInputResolver: taskInputResolver(),
    });
    const plan = { sensors: ['run-checks'], none_applies: 'report-no-applicable-sensor' };

    await expect(team.run('dispatch_task', {
      agent: 'worker', instruction: 'Implement and verify.',
      contract: taskContract({
        verification_plan: plan,
        required_capabilities: { version: 1, capabilities: ['shell'] },
      }),
    })).resolves.toMatch(/no-executor.*verification-sensor.*run-checks/i);
    expect(routed).toEqual([]);

    await expect(team.run('assign_task', {
      agent: 'coordinator', instruction: 'Run the configured checks.', verification_plan: plan,
    })).resolves.toBe('checks ran');
    expect(routed).toHaveLength(1);
    expect(routed[0].payload.verificationPlan).toEqual({ sensors: ['run-checks'], noneApplies: 'report-no-applicable-sensor' });
  });

  it('forwards a host-validated plan with the delegated task rather than reading one workspace-global command', async () => {
    const bus = new MessageBus();
    const team = new TeamTools('pm', view, bus, {
      timeoutMs: 5_000, evidenceEnabled: true, taskInputResolver: taskInputResolver(),
    });
    let assignment: Message | undefined;
    bus.onType('task.assign', (message) => { assignment = message; });

    const receipt = await team.run('dispatch_task', {
      agent: 'dev',
      instruction: 'Update the documentation.',
      contract: taskContract({
        verification_plan: { sensors: [], none_applies: 'report-no-applicable-sensor' },
      }),
    });

    expect(receipt).toContain('Handle:');
    expect(assignment?.payload.verificationPlan).toEqual({
      sensors: [], noneApplies: 'report-no-applicable-sensor',
    });
    bus.send('dev', 'pm', 'task.complete', {
      instruction: 'Updated the documentation.',
      metadata: { delegationEvidence: { hadToolActions: true, changedFiles: [] } },
    }, 'normal', assignment?.correlationId);
  });
});

describe('v0.9.61 deterministic contract routing and execution strategy', () => {
  const routedRoster: TeamRosterEntry[] = [
    {
      id: 'pm', role: 'pm', name: 'PM', status: 'running',
      capabilities: {
        read: true, write: true, shell: true, toolFamilies: ['read', 'write', 'execute', 'delegate'],
        verificationSensors: ['command-exit-zero', 'recorded-file-effect', 'run-checks'], taskScope: 'per-turn',
      },
    },
    {
      id: 'weak', role: 'developer', name: 'Weak', status: 'idle',
      capabilities: { read: true, write: true, shell: false, toolFamilies: ['read', 'write'], verificationSensors: ['recorded-file-effect'], taskScope: 'per-turn' },
    },
    {
      id: 'strong', role: 'developer', name: 'Strong', status: 'idle',
      capabilities: { read: true, write: true, shell: true, toolFamilies: ['read', 'write', 'execute'], verificationSensors: ['command-exit-zero'], taskScope: 'per-turn' },
    },
    { id: 'solo', role: 'solo', name: 'Solo', status: 'idle' },
  ];
  const routedView: TeamView = { list: () => routedRoster, resolve: (ref) => ({ id: ref }), preflightTaskScope: () => undefined };

  it('keeps final policy refusal separate from dispatch, evidence, settlement, delivery, and no-executor', async () => {
    const bus = new MessageBus();
    const dispatched = vi.fn();
    const refused = vi.fn();
    const evidence = vi.fn();
    const retained = vi.fn();
    const tools = new TeamTools('pm', routedView, bus, {
      timeoutMs: 1_000,
      taskInputResolver: taskInputResolver(),
      waitForTaskAdmission: true,
      onDelegationDispatched: dispatched,
      onDelegationRefused: refused,
      onDelegationEvidence: evidence,
      onAsyncResultRetained: retained,
    });
    bus.onType('task.assign', (message) => {
      bus.send('strong', 'pm', 'system.error', {
        instruction: 'Same reported model identity.',
        metadata: { isError: true, policyRefused: true, policyId: 'artifact-review-different-reported-model-v1' },
      }, 'normal', message.correlationId);
    });

    const result = await tools.run('dispatch_task', {
      agent: 'strong', instruction: 'Review the declared artifact.', contract: taskContract(),
    });
    expect(result).toMatch(/task state policy-refused/i);
    expect(result).not.toMatch(/no-executor/i);
    expect(dispatched).not.toHaveBeenCalled();
    expect(evidence).not.toHaveBeenCalled();
    expect(retained).not.toHaveBeenCalled();
    expect(refused).toHaveBeenCalledWith(expect.objectContaining({
      taskState: 'policy-refused',
      policyId: 'artifact-review-different-reported-model-v1',
      handle: expect.any(String),
    }));
  });

  it('applies the same policy decision to coordinator-only execution', async () => {
    const refused = vi.fn();
    const tools = new TeamTools('pm', routedView, new MessageBus(), {
      timeoutMs: 1_000,
      taskInputResolver: taskInputResolver(),
      admitCoordinatorAttempt: () => ({
        allowed: false,
        applied: true,
        policyId: 'artifact-review-different-reported-model-v1',
        code: 'refused-same-reported-model',
        reason: 'Same reported model identity.',
      }),
      onDelegationRefused: refused,
    });
    const result = await tools.run('dispatch_task', {
      agent: 'pm', instruction: 'Review it.', contract: taskContract({ execution_strategy: 'coordinator-only' }),
    });
    expect(result).toMatch(/policy-refused/i);
    expect(result).not.toMatch(/no-executor/i);
    expect(tools.currentCoordinatorTaskAttempt()).toBeUndefined();
    expect(refused).toHaveBeenCalledWith(expect.objectContaining({ taskState: 'policy-refused' }));
  });

  it('filters a role before rotation and refuses an unfit exact id without substitution', async () => {
    const bus = new MessageBus();
    const tools = new TeamTools('pm', routedView, bus, { timeoutMs: 1_000, taskInputResolver: taskInputResolver() });
    const assignments: Message[] = [];
    bus.onType('task.assign', (message) => assignments.push(message));
    const contract = taskContract({ required_capabilities: { version: 1, capabilities: ['shell'] } });

    const roleResult = await tools.run('dispatch_task', { agent: 'developer', instruction: 'Run the declared command.', contract });
    expect(roleResult).toContain('to strong');
    expect(assignments[0].to).toBe('strong');
    tools.cancelPending('test cleanup');

    const exactResult = await tools.run('dispatch_task', { agent: 'weak', instruction: 'Run the declared command.', contract });
    expect(exactResult).toMatch(/no-executor.*shell.*not substituted/i);
    expect(assignments.filter((message) => message.to === 'weak')).toEqual([]);
  });

  it('does not skip the host task-scope dry run or the file-claim hard filter', async () => {
    const contract = taskContract({
      effects: {
        read_files: [],
        write_scope: { folder_access: [{ path: 'src', permission: 'readwrite' }] },
        expected_file_effect: 'modify',
      },
      required_capabilities: { version: 1, capabilities: ['write'] },
    });

    const scopedBus = new MessageBus();
    const scopedAssignments: Message[] = [];
    scopedBus.onType('task.assign', (message) => scopedAssignments.push(message));
    const scopeTools = new TeamTools('pm', {
      list: () => routedRoster,
      resolve: (ref) => ({ id: ref }),
      preflightTaskScope: () => 'declared path is outside the target configured authority',
    }, scopedBus, { timeoutMs: 1_000, taskInputResolver: taskInputResolver() });
    expect(await scopeTools.run('dispatch_task', { agent: 'strong', instruction: 'Make the edit.', contract }))
      .toMatch(/no-executor.*task-scope.*outside the target configured authority/is);
    expect(scopedAssignments).toEqual([]);

    const claims = new TaskClaimRegistry();
    expect(claims.claim('existing-task', 'other-worker', ['src'], 'Existing edit').ok).toBe(true);
    const claimBus = new MessageBus();
    const claimAssignments: Message[] = [];
    claimBus.onType('task.assign', (message) => claimAssignments.push(message));
    const claimTools = new TeamTools('pm', routedView, claimBus, {
      timeoutMs: 1_000,
      claims,
      taskInputResolver: taskInputResolver(),
    });
    expect(await claimTools.run('dispatch_task', { agent: 'strong', instruction: 'Make the edit.', contract }))
      .toMatch(/no-executor.*file-claim.*existing-task.*other-worker/is);
    expect(claimAssignments).toEqual([]);
  });

  it('can explicitly grant coordinator-owned content without reopening shared-store reads', async () => {
    const store = new ContentAssetStore();
    const resolver = new TaskInputResolver(store, process.cwd());
    const owned = await store.storeText('PM-FETCHED-SOURCE', 'public-url', 'pm');
    const foreign = await store.storeText('OTHER-AGENT-SOURCE', 'public-url', 'other-agent');
    if ('error' in owned || 'error' in foreign) throw new Error('fixture storage failed');
    const bus = new MessageBus();
    const assignments: Message[] = [];
    bus.onType('task.assign', (message) => assignments.push(message));
    const tools = new TeamTools('pm', routedView, bus, { timeoutMs: 1_000, taskInputResolver: resolver });
    const contentContract = (assetId: string) => taskContract({
      inputs: [{
        input_id: 'source', kind: 'contentAsset', asset_id: assetId, purpose: 'Declared source',
        required: true, freshness: 'attempt-start', provenance: { kind: 'coordinator-declared', source_refs: [] },
      }],
      required_capabilities: { version: 1, capabilities: ['read'] },
    });

    expect(await tools.run('dispatch_task', {
      agent: 'strong', instruction: 'Use the declared source.', contract: contentContract(owned.assetId),
    })).toContain('Handle:');
    expect(assignments[0].payload.taskAttempt?.grants).toEqual([
      expect.objectContaining({ agentId: 'strong', sourceRef: owned.assetId }),
    ]);
    tools.cancelPending('test cleanup');

    expect(await tools.run('dispatch_task', {
      agent: 'strong', instruction: 'Use the undeclared foreign source.', contract: contentContract(foreign.assetId),
    })).toMatch(/no-executor.*not authorised for delegation/is);
    await store.dispose();
  });

  it('does not re-delegate contract-managed content merely because the coordinator owns its bytes', async () => {
    const store = new ContentAssetStore();
    const resolver = new TaskInputResolver(store, process.cwd());
    const producer = compileTaskContract(taskContract({ objective: 'Produce a managed artifact.' }), 'pm').contract;
    if (!producer) throw new Error('fixture contract failed to compile');
    const attempt = await resolver.beginAttempt(producer, {
      agentId: 'pm', capabilities: { read: true, write: true, shell: true }, taskScope: 'per-turn',
      verificationSensors: [], authorizedContentAssetIds: [], liveContentAssetIds: [], readyArtifacts: [],
    }, 'pm');
    if (!attempt.card) throw new Error('fixture producer attempt was not admitted');
    const published = await resolver.publishArtifact(attempt.card.attemptId, 'pm', 'MANAGED COORDINATOR ARTIFACT');
    if (!published.artifact) throw new Error('fixture artifact was not published');
    expect(await store.isOwnedBy(published.artifact.contentAssetId, 'pm')).toBe(true);
    expect(resolver.isContractManagedContentAsset(published.artifact.contentAssetId)).toBe(true);

    const bus = new MessageBus();
    const assignments: Message[] = [];
    bus.onType('task.assign', (message) => assignments.push(message));
    const tools = new TeamTools('pm', routedView, bus, { timeoutMs: 1_000, taskInputResolver: resolver });
    const handoff = taskContract({
      objective: 'Hand the managed artifact to a teammate.',
      inputs: [{
        input_id: 'managed', kind: 'contentAsset', asset_id: published.artifact.contentAssetId,
        purpose: 'A contract-managed coordinator artifact', required: true, freshness: 'attempt-start',
        provenance: { kind: 'coordinator-declared', source_refs: [] },
      }],
      required_capabilities: { version: 1, capabilities: ['read'] },
    });

    await expect(tools.run('dispatch_task', { agent: 'strong', instruction: 'Use the managed artifact.', contract: handoff }))
      .resolves.toMatch(/no-executor.*not authorised for delegation/i);
    expect(assignments).toEqual([]);
    await store.dispose();
  });

  it('consults attempt liveness at both coordinator self-execution consumers', async () => {
    const resolver = taskInputResolver();
    const tools = new TeamTools('pm', routedView, new MessageBus(), { timeoutMs: 1_000, taskInputResolver: resolver });
    const first = taskContract({
      objective: 'Make the first coordinator-only change.',
      effects: { read_files: [], expected_file_effect: 'modify' },
      required_capabilities: { version: 1, capabilities: ['write'] },
      execution_strategy: 'coordinator-only',
    });
    const second = taskContract({
      objective: 'Make a distinct coordinator-only change.',
      effects: { read_files: [], expected_file_effect: 'modify' },
      required_capabilities: { version: 1, capabilities: ['write'] },
      execution_strategy: 'coordinator-only',
    });

    await expect(tools.run('dispatch_task', { agent: 'pm', instruction: 'Start the first change.', contract: first }))
      .resolves.toMatch(/Coordinator execution is authorised/);
    const live = tools.currentCoordinatorTaskAttempt();
    expect(live).toBeDefined();
    expect(tools.canCoordinatorExecute('write_file')).toBe(true);
    await expect(tools.run('dispatch_task', { agent: 'pm', instruction: 'Overlap with a second change.', contract: second }))
      .resolves.toMatch(/already has live contract/i);

    resolver.endAttempt(live!.attemptId, 'settled');
    expect(tools.canCoordinatorExecute('write_file')).toBe(false);
    await expect(tools.run('dispatch_task', { agent: 'pm', instruction: 'Start the second change after settlement.', contract: second }))
      .resolves.toMatch(/Coordinator execution is authorised/);
    tools.finishCoordinatorAttempt();
  });

  it('implements all three execution strategies without a bounce-count bypass or Solo fallback', async () => {
    const bus = new MessageBus();
    const tools = new TeamTools('pm', routedView, bus, { timeoutMs: 1_000, taskInputResolver: taskInputResolver() });
    const assignments: Message[] = [];
    bus.onType('task.assign', (message) => assignments.push(message));
    const impossibleDelegate = taskContract({
      required_capabilities: { version: 1, capabilities: ['shell'] },
      execution_strategy: 'delegate-required',
    });
    expect(await tools.run('dispatch_task', { agent: 'weak', instruction: 'Run it.', contract: impossibleDelegate }))
      .toMatch(/task state no-executor/i);
    expect(tools.currentCoordinatorTaskAttempt()).toBeUndefined();

    // A role with no viable delegate reaches the non-exact branch below. The PM can satisfy this
    // contract, so replacing that branch's no-executor result with coordinator authorisation must fail.
    expect(await tools.run('dispatch_task', { agent: 'missing-role', instruction: 'Run it.', contract: impossibleDelegate }))
      .toMatch(/task state no-executor/i);
    expect(tools.currentCoordinatorTaskAttempt()).toBeUndefined();

    const coordinatorOnly = taskContract({
      required_capabilities: { version: 1, capabilities: ['write'] },
      effects: { read_files: [], expected_file_effect: 'modify' },
      execution_strategy: 'coordinator-only',
    });
    expect(await tools.run('dispatch_task', { agent: 'solo', instruction: 'Make the atomic edit.', contract: coordinatorOnly }))
      .toMatch(/Coordinator execution is authorised/);
    expect(assignments).toEqual([]);
    expect(tools.canCoordinatorExecute('write_file')).toBe(true);
    expect(tools.canCoordinatorExecute('run_command')).toBe(false);
    expect(await tools.run('dispatch_task', {
      agent: 'solo', instruction: 'Try to overlap coordinator work.', contract: coordinatorOnly,
    })).toMatch(/no-executor.*already has live contract/is);
    expect(tools.canCoordinatorExecute('write_file')).toBe(true);
    tools.finishCoordinatorAttempt();

    const preferred = taskContract({
      required_capabilities: { version: 1, capabilities: ['shell'] },
      execution_strategy: 'delegate-preferred',
    });
    expect(await tools.run('dispatch_task', { agent: 'missing-role', instruction: 'Run it.', contract: preferred }))
      .toMatch(/delegate filters exhausted.*Coordinator execution is authorised/is);
    expect(tools.currentCoordinatorTaskAttempt()?.agentId).toBe('pm');
    expect(assignments.every((message) => message.to !== 'solo')).toBe(true);
  });

  it('does not authorise coordinator fallback when a delegate-required target disappears during dispatch', async () => {
    let rosterReads = 0;
    const rosterDuringAdmission: TeamRosterEntry[] = routedRoster;
    const team = new TeamTools('pm', {
      // Candidate selection and attempt admission see Strong. Its real dispatch resolves the roster again,
      // at which point Strong has gone away. That must still be no-executor for delegate-required work.
      list: () => ++rosterReads < 3 ? rosterDuringAdmission : [routedRoster[0]],
      resolve: (ref) => ({ id: ref }),
      preflightTaskScope: () => undefined,
    }, new MessageBus(), { timeoutMs: 1_000, taskInputResolver: taskInputResolver() });
    const contract = taskContract({
      required_capabilities: { version: 1, capabilities: ['shell'] },
      execution_strategy: 'delegate-required',
    });

    const result = await team.run('dispatch_task', {
      agent: 'strong', instruction: 'Run the declared command.', contract,
    });

    expect(result).toMatch(/task state no-executor.*delegation capability mismatch.*no capability facts/i);
    expect(result).not.toContain('Coordinator execution is authorised');
    expect(team.currentCoordinatorTaskAttempt()).toBeUndefined();
  });

  it('re-evaluates host task scope when delegate-preferred work falls back to the coordinator', async () => {
    const bus = new MessageBus();
    const fallbackView: TeamView = {
      list: () => routedRoster,
      resolve: (ref) => ({ id: ref }),
      preflightTaskScope: (agentId) => agentId === 'pm'
        ? 'declared path is outside the coordinator configured authority'
        : undefined,
    };
    const tools = new TeamTools('pm', fallbackView, bus, {
      timeoutMs: 1_000,
      taskInputResolver: taskInputResolver(),
    });
    const contract = taskContract({
      effects: {
        read_files: [],
        write_scope: { folder_access: [{ path: 'src', permission: 'readwrite' }] },
        expected_file_effect: 'modify',
      },
      required_capabilities: { version: 1, capabilities: ['write'] },
      execution_strategy: 'delegate-preferred',
    });

    const result = await tools.run('dispatch_task', {
      agent: 'missing-role',
      instruction: 'Make the declared edit.',
      contract,
    });

    expect(result).toMatch(/no-executor.*task-scope.*outside the coordinator configured authority/is);
    expect(result).not.toContain('Coordinator execution is authorised');
    expect(tools.currentCoordinatorTaskAttempt()).toBeUndefined();
    expect(tools.canCoordinatorExecute('write_file')).toBe(false);
  });

  it('re-evaluates capability, sensor, and claim filters when delegate-preferred work falls back to the coordinator', async () => {
    const fallback = async (
      coordinator: TeamRosterEntry,
      contract: Record<string, unknown>,
      options: { claims?: TaskClaimRegistry } = {},
    ) => {
      const team = new TeamTools('pm', {
        list: () => [coordinator],
        resolve: (ref) => ({ id: ref }),
        preflightTaskScope: () => undefined,
      }, new MessageBus(), { timeoutMs: 1_000, taskInputResolver: taskInputResolver(), ...options });
      const result = await team.run('dispatch_task', {
        agent: 'missing-role', instruction: 'Run the declared task.', contract,
      });
      expect(result).toMatch(/task state no-executor/i);
      expect(team.currentCoordinatorTaskAttempt()).toBeUndefined();
      return result;
    };

    const withoutShell: TeamRosterEntry = {
      id: 'pm', role: 'pm', name: 'PM', status: 'running',
      capabilities: {
        read: true, write: true, shell: false, toolFamilies: ['read', 'write', 'delegate'],
        verificationSensors: ['command-exit-zero'], taskScope: 'per-turn',
      },
    };
    await expect(fallback(withoutShell, taskContract({
      required_capabilities: { version: 1, capabilities: ['shell'] },
      execution_strategy: 'delegate-preferred',
    }))).resolves.toMatch(/permissions.*shell/i);

    const withoutRunChecks: TeamRosterEntry = {
      id: 'pm', role: 'pm', name: 'PM', status: 'running',
      capabilities: {
        read: true, write: true, shell: true, toolFamilies: ['read', 'write', 'execute', 'delegate'],
        verificationSensors: ['command-exit-zero'], taskScope: 'per-turn',
      },
    };
    await expect(fallback(withoutRunChecks, taskContract({
      verification_plan: { sensors: ['run-checks'], none_applies: 'report-no-applicable-sensor' },
      execution_strategy: 'delegate-preferred',
    }))).resolves.toMatch(/verification-sensor.*run-checks/i);

    const claims = new TaskClaimRegistry();
    expect(claims.claim('existing-task', 'other-worker', ['src'], 'Existing edit').ok).toBe(true);
    await expect(fallback(routedRoster[0], taskContract({
      effects: {
        read_files: [],
        write_scope: { folder_access: [{ path: 'src', permission: 'readwrite' }] },
        expected_file_effect: 'modify',
      },
      required_capabilities: { version: 1, capabilities: ['write'] },
      execution_strategy: 'delegate-preferred',
    }), { claims })).resolves.toMatch(/file-claim.*existing-task.*other-worker/i);
  });

  it('requires a contract in the model-visible path and contains no prose capability inference fallback', async () => {
    const bus = new MessageBus();
    const tools = new TeamTools('pm', routedView, bus, { timeoutMs: 1_000, taskInputResolver: taskInputResolver() });
    expect(await tools.run('dispatch_task', { agent: 'strong', instruction: 'Please run npm test.' }))
      .toMatch(/required.*object/i);
    const dispatchSchema = tools.specs().find((spec) => spec.function.name === 'dispatch_task')?.function.parameters as any;
    const contractRequired = dispatchSchema.properties.contract.required as string[];
    // Model-visible schema canary: the parser accepts these fields when absent, but that does not
    // prove that the advertised tool schema stopped requiring them. Re-adding any one must fail.
    for (const field of ['expected_deliverable', 'constraints', 'dependencies']) {
      expect(contractRequired).not.toContain(field);
    }
    const writeScopeProperties = dispatchSchema.properties.contract.properties.effects.properties.write_scope.properties;
    expect(writeScopeProperties).toHaveProperty('folder_access');
    expect(writeScopeProperties).not.toHaveProperty('folderAccess');
    const collectSchema = tools.specs().find((spec) => spec.function.name === 'collect_ready_tasks')?.function.parameters as any;
    expect(collectSchema.required).toEqual([]);
    expect(Object.keys(collectSchema.properties)).toEqual(['handles']);
    const source = await import('fs/promises').then(({ readFile }) => readFile(join(process.cwd(), 'src/backend/TeamTools.ts'), 'utf8'));
    expect(source).not.toContain('requestedDelegationCapabilities');
  });
});

describe('TeamTools required-input settlement receipts (W5)', () => {
  const sourceInput = (required: boolean) => taskContract({
    inputs: [{
      input_id: 'source',
      kind: 'workspacePath',
      path: 'src/backend/TeamTools.ts',
      purpose: 'Inspect the declared source.',
      required,
      provenance: { kind: 'workspace', source_refs: ['src/backend/TeamTools.ts'] },
      freshness: 'current',
    }],
    required_capabilities: { version: 1, capabilities: ['read'] },
  });

  it.each(['missing', 'expired', 'outside-task-scope'] as const)(
    'renders a %s context gap without inventing an Unreadable sentence',
    (reason) => {
      const text = formatDelegationEvidence('Partial report.', {
        outcome: 'tool-activity-recorded', completionState: 'partial', changedFiles: [], hadToolActions: true,
        verification: { ran: false, passed: false }, unrecordedWrites: false,
        contextGaps: [{
          attemptId: 'attempt', contractId: 'contract', inputId: 'source', reason,
          purpose: 'Inspect the source.', reportedAt: '2026-08-31T12:00:00.000Z',
        }],
      });
      expect(text).toContain(`input source; reason ${reason}`);
      expect(text).not.toContain('Unreadable');
      expect(text).not.toContain('host observed a read failure');
    },
  );

  async function settle(
    contract: Record<string, unknown>,
    beforeComplete?: (attemptId: string, resolver: TaskInputResolver) => void,
  ) {
    const bus = new MessageBus();
    const resolver = taskInputResolver();
    const evidence: Array<{ outcome: string; evidence: any }> = [];
    const tools = new TeamTools('pm', view, bus, {
      taskInputResolver: resolver,
      evidenceEnabled: true,
      onDelegationEvidence: (event) => evidence.push(event),
    });
    bus.onType('task.assign', (message: Message) => {
      const attemptId = (message.payload.taskAttempt as { attemptId: string }).attemptId;
      beforeComplete?.(attemptId, resolver);
      bus.send('dev', message.from, 'task.complete', {
        instruction: 'Completed the assigned review.',
        // This claims every receipt was read, but W5 must use the resolver instead.
        metadata: { delegationEvidence: {
          hadToolActions: true,
          inputGrants: [{
            attemptId: 'worker-forged', agentId: 'dev', inputId: 'source', kind: 'workspacePath',
            sourceRef: 'src/backend/TeamTools.ts', suppliedAt: '2026-08-30T00:00:00.000Z', readAt: '2026-08-30T00:00:01.000Z',
          }],
        } },
      }, 'normal', message.correlationId);
    });

    await tools.run('dispatch_task', { agent: 'dev', instruction: 'Inspect the declared source.', contract });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(evidence).toHaveLength(1);
    return evidence[0];
  }

  it('records an unread required-input state from host grants even when the worker forges read metadata', async () => {
    const settled = await settle(sourceInput(true));

    expect(settled.outcome).toBe('required-input-read-not-observed');
    expect(settled.evidence).toMatchObject({ requiredInputCount: 1, requiredInputReadNotObservedCount: 1 });
  });

  it('leaves a task with an observed required-input read on its ordinary evidence outcome', async () => {
    const settled = await settle(sourceInput(true), (attemptId, resolver) =>
      resolver.noteWorkspaceRead(attemptId, 'dev', 'src/backend/TeamTools.ts'));

    expect(settled.outcome).toBe('tool-activity-recorded');
    expect(settled.evidence).toMatchObject({ requiredInputCount: 1, requiredInputReadNotObservedCount: 0 });
  });

  it('does not classify optional or zero required inputs as unread-required-input work', async () => {
    const optional = await settle(sourceInput(false));
    const none = await settle(taskContract({ required_capabilities: { version: 1, capabilities: [] } }));

    expect(optional.outcome).toBe('tool-activity-recorded');
    expect(optional.evidence).toMatchObject({ requiredInputCount: 0, requiredInputReadNotObservedCount: 0 });
    expect(none.outcome).toBe('tool-activity-recorded');
    expect(none.evidence).toMatchObject({ requiredInputCount: 0, requiredInputReadNotObservedCount: 0 });
  });

  it('retains separate timeout and late-terminal receipt snapshots with their observation times', async () => {
    vi.useFakeTimers();
    try {
      const bus = new MessageBus();
      const resolver = taskInputResolver();
      const evidence: Array<{ outcome: string; evidence: any }> = [];
      let assignment: Message | undefined;
      let attemptId = '';
      const tools = new TeamTools('pm', view, bus, {
        timeoutMs: 100,
        taskInputResolver: resolver,
        evidenceEnabled: true,
        onDelegationDispatched: (event) => { attemptId = event.attemptId ?? ''; },
        onDelegationEvidence: (event) => evidence.push(event),
      });
      bus.onType('task.assign', (message: Message) => { assignment = message; });

      await tools.run('dispatch_task', {
        agent: 'dev', instruction: 'Inspect the declared source.', contract: sourceInput(true),
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(evidence).toHaveLength(1);
      expect(evidence[0].evidence.receiptSnapshots.timeout).toMatchObject({
        requiredInputCount: 1,
        requiredInputReadNotObservedCount: 1,
        observedAt: expect.any(String),
      });

      await vi.advanceTimersByTimeAsync(1);
      resolver.noteWorkspaceRead(attemptId, 'dev', 'src/backend/TeamTools.ts');
      bus.send('dev', 'pm', 'task.partial', {
        instruction: 'The source was reviewed, but one synthesis step remains.',
        metadata: { completionState: 'partial', unfinishedActivity: 'Finish the synthesis.' },
      }, 'normal', assignment!.correlationId);
      await vi.advanceTimersByTimeAsync(0);

      const late = evidence.at(-1)!;
      expect(late.outcome).toBe('timed-out');
      expect(late.evidence.completionState).toBe('partial');
      expect(late.evidence.receiptSnapshots.timeout).toMatchObject({
        requiredInputCount: 1,
        requiredInputReadNotObservedCount: 1,
        observedAt: expect.any(String),
      });
      expect(late.evidence.receiptSnapshots.terminal).toMatchObject({
        requiredInputCount: 1,
        requiredInputReadNotObservedCount: 0,
        observedAt: expect.any(String),
      });
      expect(late.evidence.receiptSnapshots.terminal.observedAt)
        .not.toBe(late.evidence.receiptSnapshots.timeout.observedAt);
      expect(resolver.isAttemptLive(attemptId, 'dev')).toBe(false);
      tools.consumeAsyncResult(assignment!.correlationId!);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Regression: two teammates share a role → role delegation must SPREAD across them, not pile both
// tasks onto the first match (the "PM sent both tasks to Developer, none to Backend Developer" bug).
describe('TeamTools role-spread (multiple same-role teammates)', () => {
  const twoDevsRoster = [
    { id: 'pm', role: 'pm', name: 'PM', status: 'running' },
    { id: 'dev1', role: 'senior-dev', name: 'Developer', status: 'idle' },
    { id: 'dev2', role: 'senior-dev', name: 'Backend Developer', status: 'idle' },
  ];
  // A naive view.resolve that always returns the FIRST same-role match — the old behavior. The point
  // of these tests is that TeamTools now spreads regardless of how the extension's resolver behaves.
  const twoDevsView: TeamView = {
    list: () => twoDevsRoster,
    resolve: (ref) => {
      if (ref === 'pm') { return { id: 'pm' }; }
      if (ref === 'dev1' || ref === 'dev2') { return { id: ref }; }
      if (ref === 'senior-dev') { return { id: 'dev1' }; } // first match — the trap
      return undefined;
    },
  };

  let bus: MessageBus;
  let team: TeamTools;
  beforeEach(() => {
    bus = new MessageBus();
    team = new TeamTools('pm', twoDevsView, bus, { timeoutMs: 1000 });
  });

  it('round-robins sequential assign_task("role") across same-role teammates', async () => {
    const targets: string[] = [];
    bus.onType('task.assign', (m: Message) => {
      targets.push(String(m.to));
      bus.send(String(m.to), m.from, 'task.complete', { instruction: `done by ${m.to}` }, 'normal', m.correlationId);
    });
    const a = await team.run('assign_task', { agent: 'senior-dev', instruction: 'task A' });
    const b = await team.run('assign_task', { agent: 'senior-dev', instruction: 'task B' });
    expect(targets).toEqual(['dev1', 'dev2']); // not ['dev1','dev1']
    expect(a).toBe('done by dev1');
    expect(b).toBe('done by dev2');
  });

  it('fans parallel assign_task_async("role") out to different teammates', async () => {
    // No responder → both stay in flight; the second must skip the now-busy first match.
    const a = await team.run('assign_task_async', { agent: 'senior-dev', instruction: 'A' });
    const b = await team.run('assign_task_async', { agent: 'senior-dev', instruction: 'B' });
    expect(a).toMatch(/Dispatched to dev1\./);
    expect(b).toMatch(/Dispatched to dev2\./);
  });

  it('resolves a teammate by display name (not just id/role)', async () => {
    bus.onType('task.assign', (m: Message) => {
      bus.send(String(m.to), m.from, 'task.complete', { instruction: `done by ${m.to}` }, 'normal', m.correlationId);
    });
    expect(await team.run('assign_task', { agent: 'Backend Developer', instruction: 'x' })).toBe('done by dev2');
  });

  it('still honors an exact id and never reinterprets it', async () => {
    bus.onType('task.assign', (m: Message) => {
      bus.send(String(m.to), m.from, 'task.complete', { instruction: `done by ${m.to}` }, 'normal', m.correlationId);
    });
    expect(await team.run('assign_task', { agent: 'dev2', instruction: 'x' })).toBe('done by dev2');
  });

  it('keeps a firm retry on the SAME teammate (does not round-robin the retry away)', async () => {
    const targets: string[] = [];
    const attempts = new Map<string, number>();
    bus.onType('task.assign', (m: Message) => {
      const to = String(m.to);
      targets.push(to);
      const n = (attempts.get(to) ?? 0) + 1;
      attempts.set(to, n);
      // dev1's first reply is empty (triggers a firm retry); its retry returns real work.
      const text = to === 'dev1' && n === 1 ? '' : `done by ${to}`;
      bus.send(to, m.from, 'task.complete', { instruction: text }, 'normal', m.correlationId);
    });
    const out = await team.run('assign_task', { agent: 'senior-dev', instruction: 'task A' });
    expect(out).toBe('done by dev1');
    expect(targets).toEqual(['dev1', 'dev1']); // retry stayed on dev1, did not jump to dev2
  });

  it('does not mark a real tool-active delegated reply verified when the coordinator receives no delivery (T4)', async () => {
    const outcomes: string[] = [];
    const evidence = new TeamTools('pm', view, bus, {
      timeoutMs: 1000,
      evidenceEnabled: true,
      onDelegationEvidence: ({ outcome }) => outcomes.push(outcome),
    });
    bus.onType('task.assign', (m: Message) => {
      // The worker genuinely used a tool, but its final result is empty. This is the coordinator's
      // incomplete-delivery case, not a synthetic direct call to the classifier.
      bus.send('dev', m.from, 'task.complete', {
        instruction: '',
        metadata: { delegationEvidence: { hadToolActions: true, changedFiles: [] } },
      }, 'normal', m.correlationId);
    });

    expect(await evidence.run('assign_task', { agent: 'dev', instruction: 'Inspect the data and return the rows.' }))
      .toContain('teammate returned no output');
    expect(outcomes).toEqual(['no-evidence']);
    expect(evidence.takeSettledOutcomes()).toEqual(['no-evidence']);
    // Mutation: restoring the former pure hadToolActions route makes this named test red.
  });

  it('keeps the F2 field payload out of green verified when only tool activity is mechanically recorded (T7)', async () => {
    const outcomes: string[] = [];
    const evidence = new TeamTools('pm', view, bus, {
      timeoutMs: 1000,
      evidenceEnabled: true,
      onDelegationEvidence: ({ outcome }) => outcomes.push(outcome),
    });
    const f2Reply = [
      'search_files /AUDIT_v0943_skills_catalogue_REPORT/',
      'No matches.',
      'F2 was delivered earlier.',
    ].join('\n');
    bus.onType('task.assign', (m: Message) => {
      bus.send('dev', m.from, 'task.complete', {
        instruction: f2Reply,
        metadata: { delegationEvidence: { hadToolActions: true, changedFiles: [] } },
      }, 'normal', m.correlationId);
    });

    const output = await evidence.run('assign_task', { agent: 'dev', instruction: 'Deliver F2 with a table and changed files.' });
    expect(output).toContain('[delegation: tool-activity-recorded]');
    expect(output).toContain('Tool activity was recorded; delivery was not mechanically checked.');
    expect(output).not.toContain('[delegation: verified]');
    expect(outcomes).toEqual(['tool-activity-recorded']);
    expect(evidence.takeSettledOutcomes()).toEqual(['tool-activity-recorded']);
    // Mutation: restoring the former returnedNothing-only green fall-through makes this named field-payload test red.
  });
});

describe('classifyDelegationEvidence (framework-verified, not prose-trusting)', () => {
  const ev = (o: Partial<Parameters<typeof classifyDelegationEvidence>[1]> = {}) =>
    ({ hadToolActions: true, changedFiles: [], verification: { ran: false, passed: false }, unrecordedWrites: false, ...o });

  it('reaches verified for a declared command-exit-zero sensor', () => {
    expect(classifyDelegationEvidence('done', ev({ changedFiles: ['a.ts'], verification: { ran: true, passed: true } })).outcome)
      .toBe('replied-not-verified');
    expect(classifyDelegationEvidence('done', ev({ changedFiles: ['a.ts'], verification: { ran: true, passed: true, source: 'command-exit-zero' } }), commandExitPlan).outcome)
      .toBe('verified');
  });
  it('records read-only research activity without asserting that it was delivered', () => {
    expect(classifyDelegationEvidence('here is what I found', ev()).outcome).toBe('tool-activity-recorded');
  });
  it('does not award verified to an empty-but-tool-active reply the coordinator rejects as incomplete (T4)', () => {
    const verdict = classifyDelegationEvidence('', ev());
    expect(verdict.outcome).not.toBe('verified');
    expect(verdict.outcome).toBe('no-evidence');
    // Mutation: restoring the old pure `hadToolActions` branch makes this named test red.
  });
  it('does not downgrade an honest failure report (negation not read as a pass-claim)', () => {
    expect(classifyDelegationEvidence('the existing tests do not pass on main', ev()).outcome).toBe('tool-activity-recorded');
  });
  it('flags a write with no passing verification', () => {
    expect(classifyDelegationEvidence('done', ev({ changedFiles: ['a.ts'] })).outcome).toBe('replied-not-verified');
  });
  it('flags an unrecorded native write only when not verified', () => {
    expect(classifyDelegationEvidence('done', ev({ unrecordedWrites: true })).outcome).toBe('replied-not-verified');
    expect(classifyDelegationEvidence('done', ev({ unrecordedWrites: true, verification: { ran: true, passed: true, source: 'command-exit-zero' } }), commandExitPlan).outcome)
      .toBe('verified');
  });
  it('records the same host-observed outcome regardless of the reply language', () => {
    expect(classifyDelegationEvidence('测试全部通过', ev()).outcome)
      .toBe(classifyDelegationEvidence('all tests pass', ev()).outcome);
    expect(classifyDelegationEvidence('测试全部通过', ev()).outcome).toBe('tool-activity-recorded');
  });
  it('classifies a reply with no tool actions as no-evidence', () => {
    expect(classifyDelegationEvidence('looks good', ev({ hadToolActions: false })).outcome).toBe('no-evidence');
  });
});

describe('declared command-exit-zero is reachable for ordinary work', () => {
  const ev = (o: Partial<Parameters<typeof classifyDelegationEvidence>[1]> = {}) =>
    ({ hadToolActions: true, changedFiles: [], verification: { ran: false, passed: false }, unrecordedWrites: false, ...o });

  it('a teammate that wrote code and ran its OWN passing test is verified', () => {
    const evidence = ev({
      changedFiles: ['_smoke/app.js', '_smoke/app.test.js'],
      verification: { ran: true, passed: true, command: 'node _smoke/app.test.js', source: 'command-exit-zero' },
    });
    expect(classifyDelegationEvidence('All tests passed', evidence, commandExitPlan).outcome).toBe('verified');
  });

  it('a teammate that wrote code and ran a FAILING test is still not verified', () => {
    const evidence = ev({
      changedFiles: ['_smoke/app.js'],
      verification: { ran: true, passed: false, command: 'node _smoke/app.test.js', source: 'command-exit-zero' },
    });
    expect(classifyDelegationEvidence('done', evidence, commandExitPlan).outcome).toBe('verification-failed');
  });

  it('a teammate that wrote code and ran NO verification is not verified', () => {
    expect(classifyDelegationEvidence('All tests passed', ev({ changedFiles: ['_smoke/app.js'] })).outcome)
      .toBe('replied-not-verified');
  });
});
