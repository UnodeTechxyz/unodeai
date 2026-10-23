/*
 * v0.9.97 P4: an OpenAI-compatible agent has `save_attachment` as a host tool (review resolution §2 route matrix:
 * "save_attachment: OpenAI-compatible: the host tool"). A turn that is handed the user's attachment saves it byte for
 * byte; a coordinator with teammates saves only under a task contract that selects it, as for write_file.
 */
import { realpathSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAICompatBackend, type FetchFn } from '../OpenAICompatBackend';
import type { BackendEvent } from '../AgentBackend';
import type { AgentConfig } from '../../types';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { FileWritePolicy } from '../fileWritePolicy';
import { admitUserTurn, attachment, attachmentIds, PNG, sha } from './attachmentSaveFixtures';
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

const toolCall = (name: string, args: Record<string, unknown>, id: string) => ({
  choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
});
const reply = (content: string) => ({ choices: [{ message: { role: 'assistant', content } }] });

describe('save_attachment on the OpenAI-compatible route (review resolution §2)', () => {
  it('is offered to the model, and a turn handed the attachment saves it byte for byte', async () => {
    const root = realpathSync.native(await temporaryFolder('unode-p4-openai-'));
    const store = new ContentAssetStore();
    const sources = await admitUserTurn(store, [attachment('image.png', 'image/png', 'image', PNG)]);
    const [id] = attachmentIds(sources);
    const bodies: any[] = [];
    const responses = [toolCall('save_attachment', { asset_id: id, path: 'assets/logo.png' }, 'call-1'), reply('Saved.')];
    let index = 0;
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      return { ok: true, status: 200, text: async () => JSON.stringify(responses[Math.min(index++, responses.length - 1)]) };
    };
    const writes = new FileWritePolicy({ workspaceId: () => 'w' }).forAgent({ agentId: 'a1', requestId: () => 'r1', decide: async () => 'once' });
    const backend = new OpenAICompatBackend(
      config(root), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 },
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { fileWrites: writes, delegationContentAssets: store },
    );
    const results: BackendEvent[] = [];
    const done = new Promise<void>((resolve) => backend.onEvent((event: BackendEvent) => {
      if (event.kind === 'tool_result') results.push(event);
      if (event.kind === 'turn_complete') resolve();
    }));
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
    backend.sendUserTurn('save it', { delegationContentSources: sources });
    await done;
    await backend.stop();

    const offered = bodies[0].tools.find((tool: any) => tool.function.name === 'save_attachment');
    expect(offered.function.parameters.required).toEqual(['asset_id', 'path']);
    expect((await fs.readFile(path.join(root, 'assets', 'logo.png'))).equals(PNG)).toBe(true);
    const toolMessage = bodies[1].messages.find((message: any) => message.role === 'tool');
    expect(toolMessage.content).toContain(`Saved attachment ${id} to assets/logo.png as a new file: ${PNG.length} bytes, SHA-256 ${sha(PNG)}`);
    await store.dispose();
  });

  it('needs a coordinator contract when the agent coordinates teammates, as write_file does', async () => {
    const root = realpathSync.native(await temporaryFolder('unode-p4-openai-pm-'));
    const team = {
      has: () => false,
      hasTeammates: () => true,
      canCoordinatorExecute: () => false,
      specs: () => [],
    };
    const backend = new OpenAICompatBackend(config(root), (async () => ({ ok: true, status: 200, text: async () => '{}' })) as FetchFn, team as any);
    const routed = await (backend as any).routeToolCall('save_attachment', { asset_id: 'content-1', path: 'logo.png' });
    expect(routed.ok).toBe(false);
    expect(routed.output).toMatch(/Coordinator execution is not authorised/);
    expect(await fs.readdir(root)).toEqual([]);
  });
});
