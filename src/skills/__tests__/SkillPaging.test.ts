import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOAD_SKILL_TOOL, READ_SKILL_FILE_TOOL, SkillRegistry } from '../SkillRegistry';
import { MODEL_TOOL_RESULT_MAX_CHARS, boundToolResultForModel } from '../../backend/boundToolResultForModel';
import { OpenAICompatBackend, type FetchFn } from '../../backend/OpenAICompatBackend';
import type { BackendEvent } from '../../backend/AgentBackend';
import type { AgentConfig } from '../../types';

/**
 * v0.9.99: an authorized skill's instructions and reference files are read in full, in bounded parts. Each part that
 * stops early names the exact call that reads the rest; nothing is refused or cut by its length. Authorization, path
 * confinement and the instruction-versus-executable distinction are unchanged.
 */
const HEADER = '---\nname: audit-skill\ndescription: Review the evidence when a change needs an audit.\n---\n';
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LOAD_NEXT = /call load_skill\(\{ name: "([^"]+)", offset: (\d+) \}\)/;
const READ_NEXT = /call read_skill_file\(\{ name: "([^"]+)", relpath: "([^"]+)", offset: (\d+) \}\)/;

let root: string;
let skill: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-skill-paging-'));
  skill = path.join(root, 'rigor', 'audit-skill');
  await fs.mkdir(skill, { recursive: true });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

/** The part a result holds: everything before the host note that follows it. */
function partOf(output: string): string {
  const at = output.lastIndexOf('\n\n[Skill ');
  return at < 0 ? output : output.slice(0, at);
}

function followBody(registry: SkillRegistry) {
  const outputs: string[] = [];
  let args: Record<string, unknown> = { name: 'audit-skill' };
  for (let guard = 0; guard < 50; guard++) {
    const result = registry.runTool(LOAD_SKILL_TOOL, args, ['audit-skill'])!;
    expect(result.status).toBe('success');
    // Every part reaches the model whole: the model-facing bound adds nothing and cuts nothing.
    expect(result.output.length).toBeLessThanOrEqual(MODEL_TOOL_RESULT_MAX_CHARS);
    expect(boundToolResultForModel(LOAD_SKILL_TOOL, result.output)).toBe(result.output);
    outputs.push(result.output);
    const next = LOAD_NEXT.exec(result.output);
    if (!next) return outputs;
    expect(next[1]).toBe('audit-skill');
    args = { name: next[1], offset: Number(next[2]) };
  }
  throw new Error('the skill body never ended');
}

function followFile(registry: SkillRegistry, relpath: string) {
  const outputs: string[] = [];
  let args: Record<string, unknown> = { name: 'audit-skill', relpath };
  for (let guard = 0; guard < 50; guard++) {
    const result = registry.runTool(READ_SKILL_FILE_TOOL, args, ['audit-skill'])!;
    expect(result.status).toBe('success');
    expect(result.output.length).toBeLessThanOrEqual(MODEL_TOOL_RESULT_MAX_CHARS);
    expect(boundToolResultForModel(READ_SKILL_FILE_TOOL, result.output)).toBe(result.output);
    outputs.push(result.output);
    const next = READ_NEXT.exec(result.output);
    if (!next) return outputs;
    expect(next[2]).toBe(relpath);
    args = { name: next[1], relpath: next[2], offset: Number(next[3]) };
  }
  throw new Error('the skill file never ended');
}

