import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { refreshCodexModels } from '../host/CodexModelRefresh';

/*
 * v0.9.96: the host wiring of Check / choose CLI. The policy is tested in cliRuntime, CliRuntimeChooser and the
 * backends; these pin that the extension routes through it.
 */

const source = readFileSync(join(process.cwd(), 'src/extension.ts'), 'utf8');

/** The source of one top-level function, from its signature to its closing brace. */
function body(signature: string): string {
  const start = source.indexOf(signature);
  expect(start, signature).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
}

/**
 * Top-level functions of extension.ts, compiled alone and run against stand-ins for the module state they read, as
 * deactivate.test.ts does: the extension does not load outside VS Code.
 */
function compiled(signatures: string[], names: string[], state: Record<string, unknown>): Record<string, any> {
  const js = signatures.map((signature) => ts.transpileModule(body(signature), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText).join('\n');
  return new Function('state', `with (state) { ${js}; return { ${names.join(', ')} }; }`)(state);
}

describe('Check / choose CLI wiring (v0.9.96)', () => {
  it('starts Claude with the host-selected program, injected apart from the resolver of host programs', () => {
    const deps = source.slice(source.indexOf('const claudeDeps: ClaudeHeadlessBackendDeps = {'), source.indexOf('return new ClaudeHeadlessBackend('));
    expect(deps).toContain('resolveExecutable: resolveHostProgram,');
    // v0.9.97: through the resolver, with who asked for the start, so a pinned start gets its pinned program only.
    expect(deps).toMatch(/resolveClaudeLaunch: async \(start\) => \{\s*const resolved = await cliRuntimeHost\(\)\.resolver\.resolveExternal\(\{\s*provider: 'claude-cli', sessionId: scopedConfig\.id, pin: start\.pin, onPending: start\.onPending,/);
    expect(deps).toContain('claudeLaunchByAgent.set(scopedConfig.id, launch);');
    expect(body('function currentClaudeLaunch(')).toContain("resolveClaudeCliLaunch(configuredSetting<string>('claudeCliPath', ''), resolveHostProgram)");
    // The resolver's external program is the configured one, resolved as before.
    expect(body('function cliRuntimeHost(')).toMatch(/if \(provider === 'claude-cli'\) \{\s*const launch = currentClaudeLaunch\(\);/);
  });

  it('checks or lists programs only from Check / choose CLI, never at activation', () => {
    const port = body('function cliRuntimePort(');
    for (const call of ['checkClaudeCliVersion(', 'discoverClaudeCliCandidates(', 'discoverCodexExtensionCandidates(']) {
      const sites = source.split(call).length - 1;
      const inPort = port.split(call).length - 1;
      const definitions = call === 'checkClaudeCliVersion(' ? 1 : 0;
      expect(sites - definitions, call).toBe(inPort);
    }
    const activate = body('export async function activate(');
    expect(activate).not.toMatch(/chooseCliRuntime\(|checkClaudeCliVersion\(|discoverClaudeCliCandidates\(/);
  });

  it('saves only the user setting, after the chooser\'s confirmation', () => {
    const port = body('function cliRuntimePort(');
    expect(port).toMatch(/update\(provider === 'claude-cli' \? 'claudeCliPath' : 'codexCliPath', settingValue, vscode\.ConfigurationTarget\.Global\)/);
    expect(body('async function confirmCliRuntime(')).toMatch(/if \(choice !== USE_THIS_CLI\) return false;/);
  });

  it('binds a Codex model list to the program that returned it, through the refresh flow and its selection check', () => {
    const refresh = body('async function loadCodexModelsForPicker(');
    expect(refresh).toContain('select: () => configuredOrChosenCodexExecutable(),');
    expect(refresh).toContain('stillSelected: (selection) => codexSelectionCurrent(selection),');
    expect(refresh).toContain("consent: (program) => codexEgressGate(undefined, 'Agent Builder model loader', program),");
    expect(refresh).toContain('binaryPath: program,');
    expect(refresh).toContain('discover: (program, assertCurrent) => {');
    expect(refresh).toMatch(/loadCodexAccountModels\(\{[^}]*assertCurrent,/);
    expect(refresh).toContain('remember: (models, selection) => rememberCodexAccountModels(models, selection.program, selection.version),');
    expect(refresh).not.toMatch(/selected\.|configuredCodexCliPath\(/);
    expect(source).toContain('onModels: (models, cliVersion, program) => (cliVersion ? rememberCodexAccountModels(models, program.executable, cliVersion) : undefined),');
    // v0.9.97: with managed Codex selected, the list comes from its admitted start, after the consent with its program.
    expect(refresh).toMatch(/runtime\.resolver\.startTransient\(\{\s*provider: 'codex-cli',\s*beforeStart: \(executable\) => codexEgressGate\(undefined, 'Agent Builder model loader', executable\),/);
    // An external program runs for its checks only once it is qualified or chosen.
    expect(body('async function configuredOrChosenCodexExecutable(')).toMatch(/const program = \(await cliRuntimeHost\(\)\.resolver\.resolveExternalTransient\(\{ provider: 'codex-cli' \}\)\)\.physical;\s*const stamp = cliProgramStamp\(program\) \?\? '';\s*const version = await verifyCodexCli\(program, process\.env\);/);
  });

  it('captures the Codex selection before its first check, and finds it stale after any change', async () => {
    let setting = 'C:\\npm\\codex.exe';
    const stamps = new Map([['C:\\npm\\codex.exe', 'A'], ['C:\\other\\codex.exe', 'B']]);
    const recorded: unknown[] = [];
    const state = {
      configuredSetting: () => setting,
      // npm's launcher resolves to the program beside it.
      configuredCodexCliPath: () => setting.replace(/\.cmd$/, '.exe'),
      cliProgramStamp: (program: string) => stamps.get(program),
      verifyCodexCli: async () => { setting = 'C:\\other\\codex.exe'; return '0.163.0'; },
      recordCliRuntimeCheck: async (check: unknown) => { recorded.push(check); },
      chooseCliRuntime: async () => { throw new Error('not chosen when configured'); },
      cliRuntimePort: () => undefined,
      hostShutdown: { started: false },
      workspaceBinding: { isStale: () => false },
      sameHostPath: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
      process: { env: {} },
      cliRuntimeHost: () => ({ resolver: { resolveExternalTransient: async () => ({ physical: setting.replace(/\.cmd$/, '.exe') }) } }),
    };
    const api = compiled(['async function configuredOrChosenCodexExecutable(', 'function codexSelectionCurrent('],
      ['configuredOrChosenCodexExecutable', 'codexSelectionCurrent'], state);
    const selection = await api.configuredOrChosenCodexExecutable();
    // The selection is what was configured when the check began, not what the setting became during it.
    expect(selection).toEqual({ setting: 'C:\\npm\\codex.exe', program: 'C:\\npm\\codex.exe', version: '0.163.0', stamp: 'A' });
    expect(api.codexSelectionCurrent(selection)).toBe(false);
    setting = 'C:\\npm\\codex.exe';
    expect(api.codexSelectionCurrent(selection)).toBe(true);
    // Another setting is another selection, even when it starts the same program.
    setting = 'C:\\npm\\codex.cmd';
    expect(api.codexSelectionCurrent(selection)).toBe(false);
    setting = 'C:\\npm\\codex.exe';
    stamps.set('C:\\npm\\codex.exe', 'replaced in place');
    expect(api.codexSelectionCurrent(selection)).toBe(false);
    stamps.set('C:\\npm\\codex.exe', 'A');
    state.hostShutdown.started = true;
    expect(api.codexSelectionCurrent(selection)).toBe(false);
    state.hostShutdown.started = false;
    state.workspaceBinding.isStale = () => true;
    expect(api.codexSelectionCurrent(selection)).toBe(false);
    expect(recorded).toEqual([expect.objectContaining({ program: 'C:\\npm\\codex.exe', version: '0.163.0', stamp: 'A' })]);
  });

  it('runs the whole refresh: a selection changed during its checks, consent or a closing window starts no App Server', async () => {
    const A = 'C:\\npm\\codex.exe';
    const B = 'C:\\other\\codex.exe';
    const refresh = (hooks: { onVerify?: () => void; onConsent?: () => void; onPrepare?: () => void }) => {
      let setting = A;
      const did: string[] = [];
      const state = {
        // extension.ts state and helpers the three functions read
        connectionIdForProviderId: () => 'codex-cli', effectiveConnectionRegistry: {},
        connectionProfile: () => ({ availability: 'available', catalogKind: 'codex-cli' }),
        refreshCodexModels,
        configuredSetting: () => setting, configuredCodexCliPath: () => setting,
        cliProgramStamp: (program: string) => `stamp of ${program}`,
        verifyCodexCli: async (program: string) => { did.push(`check ${program}`); hooks.onVerify?.(); return '0.163.0'; },
        recordCliRuntimeCheck: async () => undefined,
        chooseCliRuntime: async () => undefined, cliRuntimePort: () => undefined,
        codexEgressGate: async (_pending: unknown, _requester: string, program: string) => { did.push(`consent ${program}`); hooks.onConsent?.(); },
        // As the real loader: it prepares its folder, then asks right before it spawns.
        loadCodexAccountModels: async (deps: { binaryPath: string; assertCurrent: () => void }) => {
          hooks.onPrepare?.();
          deps.assertCurrent();
          did.push(`App Server ${deps.binaryPath}`);
          return [{ id: 'm', name: 'M', vision: false, isDefault: true }];
        },
        rememberCodexAccountModels: async (_models: unknown, program: string, version: string) => { did.push(`save ${program} ${version}`); },
        agentBuilderListModels: async () => [],
        extensionContext: { globalStorageUri: { fsPath: 'C:\\storage' } },
        vscode: { workspace: { workspaceFolders: [] } }, path: { join: (...parts: string[]) => parts.join('\\') },
        unodeVersion: 'test', process: { env: {} },
        hostShutdown: { started: false }, workspaceBinding: { isStale: () => false },
        sameHostPath: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
        set: (value: string) => { setting = value; },
        // External Codex, already chosen: the resolver hands back the configured program and starts nothing.
        cliRuntimeHost: () => ({ resolver: { resolveExternalTransient: async () => ({ physical: setting }) } }),
        managedChoice: () => ({ kind: 'external' }),
        CodexSelectionChangedError: Error,
      };
      const api = compiled(['async function loadCodexModelsForPicker(', 'async function configuredOrChosenCodexExecutable(', 'function codexSelectionCurrent('],
        ['loadCodexModelsForPicker'], state);
      return { run: () => api.loadCodexModelsForPicker('codex'), did, state };
    };

    const unchanged = refresh({});
    expect((await unchanged.run()).message).toBe('1 model loaded from Codex 0.163.0.');
    expect(unchanged.did).toEqual([`check ${A}`, `consent ${A}`, `App Server ${A}`, `save ${A} 0.163.0`]);

    const duringCheck = refresh({ onVerify: () => duringCheck.state.set(B) });
    expect((await duringCheck.run()).message).toMatch(/^The Codex CLI selection changed, or the window began closing, before App Server started\./);
    expect(duringCheck.did).toEqual([`check ${A}`]);

    const duringConsent = refresh({ onConsent: () => duringConsent.state.set(B) });
    await duringConsent.run();
    expect(duringConsent.did).toEqual([`check ${A}`, `consent ${A}`]);

    const closing = refresh({ onConsent: () => { closing.state.hostShutdown.started = true; } });
    await closing.run();
    expect(closing.did).toEqual([`check ${A}`, `consent ${A}`]);

    const rootChanged = refresh({ onVerify: () => { rootChanged.state.workspaceBinding.isStale = () => true; } });
    await rootChanged.run();
    expect(rootChanged.did).toEqual([`check ${A}`]);

    for (const [name, change] of [
      ['selection', (state: any) => state.set(B)],
      ['closing window', (state: any) => { state.hostShutdown.started = true; }],
      ['changed workspace', (state: any) => { state.workspaceBinding.isStale = () => true; }],
      ['replaced file', (state: any) => { state.cliProgramStamp = () => 'another file'; }],
    ] as const) {
      const duringPreparation = refresh({ onPrepare: () => change(duringPreparation.state) });
      expect((await duringPreparation.run()).message, name).toMatch(/before App Server started\. Nothing was started or saved\./);
      expect(duringPreparation.did, name).toEqual([`check ${A}`, `consent ${A}`]);
    }
  });

  it('keeps a check only for the program file that was checked, and shows nothing for a changed one', async () => {
    const stamps = new Map([['C:\\npm\\codex.exe', 'A']]);
    const state = {
      cliRuntimeChecks: [] as unknown[],
      cliProgramStamp: (program: string) => stamps.get(program),
      sameHostPath: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
      extensionContext: { globalState: { update: async () => undefined } },
      CLI_RUNTIME_CHECKS_KEY: 'test',
      SettingsPanel: { refreshCurrent: () => undefined },
    };
    const api = compiled(['function lastCliRuntimeCheck(', 'function cliRuntimeCheckOutdated(', 'async function recordCliRuntimeCheck('],
      ['lastCliRuntimeCheck', 'cliRuntimeCheckOutdated', 'recordCliRuntimeCheck'], state);
    const check = { provider: 'codex-cli', program: 'C:\\npm\\codex.exe', version: '0.163.0', checkedAt: '2026-10-18T12:00:00.000Z' };
    // A check of a file that changed before it was recorded is not kept.
    await api.recordCliRuntimeCheck({ ...check, stamp: 'before' });
    expect(state.cliRuntimeChecks).toEqual([]);
    expect(api.lastCliRuntimeCheck('codex-cli', 'C:\\npm\\codex.exe')).toBeUndefined();
    expect(api.cliRuntimeCheckOutdated('codex-cli', 'C:\\npm\\codex.exe')).toBe(false);
    await api.recordCliRuntimeCheck({ ...check, stamp: 'A' });
    expect(api.lastCliRuntimeCheck('codex-cli', 'C:\\npm\\codex.exe')).toMatchObject({ version: '0.163.0' });
    expect(api.cliRuntimeCheckOutdated('codex-cli', 'C:\\npm\\codex.exe')).toBe(false);
    stamps.set('C:\\npm\\codex.exe', 'updated by npm');
    expect(api.lastCliRuntimeCheck('codex-cli', 'C:\\npm\\codex.exe')).toBeUndefined();
    expect(api.cliRuntimeCheckOutdated('codex-cli', 'C:\\npm\\codex.exe')).toBe(true);
    // The cached Codex list is offered only for a program whose current file was checked.
    expect(body('function cachedCodexAccountModels(')).toMatch(/const measured = program \? lastCliRuntimeCheck\('codex-cli', program\)\?\.version : undefined;\s*if \(!measured\) return \[\];/);
  });

  it('starts no CLI check without its own folder, and the update terminal opens none', async () => {
    const probe = vi.fn(async () => ({ code: 0, signal: null, output: '2.1.302 (Claude Code)' }));
    const refuse = () => { throw new Error('UnodeAi could not prepare its folder for CLI programs (EPERM). Nothing was started.'); };
    const state = {
      runCliProbe: probe, runCodexCliProbe: probe, killProcessTree: vi.fn(), resolveHostProgram: vi.fn(), cliCheckFolder: refuse,
      CLAUDE_CHECK_CREDENTIAL_KEYS: [], parseClaudeCliVersion: () => '2.1.302', process: { env: {} },
    };
    const api = compiled(['async function checkClaudeCliVersion(', 'async function runCodexCli('], ['checkClaudeCliVersion', 'runCodexCli'], state);
    await expect(api.checkClaudeCliVersion('C:\\bin\\claude.exe', false)).rejects.toThrow(/Nothing was started/);
    await expect(api.runCodexCli('C:\\npm\\codex.exe', ['--version'], {})).rejects.toThrow(/Nothing was started/);
    expect(probe).not.toHaveBeenCalled();

    state.cliCheckFolder = () => 'D:\\profile\\cli-runtime-check';
    expect(await api.checkClaudeCliVersion('C:\\bin\\claude.exe', false)).toBe('2.1.302');
    expect(probe.mock.calls[0][4]).toMatchObject({ cwd: 'D:\\profile\\cli-runtime-check', shell: false });

    const created = vi.fn();
    const notices: string[] = [];
    const terminal = compiled(['function typeCliUpdateInTerminal('], ['typeCliUpdateInTerminal'], {
      CLI_PROVIDER_LABEL: { 'codex-cli': 'Codex CLI' }, cliCheckFolder: refuse,
      showResultNotice: (_kind: string, message: string) => { notices.push(message); },
      vscode: { window: { createTerminal: created } },
    });
    terminal.typeCliUpdateInTerminal('codex-cli', 'npm install -g @openai/codex@latest', 'C:\\Windows\\System32\\cmd.exe');
    expect(created).not.toHaveBeenCalled();
    expect(notices).toEqual(['UnodeAi could not prepare its folder for CLI programs (EPERM). Nothing was started. Copy the command from Update instructions instead.']);
  });

  it('copies the update command, or types it in a terminal without pressing Enter, and runs none', () => {
    const instructions = body('async function showCliUpdateInstructions(');
    expect(instructions).toContain('await vscode.env.clipboard.writeText(copied);');
    expect(instructions).toContain('typeCliUpdateInTerminal(provider, typed, shellPath);');
    // The command is written for the shell the terminal is started with.
    expect(instructions).toMatch(/const shellPath = vscode\.env\.shell;\s*const shell = cliTerminalShell\(shellPath\);/);
    expect(instructions).not.toMatch(/sendText|createTerminal|spawn\(|exec\(/);
    const terminal = body('function typeCliUpdateInTerminal(');
    // Typed, never sent with Enter; started in UnodeAi's own folder, with the shell the command was written for.
    expect(terminal).toContain('terminal.sendText(line, false);');
    expect(terminal.match(/sendText\(/g)).toHaveLength(1);
    expect(terminal).toContain('cwd = cliCheckFolder();');
    expect(terminal).toContain('vscode.window.createTerminal({ name, cwd, shellPath, isTransient: true });');
    expect(terminal).not.toMatch(/spawn\(|exec\(|executeCommand\(/);
    expect(source.split('typeCliUpdateInTerminal(').length - 1).toBe(2);
  });

  it('looks up the latest version only through the metadata consent and its gated fetch, never at activation', () => {
    const lookup = body('async function lookUpLatestCliVersion(');
    const consent = lookup.indexOf('await requestMetadataConsent(');
    const allowed = lookup.indexOf('if (!hasMetadataConsent(CLI_LATEST_HOST)) {');
    const request = lookup.indexOf('await metadataFetch(cliLatestVersionUrl(provider)');
    expect(consent).toBeGreaterThan(0);
    expect(allowed).toBeGreaterThan(consent);
    expect(request).toBeGreaterThan(allowed);
    expect(lookup).toContain("purposes: ['cli-version'], authenticated: false");
    expect(lookup).toContain('signal: controller.signal, redirect: \'error\'');
    expect(lookup).toContain('readBoundedText(response, CLI_LATEST_LIMITS.bytes)');
    expect(lookup).not.toMatch(/[^\w.]fetch\(|globalThis/);
    // Only Check / choose CLI and Update instructions ask.
    expect(source.split('lookUpLatestCliVersion(').length - 1).toBe(3);
    expect(body('function cliRuntimePort(')).toContain("latest: () => lookUpLatestCliVersion(provider, 'Check / choose CLI'),");
    expect(body('async function showCliUpdateInstructions(')).toContain("await lookUpLatestCliVersion(provider, 'Update instructions');");
    expect(body('export async function activate(')).not.toMatch(/lookUpLatestCliVersion|cliLatestVersionUrl/);
  });

  it('keeps only a valid looked-up version per CLI, and offers an update only when a check found an older program', () => {
    const restore = new Function(
      `${ts.transpileModule(body('function restoreCliLatestVersions('), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}; return restoreCliLatestVersions;`,
    )() as (value: unknown) => Record<string, unknown>;
    const at = '2026-10-18T09:31:00.000Z';
    expect(restore({ 'claude-cli': { version: '2.1.302', checkedAt: at }, 'codex-cli': { version: '0.163.0', checkedAt: at } }))
      .toEqual({ 'claude-cli': { version: '2.1.302', checkedAt: at }, 'codex-cli': { version: '0.163.0', checkedAt: at } });
    expect(restore({
      'claude-cli': { version: '2.1.303-beta.1', checkedAt: at },
      'codex-cli': { version: '0.163.0', checkedAt: 'yesterday' },
      'other-cli': { version: '1.0.0', checkedAt: at },
    })).toEqual({});
    expect(restore(undefined)).toEqual({});
    expect(restore('0.163.0')).toEqual({});

    expect(body('async function chooseCliExecutable(')).toContain(
      'if (choice?.latest && compareCliVersions(choice.version, choice.latest) === -1) void offerCliUpdate(provider, choice.version, choice.latest);');
    expect(body('function cliRuntimeStatus(')).toContain(
      'behindLatest: !!check && !!latest && compareCliVersions(check.version, latest.version) === -1,');
    expect(body('export async function activate(')).toContain(
      'cliLatestVersions = restoreCliLatestVersions(context.globalState.get<unknown>(CLI_LATEST_VERSIONS_KEY));');
  });

  it('offers the repair once for a classified provider error, beside the failed turn, and resends nothing', () => {
    const notice = body('function cliRuntimeFailureNotice(');
    expect(notice).toContain('classifyCliRuntimeFailure(provider, text)');
    expect(notice).toMatch(/if \(!offeredCliRepairs\.has\(key\)\)/);
    expect(notice).not.toMatch(/sessionManager\.(send|start|restart)\(/);
    expect(source).toMatch(/const runtimeNotice = replyIsError \? cliRuntimeFailureNotice\(msg\.from, replyText, msg\.id\) : undefined;/);
  });
});
