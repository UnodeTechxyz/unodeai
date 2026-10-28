import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runContentReceiptRead } from '../contentReceiptRead';
import { READ_FILE_CHAR_OFFSET_DESCRIPTION, WorkspaceTools, receiptTextSize } from '../WorkspaceTools';
import { ClaudeHeadlessBackend } from '../ClaudeHeadlessBackend';
import { COORDINATOR_READ_FILE_SPEC } from '../CodexBackend';
import { OpenAICompatBackend, type FetchFn } from '../OpenAICompatBackend';
import type { BackendEvent } from '../AgentBackend';
import type { AgentConfig } from '../../types';

/**
 * v0.9.99: read_file pages inside a line. A line longer than the route can carry arrives in bounded parts; each part
 * names the exact call that reads the rest (`char_offset`), outside the part's own budget, and no part is presented
 * as a whole citable line.
 */
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-long-line-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const CONTINUE_CALL = /call read_file\(\{ path: "([^"]*)", offset: (\d+), char_offset: (\d+) \}\)/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

type Budget = { unit: 'bytes' | 'chars'; limit: number; delivery: 'delivered' | 'pending-observation' | 'end-check' };

/** One receipt-route read, as OpenAI-compatible (chars), Claude (bytes) and Codex (bytes, end check) run it. */
async function receiptRead(tools: WorkspaceTools, args: Record<string, unknown>, budget: Budget) {
  const registered: string[] = [];
  const read = await runContentReceiptRead(tools, args, {
    unit: budget.unit,
    limit: budget.limit,
    delivery: budget.delivery,
    register: (content) => { registered.push(content); return { id: `receipt-${'0'.repeat(36)}`, endCheck: 'abcdef012345' }; },
  });
  return { read, registered };
}

/** Follows the continuation calls the results name, from `offset`, and returns every part of that one line. */
async function followLine(tools: WorkspaceTools, file: string, offset: number, budget: Budget) {
  const parts: string[] = [];
  const texts: string[] = [];
  let args: Record<string, unknown> = { path: file, offset };
  for (let guard = 0; guard < 100; guard++) {
    const { read, registered } = await receiptRead(tools, args, budget);
    expect(read.result.status).toBe('success');
    // A part of a line is never a content receipt: it is not exact whole content.
    expect(read.receipt).toBeUndefined();
    expect(registered).toEqual([]);
    expect(receiptTextSize(read.text, budget.unit)).toBeLessThanOrEqual(budget.limit);
    texts.push(read.text);
    parts.push(read.text.slice(0, read.text.indexOf('\n')));
    const next = CONTINUE_CALL.exec(read.text);
    if (!next) return { parts, texts };
    expect(next[1]).toBe(file);
    expect(Number(next[2])).toBe(offset);
    args = { path: next[1], offset: Number(next[2]), char_offset: Number(next[3]) };
  }
  throw new Error('the line never ended');
}

