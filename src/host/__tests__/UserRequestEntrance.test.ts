import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { MessageBus } from '../../bus/MessageBus';
import { SessionLocalReadScopeConsent } from '../../backend/localReadScope';
import { UserRequestEntrance } from '../UserRequestEntrance';

function entrance(options: { running?: boolean; onRoster?: boolean; startFails?: boolean } = {}) {
  const bus = new MessageBus();
  const prompts: string[] = [];
  const answer = { allow: false };
  // The real consent gate: a decline blocks the root until the person makes a new request.
  const consent = new SessionLocalReadScopeConsent(async (root) => {
    prompts.push(root);
    return answer.allow;
  });
  const order: string[] = [];
  const agent = { running: options.running ?? false };
  bus.subscribe({}, (message) => {
    order.push(`send:${message.from}:${message.to}:${message.type}`);
  });
  const requests = new UserRequestEntrance({
    beginUserRequest: () => {
      order.push('begin');
      consent.beginUserRequest();
    },
    bus,
    agents: {
      has: () => options.onRoster ?? true,
      isRunning: () => agent.running,
      start: async () => {
        order.push('start');
        if (options.startFails) throw new Error('no route');
        agent.running = true;
      },
    },
  });
  return { bus, consent, prompts, answer, order, requests };
}

const root = path.resolve('outside-the-workspace');

describe('UserRequestEntrance', () => {
  it('begins a new request of the person before it routes the message', () => {
    const { requests, order } = entrance({ running: true });
    const sent = requests.submit('pm', 'ask.question', { instruction: 'ship the change', mode: 'act' });

    expect(order).toEqual(['begin', 'send:user:pm:ask.question']);
    expect(sent).toMatchObject({
      from: 'user', to: 'pm', type: 'ask.question', priority: 'normal',
      payload: { instruction: 'ship the change', mode: 'act' },
    });
  });

  it('starts a request again as a new request: a new process, no metadata of the ended attempt, and a declined local read askable again', async () => {
    const { bus, consent, prompts, answer, order, requests } = entrance();
    const original = requests.submit('pm', 'ask.question', {
      instruction: 'ship the change', mode: 'act', metadata: { turnEpoch: 7 },
    });
    // The person declined a folder during the attempt. Within that request the decline holds and is not asked twice.
    await expect(consent.ensure(root)).resolves.toBe(false);
    await expect(consent.ensure(root)).resolves.toBe(false);
    expect(prompts).toHaveLength(1);
    order.length = 0;

    await expect(requests.resubmit('pm', original)).resolves.toBe(true);

    // The agent's process was ended with the attempt, so it is started first; then the request enters as any other.
    expect(order).toEqual(['start', 'begin', 'send:user:pm:ask.question']);
    const sent = bus.query({ type: 'ask.question' });
    expect(sent).toHaveLength(2);
    expect(sent[1].id).not.toBe(original.id);
    expect(sent[1]).toMatchObject({ from: 'user', to: 'pm', priority: original.priority });
    expect(sent[1].payload).toEqual({ instruction: 'ship the change', mode: 'act' });
    // It is a new request, so the earlier decline no longer answers for the person: the folder is asked again.
    answer.allow = true;
    await expect(consent.ensure(root)).resolves.toBe(true);
    expect(prompts).toHaveLength(2);
  });

  it('does not start an agent that is already running', async () => {
    const { requests, order } = entrance({ running: true });
    const original = requests.submit('pm', 'ask.question', { instruction: 'ship the change', mode: 'act' });
    order.length = 0;

    await expect(requests.resubmit('pm', original)).resolves.toBe(true);
    expect(order).toEqual(['begin', 'send:user:pm:ask.question']);
  });

  it('submits nothing, and begins no request, when there is nothing to start again or the agent cannot be started', async () => {
    // The request is gone.
    const gone = entrance();
    await expect(gone.requests.resubmit('pm', undefined)).resolves.toBe(false);
    expect(gone.order).toEqual([]);

    // The message was not a request of the person.
    const host = entrance();
    const wake = host.bus.send('unode', 'pm', 'ask.question', { instruction: 'a result arrived', mode: 'act' });
    host.order.length = 0;
    await expect(host.requests.resubmit('pm', wake)).resolves.toBe(false);
    expect(host.order).toEqual([]);

    // The agent left the roster.
    const removed = entrance({ onRoster: false });
    const earlier = removed.bus.send('user', 'pm', 'ask.question', { instruction: 'ship the change', mode: 'act' });
    removed.order.length = 0;
    await expect(removed.requests.resubmit('pm', earlier)).resolves.toBe(false);
    expect(removed.order).toEqual([]);

    // The agent cannot be started: the start was tried, and no request was begun for it.
    const broken = entrance({ startFails: true });
    const request = broken.bus.send('user', 'pm', 'ask.question', { instruction: 'ship the change', mode: 'act' });
    broken.order.length = 0;
    await expect(broken.requests.resubmit('pm', request)).resolves.toBe(false);
    expect(broken.order).toEqual(['start']);
    expect(broken.bus.query({ type: 'ask.question' })).toHaveLength(1);
  });
});
