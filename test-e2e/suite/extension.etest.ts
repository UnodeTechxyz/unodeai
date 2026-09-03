/*---------------------------------------------------------------------------------------------
 *  UnodeAi - E2E smoke test (P1#7)
 *  Runs inside a real VS Code instance (via @vscode/test-cli). This is the scaffold the project
 *  reviews flagged as missing (E2E=0): it activates the extension and asserts the core user-journey
 *  entry points exist. Extend with: add agent -> start -> send message -> observe activity feed.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as vscode from 'vscode';

const EXT_ID = 'unode.unodeai';

const EXPECTED_COMMANDS = [
  'unode.showTeamPanel',
  'unode.showDashboard',
  'unode.addAgent',
  'unode.createDefaultTeam',
  'unode.createTeamPreset',
  'unode.startSolo',
  'unode.showAgentTerminal',
  'unode.restoreCheckpoint',
  'unode.sendMessage',
  'unode.openChat',
  'unode.chatWithAgent',
  'unode.reviewRun',
  'unode.runWorkflow',
  'unode.editWorkflow',
  'unode.onboarding',
  'unode.runDemoTask',
  'unode.setApiKey',
  'unode.openSettings',
  'unode.openAccount',
  'unode.resetWorkspaceState',
];

describe('UnodeAi activation', () => {
  // This suite creates a default team for the demo-task assertion. Removing it in a
  // suite hook keeps the next vscode-test process equivalent to the first one.
  after(async function () {
    this.timeout(30_000);
    const agents = await vscode.commands.executeCommand<{ id: string }[]>('unode.stopAllAgents', { e2e: true }) ?? [];
    for (const agent of agents) {
      await vscode.commands.executeCommand('unode.agentRemove', agent.id);
    }
    const remaining = await vscode.commands.executeCommand<{ id: string }[]>('unode.stopAllAgents', { e2e: true }) ?? [];
    assert.strictEqual(remaining.length, 0, 'activation e2e suite must not leave a roster for the next run');
  });

  it('activates the extension', async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} should be present`);
    await ext!.activate();
    assert.strictEqual(ext!.isActive, true);
  });

  it('imports a local native-text PDF through the packaged attachment boundary without retaining its source metadata', async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} should be present`);
    await ext!.activate();
    const probe = ext!.exports as {
      __testLocalPdfAttachmentPipeline?: (attachment: {
        name: string; mime: string; kind: 'pdf'; dataBase64: string; size: number;
      }, fixture: { e2e: true }) => Promise<{ intake: string; read: string; receipts: unknown[]; durableMessage: unknown }>;
    };
    assert.strictEqual(typeof probe.__testLocalPdfAttachmentPipeline, 'function', 'bundled extension must expose PDF E2E proof seam');

    const filename = 'confidential-local-report.pdf';
    const marker = 'LOCALPDFPAGE';
    const bytes = threePagePdfWithText(['LOCALPDFPAGEONE', `${marker}TWO`, 'LOCALPDFPAGETHREE']);
    const result = await probe.__testLocalPdfAttachmentPipeline!({
      name: filename,
      mime: 'application/octet-stream',
      kind: 'pdf',
      dataBase64: bytes.toString('base64'),
      size: bytes.byteLength,
    }, { e2e: true });

    assert.match(result.intake, /temporary asset content-1/);
    assert.match(result.read, /pages requested 2-2, extracted 1 of 3 total/);
    assert.match(result.read, new RegExp(marker));
    const durable = JSON.stringify({ intake: result.intake, receipts: result.receipts, message: result.durableMessage });
    assert.ok(!durable.includes(filename), 'filename must not enter durable chat/evidence facts');
    assert.ok(!durable.includes(marker), 'extracted text must not enter durable chat/evidence facts');
    assert.ok(!durable.includes(bytes.toString('base64').slice(0, 80)), 'raw PDF bytes must not enter durable chat/evidence facts');
  });

  it('repairs an old key coefficient only after the user opens Settings', async () => {
    const config = vscode.workspace.getConfiguration('unode');
    const original = config.inspect<unknown>('priceMultiplier')?.globalValue;
    await config.update('priceMultiplier', {}, vscode.ConfigurationTarget.Global);
    try {
      // The fixture stores a key without going through the interactive coefficient prompt. This is the
      // old-key shape that v0.9.56 repaired at activation; A1 repairs it only when the user opens Settings.
      const keyAction = await vscode.commands.executeCommand<string>('unode.setApiKey', { e2e: true });
      assert.ok(keyAction === 'create' || keyAction === 'leave', `unexpected fixture key action: ${keyAction}`);
      // `WorkspaceConfiguration` is a snapshot in this extension-host version. Re-read after our own
      // setup write too, or a prior smoke run's restored value can make this order-dependent.
      assert.deepStrictEqual(vscode.workspace.getConfiguration('unode').get<unknown>('priceMultiplier'), {});

      await vscode.commands.executeCommand('unode.openSettings');
      // `WorkspaceConfiguration` is a snapshot in this extension-host test. Re-read it instead of
      // mistaking the old handle for a failed global update.
      assert.deepStrictEqual(
        vscode.workspace.getConfiguration('unode').get<unknown>('priceMultiplier'),
        { unode: 1 },
        `key action was ${keyAction}`,
      );
    } finally {
      await vscode.commands.executeCommand('unode.setApiKey', { e2e: true, clear: true });
      await config.update('priceMultiplier', original, vscode.ConfigurationTarget.Global);
    }
  });

  it('registers all core commands', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const cmd of EXPECTED_COMMANDS) {
      assert.ok(all.includes(cmd), `command ${cmd} should be registered`);
    }
  });

  it('opens the Settings panel without throwing', async () => {
    await vscode.commands.executeCommand('unode.openSettings');
  });

  it('opens the Workflow Editor without throwing', async () => {
    await vscode.commands.executeCommand('unode.editWorkflow');
  });

  it('completes onboarding and sets the workspace flag', async () => {
    const result = await vscode.commands.executeCommand('unode.onboarding', { completeImmediately: true });
    assert.strictEqual(result, true);
  });

  it('sends a demo task to the Project Manager through the normal turn entrypoint', async () => {
    const originalInfo = vscode.window.showInformationMessage;
    const originalWarning = vscode.window.showWarningMessage;
    try {
      (vscode.window as unknown as { showInformationMessage: typeof vscode.window.showInformationMessage }).showInformationMessage =
        async () => undefined;
      (vscode.window as any).showWarningMessage = async (_message: string, ...args: unknown[]) => {
        const items = args.filter((item): item is string => typeof item === 'string');
        return items.includes('Add') ? 'Add' : undefined;
      };
      await vscode.commands.executeCommand('unode.createDefaultTeam', { e2e: true });
      await vscode.commands.executeCommand('unode.runDemoTask', 'hello-world-http-server');
    } finally {
      (vscode.window as unknown as { showInformationMessage: typeof vscode.window.showInformationMessage }).showInformationMessage =
        originalInfo;
      (vscode.window as any).showWarningMessage = originalWarning;
    }
  });
});

/** A small, real three-page text PDF. Generated at test time so it cannot ship as a VSIX asset. */
function threePagePdfWithText(words: string[]): Buffer {
  const objects: Array<string | undefined> = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R 4 0 R 5 0 R]/Count 3>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 6 0 R/Resources<</Font<</F1 9 0 R>>>>>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 7 0 R/Resources<</Font<</F1 9 0 R>>>>>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 8 0 R/Resources<</Font<</F1 9 0 R>>>>>>',
    undefined,
    undefined,
    undefined,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  words.forEach((word, index) => {
    const stream = `BT /F1 24 Tf 20 100 Td (${word}) Tj ET`;
    objects[5 + index] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
  });

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
