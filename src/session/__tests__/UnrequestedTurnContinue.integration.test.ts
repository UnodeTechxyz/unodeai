/*
 * v0.9.103 (F2, the Owner's option A): the composed Continue flow for a turn a Claude CLI began on its own.
 *
 * MODULE INTEGRATION, NOT ACTIVATION EVIDENCE. Nothing here runs activate(). The wiring between the modules is the few
 * lines activation has: SessionManager's `session.unrequestedTurn` goes to UnrequestedTurnOffers.offer, and Continue's
 * `sendPersonMessage` submits through the UserRequestEntrance chat Send ends in (`submit(agentId, 'ask.question', ...)`).
 *
 * Real: SessionManager, MessageBus, UserRequestEntrance, UnrequestedTurnOffers, and the production ClaudeHeadlessBackend
 * with a fake process (deps.spawn) fed the native probe's sequence (ids rewritten). Its PreToolUse gate is called as the
 * CLI's hook calls it; the command policy is `all`. The offer's `show` is a fake that resolves `Continue`.
 */
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeHeadlessBackend } from '../../backend/ClaudeHeadlessBackend';
import { CommandPolicy } from '../../backend/CommandPolicy';
import { MessageBus } from '../../bus/MessageBus';
import { UserRequestEntrance } from '../../host/UserRequestEntrance';
import { CONTINUE_ACTION, UnrequestedTurnOffers, continueMessageText } from '../../host/unrequestedTurnOffer';
import type { LocalJsonEndpoint, LocalMcpServer, LocalMcpTool } from '../../mcp/LocalMcpServer';
import type { AgentConfig, Message } from '../../types';
import { SessionManager, type SpendSessionPort } from '../SessionManager';
import { PROBE_SUMMARY, probeCli, probeTask } from '../../backend/__tests__/claudeBackgroundWakeTrace';

const REQUEST_ENDED = 'The request ended before this command. Nothing was run.';
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0)); };

type FakeServer = LocalMcpServer & { localTools: LocalMcpTool[]; jsonEndpoints: LocalJsonEndpoint[] };

function fakeLocalServer(): FakeServer {
  return {
    port: 48123, token: 'test-token', localTools: [], jsonEndpoints: [],
    addLocalTool(tool) { this.localTools.push(tool); },
    addJsonEndpoint(endpoint) { this.jsonEndpoints.push(endpoint); },
    observeToolOutcomes() { /* not read here */ },
    async start() { /* nothing listens */ },
    async stop() { /* nothing to close */ },
  } as FakeServer;
}

interface FakeCli { proc: any; packets: any[] }

function fakeClaudeSpawn() {
  const clis: FakeCli[] = [];
  const fn = () => {
    const proc = new EventEmitter() as any;
    const cli: FakeCli = { proc, packets: [] };
    proc.pid = 6160;
    proc.exitCode = null;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdout.setEncoding = () => undefined;
    proc.stderr.setEncoding = () => undefined;
    proc.stdin = {
      write: (text: string) => {
        for (const line of String(text).split('\n')) if (line.trim()) cli.packets.push(JSON.parse(line));
        return true;
      },
      end: () => undefined,
    };
    proc.kill = () => { if (proc.exitCode === null) { proc.exitCode = 0; proc.emit('exit', 0); } return true; };
    clis.push(cli);
    setTimeout(() => proc.emit('spawn'), 0);
    return proc;
  };
  return { fn, clis };
}

function devConfig(dir: string): AgentConfig {
  return {
    id: 'dev', name: 'Dev', role: 'developer', skill: '', provider: { providerId: 'anthropic', apiKeySecretName: 'ANTHROPIC_API_KEY' },
    model: 'claude-haiku-5-5', systemPrompt: 'Follow the role.', autoApprove: true, allowedTools: ['read', 'write', 'execute'],
    backend: 'claude', workingDirectory: dir,
  };
}

interface Flow {
  dir: string;
  bus: MessageBus;
  mgr: SessionManager;
  spawn: ReturnType<typeof fakeClaudeSpawn>;
  gates: FakeServer[];
  entrance: UserRequestEntrance;
  shown: Array<{ text: string; action: string }>;
  informed: string[];
  begun: number[];
  unrequested: Array<{ phase: string; launchId: string; taskId?: string; summary?: string }>;
  /** Each usage unit the session opened, with its request and the cost it settled with. */
  units: Map<string, { requestId: string; costUsd?: number; settled: boolean }>;
}