describe('authorized skill content is read in full, in parts', () => {
  it('loads an authorized 24,001-character body in parts instead of refusing it', async () => {
    const body = `${'x'.repeat(24_001)}TAIL`;
    await fs.writeFile(path.join(skill, 'SKILL.md'), `${HEADER}${body}`);
    const registry = SkillRegistry.load(root);
    expect(registry.metadata(['audit-skill'])).toHaveLength(1);

    const outputs = followBody(registry);
    expect(outputs.length).toBe(2);
    expect(outputs.map(partOf).join('')).toBe(body);
    expect(outputs[0]).toContain('not the whole instructions');
    expect(outputs[1]).toContain('the end of the instructions');
  });

  it('continues a 100,004-character authorized reference to its TAIL', async () => {
    await fs.writeFile(path.join(skill, 'SKILL.md'), `${HEADER}Read reference.md.`);
    const reference = `${'r'.repeat(100_000)}TAIL`;
    await fs.writeFile(path.join(skill, 'reference.md'), reference);
    const registry = SkillRegistry.load(root);

    const outputs = followFile(registry, 'reference.md');
    expect(outputs.length).toBeGreaterThan(4);
    expect(outputs.map(partOf).join('')).toBe(reference);
    expect(outputs.at(-1)).toContain('TAIL');
    expect(outputs.at(-1)).toContain('the end of the file');
    // A short reference is still returned exactly as it is, with no note.
    await fs.writeFile(path.join(skill, 'short.md'), 'inside reference');
    expect(registry.runTool(READ_SKILL_FILE_TOOL, { name: 'audit-skill', relpath: 'short.md' }, ['audit-skill'])?.output)
      .toBe('inside reference');
  });

  it('never splits a surrogate pair, and starts a cursor inside a pair at the pair', async () => {
    const body = '中😀𠜎a'.repeat(12_000);
    await fs.writeFile(path.join(skill, 'SKILL.md'), `${HEADER}${body}`);
    const registry = SkillRegistry.load(root);
    const outputs = followBody(registry);
    for (const output of outputs) expect(LONE_SURROGATE.test(partOf(output))).toBe(false);
    expect(outputs.map(partOf).join('')).toBe(body);

    // Offset 2 names the second half of the 😀 pair.
    const inside = registry.runTool(LOAD_SKILL_TOOL, { name: 'audit-skill', offset: 2 }, ['audit-skill'])!;
    expect(partOf(inside.output).startsWith('😀𠜎a')).toBe(true);

    // Bodies of pairs only, shifted by one character, so a part boundary falls inside a pair whatever the page size.
    for (const shift of ['', 'a']) {
      const pairs = `${shift}${'😀'.repeat(15_000)}`;
      await fs.writeFile(path.join(skill, 'SKILL.md'), `${HEADER}${pairs}`);
      const pairOutputs = followBody(SkillRegistry.load(root));
      for (const output of pairOutputs) expect(LONE_SURROGATE.test(partOf(output))).toBe(false);
      expect(pairOutputs.map(partOf).join('')).toBe(pairs);
    }
  });

  it('keeps the executable-action notice on every part of a long body', async () => {
    const body = 'e'.repeat(60_000);
    await fs.writeFile(path.join(skill, 'SKILL.md'), `${HEADER}${body}`);
    await fs.writeFile(path.join(skill, 'unode-actions.json'), JSON.stringify({
      version: 1,
      actions: [{ id: 'run-audit', description: 'Run the bounded audit.', handler: 'unode.echo-json.v1', declaredEffects: ['read-workspace'] }],
    }));
    const registry = SkillRegistry.load(root);
    const outputs = followBody(registry);
    expect(outputs.length).toBeGreaterThan(2);
    for (const output of outputs) {
      expect(output).toContain('## UnodeAi executable actions');
      expect(output).toContain('run_skill_action');
    }
    const parts = outputs.map((output) => output.slice(0, output.indexOf('\n\n')));
    expect(parts.join('')).toBe(body);
  });

  it('says plainly when an offset is past the end', async () => {
    await fs.writeFile(path.join(skill, 'SKILL.md'), `${HEADER}short body`);
    await fs.writeFile(path.join(skill, 'note.md'), 'note');
    const registry = SkillRegistry.load(root);
    expect(registry.runTool(LOAD_SKILL_TOOL, { name: 'audit-skill', offset: 50 }, ['audit-skill']))
      .toMatchObject({ status: 'failed', output: expect.stringContaining('offset 50 is at or past the end of skill "audit-skill" (10 characters)') });
    expect(registry.runTool(READ_SKILL_FILE_TOOL, { name: 'audit-skill', relpath: 'note.md', offset: 4 }, ['audit-skill']))
      .toMatchObject({ status: 'failed', output: expect.stringContaining('offset 4 is at or past the end of note.md (4 characters)') });
  });

  it('keeps authorization, path confinement and the executable boundary with an offset', async () => {
    await fs.writeFile(path.join(skill, 'SKILL.md'), `${HEADER}${'b'.repeat(30_000)}`);
    await fs.writeFile(path.join(skill, 'unode-actions.json'), JSON.stringify({
      version: 1,
      actions: [{ id: 'run-audit', description: 'Run the bounded audit.', handler: 'unode.echo-json.v1', declaredEffects: ['read-workspace'] }],
    }));
    await fs.writeFile(path.join(root, 'outside.md'), `${'o'.repeat(30_000)}SECRET`);
    const registry = SkillRegistry.load(root);
    expect(registry.runTool(LOAD_SKILL_TOOL, { name: 'audit-skill', offset: 10 }, []))
      .toMatchObject({ status: 'refused', reason: 'capability' });
    expect(registry.runTool(READ_SKILL_FILE_TOOL, { name: 'audit-skill', relpath: 'reference.md', offset: 10 }, ['other-skill']))
      .toMatchObject({ status: 'refused', reason: 'capability' });
    const escape = registry.runTool(READ_SKILL_FILE_TOOL, { name: 'audit-skill', relpath: '../../outside.md', offset: 29_995 }, ['audit-skill'])!;
    expect(escape).toMatchObject({ status: 'refused', reason: 'scope' });
    expect(escape.output).not.toContain('SECRET');
    expect(registry.runTool(READ_SKILL_FILE_TOOL, { name: 'audit-skill', relpath: 'unode-actions.json', offset: 1 }, ['audit-skill']))
      .toMatchObject({ status: 'refused', reason: 'scope' });
  });

  it('advertises the offset on both skill tools', async () => {
    await fs.writeFile(path.join(skill, 'SKILL.md'), `${HEADER}body`);
    const specs = SkillRegistry.load(root).toolSpecs(['audit-skill']);
    for (const spec of specs) {
      expect((spec.function.parameters as any).properties.offset).toMatchObject({ type: 'integer' });
      expect((spec.function.parameters as any).required).not.toContain('offset');
      expect(spec.function.description).toContain('in parts');
    }
  });

  it('lets an OpenAI-compatible model load a long body by making the calls the results name', async () => {
    const body = `${'z'.repeat(50_000)}TAIL`;
    await fs.writeFile(path.join(skill, 'SKILL.md'), `${HEADER}${body}`);
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-skill-paging-ws-'));
    const toolResults: string[] = [];
    let call = 0;
    const fetchFn: FetchFn = async (_url, init) => {
      const request = JSON.parse(init.body);
      const last = request.messages.at(-1);
      // A tool message may carry its text as content parts.
      if (last?.role === 'tool') {
        toolResults.push(typeof last.content === 'string' ? last.content : last.content.map((part: { text?: string }) => part.text ?? '').join(''));
      }
      const next = toolResults.length === 0 ? { name: 'audit-skill' } : (() => {
        const match = LOAD_NEXT.exec(toolResults.at(-1)!);
        return match ? { name: match[1], offset: Number(match[2]) } : undefined;
      })();
      const message = next && call < 10
        ? { role: 'assistant', content: null, tool_calls: [{ id: `skill-${++call}`, type: 'function', function: { name: LOAD_SKILL_TOOL, arguments: JSON.stringify(next) } }] }
        : { role: 'assistant', content: 'skill loaded' };
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message }] }) };
    };
    const backend = new OpenAICompatBackend({
      id: 'a1', name: 'Worker', role: 'senior-dev', skill: '',
      provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
      model: 'deepseek-chat', systemPrompt: 'Be terse.', autoApprove: true,
      allowedTools: ['read'], workingDirectory: workspace, playbooks: ['audit-skill'],
    } as AgentConfig, fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    (backend as any).skillRegistry = SkillRegistry.load(root);
    try {
      const events: BackendEvent[] = [];
      const done = new Promise<void>((resolve) => backend.onEvent((event) => {
        events.push(event);
        if (event.kind === 'turn_complete') resolve();
      }));
      await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
      backend.sendUserTurn('audit this');
      await done;
      expect(events.find((event) => event.kind === 'assistant')).toMatchObject({ text: 'skill loaded' });
      expect(toolResults.length).toBe(3);
      expect(toolResults.map(partOf).join('')).toBe(body);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
