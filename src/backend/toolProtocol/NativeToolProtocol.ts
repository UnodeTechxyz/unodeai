/*---------------------------------------------------------------------------------------------
 *  UnodeAi - NativeToolProtocol
 *  The default protocol: OpenAI-style native function calling. Tools are advertised via the API's
 *  `tools` field and the model returns structured `tool_calls`; results go back as role:'tool'
 *  messages. This is exactly the behaviour OpenAICompatBackend had before design C — extracted behind
 *  the ToolProtocol seam so an alternative (XmlToolProtocol) can be swapped in for weaker models.
 *--------------------------------------------------------------------------------------------*/

import type { ToolSpec } from '../WorkspaceTools';
import {
  AssistantMessageView,
  ParsedToolCall,
  ProtocolHistoryMessage,
  ToolProtocol,
} from './ToolProtocol';
import { recoverLeakedToolCalls } from './leakedToolCalls';
import { parseFlatXmlToolCall } from './flatXmlToolCall';

export class NativeToolProtocol implements ToolProtocol {
  public readonly sendsNativeTools = true;
  private recoveredCount = 0;

  /** Tool specs, so a flat-XML call leaked into content can be matched against known tool names. */
  constructor(private readonly specs: ToolSpec[] = []) {}

  /** Native advertises tools through the API's `tools` field, so no prompt guide is needed. */
  renderToolGuide(_specs: ToolSpec[]): string {
    return '';
  }

  parseCalls(msg: AssistantMessageView): ParsedToolCall[] {
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      return msg.tool_calls.map((call) => {
        const { args, parseError } = parseToolArgs(call.function.arguments);
        return { id: call.id, name: call.function.name, args, ...(parseError ? { argsParseError: parseError } : {}) };
      });
    }
    const content = msg.content ?? '';
    // Robustness: some models (e.g. DeepSeek) leak the tool call into `content` as text instead of the
    // tool_calls field (DSML/antml invoke, Kimi tokens). Recover those so they execute instead of
    // dead-ending in chat.
    const leaked = recoverLeakedToolCalls(content);
    if (leaked.length > 0) {
      return leaked.map((c) => ({ id: `recovered-${++this.recoveredCount}`, name: c.name, args: c.args, recovered: true }));
    }
    // And a reasoning model (e.g. Kimi) on native function-calling may emit a FLAT-XML call after a
    // </think> block — <read_file><path>…</path></read_file>. Recover that too (keyed on known tool
    // names) so the turn doesn't stall with an unexecuted call inside it.
    const flat = parseFlatXmlToolCall(content, this.specs);
    return flat ? [{ id: `recovered-${++this.recoveredCount}`, name: flat.name, args: flat.args, recovered: true }] : [];
  }

  formatResult(call: ParsedToolCall, output: string): ProtocolHistoryMessage {
    // A recovered call has no matching assistant `tool_calls` entry in history, so a native role:'tool'
    // message would be an orphan that strict OpenAI-compatible APIs reject. Feed it back as a plain user
    // message instead (the model still sees the result; the next request stays valid).
    if (call.recovered) {
      return { role: 'user', content: `[Tool result: ${call.name}]\n${output}` };
    }
    return { role: 'tool', tool_call_id: call.id, content: output };
  }
}

/**
 * Parse a native tool call's `arguments`.
 *
 * Per the OpenAI spec this is a JSON string, but real gateways deviate:
 *  - some deliver an already-parsed **object** (Unode gateway + DeepSeek). Coercing that to a string
 *    produced `"[object Object]"`, which failed to parse and silently became `{}` — the model was then
 *    told it had "omitted" parameters it had actually sent, so it blind-retried the identical call.
 *  - a truncated stream leaves invalid JSON. Collapsing that to `{}` produces the same false message.
 *
 * So: accept objects directly, and report a parse failure rather than pretending the model sent nothing.
 */
export function parseToolArgs(raw: unknown): { args: Record<string, unknown>; parseError?: string } {
  if (raw && typeof raw === 'object') {
    return { args: raw as Record<string, unknown> };
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { args: {} }; // genuinely absent — the "missing required parameter" message is correct here
  }
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? { args: value as Record<string, unknown> } : { args: {} };
  } catch (err) {
    // Non-empty but unparsable: the model DID send arguments. Say so, instead of "you omitted them".
    return { args: {}, parseError: err instanceof Error ? err.message : String(err) };
  }
}
