import { describe, it, expect } from 'vitest';
import { WorkspaceTools } from '../WorkspaceTools';
import { MessageBus } from '../../bus/MessageBus';
import { Message } from '../../types';

// F3: the send_message tool lets an agent message a teammate (or broadcast) over the team bus.
// Capability-gated by the 'message' token; degrades safely when no bus is wired.
describe('WorkspaceTools send_message (F3)', () => {
  const root = process.cwd();

  it('only exposes send_message when the "message" token is granted', () => {
    const without = new WorkspaceTools(root, new Set(['read']));
    expect(without.specs().some((s) => s.function.name === 'send_message')).toBe(false);

    const withMsg = new WorkspaceTools(root, new Set(['read', 'message']), 'alice', undefined, undefined, undefined, undefined, new MessageBus());
    expect(withMsg.specs().some((s) => s.function.name === 'send_message')).toBe(true);
  });

  it('sends a directed message to a teammate over the bus', async () => {
    const bus = new MessageBus();
    const received: Message[] = [];
    bus.onAddressed('bob', (m) => received.push(m));

    const tools = new WorkspaceTools(root, new Set(['message']), 'alice', undefined, undefined, undefined, undefined, bus);
    const out = await tools.runText('send_message', { target: 'bob', message: 'ship it' });

    expect(out).toMatch(/sent to "bob"/i);
    expect(received).toHaveLength(1);
    expect(received[0].from).toBe('alice');
    expect(received[0].to).toBe('bob');
    expect(received[0].type).toBe('agent.message');
    expect(received[0].payload.message).toBe('ship it');
  });

  it('broadcasts to all teammates with target "*"', async () => {
    const bus = new MessageBus();
    const seen: Message[] = [];
    bus.onType('agent.message', (m) => seen.push(m));

    const tools = new WorkspaceTools(root, new Set(['message']), 'alice', undefined, undefined, undefined, undefined, bus);
    const out = await tools.runText('send_message', { target: '*', message: 'standup in 5' });

    expect(out).toMatch(/broadcast/i);
    expect(seen).toHaveLength(1);
    expect(seen[0].to).toBe('*');
    expect(seen[0].payload.message).toBe('standup in 5');
  });

  it('errors (does not throw) when no bus is configured', async () => {
    const tools = new WorkspaceTools(root, new Set(['message']), 'alice');
    const out = await tools.runText('send_message', { target: 'bob', message: 'hi' });
    expect(out).toMatch(/not available/i);
  });

  it('refuses send_message without the message token even if invoked directly', async () => {
    const tools = new WorkspaceTools(root, new Set(['read']), 'alice', undefined, undefined, undefined, undefined, new MessageBus());
    const result = await tools.run('send_message', { target: 'bob', message: 'hi' });
    expect(result).toMatchObject({ status: 'refused', reason: 'capability' });
  });

  it('validates target and message are present', async () => {
    const tools = new WorkspaceTools(root, new Set(['message']), 'alice', undefined, undefined, undefined, undefined, new MessageBus());
    expect(await tools.runText('send_message', { target: '', message: 'hi' })).toMatch(/target is required/i);
    expect(await tools.runText('send_message', { target: 'bob', message: '' })).toMatch(/message is required/i);
  });
});
