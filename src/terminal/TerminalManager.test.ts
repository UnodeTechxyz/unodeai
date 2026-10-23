import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * A fake of the VS Code terminal and shell-integration API, close enough to drive every branch of the manager:
 * terminals with a configurable shell, reported folder and integration; executions whose stream and end event the
 * test controls; manager-observable start, end and close events; and a count of every live event listener.
 */
const vs = vi.hoisted(() => {
  type Listener = (event: any) => void;
  class Emitter {
    readonly listeners = new Set<Listener>();
    readonly event = (listener: Listener) => {
      this.listeners.add(listener);
      return { dispose: () => { this.listeners.delete(listener); } };
    };
    fire(event: any) { for (const listener of [...this.listeners]) listener(event); }
  }
  const emitters = {
    integration: new Emitter(),
    start: new Emitter(),
    end: new Emitter(),
    close: new Emitter(),
  };

  class Stream {
    private readonly chunks: string[] = [];
    private ended = false;
    private wake?: () => void;
    push(chunk: string) { this.chunks.push(chunk); this.wake?.(); }
    end() { this.ended = true; this.wake?.(); }
    async *iterate(): AsyncGenerator<string> {
      for (;;) {
        if (this.chunks.length) { yield this.chunks.shift()!; continue; }
        if (this.ended) return;
        await new Promise<void>((resolve) => { this.wake = resolve; });
        this.wake = undefined;
      }
    }
  }

  type ShellKind = 'windows-powershell' | 'pwsh' | 'bash' | 'zsh' | 'cmd';
  interface Setup {
    shell: ShellKind;
    reportedCwd: string | undefined;
    integrate: boolean;
    cwdScheme?: string;
    cwdLater?: boolean;
    /** The folder a user command's execution reports as its start, when it differs from the terminal's. */
    startCwd?: string;
    /** executeCommand throws for a user command (never for a probe). */
    commandThrows?: boolean;
  }
  const state = {
    terminals: [] as any[],
    created: [] as any[],
    /** What the next created terminals are; a queue, or the default when it is empty. */
    nextTerminals: [] as Setup[],
    defaultSetup: { shell: 'pwsh', reportedCwd: '/work/project', integrate: true } as Setup,
    /** How a user command (anything but a probe) behaves. */
    onCommand: undefined as undefined | ((text: string, control: any) => void),
    executed: [] as Array<{ terminal: any; text: string }>,
  };

  function execution(terminal: any, text: string) {
    const stream = new Stream();
    const exec: any = {
      commandLine: { value: text },
      cwd: { scheme: 'file', fsPath: !text.includes('__UNODE_CAPTURE_') && terminal.startCwd ? terminal.startCwd : terminal.reportedCwd },
      read: () => stream.iterate(),
    };
    const control = {
      exec,
      output: (chunk: string) => stream.push(chunk),
      finish: (exitCode: number | undefined, chunk?: string) => {
        if (chunk) stream.push(chunk);
        stream.end();
        emitters.end.fire({ terminal, execution: exec, exitCode, shellIntegration: terminal.shellIntegration });
      },
      endEventOnly: (exitCode: number | undefined) => emitters.end.fire({ terminal, execution: exec, exitCode, shellIntegration: terminal.shellIntegration }),
      close: () => terminal.dispose(),
    };
    return { exec, control };
  }

  function probeAnswer(terminal: any, text: string, control: any) {
    const tag = /(__UNODE_CAPTURE_[0-9a-f]+__)/.exec(text)?.[1];
    const kind: ShellKind = terminal.shellKind;
    const powershell = kind === 'windows-powershell' || kind === 'pwsh';
    const posix = kind === 'bash' || kind === 'zsh';
    if (text.startsWith('Write-Output')) {
      if (powershell) control.finish(0, `${tag}:C:\\Program Files\\PowerShell:${kind === 'pwsh' ? 'Core' : 'Desktop'}\r\n`);
      else control.finish(2, 'syntax error near unexpected token `(\'\n');
    } else if (text.startsWith('printf')) {
      if (posix) control.finish(0, `${tag}:${kind}\n`);
      else control.finish(1, 'printf: The term is not recognized\r\n');
    } else if (text.startsWith('echo')) {
      if (kind === 'cmd') control.finish(0, `${tag}:C:\\WINDOWS\\system32\\cmd.exe\r\n`);
      else control.finish(0, `${tag}:%COMSPEC%\r\n`);
    }
  }

  function integrationFor(terminal: any) {
    return {
      get cwd() {
        if (terminal.reportedCwd === undefined) return undefined;
        return { scheme: terminal.cwdScheme ?? 'file', fsPath: terminal.reportedCwd };
      },
      executeCommand: (text: string) => {
        if (terminal.executeThrows || (terminal.commandThrows && !text.includes('__UNODE_CAPTURE_'))) throw new Error('integration is gone');
        const { exec, control } = execution(terminal, text);
        state.executed.push({ terminal, text });
        // VS Code reports the start asynchronously, after executeCommand returned.
        queueMicrotask(() => {
          emitters.start.fire({ terminal, execution: exec, shellIntegration: terminal.shellIntegration });
          if (text.includes('__UNODE_CAPTURE_')) {
            if (terminal.probeHangs) return;
            if (terminal.probeOverride) terminal.probeOverride(text, control);
            else probeAnswer(terminal, text, control);
          } else if (state.onCommand) {
            state.onCommand(text, control);
          } else {
            control.finish(0, `ran ${text}\n`);
          }
        });
        return exec;
      },
    };
  }

  function makeTerminal(options: Record<string, any>, setup: Setup, pid: number) {
    const terminal: any = {
      name: options.name,
      creationOptions: options,
      processId: Promise.resolve(pid),
      exitStatus: undefined,
      shellIntegration: undefined,
      shellKind: setup.shell,
      reportedCwd: setup.reportedCwd,
      cwdScheme: setup.cwdScheme,
      startCwd: setup.startCwd,
      commandThrows: setup.commandThrows,
      show: vi.fn(),
      sendText: vi.fn(),
      dispose: vi.fn(() => {
        if (terminal.exitStatus) return;
        terminal.exitStatus = { code: undefined };
        const index = state.terminals.indexOf(terminal);
        if (index >= 0) state.terminals.splice(index, 1);
        queueMicrotask(() => emitters.close.fire(terminal));
      }),
    };
    return terminal;
  }

  const createTerminal = vi.fn((options: Record<string, any>) => {
    const setup = state.nextTerminals.shift() ?? state.defaultSetup;
    const terminal = makeTerminal(options, setup, 2000 + state.created.length);
    state.terminals.push(terminal);
    state.created.push(terminal);
    if (setup.integrate) {
      const reported = terminal.reportedCwd;
      if (setup.cwdLater) terminal.reportedCwd = undefined;
      queueMicrotask(() => {
        terminal.shellIntegration = integrationFor(terminal);
        emitters.integration.fire({ terminal, shellIntegration: terminal.shellIntegration });
        if (setup.cwdLater) {
          setTimeout(() => {
            terminal.reportedCwd = reported;
            emitters.integration.fire({ terminal, shellIntegration: terminal.shellIntegration });
          }, 50);
        }
      });
    }
    return terminal;
  });

  /** A terminal some earlier host left behind, or a user terminal. */
  function foreignTerminal(pid: number, options: Record<string, any>) {
    return makeTerminal(options, state.defaultSetup, pid);
  }

  const liveListeners = () => Object.values(emitters).reduce((sum, emitter) => sum + emitter.listeners.size, 0);

  return {
    state,
    emitters,
    foreignTerminal,
    liveListeners,
    window: {
      get terminals() { return state.terminals; },
      createTerminal,
      onDidChangeTerminalShellIntegration: emitters.integration.event,
      onDidStartTerminalShellExecution: emitters.start.event,
      onDidEndTerminalShellExecution: emitters.end.event,
      onDidCloseTerminal: emitters.close.event,
    },
    env: { shell: '' },
  };
});

