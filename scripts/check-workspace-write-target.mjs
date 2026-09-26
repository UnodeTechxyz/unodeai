import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const read = (file) => readFileSync(resolve(root, file), 'utf8');

function failuresFor(sources) {
  const failures = [];
  const extension = sources.extension;
  const executableExtension = extension.replace(/\/\/.*$/gm, '');
  const folderChangeAt = extension.indexOf('vscode.workspace.onDidChangeWorkspaceFolders(');
  const folderChangeBody = folderChangeAt >= 0 ? extension.slice(folderChangeAt, folderChangeAt + 1_800) : '';

  if (/process\.cwd\(\)/.test(executableExtension)) {
    failures.push('extension.ts still derives a workspace target from process.cwd()');
  }
  for (const [name, source] of Object.entries(sources.backends)) {
    const executableSource = source.replace(/\/\/.*$/gm, '');
    if (/workingDirectory\s*(?:\|\||\?\?)\s*process\.cwd\(\)|opts\.cwd\s*\?\?\s*process\.cwd\(\)/.test(executableSource)) {
      failures.push(`${name} still inherits the extension host current directory`);
    }
  }

  const rootBody = /function workspaceRoot\(\): string \{([\s\S]*?)\n\}/.exec(extension)?.[1] ?? '';
  if (!rootBody.includes('firstWorkspaceRoot()') || !rootBody.includes('throw new Error(')) {
    failures.push('workspaceRoot does not fail closed when the activation-time binding is absent or stale');
  }
  if (!extension.includes('vscode.workspace.onDidChangeWorkspaceFolders(')
      || !extension.includes('workspaceBinding.observe(nextRoot)')) {
    failures.push('first-folder changes do not invalidate the activation-time workspace binding');
  }
  if (!folderChangeBody.includes('closeTeamRulesPanel();') || !folderChangeBody.includes('sessionManager?.stopAll()')
      || !folderChangeBody.includes('mcpHub?.stopAll()') || !folderChangeBody.includes('terminalManager.disposeAll()')) {
    failures.push('first-folder invalidation does not close captured editors and stop active agent/MCP/terminal work');
  }
  if (!extension.includes('canSave: () => !!firstWorkspaceRoot() && sameWorkspaceRoot')) {
    failures.push('the open Team Rules editor does not re-check its workspace binding before save');
  }
  if (!sources.session.includes('this.deps.workspaceAvailable?.() === false')) {
    failures.push('SessionManager does not refuse starts and deliveries after a folder-binding change');
  }
  for (const service of [
    'rulesFile', 'projectKnowledge', 'sharedMemory', 'memoryAttestationStore',
    'projectConventions', 'integrationEvidenceStore', 'worktreeCoordinator',
  ]) {
    if (!extension.includes(`${service} = undefined;`)) {
      failures.push(`first-folder invalidation does not clear ${service}`);
    }
  }
  for (const constructor of [
    'new RulesFile(rulesFilePath(boundRoot))',
    'new ProjectKnowledge(boundRoot)',
    'new SharedMemory(memoryFilePath(boundRoot))',
    'new MemoryAttestationStore(rootWorkspaceState, boundRoot)',
    'new ProjectConventions(boundRoot)',
  ]) {
    if (!extension.includes(constructor)) {
      failures.push(`captured-root writer is not visibly bound through boundRoot: ${constructor}`);
    }
  }
  if (!/new PersistenceManager\([\s\S]{0,360}?context[\s\S]{0,360}?firstWorkspaceRoot\(\) !== undefined[\s\S]{0,180}?runHostIdentity[\s\S]{0,180}?rootWorkspaceState/.test(extension)) {
    failures.push('PersistenceManager is not gated by the live activation-time workspace binding');
  }
  if (!extension.includes('new RootScopedWorkspaceState(')
      || !extension.includes('context.workspaceState,')
      || !extension.includes('() => firstWorkspaceRoot()')) {
    failures.push('workspace-state consumers are not visibly bound through the canonical root-scoped adapter');
  }

  if (!sources.orchestration.includes('new TaskInputResolver(store, () => this.runtime.workspace().root())')) {
    failures.push('orchestration resolves a workspace target eagerly during no-folder activation');
  }

  const persistence = sources.persistence;
  if (!persistence.includes("throw new Error('Open a workspace before saving .unode/team.json.')")) {
    failures.push('team-file persistence does not visibly refuse without a workspace');
  }
  if (!persistence.includes('return this.hasWorkspace() ? vscode.workspace.workspaceFolders?.[0] : undefined;')) {
    failures.push('PersistenceManager does not obtain project paths through its workspace guard');
  }

  const binding = sources.binding;
  if (!binding.includes('path.isAbsolute(root)') || !binding.includes('throw new Error(')
      || !binding.includes('class FirstWorkspaceBinding') || !binding.includes('this.invalidated = true;')) {
    failures.push('agent backend workspace binding accepts an absent or relative target');
  }
  if (!sources.bindingTest.includes('binding.observe(second)') || !sources.bindingTest.includes('binding.root()).toBeUndefined()')) {
    failures.push('no executable regression changes the first folder and proves the captured binding is refused');
  }
  return failures;
}

const sources = {
  extension: read('src/extension.ts'),
  persistence: read('src/state/PersistenceManager.ts'),
  binding: read('src/backend/WorkspaceBinding.ts'),
  bindingTest: read('src/backend/__tests__/WorkspaceBinding.test.ts'),
  session: read('src/session/SessionManager.ts'),
  orchestration: read('src/host/orchestration/OrchestrationHostAdapter.ts'),
  backends: Object.fromEntries([
    'OpenAICompatBackend.ts', 'ClaudeHeadlessBackend.ts', 'CodexBackend.ts', 'TeamTools.ts',
  ].map((name) => [name, read(`src/backend/${name}`)])),
};

const failures = failuresFor(sources);
if (failures.length > 0) {
  throw new Error(`workspace write-target gate failed:\n- ${failures.join('\n- ')}`);
}

const plants = [
  {
    label: 'process.cwd fallback',
    value: { ...sources, extension: sources.extension.replace(
      "throw new Error('Open a workspace folder before using this UnodeAi action.');",
      'return process.cwd();',
    ) },
  },
  {
    label: 'running agents survive folder change',
    value: { ...sources, extension: sources.extension.replace(
      'sessionManager?.stopAll() ?? Promise.resolve(),',
      'Promise.resolve(), // planted running agents',
    ) },
  },
  {
    label: 'terminals survive folder change',
    value: { ...sources, extension: sources.extension.replace(
      `        terminalManager.disposeAll(),
      ]);
      await terminalManager.disposeAll();`,
      `        Promise.resolve(), // planted live terminals
      ]);
      // planted terminal resweep`,
    ) },
  },
  {
    label: 'relative backend root',
    value: { ...sources, binding: sources.binding.replace('!root || !path.isAbsolute(root)', '!root') },
  },
  {
    label: 'open rules editor keeps stale save authority',
    value: { ...sources, extension: sources.extension.replace(
      'canSave: () => !!firstWorkspaceRoot() && sameWorkspaceRoot',
      'canSave: () => true && sameWorkspaceRoot',
    ) },
  },
];
for (const plant of plants) {
  if (failuresFor(plant.value).length === 0) {
    throw new Error(`planted ${plant.label} failure survived`);
  }
}

console.log('Workspace write-target gate passed: no extension-host cwd fallback; a real folder-change regression refuses the old binding; running agents/MCP/terminals and captured rule editors stop; 5 planted failures killed.');
