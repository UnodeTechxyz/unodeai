import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { solidScreenshotPng } from '../../backend/__tests__/presentationImageFixtures';
const state = vi.hoisted(() => ({ panels: [] as any[], create: vi.fn() }));
vi.mock('vscode', () => ({ ViewColumn: { Beside: 2 }, window: { createWebviewPanel: (...args: unknown[]) => {
  state.create(...args); let disposed: (() => void) | undefined;
  const panel = { webview: { html: '' }, onDidDispose: (callback: () => void) => { disposed = callback; }, dispose: () => disposed?.(), reveal: vi.fn() };
  state.panels.push(panel); return panel;
} } }));
import { ImagePreviewHost } from '../ImagePreviewHost';
import type { ImageGenerationReceipt } from '../ImageGenerationHost';
it('previews the exact generated PNG without scripts, remote resources, approval or focus-taking, and never reopens after dispose', () => {
  const bytes = solidScreenshotPng(1536, 1024);
  const receipt = { state: 'succeeded', width: 1536, height: 1024, sha256: createHash('sha256').update(bytes).digest('hex'),
    operation_id: 'image-host-minted', model: 'gpt-image-2.6-flare' } as ImageGenerationReceipt;
  const preview = new ImagePreviewHost(); preview.show(receipt, bytes);
  expect(state.create).toHaveBeenCalledWith('unode.generatedImagePreview', 'Generated image', { viewColumn: 2, preserveFocus: true }, { enableScripts: false, localResourceRoots: [] });
  const panel = state.panels[0]; expect(panel.webview.html).toContain('data:image/png;base64,' + bytes.toString('base64'));
  expect(panel.webview.html).toContain("default-src 'none'"); expect(panel.webview.html).not.toContain('<button');
  preview.show(receipt, Buffer.from('changed')); expect(state.create).toHaveBeenCalledTimes(1);
  preview.show(receipt, bytes); expect(panel.reveal).not.toHaveBeenCalled(); expect(state.create).toHaveBeenCalledTimes(1);
  preview.dispose(); preview.show(receipt, bytes); expect(state.create).toHaveBeenCalledTimes(1);
});
