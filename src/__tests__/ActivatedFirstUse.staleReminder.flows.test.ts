import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * v0.9.106 quiet first screen (Codex's RC-1 on 466ee324), through the extension's real entry: a window that opens with
 * no agent shows no stale reference-price reminder in that session, also when its first agent is created before the
 * delayed check runs. activate() runs with only the VS Code API and the model's HTTP endpoint stood in; the person types
 * a goal on the Chat page, presses Send and then Start with Solo.
 * To produce that order, every 300 ms timer (the spend view refresh that runs the check is one) is held until the Solo
 * task has reached its model, and then run. A window that opens with agents still gets its due reminder:
 * ActivatedExtension.checks.flows.test.ts.
 */
const host = await vi.hoisted(async () => (await import('./support/activatedVscode')).createActivatedHost());

vi.mock('vscode', async () => (await import('./support/activatedVscode')).activatedVscodeModule(host));
vi.mock('../host/postWriteDiagnosticsSettle', () => ({ POST_WRITE_DIAGNOSTICS_SETTLE_MS: 0 }));

import { DEFAULT_MODEL_TIERS } from '../roles/RoleConfig';
import { chatScreen, context, installActivatedExtension, latestUser, pumpWhile, requests, scripts } from './support/activatedHarness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const held: Array<() => void> = [];
let holding = true;
const realSetTimeout = globalThis.setTimeout;
beforeAll(() => {
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms === 300 && holding) {
      held.push(() => callback(...args));
      const placeholder = realSetTimeout(() => undefined, 3_600_000);
      (placeholder as { unref?: () => void }).unref?.();
      return placeholder;
    }
    return realSetTimeout(callback, ms, ...args);
  }) as typeof setTimeout);
});
afterAll(() => { vi.restoreAllMocks(); });

let screen: ReturnType<typeof chatScreen>;
let chatProvider: any;
installActivatedExtension(host, (ready) => { chatProvider = ready.chatProvider; screen = ready.screen; }, { agents: [] });

const descendants = (node: any): any[] => (Array.isArray(node?.children) ? node.children : []).flatMap((child: any) => [child, ...descendants(child)]);
const page = () => screen.page();
const actionButton = (action: string) => descendants(page().elements.get('transcript'))
  .find((node) => node.type === 'button' && node.dataset?.firstUseAction === action);
const agents = () => chatProvider.currentState().agents as Array<{ id: string; role: string }>;
const staleReminders = () => host.infos.filter((text) => /reference prices UnodeAi shows were captured .* are now stale/.test(text));
const STALE_REMINDED_KEY = 'unode.spend.staleReferenceRemindedAt';

describe('v0.9.106 a window that opens with no agent: the stale reference-price reminder', () => {
  it('stays quiet when the first task starts with Solo before the delayed check runs, and records no cooldown', async () => {
    await pumpWhile(() => !chatProvider.currentState().firstUse?.active, () => screen.pump());
    expect(agents()).toEqual([]);
    const goal = 'Summarise this folder before the reminder check.';
    scripts.set(DEFAULT_MODEL_TIERS.standard.unode, () => ({ text: 'Here is the summary.' }));
    const input = page().elements.get('input') as any;
    input.value = goal;
    page().dispatchElementEvent(input, 'input');
    await screen.sendBox();
    await pumpWhile(() => !actionButton('start-solo'), () => screen.pump());
    page().dispatchElementEvent(actionButton('start-solo'), 'click');
    await pumpWhile(() => !requests.some((request) => latestUser(request).includes(goal)), () => screen.pump());
    expect(agents().map((agent) => agent.role)).toEqual(['solo']);
    // The delayed callbacks, the spend view refresh that runs the check among them, run only now.
    expect(held.length).toBeGreaterThan(0);
    holding = false;
    for (const callback of held.splice(0)) callback();
    await screen.pump();
    expect(staleReminders(), JSON.stringify(host.infos)).toEqual([]);
    expect(context.globalState.get(STALE_REMINDED_KEY)).toBeUndefined();
  });
});
