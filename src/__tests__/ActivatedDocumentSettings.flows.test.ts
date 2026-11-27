import { expect, it, vi } from 'vitest';

/** Real activate/registered command/SettingsPanel chain; only VSCode and transport are stood in. */
const host = await vi.hoisted(async () => (await import('./support/activatedVscode')).createActivatedHost());
vi.mock('vscode', async () => (await import('./support/activatedVscode')).activatedVscodeModule(host));
vi.mock('../host/postWriteDiagnosticsSettle', () => ({ POST_WRITE_DIAGNOSTICS_SETTLE_MS: 0 }));
import * as fs from 'node:fs';
import * as path from 'node:path';
import UPNG from '@pdf-lib/upng';
import { base, context, installActivatedExtension } from './support/activatedHarness';
import { recordPanels } from './support/setupGuidePage';
import { SettingsPanel } from '../views/SettingsPanel';
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
const panels = recordPanels(host);
host.overrides['vscode.commands.executeCommand'] = (command: string, ...args: unknown[]) => host.commands.get(command)?.(...args);
installActivatedExtension(host, () => {}, { agents: [] });

it('registered Documents & images command opens More on both a fresh and an existing Settings panel', async () => {
  SettingsPanel.current?.dispose();
  const command = host.commands.get('unode.openDocumentSettings'); expect(command).toBeDefined();
  await command!();
  await vi.waitFor(() => expect(panels.find(panel => panel.viewType === 'unodeSettings')?.webview.html).toContain('class="section active" id="more"'));
  const panel = panels.find(panel => panel.viewType === 'unodeSettings')!;
  expect(panel.webview.html).toContain('Documents &amp; images'); expect(panel.webview.html).toContain('Refresh application detection');
  expect(panel.webview.html).toContain('Local applications have not been checked.');
  // v0.9.108: the activated panel offers Word/PowerPoint renderer choices only on the platform that has them.
  expect(panel.webview.html.includes('data-renderer-preference="word-powerpoint"')).toBe(process.platform === 'win32');
  expect(panel.webview.html).toContain(process.platform === 'win32' ? '>Prefer LibreOffice (Word/PowerPoint when LibreOffice is not available)</button>' : '>Prefer LibreOffice</button>');
  await host.commands.get('unode.openSettings')!('providers');
  expect(panel.posted.at(-1)).toEqual({ command: 'selectTab', tab: 'providers' });
  await command!();
  expect(panel.posted.at(-1)).toEqual({ command: 'selectTab', tab: 'more' });
  expect(panels.filter(item => item.viewType === 'unodeSettings')).toHaveLength(1);
  SettingsPanel.current?.dispose();
});

/** A 4x2 RGBA PNG: opaque ink, with a transparent background unless `opaque`. */
function signaturePng(opaque = false): Buffer {
  const pixels = new Uint8Array(4 * 2 * 4); for (let at = 0; at < pixels.length; at += 4) pixels.set([10, 20, 120, opaque || at < 16 ? 255 : 0], at);
  return Buffer.from(UPNG.encode([pixels.buffer], 4, 2, 0));
}

it('v0.9.108 installed smoke 6ee15ae9: My signature → Choose signature PNG shows, through the real save callback, what Settings says', async () => {
  SettingsPanel.current?.dispose();
  const folder = fs.mkdtempSync(path.join(base, 'signature-pick-'));
  const opaque = path.join(folder, 'opaque.png'); fs.writeFileSync(opaque, signaturePng(true));
  const transparent = path.join(folder, 'signature.png'); fs.writeFileSync(transparent, signaturePng());
  let pick = opaque;
  const shown: Array<{ kind: 'information' | 'warning'; text: string }> = [];
  const saved = { dialog: host.overrides['vscode.window.showOpenDialog'], info: host.overrides['vscode.window.showInformationMessage'], warn: host.overrides['vscode.window.showWarningMessage'] };
  // Stood in: only the native file picker and VS Code's notification calls. Activation, the Settings message dispatch,
  // the chooseSignature callback, the file read, PdfSignatureStore.save, signatureSaveNotice and showResultNotice are real.
  host.overrides['vscode.window.showOpenDialog'] = async () => [{ fsPath: pick, scheme: 'file', path: pick.replace(/\\/g, '/') }];
  host.overrides['vscode.window.showInformationMessage'] = async (text: string) => { shown.push({ kind: 'information', text: String(text) }); return undefined; };
  host.overrides['vscode.window.showWarningMessage'] = async (text: string) => { shown.push({ kind: 'warning', text: String(text) }); return undefined; };
  try {
    await host.commands.get('unode.openSettings')!('more');
    const panel = panels.filter(item => item.viewType === 'unodeSettings').at(-1)!;
    await vi.waitFor(() => expect(panel.webview.html).toContain('data-command="chooseSignature"'));
    const stored = path.join(context.globalStorageUri.fsPath, 'signature', 'signature.png');

    // A first Settings open in a fresh window may also show its price-coefficient notice; only signature notices count.
    const signatureNotices = () => shown.filter(notice => /signature/i.test(notice.text));
    await panel.receive!({ command: 'chooseSignature' });
    await vi.waitFor(() => expect(signatureNotices()).toHaveLength(1));
    expect(signatureNotices()[0]).toEqual({ kind: 'warning', text: 'The signature PNG has no transparent background. Export it with transparency (for example from your image editor), then choose it again.' });
    expect(fs.existsSync(stored)).toBe(false);

    pick = transparent;
    await panel.receive!({ command: 'chooseSignature' });
    await vi.waitFor(() => expect(signatureNotices()).toHaveLength(2));
    expect(signatureNotices()[1].kind).toBe('information');
    expect(fs.readFileSync(stored).equals(signaturePng())).toBe(true);
    const text = signatureNotices()[1].text;
    expect(text).toContain('confirm each placement');
    expect(text).toContain('on this computer and is not sent to a model');
    expect(text).toContain('an agent that reads that PDF with its own file reading or a command can see the signature');
    expect(text).not.toMatch(/never see/i);
  } finally {
    host.overrides['vscode.window.showOpenDialog'] = saved.dialog;
    host.overrides['vscode.window.showInformationMessage'] = saved.info;
    host.overrides['vscode.window.showWarningMessage'] = saved.warn;
    SettingsPanel.current?.dispose();
  }
});
