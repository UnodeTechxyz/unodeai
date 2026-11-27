/*---------------------------------------------------------------------------------------------
 * The user's stop-all brake in a real extension host.
 *
 * `cancel_task` intentionally excludes a solo agent because a coordinator has no authority over it. The
 * status-bar/command brake is the user's authority and must stop that solo as well as every teammate.
 * This test proves an observed running solo becomes stopped; it does not mistake a successful command
 * return for a successful stop.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as vscode from 'vscode';

const EXT_ID = 'unode.unodeai';

interface AgentLike { id: string; name: string; role: string; status: string }
interface ObserveResult { agents: AgentLike[] }
type RequestSummaryProbe = (fixture: { e2e: true }, agentId: string) => {
  records: Array<{ recordId: string; terminal: string; revision: number }>;
  cards: Array<{ recordId: string; state: string }>;
};
let coordinator: AgentLike;

describe('UnodeAi user brake (stop all)', () => {
  let roster: AgentLike[] = [];
  let solo: AgentLike;

  before(async function () {
    this.timeout(60_000);
    await vscode.extensions.getExtension(EXT_ID)?.activate();
    await clearRoster();
    await vscode.commands.executeCommand('unode.setApiKey', { e2e: true });
    roster = await createDefaultTeam();
    coordinator = requireAgent(roster, (agent) => /manager|coordinator/i.test(agent.role) || /manager/i.test(agent.name), 'Project Manager');
    solo = await createSolo();
    roster = [...roster, solo];
  });

  after(async function () {
    this.timeout(30_000);
    await clearRoster();
    await vscode.commands.executeCommand('unode.setApiKey', { e2e: true, clear: true });
  });

  it('stops a live solo agent and every live teammate', async function () {
    this.timeout(60_000);
    for (const agent of roster) {
      await vscode.commands.executeCommand('unode.agentStart', agent.id);
    }

    const ATTEMPTS = 5;
    let before: AgentLike[] = [];
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      for (const agent of roster) {
        await vscode.commands.executeCommand('unode.sendMessage', {
          targetId: agent.id,
          instruction: `E2E user-brake probe ${attempt}: stay busy.`,
        });
      }
      before = await waitForObservedRoster(
        (agents) => agents.some((agent) => agent.id === solo.id && agent.status === 'running'),
      );
      if (before.length > 0) { break; }
    }

    const liveSolo = before.find((agent) => agent.id === solo.id);
    assert.strictEqual(liveSolo?.status, 'running', 'the Solo agent was never observed running; the brake was not exercised');
    const liveBeforeStop = before.filter((agent) => agent.status === 'running');
    assert.ok(liveBeforeStop.length > 0, 'need an observed running agent before exercising stop-all');

    const after = await vscode.commands.executeCommand<AgentLike[]>('unode.stopAllAgents', { e2e: true }) ?? [];
    for (const agent of liveBeforeStop) {
      const settled = after.find((candidate) => candidate.id === agent.id);
      assert.ok(settled, `${agent.name} disappeared from the roster instead of being stopped`);
      assert.strictEqual(settled.status, 'stopped', `${agent.name} was running before the user brake and did not stop`);
    }
    const stoppedSolo = after.find((agent) => agent.id === solo.id);
    assert.strictEqual(stoppedSolo?.status, 'stopped', 'the user brake must stop Solo even though cancel_task cannot');
  });

  // v0.9.94: the turn that the brake just stopped is a top-level turn that ended. The activated extension must
  // have frozen one request closeout record for it, kept it, and given it one Request summary card in Chat.
  it('leaves one Request summary for every turn of the Solo agent that ended, the stopped one included', async function () {
    this.timeout(30_000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    const probe = (ext!.exports as { __testRequestSummaries?: RequestSummaryProbe }).__testRequestSummaries;
    assert.strictEqual(typeof probe, 'function', 'the extension must expose the request summary probe in Test mode');

    let seen = probe!({ e2e: true }, solo.id);
    const deadline = Date.now() + 10_000;
    // The store writes behind the event; the card follows the store.
    while (Date.now() < deadline
      && !(seen.records.some((record) => record.terminal === 'stopped') && seen.cards.length === seen.records.length)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      seen = probe!({ e2e: true }, solo.id);
    }
    console.log(`[request-summary-probe] ${JSON.stringify(seen)}`);

    const stopped = seen.records.filter((record) => record.terminal === 'stopped');
    assert.strictEqual(stopped.length, 1, 'the one turn the brake stopped must have exactly one closeout record');
    assert.strictEqual(new Set(seen.records.map((record) => record.recordId)).size, seen.records.length, 'a turn has one record');
    assert.deepStrictEqual(
      seen.cards.map((card) => card.recordId).sort(),
      seen.records.map((record) => record.recordId).sort(),
      'every ended turn of a solo agent shows one Request summary, and nothing else shows one',
    );
    const card = seen.cards.find((candidate) => candidate.recordId === stopped[0].recordId);
    assert.strictEqual(card?.state, 'stopped', 'the stopped turn reads Stopped, from the host record and not from any reply');
  });
});

async function waitForObservedRoster(predicate: (agents: AgentLike[]) => boolean): Promise<AgentLike[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const observed = await observeRoster();
    if (predicate(observed)) { return observed; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return [];
}

async function observeRoster(): Promise<AgentLike[]> {
  const observed = await vscode.commands.executeCommand<ObserveResult>('unode.coordinatorCancelTask', {
    e2e: true,
    coordinatorId: coordinator.id,
    observe: true,
  });
  assert.ok(observed, 'the test-only read-only roster observation must return a snapshot');
  return observed.agents;
}

async function createDefaultTeam(): Promise<AgentLike[]> {
  const originalInfo = vscode.window.showInformationMessage;
  const originalWarning = vscode.window.showWarningMessage;
  try {
    (vscode.window as any).showInformationMessage = async () => undefined;
    (vscode.window as any).showWarningMessage = async (_message: string, ...args: unknown[]) => {
      const items = args.filter((item): item is string => typeof item === 'string');
      return items.includes('Add') ? 'Add' : undefined;
    };
    const created = await vscode.commands.executeCommand<AgentLike[]>('unode.createDefaultTeam', { e2e: true });
    assert.ok(Array.isArray(created) && created.length > 1, 'createDefaultTeam should produce a crew');
    return created;
  } finally {
    (vscode.window as any).showInformationMessage = originalInfo;
    (vscode.window as any).showWarningMessage = originalWarning;
  }
}

async function createSolo(): Promise<AgentLike> {
  const originalQuickPick = vscode.window.showQuickPick;
  try {
    (vscode.window as any).showQuickPick = async (items: readonly unknown[]) => items[0];
    const created = await vscode.commands.executeCommand<AgentLike>('unode.startSolo');
    assert.ok(created, 'startSolo should create a standalone agent');
    assert.strictEqual(created.role, 'solo', 'startSolo must create the standalone Solo role');
    return created;
  } finally {
    (vscode.window as any).showQuickPick = originalQuickPick;
  }
}

async function clearRoster(): Promise<void> {
  const agents = await vscode.commands.executeCommand<AgentLike[]>('unode.stopAllAgents', { e2e: true }) ?? [];
  for (const agent of agents) {
    await vscode.commands.executeCommand('unode.agentRemove', agent.id);
  }
  const remaining = await vscode.commands.executeCommand<AgentLike[]>('unode.stopAllAgents', { e2e: true }) ?? [];
  assert.strictEqual(remaining.length, 0, 'stop-all E2E suite must not leave a roster behind');
}

function requireAgent(agents: AgentLike[], predicate: (agent: AgentLike) => boolean, label: string): AgentLike {
  const agent = agents.find(predicate);
  assert.ok(agent, `${label} should exist`);
  return agent;
}
