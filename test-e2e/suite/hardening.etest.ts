import * as assert from 'assert';
import * as vscode from 'vscode';

const EXT_ID = 'unode.unodeai';

interface AgentLike {
  id: string;
  role: string;
  name: string;
  status?: string;
  pendingStart?: boolean;
}

interface MessageLike {
  from: string;
  to: string;
  type: string;
  payload?: { instruction?: string };
}

describe('UnodeAi routing and concurrency', () => {
  let originalGlobalConcurrencyLimit: number | undefined;
  let globalConcurrencyLimitCaptured = false;
  let team: AgentLike[] = [];

  before(async function () {
    this.timeout(30_000);
    await vscode.extensions.getExtension(EXT_ID)?.activate();
    // A crashed earlier run can leave a roster even when it did not reach its cleanup hook. Start
    // from the suite's defined fixture rather than waiting on createDefaultTeam's interactive
    // "Add anyway?" prompt; the after hook still proves this suite leaves no roster behind.
    await clearRoster();
    originalGlobalConcurrencyLimit = globalConcurrencyLimit();
    globalConcurrencyLimitCaptured = true;
    team = await createDefaultTeam();
  });

  // Mocha runs this hook after a timed-out test. Keep cleanup outside the test body: a
  // `finally` is not reached when Mocha abandons an unresolved await at its timeout.
  afterEach(async function () {
    this.timeout(30_000);
    assert.ok(globalConcurrencyLimitCaptured, 'global setting must be snapshotted before a test can mutate it');
    await vscode.commands.executeCommand('unode.stopAllAgents', { e2e: true });
    await restoreGlobalConcurrencyLimit(originalGlobalConcurrencyLimit);
    assert.strictEqual(
      globalConcurrencyLimit(),
      originalGlobalConcurrencyLimit,
      'each test must restore the global maxConcurrentAgents setting'
    );
  });

  after(async function () {
    this.timeout(60_000);
    if (globalConcurrencyLimitCaptured) {
      await restoreGlobalConcurrencyLimit(originalGlobalConcurrencyLimit);
      assert.strictEqual(
        globalConcurrencyLimit(),
        originalGlobalConcurrencyLimit,
        'the suite must leave maxConcurrentAgents exactly as it found it'
      );
    }
    await clearRoster();
    await vscode.commands.executeCommand('unode.setApiKey', { e2e: true, clear: true });
  });

  it('routes a user task to QA without targeting Dev', async () => {
    const dev = requireAgent(team, (a) => a.role === 'senior-dev' || a.role === 'developer', 'Dev');
    const qa = requireAgent(team, (a) => a.role === 'reviewer' || a.role === 'tester' || a.role === 'qa', 'QA');

    const sent = await vscode.commands.executeCommand<MessageLike>('unode.sendMessage', {
      targetId: qa.id,
      instruction: 'E5e routing probe for QA only',
    });

    assert.ok(sent, 'sendMessage should return the sent bus message');
    assert.strictEqual(sent.from, 'user');
    assert.strictEqual(sent.to, qa.id);
    assert.notStrictEqual(sent.to, dev.id);
    assert.strictEqual(sent.type, 'task.assign');
    assert.strictEqual(sent.payload?.instruction, 'E5e routing probe for QA only');
  });

  it('queues the third agent at max concurrency 2 and auto-starts it when a slot frees', async () => {
    const cfg = vscode.workspace.getConfiguration('unode');
    await cfg.update('maxConcurrentAgents', 2, vscode.ConfigurationTarget.Global);
    await setRoamApiKey();
    assert.ok(team.length >= 3, 'default team should provide at least three agents');

    const [first, second, third] = team;
    await vscode.commands.executeCommand<AgentLike>('unode.agentStart', first.id);
    await vscode.commands.executeCommand<AgentLike>('unode.agentStart', second.id);
    const queued = await vscode.commands.executeCommand<AgentLike>('unode.agentStart', third.id);

    assert.strictEqual(queued?.id, third.id);
    assert.strictEqual(queued?.pendingStart, true, 'third start should be pending behind the cap');
    assert.strictEqual(queued?.status, 'stopped');

    const afterStop = await vscode.commands.executeCommand<AgentLike[]>('unode.agentStop', first.id);
    const resumed = await poll(
      () => afterStop?.find((agent) => agent.id === third.id),
      (agent): agent is AgentLike => !!agent && !agent.pendingStart && (agent.status === 'starting' || agent.status === 'idle'),
      5000
    );

    assert.ok(resumed, 'queued third agent should auto-start after a slot frees');
  });
});

function globalConcurrencyLimit(): number | undefined {
  return vscode.workspace.getConfiguration('unode').inspect<number>('maxConcurrentAgents')?.globalValue;
}

async function restoreGlobalConcurrencyLimit(value: number | undefined): Promise<void> {
  await vscode.workspace.getConfiguration('unode').update(
    'maxConcurrentAgents',
    value,
    vscode.ConfigurationTarget.Global
  );
}

/** Remove the test roster so a second vscode-test process starts from the same workspace state. */
async function clearRoster(): Promise<void> {
  const agents = await vscode.commands.executeCommand<AgentLike[]>('unode.stopAllAgents', { e2e: true }) ?? [];
  for (const agent of agents) {
    await vscode.commands.executeCommand('unode.agentRemove', agent.id);
  }
  const remaining = await vscode.commands.executeCommand<AgentLike[]>('unode.stopAllAgents', { e2e: true }) ?? [];
  assert.strictEqual(remaining.length, 0, 'e2e suite must not leave a roster for the next run');
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
    assert.ok(Array.isArray(created), 'createDefaultTeam should return created agents');
    return created;
  } finally {
    (vscode.window as any).showInformationMessage = originalInfo;
    (vscode.window as any).showWarningMessage = originalWarning;
  }
}

async function setRoamApiKey(): Promise<void> {
  await vscode.commands.executeCommand('unode.setApiKey', { e2e: true });
}

function requireAgent(agents: AgentLike[], predicate: (agent: AgentLike) => boolean, label: string): AgentLike {
  const agent = agents.find(predicate);
  assert.ok(agent, `${label} agent should exist`);
  return agent;
}

async function poll<T>(
  read: () => T,
  done: (value: T) => boolean,
  timeoutMs: number
): Promise<T | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = read();
    if (done(value)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}
