import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ workspace: {}, window: {} }));
import { readUnodeSetting, type InspectableConfiguration } from '../settings/AuthoritySettings';
import { resolveWebAccessPolicy, SessionWebAccessApprover, DEFAULT_WEB_ACCESS_POLICY } from '../backend/WebAccessPolicy';
import { readResultNoticeStyle } from '../resultNotice';

/**
 * v0.9.99 capability-first defaults, read through the same code the host uses: the manifest default arrives as
 * VS Code's `defaultValue`, the person's own choice as `globalValue`, and a repository value is ignored.
 */
const properties = JSON.parse(readFileSync('package.json', 'utf8')).contributes.configuration.properties;

function configuration(key: string, layers: { globalValue?: unknown; workspaceValue?: unknown } = {}): InspectableConfiguration {
  const defaultValue = properties[`unode.${key}`].default;
  return {
    get: <T>(_key: string, fallback: T) => (layers.workspaceValue ?? layers.globalValue ?? defaultValue ?? fallback) as T,
    inspect: <T>() => ({ defaultValue: defaultValue as T, globalValue: layers.globalValue as T, workspaceValue: layers.workspaceValue as T }),
  };
}

/** What a web read on either route meets: the policy row, then the approval surface only for Ask. */
async function webRead(layers: { globalValue?: unknown; workspaceValue?: unknown }) {
  let prompts = 0;
  const approver = new SessionWebAccessApprover(async () => { prompts++; return { allow: false, reason: 'Denied by the person.' }; });
  const value = readUnodeSetting(configuration('webAccess', layers), 'webAccess', DEFAULT_WEB_ACCESS_POLICY);
  const decision = resolveWebAccessPolicy(value, true) ?? await approver.requestApproval({ agentName: 'Researcher', toolName: 'WebSearch' });
  return { decision, prompts };
}

describe('v0.9.99 defaults: absent adopts the new default, an explicit choice survives', () => {
  it('B6: an existing user with no webAccess value now searches without a prompt', async () => {
    expect(properties['unode.webAccess'].default).toBe('allow');
    await expect(webRead({})).resolves.toEqual({ decision: { allow: true }, prompts: 0 });
  });

  it('B6: an explicit Ask in User Settings still asks, and an explicit Off still denies without asking', async () => {
    await expect(webRead({ globalValue: 'ask' })).resolves.toMatchObject({ decision: { allow: false }, prompts: 1 });
    await expect(webRead({ globalValue: 'off' })).resolves.toMatchObject({
      decision: { allow: false, reason: 'Public web access is turned off by unode.webAccess.' },
      prompts: 0,
    });
  });

  it('B6: a repository cannot change the person\'s web policy in either direction', async () => {
    await expect(webRead({ globalValue: 'off', workspaceValue: 'allow' })).resolves.toMatchObject({ decision: { allow: false }, prompts: 0 });
    await expect(webRead({ workspaceValue: 'off' })).resolves.toEqual({ decision: { allow: true }, prompts: 0 });
  });

  it('A10: an absent result style is quiet; an explicit Dialog is kept; a repository value is ignored', () => {
    expect(properties['unode.notifications.resultStyle'].default).toBe('quiet');
    expect(readResultNoticeStyle(configuration('notifications.resultStyle'))).toBe('quiet');
    expect(readResultNoticeStyle(configuration('notifications.resultStyle', { globalValue: 'dialog' }))).toBe('dialog');
    expect(readResultNoticeStyle(configuration('notifications.resultStyle', { workspaceValue: 'dialog' }))).toBe('quiet');
  });
});
