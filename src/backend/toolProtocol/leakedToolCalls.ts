/*---------------------------------------------------------------------------------------------
 *  UnodeAi - leakedToolCalls  (native-mode robustness)
 *  Some models (notably DeepSeek) intermittently emit their tool call as TEXT in the message content
 *  instead of the OpenAI `tool_calls` field — e.g.:
 *
 *    <｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="read_file">
 *      <｜｜DSML｜｜parameter name="path" string="true">src/foo.ts</｜｜DSML｜｜parameter>
 *    </｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>
 *
 *  When that happens the native parser sees no tool_calls, treats the markup as the final answer, and
 *  the tool never runs (it just leaks into chat). This recovers such calls from `content` so they
 *  execute anyway. Keys on the `invoke name="…"` / `parameter name="…">value</…parameter>` structure,
 *  so it's tolerant of the surrounding token noise (｜｜DSML｜｜, antml:, etc.). Pure; never throws.
 *--------------------------------------------------------------------------------------------*/

export interface RecoveredCall {
  name: string;
  args: Record<string, unknown>;
}

// One `invoke name="TOOL"` …up to the next invoke or end of string (close tag may be missing/truncated).
const INVOKE_RE = /invoke\s+name="([^"]+)"([\s\S]*?)(?=invoke\s+name="|$)/gi;
// One `parameter name="NAME" …>VALUE</…parameter>` inside an invoke body.
const PARAM_RE = /parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/?[^>]*?parameter>/gi;
// Kimi/Moonshot leak: `<|tool_call_begin|>functions.NAME:ID<|tool_call_argument_begin|>{json}<|tool_call_end|>`.
const KIMI_CALL_RE =
  /<\|tool_call_begin\|>\s*(?:functions\.)?([^\s:|<]+)(?::\d+)?\s*<\|tool_call_argument_begin\|>([\s\S]*?)<\|tool_call_end\|>/g;
// GLM / Qwen / Hermes leak: `<tool_call>{"name":"TOOL","arguments":{…}}</tool_call>` (arguments may be a
// nested object OR a JSON string). GLM-5.2 emits this even when told to use another format, so the XML/native
// parser sees no call and stalls. Matched tolerantly (optional whitespace/newlines around the JSON body).
const JSON_TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;

/**
 * Recover tool calls a model leaked into message text instead of the OpenAI `tool_calls` field, across
 * the known token formats (GLM/Qwen/Hermes `<tool_call>{json}</tool_call>`, DeepSeek DSML `invoke`/
 * `parameter`, antml, Kimi `<|tool_call_begin|>`). Returns [] when no leak pattern is present. Never throws.
 */
export function recoverLeakedToolCalls(content: string): RecoveredCall[] {
  if (!content) {
    return [];
  }
  const jsonTag = recoverJsonToolCallTags(content);
  if (jsonTag.length > 0) {
    return jsonTag;
  }
  const kimi = recoverKimiCalls(content);
  if (kimi.length > 0) {
    return kimi;
  }
  return recoverInvokeCalls(content);
}

/** GLM/Qwen/Hermes `<tool_call>{"name","arguments"}</tool_call>` — the body is JSON; parse name + args. */
function recoverJsonToolCallTags(content: string): RecoveredCall[] {
  if (!/<tool_call>/i.test(content)) {
    return [];
  }
  const out: RecoveredCall[] = [];
  for (const m of content.matchAll(JSON_TOOL_CALL_RE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue; // truncated / non-JSON body — skip so the model can be re-prompted
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!name) {
      continue;
    }
    let args: Record<string, unknown> = {};
    const raw = obj.arguments ?? obj.parameters ?? {};
    if (typeof raw === 'string') {
      try {
        const a = JSON.parse(raw);
        if (a && typeof a === 'object' && !Array.isArray(a)) { args = a as Record<string, unknown>; }
      } catch { /* leave empty → required-param validation prompts a correction */ }
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      args = raw as Record<string, unknown>;
    }
    out.push({ name, args });
  }
  return out;
}

/** Kimi/Moonshot format: the arguments block is proper JSON, so we parse it into typed args. */
function recoverKimiCalls(content: string): RecoveredCall[] {
  if (!content.includes('<|tool_call_begin|>')) {
    return [];
  }
  const out: RecoveredCall[] = [];
  for (const m of content.matchAll(KIMI_CALL_RE)) {
    const name = m[1].trim();
    if (!name) {
      continue;
    }
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(m[2].trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // arguments weren't valid JSON — leave empty so required-param validation prompts a correction
    }
    out.push({ name, args });
  }
  return out;
}

/** DeepSeek DSML / antml format: `invoke name="…"` with `parameter name="…">value</…parameter>` children. */
function recoverInvokeCalls(content: string): RecoveredCall[] {
  if (!/invoke\s+name="/i.test(content)) {
    return [];
  }
  const out: RecoveredCall[] = [];
  for (const inv of content.matchAll(INVOKE_RE)) {
    const name = inv[1].trim();
    if (!name) {
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const p of inv[2].matchAll(PARAM_RE)) {
      const key = p[1].trim();
      if (key) {
        args[key] = trimOuterLineBreaks(p[2]);
      }
    }
    out.push({ name, args });
  }
  return out;
}

function trimOuterLineBreaks(value: string): string {
  return value.replace(/^\s*\r?\n/, '').replace(/\r?\n\s*$/, '').trim();
}

/**
 * Strip tool-call markup a model put in its message text — the XML protocol's `<use_tool>` blocks and
 * leaked native tool tokens (DSML/antml `…tool_calls`/`invoke` wrappers) — so the chat transcript shows
 * the model's prose, not the raw call. Tolerant of the token noise around the tag names.
 */
export function stripToolCallMarkup(content: string, toolNames: string[] = []): string {
  if (!content) {
    return content;
  }
  let out = content
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '') // GLM/Qwen/Hermes JSON tool-call block
    .replace(/<[^>]*?use_tool\b[^>]*>[\s\S]*?<\/[^>]*?use_tool>/gi, '')
    .replace(/<[^>]*?tool_calls\b[^>]*>[\s\S]*?<\/[^>]*?tool_calls>/gi, '')
    .replace(/<[^>]*?invoke\b[^>]*>[\s\S]*?<\/[^>]*?invoke>/gi, '')
    // Kimi/Moonshot token block, plus any stray section/call tokens.
    .replace(/<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/g, '')
    .replace(/<\|tool_call[s]?(?:_[a-z]+)*\|>/g, '');
  // A recovered FLAT-XML call (<tool_name>…</tool_name>) — strip the block for each tool name we
  // actually parsed, so the transcript shows prose, not the raw call. Anchored on real names only.
  for (const name of toolNames) {
    if (!name) { continue; }
    out = out.replace(new RegExp(`<${escapeForStrip(name)}\\b[^>]*>[\\s\\S]*?</${escapeForStrip(name)}>`, 'gi'), '');
  }
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeForStrip(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
