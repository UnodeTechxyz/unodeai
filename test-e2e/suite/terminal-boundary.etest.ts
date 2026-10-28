import * as assert from 'assert';
import * as vscode from 'vscode';

const EXT_ID = 'unode.unodeai';

type TerminalBoundaryProbe = (fixture: { e2e: true }, cwd: string) => Promise<{
  transports: string[];
  shells: string[];
  terminalsBeforeApproval: number;
  serial: { firstEnd: number; secondStart: number };
  parallel: { firstStart: number; firstEnd: number; otherStart: number };
  timeout: { status: string; reason?: string; childPid?: number; childAlive?: boolean };
}>;

/**
 * v0.9.96 terminal execution boundary, in a real extension host with real terminals. Where this host's terminal
 * cannot prove its shell, folder and capture, the same probe runs through the declared direct fallback, and every
 * assertion below must hold either way: the lane rules do not depend on the transport.
 */
describe('terminal execution boundary (v0.9.96)', () => {
  it('serializes one agent, lets another run, and leaves no nested child alive after a timeout', async function () {
    this.timeout(120_000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} should be present`);
    await ext!.activate();
    const probe = (ext!.exports as { __testTerminalBoundary?: TerminalBoundaryProbe }).__testTerminalBoundary;
    assert.strictEqual(typeof probe, 'function', 'the extension must expose the terminal boundary probe in Test mode');
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(folder, 'the E2E run opens a workspace folder');

    const result = await probe!({ e2e: true }, folder!);
    console.log(`[terminal-boundary] ${JSON.stringify(result)}`);

    // A prepared command that was never approved started no terminal.
    assert.strictEqual(result.terminalsBeforeApproval, 0, 'a terminal was created before the approval');
    // A later command of the same agent began only after the earlier one had ended.
    assert.ok(result.serial.secondStart >= result.serial.firstEnd,
      `same-agent overlap: second started ${result.serial.firstEnd - result.serial.secondStart} ms before the first ended`);
    // Another agent was not held behind it.
    assert.ok(result.parallel.otherStart < result.parallel.firstEnd, 'another agent waited for this agent\'s command');
    // The timeout stopped the whole tree, and the nested child was confirmed gone before the result.
    assert.strictEqual(result.timeout.status, 'timed-out', `timeout outcome ${JSON.stringify(result.timeout)}`);
    assert.ok(result.timeout.childPid, 'the nested child wrote its process id');
    assert.strictEqual(result.timeout.childAlive, false, 'the nested child survived the timeout');
  });
});
