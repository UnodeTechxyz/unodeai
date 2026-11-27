/*---------------------------------------------------------------------------------------------
 * A0 extension-host benchmark fixture
 *
 * Loaded only by scripts/run-a0-benchmark.mjs. It deliberately records what a real extension host can
 * observe and marks the rest unavailable; a command returning is not evidence that browser DOM paint has
 * completed.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { writeFileSync } from 'fs';
import * as vscode from 'vscode';

const reportPath = process.env.UNODE_A0_E2E_REPORT;
const EXT_ID = 'unode.unodeai';

interface AgentLike { id: string }

function rounded(ms: number): number {
  return Number(ms.toFixed(3));
}

async function timed<T>(fn: () => Thenable<T> | Promise<T>): Promise<{ value: T; elapsedMs: number }> {
  const started = performance.now();
  const value = await fn();
  return { value, elapsedMs: performance.now() - started };
}

async function clearRoster(): Promise<void> {
  const agents = await vscode.commands.executeCommand<AgentLike[]>('unode.stopAllAgents', { e2e: true }) ?? [];
  for (const agent of agents) {
    await vscode.commands.executeCommand('unode.agentRemove', agent.id);
  }
  const remaining = await vscode.commands.executeCommand<AgentLike[]>('unode.stopAllAgents', { e2e: true }) ?? [];
  assert.strictEqual(remaining.length, 0, 'A0 benchmark must leave no E2E roster behind');
}

async function createDefaultTeam(): Promise<AgentLike[]> {
  const originalInfo = vscode.window.showInformationMessage;
  const originalWarning = vscode.window.showWarningMessage;
  try {
    (vscode.window as unknown as { showInformationMessage: typeof vscode.window.showInformationMessage }).showInformationMessage =
      async () => undefined;
    (vscode.window as any).showWarningMessage = async (_message: string, ...args: unknown[]) => {
      const items = args.filter((item): item is string => typeof item === 'string');
      return items.includes('Add') ? 'Add' : undefined;
    };
    const team = await vscode.commands.executeCommand<AgentLike[]>('unode.createDefaultTeam', { e2e: true });
    assert.ok(Array.isArray(team) && team.length > 0, 'benchmark workspace fixture should create a team');
    return team;
  } finally {
    (vscode.window as unknown as { showInformationMessage: typeof vscode.window.showInformationMessage }).showInformationMessage = originalInfo;
    (vscode.window as unknown as { showWarningMessage: typeof vscode.window.showWarningMessage }).showWarningMessage = originalWarning;
  }
}

if (reportPath) {
  describe('A0 extension-host benchmark fixture', () => {
    after(async function () {
      this.timeout(30_000);
      await vscode.commands.executeCommand('unode.closeWorkbench');
      await clearRoster();
    });

    it('records host-observable command readiness and established-workspace panel completion', async function () {
      this.timeout(60_000);
      const extension = vscode.extensions.getExtension(EXT_ID);
      assert.ok(extension, `extension ${EXT_ID} should be present`);
      const wasActiveBeforeMeasurement = extension!.isActive;
      const activationToCommandsStartedAt = performance.now();
      const activation = await timed(() => extension!.activate());
      const commands = await timed(() => vscode.commands.getCommands(true));
      const activationToCommandRegistrationMs = performance.now() - activationToCommandsStartedAt;
      assert.ok(commands.value.includes('unode.openChat'), 'openChat command should be registered');

      await clearRoster();
      const establishedWorkspace = await timed(() => createDefaultTeam());
      const interactivePanelCommand = await timed(() => vscode.commands.executeCommand('unode.openChat'));
      await vscode.commands.executeCommand('unode.closeWorkbench');

      writeFileSync(reportPath!, `${JSON.stringify({
        schemaVersion: 1,
        fixture: 'fresh-vscode-test-extension-host-with-established-team-created-in-test',
        activation: {
          activationCallMs: rounded(activation.elapsedMs),
          activationToCommandRegistrationMs: rounded(activationToCommandRegistrationMs),
          wasAlreadyActiveBeforeMeasurement: wasActiveBeforeMeasurement,
          hostStartupToCommandRegistration: {
            status: 'unavailable',
            reason: 'onStartupFinished may activate the extension before a test suite obtains a clock origin.',
          },
          commandInventoryMs: rounded(commands.elapsedMs),
          commandsObserved: commands.value.filter((command) => command.startsWith('unode.')).length,
        },
        establishedWorkspace: {
          defaultTeamMembers: establishedWorkspace.value.length,
          fixtureSetupMs: rounded(establishedWorkspace.elapsedMs),
          interactivePanelCommandCompletionMs: rounded(interactivePanelCommand.elapsedMs),
          interactivePanelReady: {
            status: 'unavailable',
            reason: 'Command completion proves the host opened the panel, not that webview DOM paint completed.',
          },
        },
      }, null, 2)}\n`, 'utf8');
    });
  });
}
