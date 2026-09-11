/*---------------------------------------------------------------------------------------------
 *  UnodeAi - cancel_task in a real extension host
 *
 *  Every earlier test of the coordinator's brake injected a fake stopTeammate. That proves the tool calls
 *  its callback and nothing about the callback the host actually supplies -- the one that looks the
 *  session up, refuses when the target is the coordinator itself, and ends the turn. Codex named the gap
 *  as a release condition for v0.9.56.
 *
 *  This drives cancel_task through makeCoordinatorTeamTools, the same function a real turn uses, against
 *  a real roster in a real extension host.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as vscode from 'vscode';

const EXT_ID = 'unode.unodeai';

interface AgentLike { id: string; role: string; name: string; status?: string }
interface Snapshot { id: string; name: string; role: string; status: string }
interface CancelResult { result: string; agents: Snapshot[] }

describe('UnodeAi coordinator brake (cancel_task)', () => {
  let team: AgentLike[] = [];
  let pm: AgentLike;

  before(async function () {
    this.timeout(60_000);
    await vscode.extensions.getExtension(EXT_ID)?.activate();
    await clearRoster();
    team = await createDefaultTeam();
    pm = requireAgent(
      team,
      (a) => /manager|coordinator/i.test(a.role) || /manager/i.test(a.name),
      'Project Manager'
    );
  });

  after(async function () {
    this.timeout(60_000);
    await clearRoster();
    await vscode.commands.executeCommand('unode.setApiKey', { e2e: true, clear: true });
  });

  it('is unreachable without the Test-mode fixture marker', async () => {
    await assert.rejects(
      async () => {
        await vscode.commands.executeCommand('unode.coordinatorCancelTask', { coordinatorId: pm.id, all: true });
      },
      /Test mode/,
      'the fixture command must refuse an unmarked call even inside the Test host'
    );
  });

  it('refuses a call that names neither a handle, an agent nor all', async () => {
    const { result } = await cancel({ coordinatorId: pm.id });
    assert.match(result, /needs a handle, an agent, or all=true/);
  });

  /**
   * The roster the coordinator sees carries display names, not ids -- so the name it reads back is the
   * name it must be able to cancel by. "Not running" is the honest answer for an idle teammate, asserted
   * here so a later change cannot start claiming a stop that did not happen.
   */
  it('resolves a teammate by display name and reports honestly that it was idle', async () => {
    const teammate = requireAgent(team, (a) => a.id !== pm.id, 'a teammate');
    const { result } = await cancel({ coordinatorId: pm.id, agent: teammate.name });
    assert.ok(
      result.startsWith(teammate.name + ' was not running'),
      'expected an honest not-running report, got: ' + result
    );
  });

  it('names list_agents when the coordinator invents a teammate', async () => {
    const { result } = await cancel({ coordinatorId: pm.id, agent: 'Chief Imaginary Officer' });
    assert.match(result, /no teammate matches/);
    assert.match(result, /list_agents/);
  });

  it('rejects a stale handle without claiming it stopped anything', async () => {
    const { result } = await cancel({ coordinatorId: pm.id, handle: 'task-does-not-exist' });
    assert.match(result, /no assignment with handle task-does-not-exist is running for you/);
  });

  /**
   * The safety property, checked where it actually runs.
   *
   * all: true walks the whole roster and calls the host's stopTeammate on each. A coordinator that
   * stopped itself mid-tool-call would end the turn that is trying to stop the team, so the host refuses
   * agentId === config.id. That refusal lives in extension.ts and is invisible to every test that
   * supplied its own stopTeammate.
   */
  it('sweeps the whole roster and never stops the coordinator', async function () {
    this.timeout(60_000);
    const roster = await startEveryone();
    assert.ok(roster.length > 1, 'need a coordinator and at least one teammate');

    // Put every teammate mid-turn so the sweep has live sessions to end rather than an idle roster to
    // walk. Each turn's model call fails on the offline fixture key, so the brake has to beat it there;
    // sending to all of them means catching one does not depend on which agent is slowest.
    //
    // Retried rather than tolerated. The first version of this test logged whether it had caught a live
    // teammate and asserted either way, which meant a future run that stopped nothing would still pass
    // having proved only the roster walk (Codex review, 2026-08-22). An attempt that misses the window is
    // a missed window, not a result: try again, and fail if every attempt misses.
    const ATTEMPTS = 5;
    let attempt = 0;
    let result = '';
    let agents: Snapshot[] = [];
    let wereRunning: Snapshot[] = [];
    let soloWasRunning: Snapshot[] = [];

    while (attempt < ATTEMPTS) {
      attempt += 1;
      for (const teammate of roster.filter((a) => a.id !== pm.id)) {
        await vscode.commands.executeCommand('unode.sendMessage', {
          targetId: teammate.id,
          instruction: 'E2E brake probe ' + attempt + ': stay busy.',
        });
      }
      const caught = await waitFor(
        pm.id,
        (snapshot) => snapshot.filter(isTeammateOf(pm.id)).some((a) => a.status === 'running')
      );
      if (!caught) { continue; }

      const { agents: live } = await cancel({ coordinatorId: pm.id, observe: true });
      wereRunning = live.filter(isTeammateOf(pm.id)).filter((a) => a.status === 'running');
      soloWasRunning = live.filter((a) => a.role === 'solo' && a.status === 'running');

      ({ result, agents } = await cancel({ coordinatorId: pm.id, all: true, reason: 'E2E brake' }));
      assert.ok(result.length > 0, 'cancel_task must say what it did');
      if (/Stopped [1-9]/.test(result)) { break; }
    }

    // The assertion the whole file exists for: the brake ended a turn that was actually running, in a real
    // extension host, through the host's own stopTeammate.
    assert.match(
      result,
      /Stopped [1-9]\d* teammate/,
      'no live teammate was stopped in ' + ATTEMPTS + ' attempts; the brake was never observed to work. '
      + 'Tool said: ' + result
    );
    console.log('[cancel_task e2e] live stop on attempt ' + attempt + ': ' + result);

    const coordinator = agents.find((a) => a.id === pm.id);
    assert.ok(coordinator, 'the coordinator must still be on the roster after stopping the team');
    assert.notStrictEqual(coordinator.status, 'stopping', 'the coordinator must not have stopped itself');
    assert.ok(
      !result.includes(pm.name),
      'cancel_task must not report stopping the coordinator: ' + result
    );

    for (const agent of agents.filter(isTeammateOf(pm.id))) {
      assert.notStrictEqual(agent.status, 'running', agent.name + ' must not still be running after the brake');
    }

    // The other half of the same boundary. `delegatableRoster` excludes solo agents, so a coordinator's
    // brake reaches its team and stops there -- a solo agent is nobody's teammate and its stop belongs to
    // the user's own button. Asserted rather than assumed, because the sweep walks a roster and it would
    // be easy for a later change to widen it into "every session in the window".
    for (const solo of soloWasRunning) {
      assert.ok(
        !result.includes(solo.name),
        'a coordinator must not claim authority over a solo agent: ' + result
      );
    }

    // A teammate seen running a moment ago must either be named as stopped or have finished on its own.
    // Written this way because the observation and the brake are two calls: a turn can end between them,
    // and a test that demanded the name would fail on the host doing exactly the right thing.
    for (const teammate of wereRunning) {
      const after = agents.find((a) => a.id === teammate.id);
      assert.ok(
        result.includes(teammate.name) || after?.status !== 'running',
        teammate.name + ' was running and was neither stopped nor finished: ' + result
      );
    }

  });
});

