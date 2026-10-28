import { describe, expect, it } from 'vitest';
import { parseToolInputProgress, partialArgumentTarget, toolInputProgress } from '../ToolInputProgress';
import { OpenAIStreamReconstructor } from '../sseParser';
import { ClaudeHeadlessBackend } from '../ClaudeHeadlessBackend';
import type { AgentConfig } from '../../types';
import { WorkspaceTools } from '../WorkspaceTools';
import { CodexBackend } from '../CodexBackend';

// v0.9.99 P7: what the live line can say while the model writes a tool call's arguments.
describe('tool input progress', () => {
  it('names the target only once its whole value has arrived, and only its file name', () => {
    expect(partialArgumentTarget('{"path":"docs/contr')).toBeUndefined();
    expect(partialArgumentTarget('{"path":"docs/contract_v2.docx","content":"')).toBe('contract_v2.docx');
    expect(partialArgumentTarget('{"file_path":"C:\\\\Users\\\\ada\\\\out\\\\report.pdf"')).toBe('report.pdf');
    expect(partialArgumentTarget('{"output_path": "out/a.md"}')).toBe('a.md');
    // A "path" written inside another string value is escaped there, so it is not taken for the target.
    expect(partialArgumentTarget('{"content":"see \\"path\\": \\"secret.txt\\" here')).toBeUndefined();
    expect(partialArgumentTarget('{"brief":"private long task"}')).toBeUndefined();
  });

  it('counts UTF-8 bytes, not characters', () => {
    expect(toolInputProgress('write_file', '{"content":"合同"}')).toEqual({ tool: 'write_file', bytes: Buffer.byteLength('{"content":"合同"}') });
    expect(toolInputProgress(undefined, '')).toEqual({ bytes: 0 });
  });

  it('round-trips and drops malformed values', () => {
    expect(parseToolInputProgress({ tool: 'Write', target: 'a.md', bytes: 12 })).toEqual({ tool: 'Write', target: 'a.md', bytes: 12 });
    expect(parseToolInputProgress({ tool: 'Write', bytes: -1 })).toBeUndefined();
    expect(parseToolInputProgress({ bytes: 3, target: 'x'.repeat(121) })).toEqual({ bytes: 3 });
  });

  it('follows the call an OpenAI-compatible stream is writing, including index-less continuations', () => {
    const stream = new OpenAIStreamReconstructor();
    stream.accept({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file', arguments: '{"path":"src/a.ts",' } }] } }] });
    expect(stream.currentToolInput()).toEqual({ tool: 'write_file', target: 'a.ts', bytes: 19 });
    stream.accept({ choices: [{ delta: { tool_calls: [{ function: { arguments: '"content":"0123456789"}' } }] } }] });
    expect(stream.currentToolInput()?.bytes).toBe(19 + 23);
    expect(new OpenAIStreamReconstructor().currentToolInput()).toBeUndefined();
  });

  it('follows the call a Claude stream is writing, from its start block through its input deltas', async () => {
    const config = { id: 'c', name: 'C', role: 'developer', skill: '', provider: { providerId: 'anthropic', apiKeySecretName: 'K' },
      model: 'claude-sonnet-4-5', systemPrompt: '', autoApprove: true, allowedTools: [], backend: 'claude', workingDirectory: process.cwd() } as AgentConfig;
    const backend = new ClaudeHeadlessBackend(config);
    const events: Array<{ kind: string; toolInput?: unknown }> = [];
    backend.onEvent((event) => events.push(event as never));
    await (backend as any).handleEvent({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Write' } } });
    const parts = ['{"file_path":"/w/contract_v2.docx",', '"content":"', 'x'.repeat(12_000)];
    for (const partial_json of parts) {
      await (backend as any).handleEvent({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json } } });
    }
    const progress = events.filter((e) => e.kind === 'provider_activity').map((e) => e.toolInput);
    expect(progress[0]).toEqual({ tool: 'Write', bytes: 0 });
    expect(progress[1]).toEqual({ tool: 'Write', target: 'contract_v2.docx', bytes: parts[0].length });
    expect(progress.at(-1)).toEqual({ tool: 'Write', target: 'contract_v2.docx', bytes: parts.join('').length });
    expect(JSON.stringify(progress)).not.toContain('xxxx');
  });

  it('describes write_file as a whole-file write and points a partial change at the edit tool', () => {
    const write = new WorkspaceTools(process.cwd(), new Set(['write'])).specs().find((spec) => spec.function.name === 'write_file');
    expect(write?.function.description).toContain('To change part of an existing file, use the targeted edit tool instead: write_file resends the whole file.');
  });

  it('marks the Codex route as one that sends a tool call only once it is complete; others stream', () => {
    const codex = new CodexBackend({ id: 'codex-1', name: 'Codex', role: 'reviewer', skill: '',
      provider: { providerId: 'codex', apiKeySecretName: 'CODEX_CLI_AUTH' }, model: 'gpt-5-codex', systemPrompt: '',
      autoApprove: true, allowedTools: ['read'], backend: 'codex', workingDirectory: process.cwd() } as AgentConfig);
    expect(codex.streamsToolInput).toBe(false);
    const claude = new ClaudeHeadlessBackend({ id: 'c', name: 'C', role: 'developer', skill: '', provider: { providerId: 'anthropic', apiKeySecretName: 'K' },
      model: 'claude-sonnet-4-5', systemPrompt: '', autoApprove: true, allowedTools: [], backend: 'claude', workingDirectory: process.cwd() } as AgentConfig);
    expect((claude as { streamsToolInput?: false }).streamsToolInput).toBeUndefined();
  });
});
