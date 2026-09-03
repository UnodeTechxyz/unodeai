/*---------------------------------------------------------------------------------------------
 *  UnodeAi - flatXmlToolCall  (native-mode robustness)
 *  Recover a FLAT-XML tool call leaked into message CONTENT by a model on the NATIVE protocol:
 *
 *      <read_file><path>src/x.ts</path><offset>1100</offset><limit>150</limit></read_file>
 *
 *  i.e. the block tag IS the tool name, each child tag is an argument (the Cline-style shape the
 *  XmlToolProtocol uses). A reasoning model (e.g. Kimi) on native function-calling will sometimes emit
 *  this after a </think> block instead of a native tool_call. Without recovery the native parser sees
 *  no tool_calls, treats the markup as the final answer, and the turn ENDS with an unexecuted call —
 *  the agent "stalls" and a coordinator reads the task.complete as done.
 *
 *  Keyed on KNOWN tool names so a stray <tag> in prose can't be mistaken for a call; numeric/boolean
 *  args are coerced by the tool's schema (so e.g. read_file offset/limit are numbers, while write_file
 *  content stays a string even if it's "123"). Pure; never throws. Deliberately self-contained so it
 *  carries no dependency on the XmlToolProtocol (which owns the canonical XML-mode parse).
 *--------------------------------------------------------------------------------------------*/

import type { ToolSpec } from '../WorkspaceTools';

export interface FlatXmlCall {
  name: string;
  args: Record<string, unknown>;
}

/** Recover the earliest flat-XML tool call whose tag is a known tool name, or undefined if none. */
export function parseFlatXmlToolCall(content: string, specs: ToolSpec[]): FlatXmlCall | undefined {
  if (!content || specs.length === 0) {
    return undefined;
  }
  const block = firstFlatBlock(content, specs);
  if (!block) {
    return undefined;
  }
  const spec = specs.find((s) => s.function.name === block.name);
  const props = schemaProperties(spec);
  const known = props ? new Set(Object.keys(props)) : undefined;
  const args: Record<string, unknown> = {};
  for (const tag of directChildTags(block.body)) {
    if (known && !known.has(tag.name)) { continue; }            // only declared params (when schema known)
    if (Object.prototype.hasOwnProperty.call(args, tag.name)) { continue; } // first occurrence wins
    args[tag.name] = coerce(tag.text, props?.[tag.name]);
  }
  return { name: block.name, args };
}

function firstFlatBlock(content: string, specs: ToolSpec[]): { name: string; body: string } | undefined {
  let best: { name: string; body: string; index: number } | undefined;
  for (const spec of specs) {
    const name = spec.function?.name;
    if (!name) { continue; }
    const re = new RegExp(`<${escapeRegExp(name)}\\b[^>]*>([\\s\\S]*?)</${escapeRegExp(name)}>`, 'i');
    const m = re.exec(content);
    if (m && (best === undefined || m.index < best.index)) {
      best = { name, body: m[1], index: m.index };
    }
  }
  return best ? { name: best.name, body: best.body } : undefined;
}

function directChildTags(body: string): Array<{ name: string; text: string }> {
  const tags: Array<{ name: string; text: string }> = [];
  const re = /<([A-Za-z_][\w.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    tags.push({ name: m[1], text: trimOuterLineBreaks(m[2]) });
  }
  return tags;
}

function coerce(raw: string, schema: unknown): unknown {
  const text = trimOuterLineBreaks(raw);
  switch (schemaType(schema)) {
    case 'integer':
    case 'number': {
      const n = Number(text.trim());
      return Number.isFinite(n) ? n : text;
    }
    case 'boolean': {
      const t = text.trim().toLowerCase();
      return t === 'true' ? true : t === 'false' ? false : text;
    }
    case 'array':
    case 'object':
      try { return JSON.parse(text.trim()); } catch { return text; }
    default:
      return text;
  }
}

function schemaProperties(spec: ToolSpec | undefined): Record<string, unknown> | undefined {
  const params = spec?.function?.parameters as { properties?: unknown } | undefined;
  const props = params?.properties;
  return props && typeof props === 'object' ? (props as Record<string, unknown>) : undefined;
}

function schemaType(schema: unknown): string | undefined {
  const type = (schema as { type?: unknown } | undefined)?.type;
  if (typeof type === 'string') { return type; }
  if (Array.isArray(type)) { return type.find((t): t is string => typeof t === 'string'); }
  return undefined;
}

function trimOuterLineBreaks(value: string): string {
  return value.replace(/^\s*\r?\n/, '').replace(/\r?\n\s*$/, '').trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
