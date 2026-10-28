import { describe, expect, it } from 'vitest';
import { CODEX_REFRESH_MESSAGES, CodexSelectionChangedError, refreshCodexModels, type CodexModelRefreshPort, type CodexModelSelection } from '../CodexModelRefresh';

const A: CodexModelSelection = { setting: 'C:\\npm\\codex.exe', program: 'C:\\npm\\codex.exe', version: '0.163.0', stamp: 'A' };

/** An editor whose selection the test changes at a chosen step, recording every effect. */
function editor(options: { changeAt?: 'select' | 'consent' | 'preparing' | 'discover'; select?: CodexModelSelection | undefined; models?: number } = {}) {
  const did: string[] = [];
  let current = { ...A };
  const change = () => { current = { ...A, setting: 'C:\\other\\codex.exe', program: 'C:\\other\\codex.exe', stamp: 'B' }; };
  const port: CodexModelRefreshPort<string> = {
    select: async () => {
      did.push('select');
      if (options.changeAt === 'select') change();
      return 'select' in options ? options.select : { ...A };
    },
    stillSelected: (selection) => selection.setting === current.setting && selection.program === current.program && selection.stamp === current.stamp,
    consent: async (program) => {
      did.push(`consent ${program}`);
      if (options.changeAt === 'consent') change();
    },
    discover: async (program, assertCurrent) => {
      did.push(`discover ${program}`);
      // The loader prepares its folder, asks right before it spawns, and only then starts App Server.
      if (options.changeAt === 'preparing') change();
      assertCurrent();
      did.push(`App Server ${program}`);
      if (options.changeAt === 'discover') change();
      return Array.from({ length: options.models ?? 2 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}`, vision: false, isDefault: index === 0 }));
    },
    remember: async (models, selection) => { did.push(`remember ${models.length} ${selection.program} ${selection.version}`); },
    list: async () => ['listed'],
  };
  return { port, did, change };
}

describe('Refresh models from Codex (v0.9.96)', () => {
  it('checks, asks consent, starts App Server and saves the list for the program that was checked', async () => {
    const e = editor();
    expect(await refreshCodexModels(e.port)).toEqual({ models: ['listed'], message: '2 models loaded from Codex 0.163.0.' });
    expect(e.did).toEqual(['select', 'consent C:\\npm\\codex.exe', 'discover C:\\npm\\codex.exe', 'App Server C:\\npm\\codex.exe', 'remember 2 C:\\npm\\codex.exe 0.163.0']);
  });

  it('starts nothing more when the selection changed during the version and login checks', async () => {
    const e = editor({ changeAt: 'select' });
    expect(await refreshCodexModels(e.port)).toEqual({ models: ['listed'], message: CODEX_REFRESH_MESSAGES.changedBefore });
    expect(e.did).toEqual(['select']);
  });

  it('starts no App Server when the selection changed while consent was asked', async () => {
    const e = editor({ changeAt: 'consent' });
    expect(await refreshCodexModels(e.port)).toEqual({ models: ['listed'], message: CODEX_REFRESH_MESSAGES.changedBefore });
    expect(e.did).toEqual(['select', 'consent C:\\npm\\codex.exe']);
  });

  it('saves no list when the selection changed while it loaded', async () => {
    const e = editor({ changeAt: 'discover' });
    expect(await refreshCodexModels(e.port)).toEqual({ models: ['listed'], message: CODEX_REFRESH_MESSAGES.changedDuring });
    expect(e.did).toEqual(['select', 'consent C:\\npm\\codex.exe', 'discover C:\\npm\\codex.exe', 'App Server C:\\npm\\codex.exe']);
  });

  it('starts no App Server when the selection changed while the loader prepared its folder', async () => {
    const e = editor({ changeAt: 'preparing' });
    expect(await refreshCodexModels(e.port)).toEqual({ models: ['listed'], message: CODEX_REFRESH_MESSAGES.changedBefore });
    expect(e.did).toEqual(['select', 'consent C:\\npm\\codex.exe', 'discover C:\\npm\\codex.exe']);
  });

  it('passes on any other loader error, and the error it throws for a stale selection says so', async () => {
    const e = editor();
    e.port.discover = async () => { throw new Error('Codex model discovery exited with code 1.'); };
    await expect(refreshCodexModels(e.port)).rejects.toThrow('Codex model discovery exited with code 1.');
    expect(new CodexSelectionChangedError().message).toBe(CODEX_REFRESH_MESSAGES.changedBefore);
  });

  it('starts nothing when the selection is cancelled, and saves nothing for an empty answer', async () => {
    const cancelled = editor({ select: undefined });
    expect(await refreshCodexModels(cancelled.port)).toEqual({ models: ['listed'], message: CODEX_REFRESH_MESSAGES.cancelled });
    expect(cancelled.did).toEqual(['select']);
    const empty = editor({ models: 0 });
    expect((await refreshCodexModels(empty.port)).message).toBe('Codex 0.163.0 returned no account models. Nothing was saved; the earlier list and your model text are unchanged.');
    expect(empty.did.some((step) => step.startsWith('remember'))).toBe(false);
  });

  it('does not ask consent or start App Server when consent is declined', async () => {
    const e = editor();
    e.port.consent = async () => { throw new Error('declined'); };
    await expect(refreshCodexModels(e.port)).rejects.toThrow('declined');
    expect(e.did).toEqual(['select']);
  });
});
