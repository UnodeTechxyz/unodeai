import { describe, expect, it } from 'vitest';
import { SessionPresentationModel } from '../sessionPresentation';

function coordination(content: string, timestamp: string) {
  return {
    timestamp,
    time: new Date(timestamp).toLocaleTimeString(),
    from: 'PM',
    to: 'Developer',
    type: 'task.assign',
    priority: 'normal',
    content,
  };
}

describe('SessionPresentationModel', () => {
  it('keeps human-to-agent and agent-to-agent views as filtered projections of one event log', () => {
    const model = new SessionPresentationModel();

    model.replaceTranscript('agent-1', [{
      role: 'user',
      text: 'Review the patch.',
      ts: '2026-07-24T00:00:00.000Z',
    }]);
    model.appendAgentMessage({
      time: '12:01:00',
      from: 'PM',
      to: 'Developer',
      type: 'task.assign',
      priority: 'normal',
      content: 'Please review the patch.',
    });

    expect(model.transcript('agent-1')).toMatchObject([{ text: 'Review the patch.' }]);
    expect(model.agentMessages()).toMatchObject([{ content: 'Please review the patch.' }]);

    // Projections are copies. A webview cannot mutate the host event log, nor can
    // one stream overwrite the other simply by being rendered or cleared.
    const transcript = model.transcript('agent-1');
    transcript[0].text = 'mutated by a surface';
    const messages = model.agentMessages();
    messages[0].content = 'mutated by a surface';

    expect(model.transcript('agent-1')[0].text).toBe('Review the patch.');
    expect(model.agentMessages()[0].content).toBe('Please review the patch.');

    model.clearAgentMessages();
    expect(model.agentMessages()).toEqual([]);
    expect(model.transcript('agent-1')).toMatchObject([{ text: 'Review the patch.' }]);
  });

  it('owns selected-agent state for every consumer of the presentation model', () => {
    const model = new SessionPresentationModel();

    model.selectAgent('agent-1');
    expect(model.selectedAgentId).toBe('agent-1');
  });

  it('keeps an agent event ahead of a later human event after an order-preserving coordination trim', () => {
    const model = new SessionPresentationModel();
    model.appendAgentMessage(coordination('arrived first', '2026-07-25T00:00:00.000Z'));
    model.replaceTranscript('agent-1', [{ role: 'user', text: 'arrived second', ts: '2026-07-25T00:01:00.000Z' }]);

    // This is the exact former 300-cap path: retaining the same coordination messages must not push
    // them after a human event that arrived later.
    model.replaceAgentMessages(model.agentMessages());
    model.trimAgentMessages(300);

    expect(model.orderedEvents().map((event) => event.stream)).toEqual(['agent-agent', 'human-agent']);
  });

  it('drops only the oldest coordination events at the cap and preserves every survivor position', () => {
    const model = new SessionPresentationModel();
    model.appendAgentMessage(coordination('agent-0', '2026-07-25T00:00:00.000Z'));
    model.replaceTranscript('agent-1', [{ role: 'user', text: 'human stays put', ts: '2026-07-25T00:00:01.000Z' }]);
    for (let i = 1; i <= 300; i++) {
      model.appendAgentMessage(coordination(`agent-${i}`, `2026-07-25T00:01:${String(i % 60).padStart(2, '0')}.000Z`));
    }

    model.trimAgentMessages(300);

    expect(model.agentMessages()).toHaveLength(300);
    expect(model.agentMessages()[0].content).toBe('agent-1');
    expect(model.orderedEvents().map((event) => event.stream)).toEqual([
      'human-agent',
      ...Array(300).fill('agent-agent'),
    ]);
    expect(model.orderedEvents().some((event) => event.stream === 'agent-agent' && event.message.content === 'agent-0')).toBe(false);
  });

  it('replaces the latest coordination projection without moving it across a later human event', () => {
    const model = new SessionPresentationModel();
    model.appendAgentMessage(coordination('tool action', '2026-07-25T00:00:00.000Z'));
    model.replaceTranscript('agent-1', [{ role: 'user', text: 'human event', ts: '2026-07-25T00:00:01.000Z' }]);

    expect(model.replaceLastAgentMessage(coordination('tool action ×2', '2026-07-25T00:00:02.000Z'))).toBe(true);
    expect(model.orderedEvents().map((event) => event.stream === 'human-agent' ? event.message.text : event.message.content))
      .toEqual(['tool action ×2', 'human event']);
  });

  it('exposes the true arrival order across both streams without sorting locale display time', () => {
    const model = new SessionPresentationModel();
    model.appendAgentMessage(coordination('first', '2026-07-25T00:02:00.000Z'));
    model.replaceTranscript('agent-1', [{ role: 'user', text: 'second', ts: '2026-07-25T00:02:01.000Z' }]);
    model.appendAgentMessage(coordination('third', '2026-07-25T00:02:02.000Z'));

    expect(model.orderedEvents().map((event) => event.stream === 'human-agent' ? event.message.text : event.message.content))
      .toEqual(['first', 'second', 'third']);
    expect(model.agentMessages()[0].timestamp).toBe('2026-07-25T00:02:00.000Z');
  });
});