vi.mock('vscode', () => ({
  window: vs.window,
  env: vs.env,
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
}));

import {
  CAPTURE_PROBE_TIMEOUT_MS,
  SHELL_INTEGRATION_TIMEOUT_MS,
  TERMINAL_INTERRUPT_GRACE_MS,
  TerminalManager,
  UNODEAI_TERMINAL_MARKER,
  UNODEAI_TERMINAL_MARKER_VALUE,
} from './TerminalManager';
import type { CommandExecResult, PreparedCommandExecution, PreparedDirectCommand } from '../backend/CommandExecution';
import { HostShutdown, type ProcessTerminationOutcome } from '../backend/processTree';
import type { TerminalProfileHint } from './TerminalShellProfile';
import { CMD_SHELL } from '../backend/__tests__/shellFixtures';

const ROOT = '/work/project';
const NO_HINT: TerminalProfileHint = { wsl: false, fingerprint: 'no-hint' };
const HINTS = {
  'windows-powershell': { grammar: 'powershell', kind: 'windows-powershell', wsl: false, fingerprint: 'winps' },
  pwsh: { grammar: 'powershell', kind: 'pwsh', wsl: false, fingerprint: 'pwsh' },
  bash: { grammar: 'posix', kind: 'bash', wsl: false, fingerprint: 'bash' },
  zsh: { grammar: 'posix', kind: 'zsh', wsl: false, fingerprint: 'zsh' },
} as const satisfies Record<string, TerminalProfileHint>;
/** What the harness's linux manager names as its declared direct fallback in a "not run" result. */
const NEXT_IS_DIRECT = 'The next command of this agent is checked for the declared direct fallback (sh) before its approval.';

const managedOptions = (name = 'Unode: Senior Developer') => ({
  name,
  cwd: 'C:/old-root',
  env: { [UNODEAI_TERMINAL_MARKER]: UNODEAI_TERMINAL_MARKER_VALUE },
});

interface Harness {
  manager: TerminalManager;
  terminate: ReturnType<typeof vi.fn<(pid: number) => Promise<ProcessTerminationOutcome>>>;
  direct: { prepared: number; executed: string[]; started: string[]; result: CommandExecResult };
  hint: { current: TerminalProfileHint };
}

function harness(options: {
  terminate?: ProcessTerminationOutcome;
  realpath?: (p: string) => Promise<string>;
  platform?: NodeJS.Platform;
  hint?: TerminalProfileHint;
  shutdown?: HostShutdown;
} = {}): Harness {
  const terminate = vi.fn<(pid: number) => Promise<ProcessTerminationOutcome>>(async () => options.terminate ?? { status: 'confirmed-stopped' });
  const direct = { prepared: 0, executed: [] as string[], started: [] as string[], result: { status: 'exited', code: 0, output: 'direct ran' } as CommandExecResult };
  const hint = { current: options.hint ?? HINTS.pwsh };
  const manager = new TerminalManager({
    prepareDirect: () => {
      direct.prepared += 1;
      const prepared: PreparedDirectCommand = {
        ok: true,
        shell: CMD_SHELL,
        execute: async (command) => { direct.executed.push(command); return direct.result; },
        startBackground: (command) => { direct.started.push(command); return { ok: false, error: 'not in this test' }; },
      };
      return prepared;
    },
    terminateProcessTree: terminate,
    realpath: options.realpath ?? (async (candidate) => candidate),
    profileHint: () => hint.current,
    platform: options.platform ?? 'linux',
    nonce: () => 'abc123',
    shutdown: options.shutdown,
  });
  return { manager, terminate, direct, hint };
}

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

async function lease(manager: TerminalManager, agentId = 'dev', cwd = ROOT): Promise<PreparedCommandExecution> {
  const prepared = await manager.executionProviderFor(agentId, `Unode: ${agentId}`).acquire({ cwd });
  if (!prepared.ok) throw new Error(`no lease: ${prepared.message}`);
  return prepared;
}

/** Prepare, run and release one command, as WorkspaceTools does after its gate allowed it. */
async function run(manager: TerminalManager, command: string, agentId = 'dev', cwd = ROOT): Promise<CommandExecResult> {
  const prepared = await lease(manager, agentId, cwd);
  try {
    return await prepared.execute(command, 10_000);
  } finally {
    await prepared.release();
  }
}

const probes = () => vs.state.executed.filter((entry) => entry.text.includes('__UNODE_CAPTURE_'));
const commands = () => vs.state.executed.filter((entry) => !entry.text.includes('__UNODE_CAPTURE_'));

beforeEach(() => {
  vs.state.terminals.length = 0;
  vs.state.created.length = 0;
  vs.state.nextTerminals.length = 0;
  vs.state.executed.length = 0;
  vs.state.onCommand = undefined;
  vs.state.defaultSetup = { shell: 'pwsh', reportedCwd: ROOT, integrate: true };
  vs.window.createTerminal.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TerminalManager durable ownership', () => {
  it('marks every terminal it creates in persisted creation options', () => {
    const { manager } = harness();

    manager.reveal('developer', 'Unode: Senior Developer', 'C:/root');

    expect(vs.window.createTerminal).toHaveBeenCalledWith(expect.objectContaining({
      env: { [UNODEAI_TERMINAL_MARKER]: UNODEAI_TERMINAL_MARKER_VALUE },
    }));
  });

  it('opens an agent terminal in the folder as a terminal spells it, whoever opens it first', () => {
    const { manager } = harness();

    // The Team view opens the terminal with the path the editor reports: a lower-case drive letter on Windows.
    // The agent's commands then run in that terminal, and Vitest fails from such a folder before any test.
    manager.reveal('developer', 'Unode: Senior Developer', 'c:/work/project');
    const asATerminalSpellsIt = process.platform === 'win32' ? 'C:/work/project' : 'c:/work/project';
    expect(vs.window.createTerminal).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: asATerminalSpellsIt }));

    manager.reveal('pm', 'Unode: PM');
    expect(vs.window.createTerminal).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: undefined }));
  });

  it('a re-activated host closes a pre-existing marked terminal and its process tree', async () => {
    const stale = vs.foreignTerminal(4101, managedOptions());
    vs.state.terminals.push(stale);
    const { manager, terminate } = harness();

    await manager.disposeAll();

    expect(terminate).toHaveBeenCalledWith(4101);
    expect(stale.dispose).toHaveBeenCalledOnce();
    expect(terminate.mock.invocationCallOrder[0]).toBeLessThan(stale.dispose.mock.invocationCallOrder[0]);
  });

  it('an invalidation sweep closes marked terminals not created by this host', async () => {
    const { manager, terminate } = harness();
    manager.reveal('developer', 'Unode: Developer', 'C:/current-root');
    const inherited = vs.foreignTerminal(4202, managedOptions('Unode: Reviewer'));
    vs.state.terminals.push(inherited);

    await manager.disposeAll();

    expect(terminate).toHaveBeenCalledTimes(2);
    expect(terminate).toHaveBeenCalledWith(4202);
    expect(inherited.dispose).toHaveBeenCalledOnce();
  });

  it('never touches an unmarked user terminal, even when its name looks like an Unode terminal', async () => {
    const userTerminal = vs.foreignTerminal(4303, { name: 'Unode: Senior Developer', cwd: 'C:/user-root' });
    const stale = vs.foreignTerminal(4304, managedOptions());
    vs.state.terminals.push(userTerminal, stale);
    const { manager, terminate } = harness();

    await manager.disposeAll();
    await manager.disposeAll(); // VS Code may briefly retain a disposed terminal in window.terminals.

    expect(terminate).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledWith(4304);
    expect(userTerminal.dispose).not.toHaveBeenCalled();
    expect(stale.dispose).toHaveBeenCalledOnce();
  });

  it('a second sweep acts on no terminal twice and leaves no listener behind', async () => {
    const baseline = vs.liveListeners();
    const { manager, terminate } = harness();
    await run(manager, 'echo one');

    await Promise.all([manager.disposeAll(), manager.disposeAll()]);
    await manager.disposeAll();

    expect(terminate).toHaveBeenCalledTimes(1);
    expect(vs.state.created[0].dispose).toHaveBeenCalled();
    expect(vs.liveListeners()).toBe(baseline);
  });
});

