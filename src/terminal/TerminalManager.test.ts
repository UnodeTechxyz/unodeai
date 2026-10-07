import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMock = vi.hoisted(() => {
  const terminals: any[] = [];
  const createTerminal = vi.fn((creationOptions: Record<string, unknown>) => {
    const terminal = {
      name: creationOptions.name,
      creationOptions,
      processId: Promise.resolve(2000 + terminals.length),
      exitStatus: undefined,
      shellIntegration: undefined,
      show: vi.fn(),
      sendText: vi.fn(),
      dispose: vi.fn(),
    };
    terminals.push(terminal);
    return terminal;
  });
  return {
    terminals,
    window: {
      terminals,
      createTerminal,
      onDidChangeTerminalShellIntegration: vi.fn(() => ({ dispose: vi.fn() })),
      onDidEndTerminalShellExecution: vi.fn(() => ({ dispose: vi.fn() })),
    },
  };
});

vi.mock('vscode', () => ({ window: vscodeMock.window }));
vi.mock('../backend/WorkspaceTools', () => ({ defaultSpawnExecutor: vi.fn() }));

import {
  TerminalManager,
  UNODEAI_TERMINAL_MARKER,
  UNODEAI_TERMINAL_MARKER_VALUE,
} from './TerminalManager';

function terminal(pid: number, options: Record<string, unknown>) {
  return {
    name: options.name ?? 'Terminal',
    creationOptions: options,
    processId: Promise.resolve(pid),
    exitStatus: undefined,
    shellIntegration: undefined,
    show: vi.fn(),
    sendText: vi.fn(),
    dispose: vi.fn(),
  };
}

const managedOptions = (name = 'Unode: Senior Developer') => ({
  name,
  cwd: 'C:/old-root',
  env: { [UNODEAI_TERMINAL_MARKER]: UNODEAI_TERMINAL_MARKER_VALUE },
});

beforeEach(() => {
  vscodeMock.terminals.length = 0;
  vscodeMock.window.createTerminal.mockClear();
});

describe('TerminalManager durable ownership', () => {
  it('marks every terminal it creates in persisted creation options', () => {
    const manager = new TerminalManager(vi.fn() as never, vi.fn().mockResolvedValue(undefined));

    manager.reveal('developer', 'Unode: Senior Developer', 'C:/root');

    expect(vscodeMock.window.createTerminal).toHaveBeenCalledWith(expect.objectContaining({
      env: { [UNODEAI_TERMINAL_MARKER]: UNODEAI_TERMINAL_MARKER_VALUE },
    }));
  });

  it('opens an agent terminal in the folder as a terminal spells it, whoever opens it first', () => {
    const manager = new TerminalManager(vi.fn() as never, vi.fn().mockResolvedValue(undefined));

    // The Team view opens the terminal with the path the editor reports: a lower-case drive letter on Windows.
    // The agent's commands then run in that terminal, and Vitest fails from such a folder before any test.
    manager.reveal('developer', 'Unode: Senior Developer', 'c:/work/project');
    const asATerminalSpellsIt = process.platform === 'win32' ? 'C:/work/project' : 'c:/work/project';
    expect(vscodeMock.window.createTerminal).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: asATerminalSpellsIt }));

    manager.reveal('pm', 'Unode: PM');
    expect(vscodeMock.window.createTerminal).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: undefined }));
  });

  it('a re-activated host closes a pre-existing marked terminal and its process tree', async () => {
    const stale = terminal(4101, managedOptions());
    vscodeMock.terminals.push(stale);
    const terminate = vi.fn().mockResolvedValue(undefined);
    const manager = new TerminalManager(vi.fn() as never, terminate);

    await manager.disposeAll();

    expect(terminate).toHaveBeenCalledWith(4101);
    expect(stale.dispose).toHaveBeenCalledOnce();
    expect(terminate.mock.invocationCallOrder[0]).toBeLessThan(stale.dispose.mock.invocationCallOrder[0]);
  });

  it('an invalidation sweep closes marked terminals not created by this host', async () => {
    const terminate = vi.fn().mockResolvedValue(undefined);
    const manager = new TerminalManager(vi.fn() as never, terminate);
    manager.reveal('developer', 'Unode: Developer', 'C:/current-root');
    const inherited = terminal(4202, managedOptions('Unode: Reviewer'));
    vscodeMock.terminals.push(inherited);

    await manager.disposeAll();

    expect(terminate).toHaveBeenCalledTimes(2);
    expect(terminate).toHaveBeenCalledWith(4202);
    expect(inherited.dispose).toHaveBeenCalledOnce();
  });

  it('never touches an unmarked user terminal, even when its name looks like an Unode terminal', async () => {
    const userTerminal = terminal(4303, { name: 'Unode: Senior Developer', cwd: 'C:/user-root' });
    const stale = terminal(4304, managedOptions());
    vscodeMock.terminals.push(userTerminal, stale);
    const terminate = vi.fn().mockResolvedValue(undefined);
    const manager = new TerminalManager(vi.fn() as never, terminate);

    await manager.disposeAll();
    await manager.disposeAll(); // VS Code may briefly retain a disposed terminal in window.terminals.

    expect(terminate).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledWith(4304);
    expect(userTerminal.dispose).not.toHaveBeenCalled();
    expect(stale.dispose).toHaveBeenCalledOnce();
  });
});
