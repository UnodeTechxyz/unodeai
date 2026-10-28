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
  // v0.9.99 (B12): a first-folder change keeps every writer on the activation-time root until the window reloads.
  // Running work is not stopped and later work is not refused; the host offers Reload Window to switch.
  if (!extension.includes('vscode.workspace.onDidChangeWorkspaceFolders(')
      || !folderChangeBody.includes('workspaceBinding.observe(')) {
    failures.push('first-folder changes are not observed by the activation-time workspace binding');
  }
  if (!folderChangeBody.includes("'Reload Window'") || !folderChangeBody.includes("'workbench.action.reloadWindow'")) {
    failures.push('a first-folder change does not offer Reload Window to switch the bound folder');
  }
  for (const stop of ['sessionManager?.stopAll()', 'mcpHub?.stopAll()', 'terminalManager.disposeAll()']) {
    if (folderChangeBody.includes(stop)) failures.push(`a first-folder change still stops running work: ${stop}`);
  }
  if (!extension.includes('canSave: () => !!firstWorkspaceRoot() && sameWorkspaceRoot')) {
    failures.push('the open Team Rules editor does not re-check its workspace binding before save');
  }
  // v0.9.99 (B11): starts and deliveries still ask the host whether this agent can run without a bound folder.
  if (!/this\.deps\.workspaceAvailable\?\.\([^)]*\) === false/.test(sources.session)) {
    failures.push('SessionManager does not ask the host whether an agent can run without a bound folder');
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
  if (!/new PersistenceManager\([\s\S]{0,360}?context[\s\S]{0,360}?\(\) => firstWorkspaceRoot\(\),[\s\S]{0,180}?runHostIdentity[\s\S]{0,180}?rootWorkspaceState/.test(extension)) {
    failures.push('PersistenceManager is not given the activation-time root (firstWorkspaceRoot) as its project root');
  }
  // v0.9.99 (I2): the editor's live first folder is read in exactly one place, editorFirstWorkspaceRoot(), which only
  // feeds the binding and its change observer. Every project-state reader uses the bound root.
  const liveFirstFolder = executableExtension.match(/workspaceFolders\?\.\[0\]|workspaceFolders\[0\]/g) ?? [];
  const editorFirstBody = /function editorFirstWorkspaceRoot\(\): string \| undefined \{([\s\S]*?)\n\}/.exec(executableExtension)?.[1] ?? '';
  if (liveFirstFolder.length !== 1 || !editorFirstBody.includes('vscode.workspace.workspaceFolders?.[0]?.uri.fsPath')) {
    failures.push(`extension.ts reads the live first folder outside editorFirstWorkspaceRoot (${liveFirstFolder.length} reads)`);
  }
  for (const name of ['executionHookCandidateSetting', 'legacyTeamEndpointOverrides', 'defaultJsonUri']) {
    const body = new RegExp(`function ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(executableExtension)?.[1] ?? '';
    if (!body.includes('boundRootUri()')) failures.push(`${name} does not resolve its folder through the activation-time root`);
  }
  if (!/function boundRootUri\(\)[^{]*\{[\s\S]*?const root = firstWorkspaceRoot\(\);[\s\S]*?vscode\.Uri\.file\(root\)/.test(executableExtension)) {
    failures.push('boundRootUri is not derived from the activation-time root');
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
  const executablePersistence = persistence.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const persistenceLiveReads = executablePersistence.match(/workspace\.workspaceFolders/g) ?? [];
  if (!persistence.includes('return root === undefined ? undefined : { uri: vscode.Uri.file(root) };')
      || !/private workspaceFolder\(\)[^{]*\{\s*const root = this\.boundWorkspaceRoot\(\);/.test(executablePersistence)) {
    failures.push('PersistenceManager does not obtain project paths from its bound workspace root');
  }
  // The single permitted read is the first-seen capture of a manager built without a root (tests, never the host).
  if (persistenceLiveReads.length !== 1
      || !executablePersistence.includes('(firstSeen ??= { root: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath }).root')) {
    failures.push('PersistenceManager follows the editor\'s live first folder');
  }
  if (!/private canonicalWorkspaceRoot\(\)[^{]*\{\s*const root = this\.boundWorkspaceRoot\(\);/.test(executablePersistence)
      || /function currentWorkspaceRoot\(/.test(executablePersistence)) {
    failures.push('project Team Library validation does not use the bound workspace root');
  }
  if (!sources.boundRootTest.includes('changeFirstFolder(binding, [newRoot, oldRoot])')
      || !sources.boundRootTest.includes("expect(fs.existsSync(path.join(newRoot, '.unode'))).toBe(false)")
      || !sources.boundRootTest.includes('new PersistenceManager(context as never, undefined, rootArgument)')) {
    failures.push('no executable regression saves and loads through the real binding and persistence after a first-folder change');
  }

  const binding = sources.binding;
  if (!binding.includes('path.isAbsolute(root)') || !binding.includes('throw new Error(')
      || !binding.includes('class FirstWorkspaceBinding') || !binding.includes('return this.initialRoot;')) {
    failures.push('agent backend workspace binding accepts an absent or relative target, or can be redirected');
  }
  if (!sources.bindingTest.includes('binding.observe(second)') || !sources.bindingTest.includes('expect(binding.root()).toBe(first)')) {
    failures.push('no executable regression changes the first folder and proves the binding keeps the activation-time root');
  }
  return failures;
}

const sources = {
  extension: read('src/extension.ts'),
  persistence: read('src/state/PersistenceManager.ts'),
  binding: read('src/backend/WorkspaceBinding.ts'),
  bindingTest: read('src/backend/__tests__/WorkspaceBinding.test.ts'),
  boundRootTest: read('src/state/__tests__/PersistenceBoundRoot.test.ts'),
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
    label: 'a folder change stops running agents again',
    value: { ...sources, extension: sources.extension.replace(
      "if (!workspaceBinding.observe(editorFirstWorkspaceRoot())) { return; }",
      "if (!workspaceBinding.observe(editorFirstWorkspaceRoot())) { return; } void sessionManager?.stopAll();",
    ) },
  },
  {
    label: 'a folder change offers no reload',
    value: { ...sources, extension: sources.extension.replaceAll("'Reload Window'", "'OK'") },
  },
  {
    label: 'the bound root follows the new folder',
    value: { ...sources, binding: sources.binding.replace('return this.initialRoot;', 'return this.pendingRoot ?? this.initialRoot;') },
  },
  {
    label: 'relative backend root',
    value: { ...sources, binding: sources.binding.replace('!root || !path.isAbsolute(root)', '!root') },
  },
  {
    label: 'team persistence follows the live first folder (I2)',
    value: { ...sources, persistence: sources.persistence.replace(
      'return root === undefined ? undefined : { uri: vscode.Uri.file(root) };',
      'return root === undefined ? undefined : vscode.workspace.workspaceFolders?.[0];',
    ) },
  },
  {
    label: 'the extension gives persistence only a has-workspace predicate (I2)',
    value: { ...sources, extension: sources.extension.replace(
      '    () => firstWorkspaceRoot(),\n    runHostIdentity,',
      '    () => firstWorkspaceRoot() !== undefined ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath : undefined,\n    runHostIdentity,',
    ) },
  },
  {
    label: 'team-library validation uses the live first folder (I2)',
    value: { ...sources, persistence: sources.persistence.replace(
      'const currentWorkspaceRoot = () => this.canonicalWorkspaceRoot();',
      'const currentWorkspaceRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;',
    ) },
  },
  {
    label: 'legacy endpoints read the live first folder (I2)',
    value: { ...sources, extension: sources.extension.replace(
      '  const folder = boundRootUri();\n  if (!folder) { return new Map(); }',
      '  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;\n  if (!folder) { return new Map(); }',
    ) },
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

console.log(`Workspace write-target gate passed: no extension-host cwd fallback; a first-folder change keeps every writer on the activation-time root, stops no running work and offers Reload Window; project persistence, the project Team Library, hooks and legacy endpoints use the bound root; captured rule editors re-check before save; ${plants.length} planted failures killed.`);