describe('TerminalManager before the approval (v0.9.96)', () => {
  it('creates, starts, types and probes nothing for a command before its approval', async () => {
    const { manager, direct } = harness();
    const prepared = await lease(manager);
    // The shell the terminal settings name is the one the gate and the approval card see.
    expect(prepared).toMatchObject({ transport: 'terminal', shell: { kind: 'pwsh', grammar: 'powershell', source: 'terminal-profile' } });
    expect(prepared.notice).toBeUndefined();
    expect(vs.state.created).toEqual([]);
    expect(vs.state.executed).toEqual([]);
    // The person denies the command: its lease is released unused, and no terminal program was ever started.
    await prepared.release();
    expect(vs.state.created).toEqual([]);
    expect(vs.state.executed).toEqual([]);
    expect(direct.prepared).toBe(0);
  });

  it('takes the named fallback without a terminal when the settings name no shell it can use', async () => {
    for (const [hint, why] of [
      [NO_HINT, 'UnodeAi could not tell from the terminal settings which shell the agent terminal would run.'],
      [{ grammar: 'unsupported', wsl: false, fingerprint: 'fish' }, 'The selected terminal profile is not a shell UnodeAi can check commands for.'],
      [{ grammar: 'cmd', kind: 'cmd', wsl: false, fingerprint: 'cmd' }, 'The selected terminal profile is Command Prompt, which reports no shell integration.'],
      [{ grammar: 'posix', kind: 'bash', wsl: true, fingerprint: 'wsl' }, 'The selected terminal profile runs WSL, whose folders UnodeAi does not map to this host.'],
    ] as Array<[TerminalProfileHint, string]>) {
      const { manager, direct } = harness({ hint });
      const prepared = await manager.executionProviderFor('dev', 'Unode: dev').acquire({ cwd: ROOT });
      expect(prepared, why).toMatchObject({ ok: true, transport: 'direct', shell: CMD_SHELL });
      if (prepared.ok) {
        expect(prepared.notice).toBe(`${why} This invocation will use the declared direct fallback: cmd.exe.`);
        await prepared.release();
      }
      expect(direct.prepared).toBe(1);
    }
    expect(vs.state.created).toEqual([]);
  });

  it('names the shell the agent terminal last proved, once it has run a command', async () => {
    vs.state.defaultSetup = { shell: 'bash', reportedCwd: ROOT, integrate: true };
    const { manager } = harness({ hint: { ...HINTS.bash, label: 'Git Bash' } });
    await run(manager, 'echo one');
    const next = await lease(manager);
    expect(next.shell).toMatchObject({ kind: 'bash', grammar: 'posix', label: 'Git Bash', source: 'terminal-probe' });
    await next.release();
  });
});

describe('TerminalManager after the approval: every start is checked again (v0.9.96)', () => {
  const UNTRUSTED = { ok: false, reason: 'shell-compatibility', message: 'Blocked: this workspace is not trusted.' } as const;
  const SETTINGS_CHANGED = 'Command not run: the terminal profile settings changed after approval. Retry to check the command '
    + 'against the current execution environment.';
  type Moment = 'before-execute' | 'terminal-created' | 'during-probe' | 'final-folder-check';
  const MOMENTS: Moment[] = ['before-execute', 'terminal-created', 'during-probe', 'final-folder-check'];

  /** Run one approved command, and make `change` happen at one moment between the approval and the command's start. */
  async function runChangingAt(
    moment: Moment,
    change: (manager: TerminalManager) => void,
    startRefusal?: () => typeof UNTRUSTED | undefined,
    shutdown?: HostShutdown,
  ) {
    let calls = 0;
    const built: Harness = harness({
      shutdown,
      realpath: async (candidate) => {
        calls += 1;
        // Calls 1 and 2 are the folder check after integration; 3 and 4 are the final check before the start.
        if (moment === 'final-folder-check' && calls === 3) change(built.manager);
        return candidate;
      },
    });
    const manager = built.manager;
    const original = vs.window.createTerminal.getMockImplementation()!;
    // Only where a terminal is created: an unused one-shot implementation would leak into the next case.
    if (moment === 'terminal-created' || moment === 'during-probe') vs.window.createTerminal.mockImplementationOnce((options: Record<string, any>) => {
      const terminal = original(options);
      if (moment === 'terminal-created') change(manager);
      if (moment === 'during-probe') {
        terminal.probeOverride = (text: string, control: any) => {
          change(manager);
          control.finish(0, `${/(__UNODE_CAPTURE_[0-9a-f]+__)/.exec(text)![1]}:C:\\PS:Core\r\n`);
        };
      }
      return terminal;
    });
    const prepared = await manager.executionProviderFor('dev', 'Unode: dev').acquire({ cwd: ROOT, startRefusal });
    if (!prepared.ok) throw new Error(prepared.message);
    if (moment === 'before-execute') change(manager);
    const result = await prepared.execute('npm test', 10_000);
    await prepared.release();
    return result;
  }

  it('checks Workspace Trust before the terminal, after its integration, after the probe and just before the command', async () => {
    const reached: Record<Moment, number> = { 'before-execute': 0, 'terminal-created': 0, 'during-probe': 0, 'final-folder-check': 0 };
    for (const moment of MOMENTS) {
      vs.state.created.length = 0;
      vs.state.executed.length = 0;
      let trusted = true;
      const result = await runChangingAt(moment, () => { trusted = false; }, () => (trusted ? undefined : UNTRUSTED));
      expect(result, moment).toEqual({ status: 'not-started', code: null, reason: 'environment-changed', output: UNTRUSTED.message });
      expect(commands(), moment).toEqual([]);
      reached[moment] = vs.state.created.length * 10 + probes().length;
    }
    // Withdrawn before the approved command went on: no terminal. Later: the terminal exists, no further probe or command.
    expect(reached).toEqual({ 'before-execute': 0, 'terminal-created': 10, 'during-probe': 11, 'final-folder-check': 11 });
  });

  it('runs nothing once the window begins to close, from before the terminal to just before the command', async () => {
    const reached: Record<Moment, number> = { 'before-execute': 0, 'terminal-created': 0, 'during-probe': 0, 'final-folder-check': 0 };
    for (const moment of MOMENTS) {
      vs.state.created.length = 0;
      vs.state.executed.length = 0;
      const shutdown = new HostShutdown();
      const result = await runChangingAt(moment, () => shutdown.begin(), undefined, shutdown);
      expect(result, moment).toEqual({ status: 'not-started', code: null, reason: 'disposed', output: 'Command not run: the window is closing or reloading.' });
      expect(commands(), moment).toEqual([]);
      reached[moment] = vs.state.created.length * 10 + probes().length;
    }
    expect(reached).toEqual({ 'before-execute': 0, 'terminal-created': 10, 'during-probe': 11, 'final-folder-check': 11 });
  });

  it('runs nothing when the terminal settings change after the approval, also when they name the same shell', async () => {
    for (const moment of MOMENTS) {
      vs.state.created.length = 0;
      vs.state.executed.length = 0;
      const result = await runChangingAt(moment, (manager) => manager.profileSettingsChanged());
      expect(result, moment).toEqual({ status: 'not-started', code: null, reason: 'environment-changed', output: SETTINGS_CHANGED });
      expect(commands(), moment).toEqual([]);
    }
  });

  it('creates no replacement terminal once trust is withdrawn while the first one is being retired', async () => {
    vs.state.nextTerminals.push({ shell: 'pwsh', reportedCwd: '/work/sibling', integrate: true });
    let trusted = true;
    const { manager, terminate } = harness();
    terminate.mockImplementation(async () => { trusted = false; return { status: 'confirmed-stopped' }; });
    const prepared = await manager.executionProviderFor('dev', 'Unode: dev').acquire({ cwd: ROOT, startRefusal: () => (trusted ? undefined : UNTRUSTED) });
    if (!prepared.ok) throw new Error(prepared.message);
    expect(await prepared.execute('npm test', 10_000)).toMatchObject({ status: 'not-started', output: UNTRUSTED.message });
    await prepared.release();
    expect(vs.state.created).toHaveLength(1);
    expect(commands()).toEqual([]);
  });

  it('checks the start condition of the direct fallback too, when its command would start', async () => {
    let trusted = true;
    const { manager, direct } = harness({ hint: NO_HINT });
    const prepared = await manager.executionProviderFor('dev', 'Unode: dev').acquire({ cwd: ROOT, startRefusal: () => (trusted ? undefined : UNTRUSTED) });
    expect(prepared).toMatchObject({ ok: true, transport: 'direct' });
    if (!prepared.ok) return;
    trusted = false;
    expect(await prepared.execute('npm test', 10_000)).toMatchObject({ status: 'not-started', output: UNTRUSTED.message });
    trusted = true;
    expect(await prepared.execute('npm test', 10_000)).toMatchObject({ status: 'not-started', reason: 'disposed' });
    await prepared.release();
    expect(direct.executed).toEqual([]);
  });

  it('runs the command when nothing changes at those moments', async () => {
    for (const moment of MOMENTS) {
      vs.state.executed.length = 0;
      expect(await runChangingAt(moment, () => undefined, () => undefined), moment).toMatchObject({ status: 'exited', code: 0 });
      expect(commands(), moment).toHaveLength(1);
    }
  });
});

