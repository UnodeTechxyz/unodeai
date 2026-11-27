import { afterEach, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { temporaryFolder, removeTemporaryFolders } from '../../backend/__tests__/pathSafetyFixtures';

const ui = vi.hoisted(() => ({ html: '', received: undefined as undefined | ((message: unknown) => Promise<void>),
  disposed: undefined as undefined | (() => void), shown: vi.fn() }));
vi.mock('vscode', () => ({ ViewColumn: { Active: 1 }, window: {
  createWebviewPanel: () => ({ reveal() {}, dispose: () => ui.disposed?.(), onDidDispose: (fn: () => void) => { ui.disposed = fn; },
    webview: { cspSource: 'fixture:', get html() { return ui.html; }, set html(value) { ui.html = value; },
      onDidReceiveMessage: (fn: typeof ui.received) => { ui.received = fn; }, postMessage() {} } }),
  showInformationMessage: ui.shown, showErrorMessage: ui.shown,
} }));

import { openTeamRulesPanel, closeTeamRulesPanel } from '../TeamRulesPanel';
import { TeamPolicyStore, TEAM_POLICY_STATE_KEY, reviewPolicyMode } from '../../policy/TeamPolicy';

afterEach(async () => { closeTeamRulesPanel(); await removeTemporaryFolders(); });

it('keeps a legacy strict choice in the real panel and saves the actual select value only after human Save', async () => {
  const values = new Map<string, unknown>([[TEAM_POLICY_STATE_KEY, { version: 1, requireDifferentReportedModelForArtifactReview: true }]]);
  const policy = new TeamPolicyStore({ get: <T>(key: string) => values.get(key) as T | undefined, update: async (key, value) => { values.set(key, value); } });
  const root = await temporaryFolder('unode-q4-panel-'); const rulesFilePath = join(root, '.unode', 'rules.md');
  await openTeamRulesPanel({ rulesFilePath, currentPolicy: () => policy.current(), setReviewPolicyFromHumanPanel: mode => policy.setModeFromHumanPanel(mode) });
  expect(ui.html).toMatch(/value="strict-different-reported-model" selected/);
  expect(ui.html).toContain('Different when author known (recommended)');
  expect(reviewPolicyMode(policy.current())).toBe('strict-different-reported-model');
  const listeners = new Map<string, () => void>(); const pending: Promise<void>[] = [];
  const nodes: Record<string, any> = { rules: { value: 'User advisory guidance.' }, reviewPolicy: { value: 'strict-different-reported-model' },
    save: { addEventListener: (name: string, fn: () => void) => listeners.set(name, fn) }, saved: { classList: { add() {}, remove() {} } } };
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(ui.html)![1];
  vm.runInNewContext(script, { document: { getElementById: (id: string) => nodes[id] }, window: { addEventListener() {} },
    acquireVsCodeApi: () => ({ postMessage: (message: unknown) => { pending.push(ui.received!(message)); } }), setTimeout });
  nodes.reviewPolicy.value = 'different-when-author-known';
  expect(reviewPolicyMode(policy.current())).toBe('strict-different-reported-model');
  listeners.get('click')!(); await Promise.all(pending);
  expect(reviewPolicyMode(policy.current())).toBe('different-when-author-known');
  expect(await readFile(rulesFilePath, 'utf8')).toBe('User advisory guidance.');
  closeTeamRulesPanel(); await openTeamRulesPanel({ rulesFilePath, currentPolicy: () => policy.current() });
  expect(ui.html).toMatch(/value="different-when-author-known" selected/);
});
