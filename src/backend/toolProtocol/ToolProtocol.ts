/*---------------------------------------------------------------------------------------------
 *  UnodeAi - ToolProtocol  (design C: pluggable tool-calling protocol)
 *  Abstracts the two protocol-specific concerns — how tools are ADVERTISED to the model, and how a
 *  tool call is PARSED out of the model's response — so the rest of the turn loop (execution, gating,
 *  checkpoints, the A/B robustness guards, emit) stays protocol-agnostic.
 *
 *  - NativeToolProtocol  → OpenAI `tools` + `tool_calls` (the current behaviour; Claude refactors to this).
 *  - XmlToolProtocol     → tool calls embedded as XML in the prompt/response (Cline-style), which weaker
 *                          models follow far more reliably than native function-call JSON.
 *
 *  This file is the STABLE CONTRACT both implementations target. Codex builds XmlToolProtocol against
 *  it; Claude builds NativeToolProtocol and wires the backend to call through the interface.
 *--------------------------------------------------------------------------------------------*/

import { ToolSpec } from '../WorkspaceTools';

/** A tool call after protocol-specific parsing, ready for the (shared) execution layer. */
export interface ParsedToolCall {
  /** Stable id used to correlate the tool_use/tool_result events and the history result. */
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** True when this call was RECOVERED from message content (the model leaked it as text instead of a
   *  native tool_calls entry). Its result must NOT be fed back as a native role:'tool' message — there's
   *  no matching assistant tool_calls entry, so strict OpenAI APIs reject the orphan; use a user message. */
  recovered?: boolean;
  /** Set when the model DID send `arguments` but they could not be parsed (truncated / invalid JSON).
   *  `args` is then `{}` — but the model must NOT be told it "omitted required parameters", which is false
   *  and makes it blind-retry the identical call. Report the parse failure instead. */
  argsParseError?: string;
}

/** Minimal view of an assistant message the protocol needs to parse calls from. */
export interface AssistantMessageView {
  content: string | null;
  /** Present only for native function-calling responses. */
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
}

/** A message to push onto history to feed a tool result back to the model. */
export interface ProtocolHistoryMessage {
  /** native → 'tool'; xml → 'user' text block (more robust on open models). */
  role: 'tool' | 'user';
  content: string;
  /** Set for role:'tool' (native) only. */
  tool_call_id?: string;
}

export interface ToolProtocol {
  /** Whether the API request should carry the native `tools` field (native=true, xml=false). */
  readonly sendsNativeTools: boolean;

  /**
   * Extra text appended to the system prompt to teach the model the tools. Native returns '' (the
   * API advertises tools natively); XML returns a tool manual + the one-tool-per-message rules.
   */
  renderToolGuide(specs: ToolSpec[]): string;

  /**
   * Extract tool calls from one assistant message. MUST NOT throw — malformed/absent calls return [].
   * Native reads `tool_calls`; XML parses the first tool block out of `content`.
   */
  parseCalls(msg: AssistantMessageView): ParsedToolCall[];

  /** Format a tool's output as the history message that feeds it back to the model next turn. */
  formatResult(call: ParsedToolCall, output: string): ProtocolHistoryMessage;
}