describe('TerminalManager shell identity and capture (v0.9.96)', () => {
  it('proves the terminal shell with a nonce probe and runs the command under that identity', async () => {
    const { manager } = harness();
    const result = await run(manager, 'npm test');
    expect(result).toMatchObject({ status: 'exited', code: 0 });
    expect(result.output).toBe('ran npm test\n');
    // The probe ran after the approval and before the command; its text holds the nonce and nothing else.
    expect(vs.state.executed.map((entry) => entry.text)).toEqual([
      "Write-Output ('__UNODE_CAPTURE_abc123__:' + $PSHOME + ':' + $PSVersionTable.PSEdition)",
      'npm test',
    ]);
  });

  it('classifies Windows PowerShell, pwsh and POSIX shells, and keeps the probe out of the result', async () => {
    const seen: Array<[string, string]> = [];
    for (const shell of ['windows-powershell', 'pwsh', 'bash', 'zsh'] as const) {
      vs.state.defaultSetup = { shell, reportedCwd: ROOT, integrate: true };
      const { manager } = harness({ hint: HINTS[shell] });
      const result = await run(manager, 'echo hi', `agent-${shell}`);
      expect(result).toMatchObject({ status: 'exited' });
      expect(result.output).not.toContain('__UNODE_CAPTURE_');
      const proved = await lease(manager, `agent-${shell}`);
      seen.push([proved.shell.kind, proved.shell.grammar]);
      await proved.release();
      await manager.disposeAll();
    }
    expect(seen).toEqual([['windows-powershell', 'powershell'], ['pwsh', 'powershell'], ['bash', 'posix'], ['zsh', 'posix']]);
  });

  it('accepts a quiet exit as data, without degrading this terminal or another agent', async () => {
    const { manager, direct } = harness();
    vs.state.onCommand = (_text, control) => control.finish(0);
    expect(await run(manager, 'git diff --quiet')).toMatchObject({ status: 'exited', code: 0, output: '' });

    vs.state.onCommand = undefined;
    const next = await lease(manager, 'dev');
    expect(next.transport).toBe('terminal');
    expect(await next.execute('echo again', 10_000)).toMatchObject({ status: 'exited', code: 0 });
    await next.release();
    const other = await lease(manager, 'reviewer');
    expect(other.transport).toBe('terminal');
    await other.release();
    expect(direct.prepared).toBe(0);
    // The quiet command left its terminal in use: the second command ran in the same one.
    expect(vs.state.created).toHaveLength(1);
    expect(commands().map((entry) => entry.terminal)).toEqual([vs.state.created[0], vs.state.created[0]]);
  });

  it('probes again once someone else ran something in the managed terminal', async () => {
    const { manager } = harness();
    await run(manager, 'echo one');
    const terminal = vs.state.created[0];
    const manual = { commandLine: { value: 'pwsh' } };
    vs.emitters.start.fire({ terminal, execution: manual });
    vs.emitters.end.fire({ terminal, execution: manual, exitCode: 0 });

    await run(manager, 'echo two');
    expect(probes()).toHaveLength(2);
  });

  it('proves the shell again before every command, because a command may change it', async () => {
    const { manager, direct } = harness();
    // The first command leaves a bash running in the agent's PowerShell terminal.
    vs.state.onCommand = (_text, control) => {
      vs.state.created[0].shellKind = 'bash';
      control.finish(0);
    };
    await run(manager, 'bash');
    vs.state.onCommand = undefined;

    // The next command is approved for the shell the terminal last proved. The terminal no longer proves it, so a
    // new terminal is made for the command, and the profile is not blamed.
    const result = await run(manager, 'npm test');
    expect(result).toMatchObject({ status: 'exited', code: 0 });
    expect(probes()).toHaveLength(3);
    expect(vs.state.created).toHaveLength(2);
    expect(vs.state.created[0].dispose).toHaveBeenCalled();
    expect(commands().map((entry) => [entry.terminal, entry.text])).toEqual([[vs.state.created[0], 'bash'], [vs.state.created[1], 'npm test']]);
    const third = await lease(manager);
    expect(third.transport).toBe('terminal');
    await third.release();
    expect(direct.prepared).toBe(0);
  });

  it('runs nothing when a new terminal proves another shell than the one approved, and checks the retry for it', async () => {
    vs.state.defaultSetup = { shell: 'windows-powershell', reportedCwd: ROOT, integrate: true };
    const { manager, direct } = harness({ hint: HINTS.pwsh });
    const result = await run(manager, 'npm test && npm run lint');
    expect(result).toEqual({
      status: 'not-started',
      code: null,
      reason: 'environment-changed',
      output: 'Command not run: the agent terminal runs Windows PowerShell, not PowerShell 7 (pwsh) as the command was checked and '
        + 'approved for. Retry: the next command is checked for Windows PowerShell.',
    });
    expect(commands()).toEqual([]);
    // The retry is checked, and approved, for the shell the terminal proved, and runs in the same terminal.
    const retry = await lease(manager);
    expect(retry.shell).toMatchObject({ kind: 'windows-powershell', source: 'terminal-probe' });
    expect(await retry.execute('npm test; npm run lint', 10_000)).toMatchObject({ status: 'exited' });
    await retry.release();
    expect(vs.state.created).toHaveLength(1);
    expect(direct.prepared).toBe(0);
  });

  it('a failed probe disposes only that terminal and takes the named fallback: wrong nonce, failing exit, two records', async () => {
    for (const answer of [
      (_text: string, control: any) => control.finish(0, '__UNODE_CAPTURE_ffffff__:C:\\PS:Core\r\n'),
      (text: string, control: any) => control.finish(1, `${/(__UNODE_CAPTURE_[0-9a-f]+__)/.exec(text)![1]}:C:\\PS:Core\r\n`),
      (text: string, control: any) => {
        const tag = /(__UNODE_CAPTURE_[0-9a-f]+__)/.exec(text)![1];
        control.finish(0, `${tag}:C:\\PS:Core\r\n${tag}:C:\\PS:Desktop\r\n`);
      },
    ]) {
      vs.state.created.length = 0;
      vs.state.executed.length = 0;
      const { manager, direct } = harness();
      const original = vs.window.createTerminal.getMockImplementation()!;
      vs.window.createTerminal.mockImplementationOnce((options: Record<string, any>) => {
        const terminal = original(options);
        terminal.probeOverride = answer;
        return terminal;
      });
      expect(await run(manager, 'npm test')).toEqual({
        status: 'not-started',
        code: null,
        reason: 'environment-changed',
        output: `Command not run: The selected terminal profile could not prove its shell. ${NEXT_IS_DIRECT}`,
      });
      expect(commands()).toEqual([]);
      expect(vs.state.created[0].dispose).toHaveBeenCalled();
      const next = await manager.executionProviderFor('dev', 'Unode: dev').acquire({ cwd: ROOT });
      expect(next).toMatchObject({ ok: true, transport: 'direct' });
      expect(direct.prepared).toBe(1);
      if (next.ok) await next.release();
      expect(vs.state.created).toHaveLength(1);
      await manager.disposeAll();
    }
  });

  it('fails closed when the profile hint and the probe disagree', async () => {
    vs.state.defaultSetup = { shell: 'pwsh', reportedCwd: ROOT, integrate: true };
    const { manager, direct } = harness({ hint: HINTS.bash });
    expect(await run(manager, 'npm test')).toMatchObject({ status: 'not-started', reason: 'environment-changed' });
    expect(commands()).toEqual([]);
    const prepared = await manager.executionProviderFor('dev', 'Unode: dev').acquire({ cwd: ROOT });
    expect(prepared).toMatchObject({ ok: true, transport: 'direct' });
    expect(direct.prepared).toBe(1);
    if (prepared.ok) {
      expect(prepared.notice).toBe('The selected terminal profile could not prove its shell. This invocation will use the declared direct fallback: cmd.exe.');
      await prepared.release();
    }
  });
});

