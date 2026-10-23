/*
 * v0.9.97 P2: an ordinary chat looks at no file. Review resolution §3: "请求入口只建身份，不做 Git 全仓状态、目录枚举、
 * 内容哈希" (a request only gets an identity at its start: no repository-wide Git status, no listing, no hashing).
 * The counted sources are every place the write policy reads from: Git, the editors, the file system and its own
 * records. A turn that reads and writes one file is the control, so a counter that never moves cannot pass.
 */
import { readFileSync, realpathSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAICompatBackend, type FetchFn } from '../OpenAICompatBackend';
import type { BackendEvent } from '../AgentBackend';
import type { AgentConfig } from '../../types';
import { FileWritePolicy, readTargetState } from '../fileWritePolicy';
import { removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';

afterEach(removeTemporaryFolders);

function config(root: string): AgentConfig {
  return {
    id: 'a1', name: 'Worker', role: 'senior-dev', skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: 'deepseek-chat', systemPrompt: 'Be terse.', autoApprove: true, allowedTools: ['read', 'write'],
    workingDirectory: root,
  };
}

function scripted(responses: unknown[]): FetchFn {
  let index = 0;
  return async () => ({ ok: true, status: 200, text: async () => JSON.stringify(responses[Math.min(index++, responses.length - 1)]) });
}

const reply = (content: string) => ({ choices: [{ message: { role: 'assistant', content } }] });
const toolCall = (name: string, args: Record<string, unknown>, id: string) => ({
  choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
});

function countedPolicy() {
  const counts = { git: 0, editors: 0, fileReads: 0, recordLoads: 0 };
  const policy = new FileWritePolicy({
    workspaceId: () => 'w',
    gitPath: async () => { counts.git++; return { repository: false }; },
    dirtyEditorPaths: () => { counts.editors++; return []; },
    readState: async (target) => { counts.fileReads++; return readTargetState(target); },
    ownEffects: { load: () => { counts.recordLoads++; return []; }, save: () => undefined },
  });
  return { counts, writes: policy.forAgent({ agentId: 'a1', requestId: () => 'r1', decide: async () => 'once' }) };
}

async function runTurn(root: string, responses: unknown[], writes: ReturnType<typeof countedPolicy>['writes']): Promise<void> {
  const backend = new OpenAICompatBackend(
    config(root), scripted(responses), undefined, undefined, undefined, { retryBaseMs: 0 },
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { fileWrites: writes },
  );
  const done = new Promise<void>((resolve) => backend.onEvent((event: BackendEvent) => { if (event.kind === 'turn_complete') resolve(); }));
  await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
  backend.sendUserTurn('hello');
  await done;
  await backend.stop();
}

describe('an empty chat causes no new enumeration, hash or Git operation (review resolution §3)', () => {
  it('counts nothing for a turn without a file tool, and counts the file a turn reads and writes', async () => {
    const root = realpathSync.native(await temporaryFolder('unode-p2-admission-'));
    await fs.writeFile(path.join(root, 'a.txt'), 'existing\n');

    const empty = countedPolicy();
    await runTurn(root, [reply('Hi.')], empty.writes);
    expect(empty.counts).toEqual({ git: 0, editors: 0, fileReads: 0, recordLoads: 0 });

    const control = countedPolicy();
    await runTurn(root, [
      toolCall('read_file', { path: 'a.txt' }, 'c1'),
      toolCall('write_file', { path: 'a.txt', content: 'changed\n' }, 'c2'),
      reply('Done.'),
    ], control.writes);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('changed\n');
    // One Git question for the one target, at its first write; no listing of anything.
    expect(control.counts.git).toBe(1);
    expect(control.counts.editors).toBeGreaterThan(0);
    expect(control.counts.fileReads).toBeGreaterThan(0);
  });
});

describe('every route the host builds is given the shared write policy (review resolution §2)', () => {
  // extension.ts needs a VS Code host to run, so its wiring is held here by its source: the policy object of each
  // agent is handed to the OpenAI-compatible engine, Claude's deps and Codex's deps alike.
  const source = readFileSync(path.join(__dirname, '..', '..', 'extension.ts'), 'utf8');

  it('builds one policy for the workspace and one view of it per agent, with the agent\'s request and decisions', () => {
    expect(source).toMatch(/fileWritePolicy = makeFileWritePolicy\(\);/);
    // Its records live in the bound root's project state, never in the raw workspace state of another root.
    expect(source).toMatch(/load: \(\) => rootWorkspaceState\.get\(OWN_FILE_EFFECTS_KEY\)/);
    expect(source).toMatch(/const fileWrites = fileWritePolicy\.forAgent\(\{\s*agentId: scopedConfig\.id,\s*requestId: \(\) => sessionManager\.currentRequestId\(scopedConfig\.id\),\s*decide: \(request\) => requestOverwriteDecision\(/);
  });

  it('hands that view to all three routes', () => {
    const engine = source.slice(source.indexOf('const engine: EngineOptions = {'), source.indexOf('return new OpenAICompatBackend('));
    const codex = source.slice(source.indexOf('return new CodexBackend('), source.indexOf('// Claude receives approved integrations'));
    const claude = source.slice(source.indexOf('const claudeDeps: ClaudeHeadlessBackendDeps = {'), source.indexOf('return new ClaudeHeadlessBackend('));
    for (const [route, block] of [['openai-compatible', engine], ['codex', codex], ['claude', claude]] as const) {
      expect(block.length, route).toBeGreaterThan(0);
      expect(block, route).toMatch(/^\s+fileWrites,$/m);
    }
  });

  it('asks the overwrite decision on a single-use card that no session approval answers', () => {
    const decision = source.slice(source.indexOf('async function requestOverwriteDecision('), source.indexOf('/** Drive `unode.soloActive`'));
    expect(decision).toContain('singleUseOnly: true');
    expect(decision).not.toContain('writeApprovedAll');
    expect(decision).toMatch(/outcome\.settledBy === 'human' && outcome\.action === 'once'/);
  });
});
