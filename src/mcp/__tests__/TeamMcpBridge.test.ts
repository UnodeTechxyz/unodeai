import { describe, it, expect } from 'vitest';
import { TeamMcpBridge, TeamToolset } from '../TeamMcpBridge';
import { ToolSpec } from '../../backend/WorkspaceTools';
import { TeamTools, TeamView } from '../../backend/TeamTools';
import { MessageBus } from '../../bus/MessageBus';
import { Message } from '../../types';

function fakeTeam(): TeamToolset & { calls: Array<[string, unknown]> } {
  const specs: ToolSpec[] = [
    { type: 'function', function: { name: 'list_agents', description: 'see the team', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'dispatch_task', description: 'delegate without waiting', parameters: { type: 'object', properties: { agent: { type: 'string' } } } } },
    { type: 'function', function: { name: 'collect_ready_tasks', description: 'collect settled work', parameters: { type: 'object', properties: {} } } },
  ];
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    specs: () => specs,
    has: (n) => n === 'list_agents' || n === 'dispatch_task' || n === 'assign_task_async' || n === 'collect_ready_tasks',
    run: async (n, a) => { calls.push([n, a]); return `ran ${n}`; },
  };
}

describe('TeamMcpBridge (P2#12 core)', () => {
  it('maps team tool specs to MCP tool defs', async () => {
    const bridge = new TeamMcpBridge(fakeTeam());
    const tools = await bridge.listTools();
    expect(tools.map((t) => t.name)).toEqual(['list_agents', 'dispatch_task', 'collect_ready_tasks']);
    expect(tools[1]).toMatchObject({ description: 'delegate without waiting' });
    expect(tools[1].inputSchema).toMatchObject({ type: 'object' });
  });

  it('maps the legacy blocking name to the non-blocking runtime tool', async () => {
    const team = fakeTeam();
    const bridge = new TeamMcpBridge(team);
    const out = await bridge.callTool('assign_task', { agent: 'dev', instruction: 'go' });
    expect(out).toContain('ran assign_task_async');
    expect(team.calls).toEqual([['assign_task_async', { agent: 'dev', instruction: 'go' }]]);
  });

  it('preserves a framework evidence verdict for a Claude PM using the bridge', async () => {
    const bus = new MessageBus();
    const view: TeamView = {
      list: () => [
        { id: 'pm', role: 'pm', name: 'PM', status: 'idle' },
        { id: 'dev', role: 'senior-dev', name: 'Developer', status: 'idle', capabilities: { read: true, write: true, shell: true, verificationSensors: ['run-checks'], toolFamilies: ['execute'] } },
      ],
      resolve: (ref) => ref === 'dev' ? { id: 'dev' } : undefined,
    };
    const team = new TeamTools('pm', view, bus, { timeoutMs: 1000, evidenceEnabled: true });
    bus.onType('task.assign', (m: Message) => {
      bus.send('dev', m.from, 'task.complete', {
        instruction: 'Implemented it.',
        metadata: { delegationEvidence: { hadToolActions: true, changedFiles: ['src/feature.ts'], verification: { ran: true, passed: true, source: 'run-checks' } } },
      }, 'normal', m.correlationId);
    });

    const bridge = new TeamMcpBridge(team);
    await bridge.callTool('assign_task', { agent: 'dev', instruction: 'implement feature', verification_plan: { sensors: ['run-checks'], none_applies: 'report-no-applicable-sensor' } });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const out = await bridge.callTool('collect_ready_tasks', {});
    expect(out).toContain('[delegation: verified]');
    expect(out).toContain('[orchestration]');
    bus.dispose();
  });

  it('returns an error string for an unknown tool (never throws)', async () => {
    const bridge = new TeamMcpBridge(fakeTeam());
    expect(await bridge.callTool('nope', {})).toContain('unknown team tool');
  });

  it('carries a host-published content receipt through the MCP bridge', async () => {
    const bus = new MessageBus();
    const team = new TeamTools('pm', {
      list: () => [{ id: 'pm', role: 'pm', name: 'PM', status: 'idle' }],
      resolve: () => undefined,
    }, bus);
    const bridge = new TeamMcpBridge(team);
    bridge.beginTurnContentReceipts();
    const receipt = bridge.registerTurnContentReceipt('A\r\nB');
    expect(receipt?.id).toMatch(/^receipt-/);

    expect(await bridge.callTool('publish_content_receipt', {
      receipt_id: receipt?.id,
      state: 'shown',
      framing: 'Here it is:',
    })).toContain('publishing receipt');
    expect(bridge.hasPendingTurnDelivery()).toBe(true);
    expect(bridge.takePublishedTurnDelivery()).toMatchObject({
      state: 'shown',
      receiptId: receipt?.id,
      text: 'Here it is:\n\nA\r\nB',
    });
    bus.dispose();
  });

  it('cancels pending team delegations when closed', async () => {
    let reason = '';
    const bridge = new TeamMcpBridge({
      ...fakeTeam(),
      cancelPending: (r) => {
        reason = r ?? '';
        return 1;
      },
    });

    await bridge.close();

    expect(reason).toMatch(/bridge shutdown/);
  });
});

describe('orchestration notes must yield to the user', () => {
  // Field report: once a user's mid-turn message could actually REACH a busy PM (it used to be silently
  // dropped), the PM received "先别管那个任务" from the user AND "continue the plan" from the orchestration
  // note in the same breath, and oscillated — it said so itself: "The orchestrator is nudging me to resume,
  // but I'll follow your lead." The user is the authority; the note must say so out loud.
  it('tells the coordinator that the user outranks the continuation note', async () => {
    const bridge = new TeamMcpBridge(fakeTeam());

    const out = await bridge.callTool('collect_ready_tasks', {});

    expect(out).toContain('[orchestration]');
    expect(out).toMatch(/THE USER OVERRIDES THIS/);
    expect(out).toMatch(/do not resume the plan/i);
  });
});