/** A spend port that records which request each unit belongs to and what it settled with. */
function recordingSpend(units: Flow['units']): SpendSessionPort {
  return {
    beginRequest: () => undefined,
    beginUsageUnit: (unit) => { units.set(unit.usageUnitId, { requestId: unit.requestId, settled: false }); },
    noteModelRequest: () => undefined,
    noteUsageProgress: () => undefined,
    settleUsageUnit: (usageUnitId, usage) => {
      const unit = units.get(usageUnitId);
      if (unit) { unit.settled = true; unit.costUsd = usage?.costUsd; }
      return usage?.costUsd !== undefined ? { costUsd: usage.costUsd, costBasis: usage.costBasis } : undefined;
    },
    closeUsageUnit: (usageUnitId) => { const unit = units.get(usageUnitId); if (unit) unit.settled = true; },
  };
}
const flows: Flow[] = [];

afterEach(async () => {
  for (const flow of flows.splice(0)) {
    await flow.mgr.stopAll().catch(() => undefined);
    flow.bus.dispose();
    await fs.rm(flow.dir, { recursive: true, force: true });
  }
});

/** `choice`: what the person picks in the offer; null dismisses it. */
async function flow(choice: string | null = CONTINUE_ACTION): Promise<Flow> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'unode-wake-continue-')));
  const bus = new MessageBus();
  const spawn = fakeClaudeSpawn();
  const gates: FakeServer[] = [];
  const units: Flow['units'] = new Map();
  const mgr = new SessionManager(5, bus, {
    spend: recordingSpend(units),
    createBackend: (agent) => new ClaudeHeadlessBackend(agent, undefined, undefined, {
      spawn: spawn.fn as any,
      toolGateServerFactory: () => { const gate = fakeLocalServer(); gates.push(gate); return gate; },
      toolBridgeServerFactory: () => fakeLocalServer(),
      localMcpServerFactory: () => fakeLocalServer(),
      messageBus: bus,
      commandPermission: { policy: new CommandPolicy('all') },
    }),
    resolveEnv: async () => ({ PATH: 'safe' }),
  });
  const begun: number[] = [];
  // As activation builds it: the one entrance chat Send ends in.
  const entrance = new UserRequestEntrance({
    beginUserRequest: () => { begun.push(Date.now()); },
    bus,
    agents: {
      has: (agentId) => mgr.get(agentId) !== undefined,
      isRunning: (agentId) => mgr.isRunning(agentId),
      start: (agentId) => mgr.start(agentId, { pin: 'reuse' }),
    },
  });
  const shown: Array<{ text: string; action: string }> = [];
  const informed: string[] = [];
  // As activation wires it (extension.ts), with a fake showInformationMessage that chooses Continue.
  const offers = new UnrequestedTurnOffers({
    show: async (text, action) => { shown.push({ text, action }); return choice ?? undefined; },
    inform: (text) => { informed.push(text); },
    agentName: (sessionId) => mgr.get(sessionId)?.config.name,
    isCurrentLaunch: (sessionId, launchId) => mgr.isCurrentBackendLaunch(sessionId, launchId),
    sendPersonMessage: (sessionId, text) => { entrance.submit(sessionId, 'ask.question', { instruction: text, mode: 'act' }); },
  });
  const unrequested: Flow['unrequested'] = [];
  mgr.on('session.unrequestedTurn', (e) => {
    unrequested.push({ ...e.data });
    if (e.sessionId && e.data.phase === 'started') {
      offers.offer({ sessionId: e.sessionId, launchId: e.data.launchId,
        ...(e.data.taskId ? { taskId: e.data.taskId } : {}), ...(e.data.summary ? { summary: e.data.summary } : {}) });
    }
  });
  mgr.create(devConfig(dir));
  await mgr.start('dev', { pin: 'take' });
  await vi.waitFor(() => expect(mgr.get('dev')?.status).toBe('idle'));
  const f: Flow = { dir, bus, mgr, spawn, gates, entrance, shown, informed, begun, unrequested, units };
  flows.push(f);
  return f;
}

function cliOf(f: Flow): FakeCli {
  expect(f.spawn.clis).toHaveLength(1);
  return f.spawn.clis[0];
}