async function cancel(args: Record<string, unknown>): Promise<CancelResult> {
  const out = await vscode.commands.executeCommand<CancelResult>(
    'unode.coordinatorCancelTask',
    { e2e: true, ...args }
  );
  assert.ok(out, 'the fixture command must return a result and a roster snapshot');
  return out;
}

/** Who a coordinator may stop: the roster minus itself, minus solo agents that answer to nobody. */
function isTeammateOf(coordinatorId: string): (agent: Snapshot) => boolean {
  return (agent) => agent.id !== coordinatorId && agent.role !== 'solo';
}

/** Poll the roster through the fixture's read-only mode until the predicate holds, or give up. */
async function waitFor(
  coordinatorId: string,
  done: (agents: Snapshot[]) => boolean,
  timeoutMs = 5_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { agents } = await cancel({ coordinatorId, observe: true });
    if (done(agents)) { return true; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/** Start every roster member so the sweep has something to walk. */
async function startEveryone(): Promise<AgentLike[]> {
  await vscode.commands.executeCommand('unode.setApiKey', { e2e: true });
  const roster = await stopAndListRoster();
  for (const agent of roster) {
    await vscode.commands.executeCommand('unode.agentStart', agent.id);
  }
  return roster;
}

/** The only roster read a test has; it stops everything first, so never call it mid-assertion. */
async function stopAndListRoster(): Promise<AgentLike[]> {
  return await vscode.commands.executeCommand<AgentLike[]>('unode.stopAllAgents', { e2e: true }) ?? [];
}

async function clearRoster(): Promise<void> {
  for (const agent of await stopAndListRoster()) {
    await vscode.commands.executeCommand('unode.agentRemove', agent.id);
  }
  const remaining = await stopAndListRoster();
  assert.strictEqual(remaining.length, 0, 'cancel_task e2e suite must not leave a roster for the next run');
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
    assert.ok(Array.isArray(created) && created.length > 1, 'createDefaultTeam should produce a team');
    return created;
  } finally {
    (vscode.window as any).showInformationMessage = originalInfo;
    (vscode.window as any).showWarningMessage = originalWarning;
  }
}

function requireAgent(agents: AgentLike[], predicate: (agent: AgentLike) => boolean, label: string): AgentLike {
  const agent = agents.find(predicate);
  assert.ok(agent, label + ' should exist on the default team');
  return agent;
}
