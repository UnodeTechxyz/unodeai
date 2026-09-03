import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { makeUnodeChatHandler } from '../UnodeChatParticipant';

function fakeStream() {
  return { markdown: vi.fn(), progress: vi.fn(), button: vi.fn() };
}
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const call = (handler: any, prompt: string, stream: any) =>
  handler({ prompt } as never, {} as never, stream as never, token as never);

describe('makeUnodeChatHandler (@unode)', () => {
  it('asks for a goal when the prompt is empty', async () => {
    const stream = fakeStream();
    await call(makeUnodeChatHandler({ runGoal: vi.fn() }), '   ', stream);
    expect(stream.markdown).toHaveBeenCalledWith(expect.stringContaining('Give me a goal'));
  });

  it('runs the goal on the crew, streams output, and adds an Open-in-UnodeAi button', async () => {
    const stream = fakeStream();
    const runGoal = vi.fn(async (_p: string, onText: (s: string) => void) => { onText('working…'); onText(' done.'); return { ok: true, agentName: 'PM' }; });
    await call(makeUnodeChatHandler({ runGoal }), 'build X', stream);
    expect(stream.progress).toHaveBeenCalled();
    expect(runGoal).toHaveBeenCalledWith('build X', expect.any(Function), token);
    expect(stream.markdown).toHaveBeenCalledWith('working…');
    expect(stream.markdown).toHaveBeenCalledWith(' done.');
    expect(stream.button).toHaveBeenCalledWith({ command: 'unode.showTeamPanel', title: 'Open in UnodeAi' });
  });

  it('surfaces a user-actionable error from runGoal (e.g. no team yet)', async () => {
    const stream = fakeStream();
    await call(makeUnodeChatHandler({ runGoal: async () => ({ ok: false, error: 'No agents yet.' }) }), 'x', stream);
    expect(stream.markdown).toHaveBeenCalledWith(expect.stringContaining('No agents yet.'));
  });

  it('reports a thrown error gracefully (no crash)', async () => {
    const stream = fakeStream();
    await call(makeUnodeChatHandler({ runGoal: async () => { throw new Error('boom'); } }), 'x', stream);
    expect(stream.markdown).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(stream.button).not.toHaveBeenCalled(); // bailed before the button
  });

  it('notes when the crew finished without text output', async () => {
    const stream = fakeStream();
    await call(makeUnodeChatHandler({ runGoal: async () => ({ ok: true }) }), 'x', stream); // no onText
    expect(stream.markdown).toHaveBeenCalledWith(expect.stringContaining('without text output'));
    expect(stream.button).toHaveBeenCalled();
  });
});