describe('TerminalManager working directory (v0.9.96)', () => {
  it('never runs in a terminal at another folder: it replaces it once and runs in the authorised one', async () => {
    vs.state.nextTerminals.push({ shell: 'pwsh', reportedCwd: '/work/sibling', integrate: true });
    const { manager, terminate } = harness();
    expect(await run(manager, 'pwd')).toMatchObject({ status: 'exited' });
    expect(vs.state.created).toHaveLength(2);
    expect(vs.state.created[0].dispose).toHaveBeenCalled();
    expect(terminate).toHaveBeenCalledWith(2000);
    expect(commands()).toEqual([{ terminal: vs.state.created[1], text: 'pwd' }]);
    // No `cd` was ever sent to repair a terminal.
    for (const terminal of vs.state.created) expect(terminal.sendText).not.toHaveBeenCalled();
  });

  it('runs nothing when the replacement cannot prove the folder either, and remembers it for the named direct fallback', async () => {
    vs.state.defaultSetup = { shell: 'pwsh', reportedCwd: '/somewhere/else', integrate: true };
    const { manager, direct } = harness();
    expect(await run(manager, 'npm test')).toEqual({
      status: 'not-started',
      code: null,
      reason: 'environment-changed',
      output: `Command not run: The agent terminal could not prove that it starts in the authorised folder. ${NEXT_IS_DIRECT}`,
    });
    expect(vs.state.created).toHaveLength(2);
    expect(commands()).toEqual([]);

    const again = await manager.executionProviderFor('dev', 'Unode: dev').acquire({ cwd: ROOT });
    expect(again).toMatchObject({ ok: true, transport: 'direct', shell: CMD_SHELL });
    if (again.ok) {
      expect(again.notice).toBe('The agent terminal could not prove that it starts in the authorised folder. This invocation will use the declared direct fallback: cmd.exe.');
      await again.release();
    }
    expect(vs.state.created).toHaveLength(2);
    expect(direct.prepared).toBe(1);
  });

  it('accepts a physically equal folder under another spelling and refuses an unreadable one', async () => {
    vs.state.defaultSetup = { shell: 'pwsh', reportedCwd: 'c:\\Work\\Project', integrate: true };
    const physical = new Map([['C:\\work\\project', 'C:\\work\\project'], ['c:\\Work\\Project', 'C:\\work\\project'], ['C:\\link\\project', 'C:\\work\\project']]);
    const realpath = async (candidate: string) => {
      const target = physical.get(candidate);
      if (!target) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return target;
    };
    const { manager } = harness({ realpath, platform: 'win32' });
    expect(await run(manager, 'dir', 'dev', 'C:\\work\\project')).toMatchObject({ status: 'exited' });

    vs.state.defaultSetup = { shell: 'pwsh', reportedCwd: 'C:\\link\\project', integrate: true };
    const junction = harness({ realpath, platform: 'win32' });
    expect(await run(junction.manager, 'dir', 'dev', 'C:\\work\\project')).toMatchObject({ status: 'exited' });

    vs.state.defaultSetup = { shell: 'pwsh', reportedCwd: 'C:\\gone', integrate: true };
    const missing = harness({ realpath, platform: 'win32' });
    expect(await run(missing.manager, 'dir', 'dev', 'C:\\work\\project')).toMatchObject({ status: 'not-started', reason: 'environment-changed' });
    expect(commands()).toHaveLength(2);
  });

  it('waits for the folder a shell reports after its integration activates, within the integration bound', async () => {
    vi.useFakeTimers();
    vs.state.defaultSetup = { shell: 'pwsh', reportedCwd: ROOT, integrate: true, cwdLater: true };
    const { manager, direct } = harness();
    const running = run(manager, 'npm test');
    await vi.advanceTimersByTimeAsync(100);
    expect(await running).toMatchObject({ status: 'exited' });
    expect(vs.state.created).toHaveLength(1);
    expect(direct.prepared).toBe(0);
  });

  it('treats a terminal that reports no folder, or a remote one, as unproved and never runs there', async () => {
    vi.useFakeTimers();
    for (const [setup, hint] of [
      [{ shell: 'pwsh' as const, reportedCwd: undefined, integrate: true }, HINTS.pwsh],
      [{ shell: 'bash' as const, reportedCwd: ROOT, integrate: true, cwdScheme: 'vscode-remote' }, HINTS.bash],
    ] as const) {
      vs.state.created.length = 0;
      vs.state.executed.length = 0;
      vs.state.defaultSetup = setup;
      const { manager, direct } = harness({ hint });
      const running = run(manager, 'npm test');
      // A folder that never comes is waited for within the integration bound, for each of the two terminals.
      await vi.advanceTimersByTimeAsync(2 * SHELL_INTEGRATION_TIMEOUT_MS + 50);
      expect(await running, JSON.stringify(setup)).toMatchObject({ status: 'not-started', reason: 'environment-changed' });
      expect(commands()).toEqual([]);
      expect(vs.state.created).toHaveLength(2);
      // The next command takes the named fallback, approved as such.
      expect(await run(manager, 'npm test')).toMatchObject({ status: 'exited', output: 'direct ran' });
      expect(direct.executed).toEqual(['npm test']);
      expect(vs.state.created).toHaveLength(2);
      await manager.disposeAll();
    }
  });

  it('runs nothing when the terminal changed folder after it was checked', async () => {
    const { manager, direct } = harness();
    const original = vs.window.createTerminal.getMockImplementation()!;
    vs.window.createTerminal.mockImplementationOnce((options: Record<string, any>) => {
      const terminal = original(options);
      // The folder moves while the shell is being proved, after its folder was checked.
      terminal.probeOverride = (text: string, control: any) => {
        terminal.reportedCwd = '/work/sibling';
        control.finish(0, `${/(__UNODE_CAPTURE_[0-9a-f]+__)/.exec(text)![1]}:C:\\PS:Core\r\n`);
      };
      return terminal;
    });
    expect(await run(manager, 'npm test')).toEqual({
      status: 'not-started',
      code: null,
      reason: 'environment-changed',
      output: 'Command not run: the prepared terminal changed working directory after approval. Retry to check the command against the current execution environment.',
    });
    expect(commands()).toEqual([]);
    expect(direct.prepared).toBe(0);
  });

  it('reports a folder change after the start as an unknown outcome, stops it and never calls it not run', async () => {
    vs.state.defaultSetup = { shell: 'pwsh', reportedCwd: ROOT, integrate: true, startCwd: '/elsewhere' };
    const { manager, terminate } = harness();
    vs.state.onCommand = () => { /* runs on */ };
    const result = await run(manager, 'npm test');
    expect(result).toMatchObject({ status: 'outcome-unknown', reason: 'cwd-changed-after-start' });
    expect(result.status).not.toBe('not-started');
    expect(terminate).toHaveBeenCalled();
  });
});