describe('read_file continues inside a long line', () => {
  it('reaches the TAIL of a one-line 32,000-character JSON value through the real receipt route (24,000 characters)', async () => {
    const json = JSON.stringify({ data: 'x'.repeat(32_000), end: 'TAIL' });
    await fs.writeFile(path.join(dir, 'one-line.json'), json, 'utf8');
    const tools = new WorkspaceTools(dir, new Set(['read']));
    const budget: Budget = { unit: 'chars', limit: 24_000, delivery: 'delivered' };

    const { parts, texts } = await followLine(tools, 'one-line.json', 0, budget);
    expect(parts.length).toBe(2);
    expect(parts.join('')).toBe(json);
    expect(JSON.parse(parts.join('')).end).toBe('TAIL');
    // The first part says it is a part, how long the line is, and that it cannot be cited as the whole line.
    expect(texts[0]).toContain(`line 0 has ${json.length} characters`);
    expect(texts[0]).toContain('not the whole line');
    expect(texts[0]).toContain('cannot be cited');
    // The last part ends the line and the file.
    expect(texts[1]).toContain(`Line 0, characters ${parts[0].length}–${json.length} of ${json.length}`);
    expect(texts[1]).toContain('the end of the file');
    expect(CONTINUE_CALL.test(texts[1])).toBe(false);
  });

  it('keeps every Unicode part whole on a byte route (Claude and Codex shapes), never splitting a surrogate pair', async () => {
    const line = `${'中😀a𠜎'.repeat(3_000)}END`;
    await fs.writeFile(path.join(dir, 'unicode.txt'), `${line}\nafter\n`, 'utf8');
    const tools = new WorkspaceTools(dir, new Set(['read']));
    for (const budget of [
      { unit: 'bytes', limit: 7_000, delivery: 'pending-observation' },
      { unit: 'bytes', limit: 9_001, delivery: 'end-check' },
      { unit: 'chars', limit: 5_003, delivery: 'delivered' },
    ] as Budget[]) {
      const { parts, texts } = await followLine(tools, 'unicode.txt', 0, budget);
      expect(parts.length).toBeGreaterThan(2);
      for (const part of parts) expect(LONE_SURROGATE.test(part)).toBe(false);
      expect(parts.join('')).toBe(line);
      // The last part points at the next line, which reads as ordinary whole content.
      expect(texts.at(-1)).toContain('To continue with the next line, use offset=1.');
      const after = await receiptRead(tools, { path: 'unicode.txt', offset: 1 }, budget);
      expect(after.registered).toEqual(['after\n']);
    }
  });

  it('starts a char_offset that lands inside a surrogate pair at the start of that pair', async () => {
    await fs.writeFile(path.join(dir, 'pair.txt'), `ab😀cd`, 'utf8');
    const tools = new WorkspaceTools(dir, new Set(['read']));
    const inside = await tools.run('read_file', { path: 'pair.txt', char_offset: 3 });
    expect(inside.status).toBe('success');
    expect(inside.output.startsWith('😀cd\n')).toBe(true);
    expect(inside.output).toContain('Line 0, characters 2–6 of 6');
  });

  it('keeps CRLF exact: the parts of a long CRLF line join to the line with its carriage return', async () => {
    const long = 'y'.repeat(30_000);
    await fs.writeFile(path.join(dir, 'crlf.csv'), `${long}\r\nTAIL\r\n`, 'utf8');
    const tools = new WorkspaceTools(dir, new Set(['read']));
    const budget: Budget = { unit: 'chars', limit: 24_000, delivery: 'delivered' };
    const { parts, texts } = await followLine(tools, 'crlf.csv', 0, budget);
    expect(parts.join('')).toBe(`${long}\r`);
    expect(texts.at(-1)).toContain('use offset=1');
    const tail = await receiptRead(tools, { path: 'crlf.csv', offset: 1 }, budget);
    expect(tail.registered).toEqual(['TAIL\r\n']);
  });

  it('says a numbered part cannot be cited and issues no read receipt for any part', async () => {
    const long = 'n'.repeat(12_000);
    await fs.writeFile(path.join(dir, 'numbered.txt'), `${long}\nnext\n`, 'utf8');
    const tools = new WorkspaceTools(dir, new Set(['read']));
    const receiptBudget = { unit: 'bytes' as const, limit: 5_000, reserved: 200 };
    const first = await tools.run('read_file', { path: 'numbered.txt', line_numbers: true }, { receiptBudget });
    expect(first.output.startsWith('1\tnnn')).toBe(true);
    expect(first.readReceipt).toBeUndefined();
    expect(first.output).toContain('[no read receipt: numbered line 1 is shown only in part and cannot be cited.]');
    const next = CONTINUE_CALL.exec(first.output)!;
    const second = await tools.run('read_file', { path: 'numbered.txt', offset: 0, char_offset: Number(next[3]), line_numbers: true }, { receiptBudget });
    // A later part carries no line number: it does not start the line.
    expect(second.output.startsWith('nnn')).toBe(true);
    expect(second.readReceipt).toBeUndefined();
    expect(second.output).toContain('[no read receipt: numbered line 1 is shown only in part and cannot be cited.]');
    expect(receiptTextSize(second.output, 'bytes')).toBeLessThanOrEqual(receiptBudget.limit - receiptBudget.reserved);
  });

  it('continues a line on an ordinary read too, and says plainly when char_offset is past the end of the line', async () => {
    await fs.writeFile(path.join(dir, 'short.txt'), 'abcdefghij\nsecond', 'utf8');
    const tools = new WorkspaceTools(dir, new Set(['read']));
    const rest = await tools.run('read_file', { path: 'short.txt', char_offset: 4 });
    expect(rest.status).toBe('success');
    expect(rest.output.startsWith('efghij\n')).toBe(true);
    expect(rest.output).toContain('Line 0, characters 4–10 of 10');
    expect(rest.output).toContain('To continue with the next line, use offset=1.');
    expect(rest.readContent).toBeUndefined();

    const past = await tools.run('read_file', { path: 'short.txt', char_offset: 10 });
    expect(past.status).toBe('failed');
    expect(past.output).toContain('char_offset 10 is at or past the end of line 0 (10 characters)');
    expect(past.output).toContain('use offset=1');
  });

  it('keeps an ordinary continued read inside the 100,000-byte read cap, the continuation call included', async () => {
    const long = 'w'.repeat(250_000);
    await fs.writeFile(path.join(dir, 'wide.txt'), `${long}\nlast`, 'utf8');
    const tools = new WorkspaceTools(dir, new Set(['read']));
    const parts: string[] = [long.slice(0, 1)];
    let args: Record<string, unknown> = { path: 'wide.txt', char_offset: 1 };
    for (let guard = 0; guard < 10; guard++) {
      const read = await tools.run('read_file', args);
      // The read cap of an ordinary read (100 KB) holds the part and its note together.
      expect(Buffer.byteLength(read.output, 'utf8')).toBeLessThanOrEqual(100_000);
      parts.push(read.output.slice(0, read.output.indexOf('\n')));
      const next = CONTINUE_CALL.exec(read.output);
      if (!next) break;
      args = { path: next[1], offset: Number(next[2]), char_offset: Number(next[3]) };
    }
    expect(parts.join('')).toBe(long);
  });

  it('keeps read authority: a cursor into a file outside the read roots reads nothing', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'unode-long-line-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'secret.txt'), `${'s'.repeat(50_000)}SECRET`, 'utf8');
      const tools = new WorkspaceTools(dir, new Set(['read']));
      const read = await tools.run('read_file', { path: path.join(outside, 'secret.txt'), char_offset: 49_990 });
      expect(read.status).not.toBe('success');
      expect(read.output).not.toContain('SECRET');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('advertises char_offset with the same words on every route that serves read_file', async () => {
    const tools = new WorkspaceTools(dir, new Set(['read']));
    const openAi = tools.specs().find((spec) => spec.function.name === 'read_file')!;
    expect((openAi.function.parameters as any).properties.char_offset).toEqual({ type: 'integer', description: READ_FILE_CHAR_OFFSET_DESCRIPTION });

    const claude = new ClaudeHeadlessBackend({ id: 'a', name: 'A', role: 'pm', model: 'sonnet', systemPrompt: '', workingDirectory: dir } as AgentConfig);
    const bridgeRead = (claude as any).buildFilesBridgeTools(tools).find((tool: { name: string }) => tool.name === 'read_file');
    expect(bridgeRead.inputSchema.properties.char_offset).toEqual({ type: 'integer', description: READ_FILE_CHAR_OFFSET_DESCRIPTION });

    expect((COORDINATOR_READ_FILE_SPEC.function.parameters as any).properties.char_offset)
      .toEqual({ type: 'integer', description: READ_FILE_CHAR_OFFSET_DESCRIPTION });
  });

  it('lets an OpenAI-compatible model read the whole long line by making the calls the results name', async () => {
    const json = JSON.stringify({ data: 'q'.repeat(32_000), end: 'TAIL' });
    await fs.writeFile(path.join(dir, 'one-line.json'), json, 'utf8');
    const toolResults: string[] = [];
    let call = 0;
    // A scripted model: it reads the file, then makes exactly the continuation call the last tool result names.
    const fetchFn: FetchFn = async (_url, init) => {
      const request = JSON.parse(init.body);
      const last = request.messages.at(-1);
      if (last?.role === 'tool') toolResults.push(String(last.content));
      const next = toolResults.length === 0 ? { path: 'one-line.json' } : (() => {
        const match = CONTINUE_CALL.exec(toolResults.at(-1)!);
        return match ? { path: match[1], offset: Number(match[2]), char_offset: Number(match[3]) } : undefined;
      })();
      const message = next && call < 10
        ? { role: 'assistant', content: null, tool_calls: [{ id: `read-${++call}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify(next) } }] }
        : { role: 'assistant', content: 'read it all' };
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message }] }) };
    };
    const backend = new OpenAICompatBackend({
      id: 'a1', name: 'Worker', role: 'senior-dev', skill: '',
      provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
      model: 'deepseek-chat', systemPrompt: 'Be terse.', autoApprove: true,
      allowedTools: ['read'], workingDirectory: dir,
    } as AgentConfig, fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 });
    const events: BackendEvent[] = [];
    const done = new Promise<void>((resolve) => backend.onEvent((event) => {
      events.push(event);
      if (event.kind === 'turn_complete') resolve();
    }));
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
    backend.sendUserTurn('read one-line.json');
    await done;

    expect(events.find((event) => event.kind === 'assistant')).toMatchObject({ text: 'read it all' });
    expect(toolResults.length).toBe(2);
    for (const result of toolResults) expect(result.length).toBeLessThanOrEqual(24_000);
    // Each result's data is its first line; the notes follow on lines of their own.
    expect(toolResults.map((result) => result.slice(0, result.indexOf('\n'))).join('')).toBe(json);
    expect(toolResults[1]).toContain('the end of the file');
  });
});