async function feed(f: Flow, ...lines: unknown[]): Promise<void> {
  const cli = cliOf(f);
  for (const line of lines) cli.proc.stdout.emit('data', `${JSON.stringify(line)}\n`);
  await (f.mgr.getBackend?.('dev') as any)?.eventChain;
  await tick();
}

function hook(f: Flow, toolName: string, input: Record<string, unknown>, toolUseId: string): Promise<{ allow: boolean; reason?: string }> {
  expect(f.gates).toHaveLength(1);
  const route = f.gates[0].jsonEndpoints.find((endpoint) => endpoint.path === '/gate')!;
  return route.handler({ tool_name: toolName, tool_input: input, tool_use_id: toolUseId }) as Promise<{ allow: boolean; reason?: string }>;
}

/** The terminal messages the session published to the person for request `requestId`. */
function terminalsFor(f: Flow, request: Message): Message[] {
  return f.bus.query().filter((message) => message.from === 'dev' && message.to === 'user'
    && (message.correlationId === request.id || message.correlationId === request.correlationId));
}

function textOf(packet: any): string {
  const content = packet.message.content;
  return typeof content === 'string' ? content : content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
}

describe('module integration, not activation evidence: Continue after a Claude CLI turn nobody requested (v0.9.103 F2)', () => {
  it('the request, its result, the background completion and wake, one offer, Continue held until the CLI reads it, a shell call through the gate, and the request\'s own result', async () => {
    const f = await flow();
    const cli = probeCli('s-flow-1');
    const task = probeTask('flow1');

    // 1. The person's first request, through the entrance chat Send uses.
    const first = f.entrance.submit('dev', 'ask.question', { instruction: 'Start the background job, flow-1.', mode: 'act' });
    await vi.waitFor(() => expect(cliOf(f).packets).toHaveLength(1));
    const firstPacket = cliOf(f).packets[0];
    expect(textOf(firstPacket)).toContain('Start the background job, flow-1.');

    // 2. Its CLI turn, as the probe recorded it, and its result.
    await feed(f, ...cli.backgroundTurn(firstPacket.uuid, firstPacket.message.content, task, 'STARTED flow-1'));
    await vi.waitFor(() => expect(terminalsFor(f, first)).toHaveLength(1));
    expect(terminalsFor(f, first)[0].payload.instruction).toBe('STARTED flow-1');
    await vi.waitFor(() => expect(f.mgr.get('dev')?.status).toBe('idle'));

    // 3. The background task finishes and the CLI begins its own turn.
    await feed(f, ...cli.finishes(task));
    expect(f.shown).toEqual([]);
    await feed(f, ...cli.wakeStarts());
    expect(f.unrequested).toEqual([{ phase: 'started', launchId: expect.any(String), taskId: task.taskId, summary: PROBE_SUMMARY }]);
    expect(f.mgr.isCurrentBackendLaunch('dev', f.unrequested[0].launchId)).toBe(true);

    // 4. One non-modal offer, naming the agent and the summary, with Continue.
    await vi.waitFor(() => expect(f.shown).toHaveLength(1));
    expect(f.shown[0]).toEqual({ text: expect.stringMatching(/^Dev: something it started in the background finished after your request ended/), action: 'Continue' });
    expect(f.shown[0].text).toContain(PROBE_SUMMARY);

    // 5. Continue: one ordinary message of the person, through the entrance.
    await vi.waitFor(() => expect(cliOf(f).packets).toHaveLength(2));
    const continuePacket = cliOf(f).packets[1];
    expect(textOf(continuePacket)).toContain(continueMessageText(PROBE_SUMMARY));
    expect(f.begun).toHaveLength(2);
    const continued = f.bus.query({ type: 'ask.question' }).filter((message) => message.from === 'user' && message.to === 'dev');
    expect(continued).toHaveLength(2);
    expect(continued[1].payload.instruction).toBe(continueMessageText(PROBE_SUMMARY));
    expect(f.informed).toEqual([]);

    // 6. Held: written to the CLI, not opened. The wake's own shell call is refused and its result completes nothing.
    await feed(f, cli.lifecycle(continuePacket.uuid, 'queued'));
    await feed(f, cli.bash('toolu_wake_flow1', 'echo wake-flow-1', 'Run echo wake-flow-1'));
    expect(await hook(f, 'Bash', { command: 'echo wake-flow-1' }, 'toolu_wake_flow1')).toEqual({ allow: false, reason: REQUEST_ENDED });
    await feed(f, cli.toolResult('toolu_wake_flow1', REQUEST_ENDED, true), ...cli.wakeReplies('The background command finished, flow-1.'),
      cli.wakeEnds('The background command finished, flow-1.', task, 0.0003));
    expect(f.unrequested.map((entry) => entry.phase)).toEqual(['started', 'ended']);
    expect(terminalsFor(f, continued[1])).toEqual([]);
    expect(terminalsFor(f, first)).toHaveLength(1);

    // The CLI reads the Continue packet: the request opens.
    await feed(f, ...cli.reads(continuePacket.uuid, continuePacket.message.content));

    // 7. A shell call through the real command gate, allowed by policy.
    await feed(f, cli.bash('toolu_req_flow1', 'echo request-flow-1', 'Run echo request-flow-1'));
    expect(await hook(f, 'Bash', { command: 'echo request-flow-1' }, 'toolu_req_flow1')).toEqual({ allow: true });
    await feed(f, cli.toolResult('toolu_req_flow1', 'request-flow-1'), cli.text('Checked the result, flow-1.'));
    expect(terminalsFor(f, continued[1])).toEqual([]);

    // 8. The request's own final result: exactly one terminal for it.
    await feed(f, cli.result('Checked the result, flow-1.', { userMessageUuid: continuePacket.uuid, cost: 0.0007 }), cli.lifecycle(continuePacket.uuid, 'completed'));
    await vi.waitFor(() => expect(terminalsFor(f, continued[1])).toHaveLength(1));
    await tick();
    expect(terminalsFor(f, continued[1])).toHaveLength(1);
    expect(terminalsFor(f, continued[1])[0].payload.instruction).toBe('Checked the result, flow-1.');
    // §4.4: the wake ran wholly before the read, so nothing of it is the request's. Its refused shell call is not
    // counted in the Continue request's outcome (the field-test sub-agent observed total 2 / refused 1 before the fix).
    expect(terminalsFor(f, continued[1])[0].payload.metadata.turnOutcome.tools).toMatchObject({ total: 1, refused: 0 });
    // Codex's audit of 6b332fa3, finding 1 (the Owner: its own receipt). Process totals 0.0005, 0.0008, 0.0015: the
    // Continue request reports and is charged only its own 0.0007; the wake's 0.0003 is a unit of the first request.
    expect(terminalsFor(f, continued[1])[0].payload.metadata.usage.costUsd).toBeCloseTo(0.0007, 10);
    // In opening order: the first request's turn, the Continue's turn (opened when its packet was written), the wake.
    const units = [...f.units.entries()].map(([id, unit]) => ({ id, ...unit }));
    expect(units).toHaveLength(3);
    const [firstUnit, continueUnit, wakeUnit] = units;
    expect(firstUnit.costUsd).toBeCloseTo(0.0005, 10);
    expect(wakeUnit).toMatchObject({ id: expect.stringMatching(/^wake:/), requestId: firstUnit.requestId, settled: true });
    expect(wakeUnit.costUsd).toBeCloseTo(0.0003, 10);
    expect(continueUnit.requestId).not.toBe(firstUnit.requestId);
    expect(continueUnit.costUsd).toBeCloseTo(0.0007, 10);
    expect(terminalsFor(f, first)).toHaveLength(1);
    expect(f.shown).toHaveLength(1);
    expect(cliOf(f).packets).toHaveLength(2);
    expect(f.mgr.get('dev')?.status).toBe('idle');
  });

  // Codex's audit of 6b332fa3, finding 1 (the Owner: its own receipt). The person's request is sent after the
  // notification and before the wake's init, so it is the session's request in flight while the whole wake runs.
  it('a request sent before the wake began: the wake is a unit of the request before it, and the sent request is charged only its own cost', async () => {
    const f = await flow(null);
    const cli = probeCli('s-flow-cost');
    const task = probeTask('flowcost');
    const first = f.entrance.submit('dev', 'ask.question', { instruction: 'Start the background job, flow-cost.', mode: 'act' });
    await vi.waitFor(() => expect(cliOf(f).packets).toHaveLength(1));
    const firstPacket = cliOf(f).packets[0];
    await feed(f, ...cli.backgroundTurn(firstPacket.uuid, firstPacket.message.content, task, 'STARTED flow-cost'));
    await vi.waitFor(() => expect(terminalsFor(f, first)).toHaveLength(1));
    await vi.waitFor(() => expect(f.mgr.get('dev')?.status).toBe('idle'));

    await feed(f, ...cli.finishes(task));
    const second = f.entrance.submit('dev', 'ask.question', { instruction: 'Look at the job, flow-cost.', mode: 'act' });
    await vi.waitFor(() => expect(cliOf(f).packets).toHaveLength(2));
    const secondPacket = cliOf(f).packets[1];
    await feed(f, ...cli.wakeStarts());
    expect(f.unrequested.map((entry) => entry.phase)).toEqual(['started']);
    await feed(f, ...cli.wakeReplies('The job finished, flow-cost.'), cli.wakeEnds('The job finished, flow-cost.', task, 0.0003));
    expect(f.unrequested.map((entry) => entry.phase)).toEqual(['started', 'ended']);
    expect(terminalsFor(f, second)).toEqual([]);

    await feed(f, ...cli.reads(secondPacket.uuid, secondPacket.message.content), cli.text('Looked, flow-cost.'),
      cli.result('Looked, flow-cost.', { userMessageUuid: secondPacket.uuid, cost: 0.0007 }));
    await vi.waitFor(() => expect(terminalsFor(f, second)).toHaveLength(1));
    expect(terminalsFor(f, second)[0].payload.metadata.usage.costUsd).toBeCloseTo(0.0007, 10);
    const units = [...f.units.entries()].map(([id, unit]) => ({ id, ...unit }));
    expect(units).toHaveLength(3);
    const [firstUnit, secondUnit, wakeUnit] = units;
    expect(wakeUnit).toMatchObject({ id: expect.stringMatching(/^wake:/), requestId: firstUnit.requestId, settled: true });
    expect(wakeUnit.costUsd).toBeCloseTo(0.0003, 10);
    expect(secondUnit.requestId).not.toBe(firstUnit.requestId);
    expect(secondUnit.costUsd).toBeCloseTo(0.0007, 10);
    expect(f.shown).toHaveLength(1);
    expect(f.begun).toHaveLength(2);
  });

  it('5e: the process exits while the Continue request is held: exactly one failure outcome, through SessionManager\'s exit branch', async () => {
    const f = await flow();
    const cli = probeCli('s-flow-5e');
    const task = probeTask('flow5e');
    const first = f.entrance.submit('dev', 'ask.question', { instruction: 'Start the background job, flow-5e.', mode: 'act' });
    await vi.waitFor(() => expect(cliOf(f).packets).toHaveLength(1));
    const firstPacket = cliOf(f).packets[0];
    await feed(f, ...cli.backgroundTurn(firstPacket.uuid, firstPacket.message.content, task, 'STARTED flow-5e'));
    await vi.waitFor(() => expect(terminalsFor(f, first)).toHaveLength(1));

    await feed(f, ...cli.finishes(task), ...cli.wakeStarts());
    await vi.waitFor(() => expect(cliOf(f).packets).toHaveLength(2));
    const continued = f.bus.query({ type: 'ask.question' }).filter((message) => message.from === 'user' && message.to === 'dev');
    expect(continued).toHaveLength(2);
    expect(terminalsFor(f, continued[1])).toEqual([]);
    const backend = f.mgr.getBackend?.('dev') as any;
    expect(backend.heldRequest).toBeDefined();

    // The CLI dies before it reads the Continue packet.
    const proc = cliOf(f).proc;
    proc.exitCode = 1;
    proc.emit('exit', 1);
    await vi.waitFor(() => expect(f.mgr.get('dev')?.status).toBe('stopped'));
    await tick();
    const terminals = terminalsFor(f, continued[1]);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ type: 'system.error', payload: { metadata: { isError: true, interrupted: true, interruptionReason: 'worker-lost' } } });
    expect(backend.heldRequest).toBeUndefined();
    expect(backend.pendingWake).toBeUndefined();
    expect(backend.unrequestedTurn).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(terminalsFor(f, continued[1])).toHaveLength(1);
    expect(terminalsFor(f, first)).toHaveLength(1);
  });
});
