/*
 * v0.9.101 (the Owner, 2026-11-05): under Approve for me, a Claude role's ordinary in-scope writes and commands get no
 * approval card. In v0.9.100 every created role carried `autoApprove: false`, and the Autonomy policy read that legacy
 * default as "review every write and command": in the speed baseline an Edit of a workspace source file and a
 * `Test-Path` command each waited 15 minutes for a card nobody had asked for.
 *
 * Source to output: the role comes from the real Software Team creation, its Autonomy from the production
 * `agentAutonomyPolicy`/`autonomyForAgent` functions of extension.ts, the backend from createClaudeBackend and
 * createAgentCommandPolicy (the composition activation's factory calls), and each call goes through Claude's real
 * PreToolUse hook. The cases observe hook decisions and card requests, not executed commands or landed edits.
 */
import { readFileSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  QuickPickItemKind: { Separator: -1 },
  ConfigurationTarget: { Workspace: 2 },
  workspace: {
    getConfiguration: () => ({ get: () => '', update: vi.fn() }),
    workspaceFolders: [{ uri: { fsPath: '/some/workspace' } }],
  },
  window: {
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
    showWarningMessage: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../../backend/CommandApprovalPrompter', () => ({ promptCommandApproval: vi.fn().mockResolvedValue(false) }));

import { createDefaultTeam, type ConnectionPick } from '../../dialogs';
import { CommandPolicy } from '../../backend/CommandPolicy';
import { FileWritePolicy } from '../../backend/fileWritePolicy';
import type { CommandApprovalContext } from '../../backend/ShellCommandGate';
import { removeTemporaryFolders, temporaryFolder } from '../../backend/__tests__/pathSafetyFixtures';
import { AutonomyDefaultConsent, resolveAutonomyPolicy, type AutonomyMode } from '../../settings/AutonomyPolicy';
import type { AgentConfig } from '../../types';
import { createAgentCommandPolicy, createClaudeBackend } from '../claudeBackendComposition';

afterEach(removeTemporaryFolders);

const extensionSource = readFileSync('src/extension.ts', 'utf8');
const parsed = ts.createSourceFile('extension.ts', extensionSource, ts.ScriptTarget.Latest, true);
const productionAutonomy = ['agentAutonomyPolicy', 'autonomyForAgent'].map((name) => {
  const node = parsed.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  if (!node) throw new Error(`Missing actual ${name}`);
  return ts.transpileModule(node.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}).join('\n');

/** The Software Team exactly as "Create team" makes it on the Claude CLI connection, with the defaults it sets. */
async function createdSeniorDeveloper(): Promise<AgentConfig> {
  const created: AgentConfig[] = [];
  const deps: any = {
    sessionManager: { getAll: () => [], create: (config: AgentConfig) => { created.push(config); }, remove: async () => {} },
    secrets: { has: async () => true, get: async () => 'test-key', promptAndStore: async () => {} },
    output: { info: () => {}, warn: () => {} },
    commandPolicy: { approvalMode: 'all', reload: () => {} },
    reloadCommandPolicy: () => {},
    defaultBackendKind: (config: AgentConfig) => config.provider?.providerId === 'anthropic' ? 'claude' : 'openai-compat',
    defaultProvider: () => 'claude-cli',
    modelCatalog: { list: async () => [] },
    ensureModelPickerConsent: async () => {},
    refreshPrices: () => {},
    pricing: undefined,
    chooseConnection: async (items: ConnectionPick[]) => items.find((item) => item.connectionId === 'claude-cli'),
  };
  const team = await createDefaultTeam(deps);
  const developer = team.find((config) => config.role === 'senior-dev');
  if (!developer) throw new Error(`No Senior Developer in ${team.map((config) => config.role).join(', ')}`);
  return developer;
}

/** The production Autonomy functions of extension.ts, reading the released default User settings. */
function productionAutonomyFor(sessions: { config: AgentConfig }[], user: Record<string, unknown>) {
  const values = new Map<string, unknown>();
  const host = {
    resolveAutonomyPolicy,
    autonomyDefaults: new AutonomyDefaultConsent({ get: <T>(key: string) => values.get(key) as T | undefined,
      update: async (key: string, value: unknown) => { values.set(key, value); } }),
    configuredSetting: (key: string, fallback: unknown) => Object.hasOwn(user, key) ? user[key] : fallback,
    defaultBackendKind: (config: AgentConfig) => config.provider?.providerId === 'anthropic' ? 'claude' : 'openai-compat',
    effectiveConnectionRegistry: {},
    vscode: { workspace: { isTrusted: true } },
    commandPolicy: { get approvalMode() { return user.commandApproval; } },
    sessionManager: {
      get: (id: string) => sessions.find((session) => session.config.id === id),
      currentTurnMode: () => 'act', currentTurnHasTaskScope: () => false, currentTurnId: () => 'turn-1',
    },
    chatViewProvider: { getAgentMode: () => 'act' },
    codexNativePolicySnapshots: new Map(),
    codexAutonomyPendingTurns: new Map(),
  };
  return new Function('host', `with (host) { ${productionAutonomy}; return { agentAutonomyPolicy, autonomyForAgent }; }`)(host) as {
    agentAutonomyPolicy(config: AgentConfig): ReturnType<typeof resolveAutonomyPolicy>;
    autonomyForAgent(config: AgentConfig): ReturnType<typeof resolveAutonomyPolicy>;
  };
}

/**
 * The Claude backend as activation composes it: createAgentCommandPolicy and createClaudeBackend are the functions
 * extension.ts's backend factory calls, given the production Autonomy functions and the real created role. Only the
 * person's side is a stand-in: each card is recorded and answered no.
 */
async function claudeRole(autonomyMode?: AutonomyMode) {
  const created = await createdSeniorDeveloper();
  const root = realpathSync.native(await temporaryFolder('unode-approve-for-me-'));
  const config: AgentConfig = { ...created, workingDirectory: root, ...(autonomyMode ? { autonomyMode } : {}) };
  const sessions = [{ config }];
  const user = { autonomy: 'workspace', commandApproval: 'all', writeApproval: 'none' };
  const autonomy = productionAutonomyFor(sessions, user);
  const liveConfig = () => sessions[0].config;
  const cards: { kind: string; detail: string; context?: CommandApprovalContext }[] = [];
  const fileWrites = new FileWritePolicy({ workspaceId: () => 'w', dirtyEditorPaths: () => [], gitPath: async () => ({ repository: false }) })
    .forAgent({ agentId: config.id, requestId: () => 'request-1', notice: () => {},
      decide: async (request) => { cards.push({ kind: 'overwrite', detail: request.path }); return 'deny'; } });
  const backend = createClaudeBackend(config, undefined, undefined, {}, {
    liveConfig,
    autonomyPolicy: (live) => autonomy.agentAutonomyPolicy(live),
    commandPolicy: createAgentCommandPolicy(new CommandPolicy('all', []), config, liveConfig, autonomy.autonomyForAgent),
    approveCommand: async (command, context) => { cards.push({ kind: 'command', detail: command, context }); return { allow: false }; },
    isTrusted: () => true,
    requestToolApproval: async (request) => { cards.push({ kind: 'tool', detail: request.toolName }); return { allow: false }; },
    requestWriteApproval: async (request) => { cards.push({ kind: 'write', detail: request.path }); return 'deny'; },
    fileWrites,
  });
  const currentAutonomy = () => autonomy.agentAutonomyPolicy(liveConfig());
  const gate = async (tool: string, input: Record<string, unknown>, id: string) =>
    (backend as any).handlePreToolUse({ tool_name: tool, tool_input: input, tool_use_id: id }) as Promise<{ allow: boolean; reason?: string }>;
  const ran = async (tool: string, input: Record<string, unknown>, id: string) => {
    await (backend as any).handleEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: tool, input }] } });
    await (backend as any).handleEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { created, root, cards, gate, ran, policy: currentAutonomy };
}

