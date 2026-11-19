import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createHasAgentsContext, followRoster, HAS_AGENTS_CONTEXT_KEY } from '../hasAgentsContext';

function roster() {
  const agents: string[] = [];
  const set: Array<[string, boolean]> = [];
  const emitter = new EventEmitter();
  const context = createHasAgentsContext({ agentCount: () => agents.length, setContext: (key, value) => { set.push([key, value]); } });
  const events = { on: (event: 'session.created' | 'session.removed', listener: () => void) => { emitter.on(event, listener); } };
  return {
    agents, set, context, events,
    add(id: string) { agents.push(id); emitter.emit('session.created'); },
    remove(id: string) { agents.splice(agents.indexOf(id), 1); emitter.emit('session.removed'); },
  };
}

describe('v0.9.106 the unode.hasAgents context key', () => {
  it('is false for an empty roster and true once one agent exists', () => {
    const r = roster();
    expect(r.context.sync()).toBe(false);
    r.agents.push('pm');
    expect(r.context.sync()).toBe(true);
    expect(r.set).toEqual([[HAS_AGENTS_CONTEXT_KEY, false], [HAS_AGENTS_CONTEXT_KEY, true]]);
    expect(HAS_AGENTS_CONTEXT_KEY).toBe('unode.hasAgents');
  });

  it('sets the key only when its value changes', () => {
    const r = roster();
    r.agents.push('pm');
    r.context.sync();
    r.agents.push('dev');
    r.context.sync();
    r.context.sync();
    expect(r.set).toEqual([[HAS_AGENTS_CONTEXT_KEY, true]]);
  });

  it('follows every agent added and removed, back to false when the last one goes', () => {
    const r = roster();
    followRoster(r.events, r.context);
    r.add('pm');
    r.add('dev');
    r.remove('pm');
    expect(r.set).toEqual([[HAS_AGENTS_CONTEXT_KEY, true]]);
    r.remove('dev');
    expect(r.set).toEqual([[HAS_AGENTS_CONTEXT_KEY, true], [HAS_AGENTS_CONTEXT_KEY, false]]);
    r.add('solo');
    expect(r.set.at(-1)).toEqual([HAS_AGENTS_CONTEXT_KEY, true]);
  });

  it('is wired in activation: it follows the roster before the restore and is set once more after it', () => {
    // activate() is too large to run here; the activation flows run it whole. This pins the order that matters:
    // the restore's own adds are seen, and an empty or failed restore still sets the key.
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    // A failed restore throws out of activate(); the key then stays unset, which reads as no agents, unless an agent
    // was added, which the subscription already reported.
    const follow = source.indexOf('followRoster(sessionManager, hasAgents);');
    const restore = source.indexOf('rosterRestored = await restoreRoster();');
    const sync = source.indexOf('hasAgents.sync();', restore);
    const nextStep = source.indexOf('messageLogProvider.hydrate(messageBus.query()', restore);
    const counts = source.indexOf('agentCount: () => sessionManager.getAll().length');
    const setsContext = source.indexOf("setContext: (key, value) => { void vscode.commands.executeCommand('setContext', key, value); }");
    expect(follow).toBeGreaterThan(0);
    expect(counts).toBeGreaterThan(0);
    expect(setsContext).toBeGreaterThan(0);
    expect(follow).toBeLessThan(restore);
    expect(sync).toBeGreaterThan(restore);
    expect(sync).toBeLessThan(nextStep);
    expect(source.split('hasAgents.sync();').length - 1).toBe(1);
  });
});
