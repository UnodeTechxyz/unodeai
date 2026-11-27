import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { isCustomGatewayEditBlockedStatus, whenCustomGatewayTurnsEnd } from '../CustomGatewayEditGuard';
import { customGatewayEditWaitingMessage } from '../CustomGatewayHelp';
import type { SessionStatus } from '../../types';

describe('custom gateway edit guard', () => {
  it('allows idle, stopped, and failed sessions because they have no in-flight turn', () => {
    expect(isCustomGatewayEditBlockedStatus('idle')).toBe(false);
    expect(isCustomGatewayEditBlockedStatus('stopped')).toBe(false);
    expect(isCustomGatewayEditBlockedStatus('error')).toBe(false);
  });

  it('blocks every in-flight lifecycle state', () => {
    expect(isCustomGatewayEditBlockedStatus('starting')).toBe(true);
    expect(isCustomGatewayEditBlockedStatus('consent_required')).toBe(true);
    expect(isCustomGatewayEditBlockedStatus('running')).toBe(true);
    expect(isCustomGatewayEditBlockedStatus('stopping')).toBe(true);
  });
});

const source = ts.createSourceFile('extension.ts', readFileSync('src/extension.ts', 'utf8'), ts.ScriptTarget.Latest, true);
function extensionFunction(name: string, host: object) {
  const found: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found.push(node); ts.forEachChild(node, visit); };
  visit(source);
  expect(found).toHaveLength(1);
  const code = ts.transpileModule(found[0].getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('host', `with (host) { ${code}; return ${name}; }`)(host);
}

/** A session list with status events, enough for the host's gateway edit wait. */
function sessions(initial: Array<{ id: string; name: string; connectionId: string; status: SessionStatus }>) {
  const listeners = new Map<string, Set<() => void>>();
  const list = initial.map((entry) => ({ id: entry.id, status: entry.status, config: { id: entry.id, name: entry.name, route: { connectionId: entry.connectionId }, provider: { providerId: entry.connectionId } } }));
  return {
    getAll: () => list,
    on: (event: string, listener: () => void) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(listener); },
    off: (event: string, listener: () => void) => { listeners.get(event)?.delete(listener); },
    set: (id: string, status: SessionStatus) => {
      list.find((entry) => entry.id === id)!.status = status;
      for (const listener of [...(listeners.get('session.status') ?? [])]) listener();
    },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

describe('v0.9.99 B22: a gateway edit during a turn is applied after it, never refused', () => {
  it('resolves at once when no agent on the gateway is mid-turn, without a notice', async () => {
    const waiting = vi.fn();
    await expect(whenCustomGatewayTurnsEnd({ busyAgentNames: () => [], onStatusChange: () => () => {} }, waiting)).resolves.toBeUndefined();
    expect(waiting).not.toHaveBeenCalled();
  });

  it('the real key replacement waits for the running turn, tells the person once, then saves', async () => {
    const team = sessions([
      { id: 'dev', name: 'Developer', connectionId: 'custom:lab', status: 'running' },
      { id: 'qa', name: 'Reviewer', connectionId: 'custom:other', status: 'running' },
    ]);
    const notices: string[] = [];
    const replaceApiKey = vi.fn(async () => {});
    const host: Record<string, unknown> = {
      sessionManager: team,
      connectionIdForProviderId: (id: string) => id,
      effectiveConnectionRegistry: { revision: 7 },
      isCustomGatewayEditBlockedStatus, whenCustomGatewayTurnsEnd, customGatewayEditWaitingMessage,
      vscode: { window: { showInformationMessage: (message: string) => { notices.push(message); return new Promise(() => {}); } } },
      customGatewayProfileForMutation: () => ({ id: 'custom:lab', revision: 3, presentation: { displayName: 'Lab gateway' } }),
      promptCustomGatewayApiKey: async () => 'new-key',
      customGatewayProfileStore: { replaceApiKey },
      reloadEffectiveConnectionRegistry: vi.fn(async () => {}),
    };
    host.customGatewayTurnsEnded = extensionFunction('customGatewayTurnsEnded', host);
    const replace = extensionFunction('replaceCustomGatewayKey', host) as (id: string) => Promise<void>;

    const editing = replace('custom:lab');
    await vi.waitFor(() => expect(notices).toHaveLength(1));
    expect(notices[0]).toBe(customGatewayEditWaitingMessage('Lab gateway', ['Developer']));
    expect(replaceApiKey).not.toHaveBeenCalled();
    // Another gateway's agent finishing changes nothing.
    team.set('qa', 'idle');
    await Promise.resolve();
    expect(replaceApiKey).not.toHaveBeenCalled();
    team.set('dev', 'idle');
    await editing;
    expect(replaceApiKey).toHaveBeenCalledExactlyOnceWith({ expectedRegistryRevision: 7, expectedProfileRevision: 3, connectionId: 'custom:lab', apiKey: 'new-key' });
    expect(notices).toHaveLength(1);
    expect(team.listenerCount()).toBe(0);
  });
});