describe('TerminalManager lanes (v0.9.96)', () => {
  it('serializes one agent, including while its first command waits for approval, and lets other agents run', async () => {
    const { manager } = harness();
    const first = await lease(manager, 'dev');
    let secondReady = false;
    const second = manager.executionProviderFor('dev', 'Unode: dev').acquire({ cwd: ROOT }).then((value) => { secondReady = true; return value; });
    const other = await lease(manager, 'reviewer');
    expect(other.transport).toBe('terminal');
    await settle(50);
    expect(secondReady).toBe(false);
    await first.execute('echo first', 10_000);
    await settle(50);
    expect(secondReady).toBe(false);
    await first.release();
    const ready = await second;
    expect(ready.ok).toBe(true);
    if (ready.ok) await ready.release();
    await other.release();
  });

  it('a released first preparation does not poison the second', async () => {
    const { manager } = harness();
    const refused = await lease(manager);
    await refused.release();
    await refused.release();
    expect(await run(manager, 'echo next')).toMatchObject({ status: 'exited' });
  });

  it('runs a prepared command at most once', async () => {
    const { manager } = harness();
    const prepared = await lease(manager);
    await prepared.execute('echo once', 10_000);
    expect(await prepared.execute('echo once', 10_000)).toMatchObject({ status: 'not-started', reason: 'disposed' });
    await prepared.release();
    expect(commands()).toHaveLength(1);
  });

  it('removing an agent aborts its approval wait at once, refuses its queued work and never starts either', async () => {
    const { manager } = harness();
    const waiting = await lease(manager, 'dev');
    const queued = manager.executionProviderFor('dev', 'Unode: dev').acquire({ cwd: ROOT });
    let aborted = false;
    waiting.signal.addEventListener('abort', () => { aborted = true; });

    // Nobody answers the approval; removal must not wait for its deadline.
    await manager.dispose('dev');

    expect(aborted).toBe(true);
    expect(await queued).toMatchObject({ ok: false, reason: 'disposed' });
    expect(await waiting.execute('echo late', 10_000)).toMatchObject({ status: 'not-started', reason: 'disposed' });
    await waiting.release();
    expect(commands()).toEqual([]);
    expect(vs.state.created).toEqual([]);
    // A later acquisition is a fresh lane.
    const fresh = await lease(manager, 'dev');
    expect(fresh.transport).toBe('terminal');
    await fresh.release();
  });

  it('reveal shows an idle agent a terminal but creates none while a command holds the lane', async () => {
    const { manager } = harness();
    manager.reveal('dev', 'Unode: dev', ROOT);
    expect(vs.state.created).toHaveLength(1);
    const prepared = await lease(manager, 'dev');
    vs.state.created[0].dispose();
    await settle();
    manager.reveal('dev', 'Unode: dev', ROOT);
    expect(vs.state.created).toHaveLength(1);
    await prepared.release();
  });

  it('a background command prepared before a quarantine or a reset does not start after it', async () => {
    vi.useFakeTimers();
    const { manager, direct } = harness({ terminate: { status: 'unknown', detail: 'process 9 was still running' } });
    // Prepared, and then waiting for its approval, while a foreground command of the same agent runs.
    const background = manager.executionProviderFor('dev', 'Unode: dev').prepareDirect!();
    expect(background).toMatchObject({ ok: true });
    vs.state.onCommand = () => { /* ignores Ctrl-C */ };
    const prepared = await lease(manager);
    const running = prepared.execute('node hang.js', 500);
    await vi.advanceTimersByTimeAsync(500 + TERMINAL_INTERRUPT_GRACE_MS + 10);
    expect(await running).toMatchObject({ status: 'outcome-unknown', reason: 'stop-unconfirmed' });
    await prepared.release();
    if (!background.ok) return;
    expect(background.startBackground('npm run dev', { cwd: ROOT })).toMatchObject({
      ok: false,
      notStarted: { ok: false, reason: 'previous-process-unknown' },
    });
    expect(await background.execute('npm run build', { cwd: ROOT })).toMatchObject({ status: 'not-started' });

    // A lane reset refuses a background command prepared before it, too.
    const other = manager.executionProviderFor('qa', 'Unode: qa').prepareDirect!();
    await manager.dispose('qa');
    expect(other.ok && other.startBackground('npm run dev', { cwd: ROOT })).toMatchObject({ ok: false, notStarted: { reason: 'disposed' } });
    expect(direct.started).toEqual([]);
    expect(direct.executed).toEqual([]);
  });
});