// The baseline's own calls (SPEED_RUN_SHEET_v09101.md, M and H; S for the pipelines).
const OPAQUE_TEST_RUN = 'npx vitest run src/backend/__tests__/OpenAICompatBackend.test.ts -t "staleness note across requests" 2>&1 | Select-Object -Last 30';
const OUTSIDE_FOLDER_CHECK = String.raw`Test-Path C:\Contracts; Test-Path C:\AI; Test-Path C:\Out; Test-Path C:\Users\Jane; Test-Path C:\ws`;

describe('Approve for me, a Claude role from Create team (v0.9.101)', () => {
  it('edits a workspace file and runs ordinary commands without a card, at the released default settings', async () => {
    const h = await claudeRole();
    expect(h.created.autoApprove).toBe(false);

    // The baseline's project declares vitest, so its `npx vitest` downloads nothing (v0.9.106 D1).
    await fs.writeFile(path.join(h.root, 'package.json'), JSON.stringify({ name: 'baseline', devDependencies: { vitest: '^4' } }));
    await fs.mkdir(path.join(h.root, 'src'), { recursive: true });
    await fs.writeFile(path.join(h.root, 'src', 'namedOutsidePaths.ts'), 'const STOP = 1;\n');
    await h.ran('Read', { file_path: path.join(h.root, 'src', 'namedOutsidePaths.ts') }, 'toolu_read');
    expect(await h.gate('Edit', { file_path: path.join(h.root, 'src', 'namedOutsidePaths.ts'),
      old_string: 'const STOP = 1;', new_string: 'const STOP = 2;' }, 'toolu_edit')).toMatchObject({ allow: true });
    expect(await h.gate('Write', { file_path: path.join(h.root, 'src', 'new.test.ts'), content: 'export {};\n' }, 'toolu_write'))
      .toMatchObject({ allow: true });
    expect(await h.gate('PowerShell', { command: OPAQUE_TEST_RUN }, 'toolu_ps')).toMatchObject({ allow: true });
    expect(await h.gate('PowerShell', { command: OUTSIDE_FOLDER_CHECK }, 'toolu_test_path')).toMatchObject({ allow: true });
    expect(await h.gate('Bash', { command: 'git status --short && git diff --stat' }, 'toolu_bash')).toMatchObject({ allow: true });

    expect(h.cards).toEqual([]);
    expect(h.policy()).toMatchObject({ label: 'Workspace', writeReview: false, commandReview: false, limits: [] });
  });

  it('still confirms a recognised destructive delete once, and runs it only on a yes', async () => {
    const h = await claudeRole();
    const decision = await h.gate('Bash', { command: 'rm -rf src' }, 'toolu_rm');
    expect(decision.allow).toBe(false);
    expect(h.cards).toHaveLength(1);
    expect(h.cards[0]).toMatchObject({ kind: 'command', detail: 'rm -rf src' });
    expect(h.cards[0].context?.dangerous).toBe(true);
  });

  // v0.9.101 S4.3: Claude's Bash on Windows runs `git.exe push`. Before, that was an ordinary command and ran
  // unconfirmed under Approve for me. It is the outward action it names: refused in the native shell, as `git push` is,
  // with the pointer to the host command tool where it is confirmed once.
  it('treats a push through git.exe as the outward git push it is', async () => {
    const h = await claudeRole();
    const exe = await h.gate('Bash', { command: 'git.exe push origin main' }, 'toolu_push');
    const plain = await h.gate('Bash', { command: 'git push origin main' }, 'toolu_plain');
    expect(plain.allow).toBe(false);
    expect(exe).toEqual(plain);
    expect(exe.reason).toMatch(/^Outward action not run/);
    expect(h.cards).toEqual([]);
  });

  it('asks before the same edit and command when the person chose Ask for approval', async () => {
    const h = await claudeRole('review');
    expect(h.policy()).toMatchObject({ writeReview: true, commandReview: true });
    await fs.writeFile(path.join(h.root, 'a.txt'), 'read by Claude');
    await h.ran('Read', { file_path: path.join(h.root, 'a.txt') }, 'toolu_read');
    expect((await h.gate('Edit', { file_path: path.join(h.root, 'a.txt'), old_string: 'read', new_string: 'edited' }, 'toolu_edit')).allow)
      .toBe(false);
    expect((await h.gate('PowerShell', { command: OUTSIDE_FOLDER_CHECK }, 'toolu_test_path')).allow).toBe(false);
    expect(h.cards.map((card) => card.kind)).toEqual(['write', 'command']);
  });

  // Supplemental: which production functions the factory hands to the composition above. The behaviour is proven by
  // the cases above; the approval keys cannot be set beside it (ClaudeBackendBaseDeps omits them).
  it('activation composes the Claude backend through createClaudeBackend with the Autonomy functions', () => {
    const factory = extensionSource.slice(extensionSource.indexOf('const claudeDeps: ClaudeBackendBaseDeps = {'));
    expect(factory).toMatch(/return createClaudeBackend\(scopedConfig, mcpConfig, resolveRouteModelParams\(scopedConfig\), claudeDeps, \{\s*liveConfig: \(\) => sessionManager\.get\(config\.id\)\?\.config \?\? config,\s*autonomyPolicy: \(live\) => agentAutonomyPolicy\(live\),/);
    expect(factory).toContain('commandPolicy: agentCommandPolicy,');
    expect(extensionSource).toMatch(/const agentCommandPolicy = createAgentCommandPolicy\(commandPolicy, scopedConfig,\s*\(\) => sessionManager\.get\(config\.id\)\?\.config \?\? config, autonomyForAgent\);/);
    expect(extensionSource).not.toContain('new ClaudeHeadlessBackend(');
  });
});