describe('TerminalManager timeout and process ownership (v0.9.96)', () => {
  it('interrupts with a raw Ctrl-C, terminates and replaces the terminal even when the job ended in grace', async () => {
    vi.useFakeTimers();
    const { manager, terminate } = harness();
    const prepared = await lease(manager);
    vs.state.onCommand = (_text, control) => {
      // Ctrl-C returns the prompt: the shell job ends during the grace period.
      vs.state.created[0].sendText.mockImplementation(() => control.finish(130));
    };
    const running = prepared.execute('npm run watch', 1_000);
    await vi.advanceTimersByTimeAsync(1_000 + TERMINAL_INTERRUPT_GRACE_MS + 10);
    const result = await running;
    await prepared.release();

    expect(vs.state.created[0].sendText).toHaveBeenCalledWith('\x03', false);
    expect(terminate).toHaveBeenCalledWith(2000);
    expect(vs.state.created[0].dispose).toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'timed-out', stopConfirmed: true });

    vs.state.onCommand = undefined;
    const next = run(manager, 'echo next');
    await vi.advanceTimersByTimeAsync(10);
    expect(await next).toMatchObject({ status: 'exited' });
    expect(vs.state.created).toHaveLength(2);
    expect(commands().at(-1)).toEqual({ terminal: vs.state.created[1], text: 'echo next' });
  });

  it('holds the lane through grace and tree cleanup: the next command waits until the stop has finished', async () => {
    vi.useFakeTimers();
    const { manager, terminate } = harness();
    let finishStop!: (outcome: ProcessTerminationOutcome) => void;
    terminate.mockImplementation(() => new Promise<ProcessTerminationOutcome>((resolve) => { finishStop = resolve; }));
    const prepared = await lease(manager);
    vs.state.onCommand = () => { /* ignores Ctrl-C */ };
    const running = prepared.execute('node hang.js', 100);
    let nextReady = false;
    const next = manager.executionProviderFor('dev', 'Unode: dev').acquire({ cwd: ROOT }).then((value) => { nextReady = true; return value; });
    await vi.advanceTimersByTimeAsync(100 + TERMINAL_INTERRUPT_GRACE_MS + 50);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(nextReady).toBe(false);
    finishStop({ status: 'confirmed-stopped' });
    expect(await running).toMatchObject({ status: 'timed-out' });
    await vi.advanceTimersByTimeAsync(10);
    expect(nextReady).toBe(false);
    await prepared.release();
    await vi.advanceTimersByTimeAsync(10);
    const ready = await next;
    expect(ready.ok).toBe(true);
    if (ready.ok) await ready.release();
  });

  it('quarantines the agent when the stop is unconfirmed, without falling back, until a reset', async () => {
    vi.useFakeTimers();
    const { manager, direct } = harness({ terminate: { status: 'unknown', detail: 'process 9 was still running' } });
    const prepared = await lease(manager);
    vs.state.onCommand = () => { /* ignores Ctrl-C */ };
    const running = prepared.execute('node hang.js', 500);
    await vi.advanceTimersByTimeAsync(500 + TERMINAL_INTERRUPT_GRACE_MS + 10);
    const result = await running;
    await prepared.release();
    expect(result).toMatchObject({ status: 'outcome-unknown', reason: 'stop-unconfirmed' });
    expect(result.output).toContain('Command timed out. UnodeAi could not confirm that its process tree stopped, so no later command will start for this agent.');

    const refused = await manager.executionProviderFor('dev', 'Unode: dev').acquire({ cwd: ROOT });
    expect(refused).toMatchObject({ ok: false, reason: 'previous-process-unknown' });
    expect(direct.prepared).toBe(0);
    // A background command does not start past the quarantine either; another agent's does.
    expect(manager.executionProviderFor('dev', 'Unode: dev').prepareDirect?.()).toMatchObject({ ok: false, reason: 'previous-process-unknown' });
    expect(manager.executionProviderFor('qa', 'Unode: qa').prepareDirect?.()).toMatchObject({ ok: true });

    await manager.dispose('dev');
    const afterReset = manager.executionProviderFor('dev', 'Unode: dev').acquire({ cwd: ROOT });
    await vi.advanceTimersByTimeAsync(10);
    expect(await afterReset).toMatchObject({ ok: true });
    expect(manager.executionProviderFor('dev', 'Unode: dev').prepareDirect?.()).toMatchObject({ ok: true });
  });

  it('a terminal that closes while a command runs is an unknown outcome, never replayed, and quarantines the agent', async () => {
    const { manager, direct } = harness();
    // A terminal that closed while idle is simply replaced for the next command.
    await run(manager, 'echo one');
    vs.state.created[0].dispose();
    await settle();
    expect(await run(manager, 'echo two')).toMatchObject({ status: 'exited' });
    expect(vs.state.created).toHaveLength(2);

    vs.state.onCommand = (_text, control) => control.close();
    const result = await run(manager, 'npm test');
    expect(result).toMatchObject({ status: 'outcome-unknown', reason: 'terminal-died' });
    expect(result.output).toContain('The agent terminal closed while this command ran, so UnodeAi could not confirm that the command\'s processes stopped. No later command will start for this agent.');
    expect(commands().filter((entry) => entry.text === 'npm test')).toHaveLength(1);
    expect(direct.executed).toEqual([]);
    // Whatever the shell started may still run: nothing more starts for this agent until a reset.
    expect(await manager.executionProviderFor('dev', 'Unode: dev').acquire({ cwd: ROOT })).toMatchObject({ ok: false, reason: 'previous-process-unknown' });
    expect(manager.executionProviderFor('dev', 'Unode: dev').prepareDirect?.()).toMatchObject({ ok: false, reason: 'previous-process-unknown' });
  });

  it('an executeCommand throw is an unknown outcome, never replayed through the fallback', async () => {
    vs.state.defaultSetup = { shell: 'pwsh', reportedCwd: ROOT, integrate: true, commandThrows: true };
    const { manager, direct } = harness();
    const result = await run(manager, 'npm test');
    expect(result).toMatchObject({ status: 'outcome-unknown' });
    expect(direct.prepared).toBe(0);
    expect(direct.executed).toEqual([]);
  });

  it('keeps the head and the tail of long output', async () => {
    const { manager } = harness();
    vs.state.onCommand = (_text, control) => {
      control.output(`FIRST LINE\n${'x'.repeat(50_000)}\n`);
      control.finish(1, 'THE ERROR AT THE END\n');
    };
    const result = await run(manager, 'npm test');
    expect(result.output.startsWith('FIRST LINE')).toBe(true);
    expect(result.output.endsWith('THE ERROR AT THE END\n')).toBe(true);
    expect(result.output).toMatch(/…\[omitted \d+ characters; showing command output head and tail\]…/);
  });
});

describe('TerminalManager failed profiles and listeners (v0.9.96)', () => {
  it('caches a profile without integration per agent and settings revision, without another five-second wait', async () => {
    vi.useFakeTimers();
    const { manager, direct } = harness();
    // Another agent already has a working terminal before this agent's profile fails.
    const reviewerFirst = run(manager, 'echo reviewer', 'reviewer');
    await vi.advanceTimersByTimeAsync(10);
    expect(await reviewerFirst).toMatchObject({ status: 'exited' });
    vs.state.created.length = 0;
    vs.state.defaultSetup = { shell: 'pwsh', reportedCwd: ROOT, integrate: false };
    const first = run(manager, 'npm test', 'dev');
    await vi.advanceTimersByTimeAsync(SHELL_INTEGRATION_TIMEOUT_MS + 10);
    expect(await first).toEqual({
      status: 'not-started',
      code: null,
      reason: 'environment-changed',
      output: `Command not run: The selected terminal profile could not prove shell integration and cwd. ${NEXT_IS_DIRECT}`,
    });
    expect(vs.state.created).toHaveLength(1);

    // The same agent and settings: straight to the fallback, no terminal, no wait.
    const cached = await manager.executionProviderFor('dev', 'Unode: dev').acquire({ cwd: ROOT });
    expect(cached).toMatchObject({ ok: true, transport: 'direct' });
    if (cached.ok) {
      expect(cached.notice).toBe('The selected terminal profile could not prove shell integration and cwd. This invocation will use the declared direct fallback: cmd.exe.');
      await cached.release();
    }
    expect(vs.state.created).toHaveLength(1);

    // Another agent is not affected by this agent's cache: its proved terminal still runs its commands.
    const other = run(manager, 'echo again', 'reviewer');
    await vi.advanceTimersByTimeAsync(10);
    expect(await other).toMatchObject({ status: 'exited', output: 'ran echo again\n' });
    expect(vs.state.created).toHaveLength(1);

    // A settings change makes the cached failure stale.
    manager.profileSettingsChanged();
    vs.state.defaultSetup = { shell: 'pwsh', reportedCwd: ROOT, integrate: true };
    const retried = run(manager, 'npm test', 'dev');
    await vi.advanceTimersByTimeAsync(10);
    expect(await retried).toMatchObject({ status: 'exited' });
    expect(direct.prepared).toBe(1);
  });

  it('retires a terminal made under other profile settings and proves the new settings in a new terminal', async () => {
    const { manager, hint, direct } = harness();
    await run(manager, 'echo one');
    // The person switches the default terminal profile to bash.
    manager.profileSettingsChanged();
    hint.current = HINTS.bash;
    vs.state.defaultSetup = { shell: 'bash', reportedCwd: ROOT, integrate: true };

    const next = await lease(manager);
    // Named from the new settings, not from the old terminal's proof.
    expect(next.shell).toMatchObject({ kind: 'bash', source: 'terminal-profile' });
    expect(vs.state.created[0].dispose).not.toHaveBeenCalled();
    expect(await next.execute('echo two', 10_000)).toMatchObject({ status: 'exited' });
    await next.release();
    expect(vs.state.created).toHaveLength(2);
    expect(vs.state.created[0].dispose).toHaveBeenCalled();
    expect(commands().map((entry) => entry.terminal)).toEqual([vs.state.created[0], vs.state.created[1]]);
    // The old terminal was never probed for the new settings: one probe in each terminal.
    expect(probes().map((entry) => entry.terminal)).toEqual([vs.state.created[0], vs.state.created[1]]);
    // Nothing was blamed on the new settings.
    const third = await lease(manager);
    expect(third).toMatchObject({ transport: 'terminal', shell: { kind: 'bash', source: 'terminal-probe' } });
    await third.release();
    expect(direct.prepared).toBe(0);
  });

  it('prepares from the new settings when they change while it waits for someone\'s command to end', async () => {
    for (const [next, setup] of [
      [HINTS.bash, { shell: 'bash' as const, reportedCwd: ROOT, integrate: true }],
      // The same kind of shell under another profile: still new facts, never the old terminal's proof.
      [{ ...HINTS.pwsh, fingerprint: 'pwsh-other-profile' }, { shell: 'pwsh' as const, reportedCwd: ROOT, integrate: true }],
    ] as const) {
      vs.state.created.length = 0;
      vs.state.executed.length = 0;
      vs.state.defaultSetup = { shell: 'pwsh', reportedCwd: ROOT, integrate: true };
      const { manager, hint } = harness();
      await run(manager, 'echo one');
      const old = vs.state.created[0];
      const manual = { commandLine: { value: 'npm run dev' } };
      vs.emitters.start.fire({ terminal: old, execution: manual });

      const preparing = manager.executionProviderFor('dev', 'Unode: dev').acquire({ cwd: ROOT });
      await settle(50);
      // While the preparation waits, the person changes the default terminal profile; then their command ends.
      manager.profileSettingsChanged();
      hint.current = next;
      vs.state.defaultSetup = setup;
      vs.emitters.end.fire({ terminal: old, execution: manual, exitCode: 0 });
      const prepared = await preparing;
      if (!prepared.ok) throw new Error(prepared.message);
      // The lease, and so the approval card, rests on the new settings alone.
      expect(prepared.shell, next.fingerprint).toMatchObject({ kind: next.kind, source: 'terminal-profile' });
      expect(await prepared.execute('npm test', 10_000)).toMatchObject({ status: 'exited' });
      await prepared.release();
      // The old terminal ran no probe after the change; the command ran in a terminal of the new settings.
      expect(old.dispose).toHaveBeenCalled();
      expect(probes().map((entry) => entry.terminal)).toEqual([old, vs.state.created[1]]);
      expect(commands().map((entry) => [entry.terminal, entry.text])).toEqual([[old, 'echo one'], [vs.state.created[1], 'npm test']]);
      await manager.disposeAll();
    }
  });

  it('never interrupts a command someone started in the managed terminal', async () => {
    vi.useFakeTimers();
    const { manager, direct } = harness();
    manager.reveal('dev', 'Unode: dev', ROOT);
    await vi.advanceTimersByTimeAsync(5);
    const terminal = vs.state.created[0];
    const manual = { commandLine: { value: 'npm run dev' } };
    vs.emitters.start.fire({ terminal, execution: manual });

    const preparing = manager.executionProviderFor('dev', 'Unode: dev').acquire({ cwd: ROOT });
    await vi.advanceTimersByTimeAsync(SHELL_INTEGRATION_TIMEOUT_MS + 10);
    const prepared = await preparing;
    expect(prepared).toMatchObject({ ok: true, transport: 'direct' });
    if (prepared.ok) {
      expect(prepared.notice).toContain('Someone is running a command in the agent terminal.');
      await prepared.release();
    }
    expect(terminal.sendText).not.toHaveBeenCalled();
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(direct.prepared).toBe(1);
  });

  it('a revision change after the terminal was checked runs nothing', async () => {
    let calls = 0;
    const realpath = async (candidate: string) => {
      calls += 1;
      // The final folder check before the start: someone runs something in the terminal meanwhile.
      if (calls === 3) {
        const terminal = vs.state.created[0];
        const manual = { commandLine: { value: 'ls' } };
        vs.emitters.start.fire({ terminal, execution: manual });
        vs.emitters.end.fire({ terminal, execution: manual, exitCode: 0 });
      }
      return candidate;
    };
    const { manager } = harness({ realpath });
    expect(await run(manager, 'npm test')).toEqual({
      status: 'not-started',
      code: null,
      reason: 'environment-changed',
      output: 'Command not run: the prepared terminal changed after approval. Retry to check the command against the current execution environment.',
    });
    expect(commands()).toEqual([]);
  });

  it('leaves only the manager-lifetime listeners between commands, and none after disposal', async () => {
    const baseline = vs.liveListeners();
    const { manager } = harness();
    for (const command of ['echo a', 'echo b']) await run(manager, command);
    expect(vs.liveListeners()).toBe(baseline + 3);
    await manager.disposeAll();
    expect(vs.liveListeners()).toBe(baseline);
  });

  it('bounds the whole probe in time', () => {
    expect(CAPTURE_PROBE_TIMEOUT_MS).toBe(2_000);
    expect(SHELL_INTEGRATION_TIMEOUT_MS).toBe(5_000);
    expect(TERMINAL_INTERRUPT_GRACE_MS).toBe(2_000);
  });
});
