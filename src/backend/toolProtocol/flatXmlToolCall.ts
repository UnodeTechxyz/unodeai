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
import { argumentTags, firstFlatToolBlock, maskCdata } from './xmlBlocks';

export interface FlatXmlCall {
  name: string;
  args: Record<string, unknown>;
}

/** Recover the earliest flat-XML tool call whose tag is a known tool name, or undefined if none. */
export function parseFlatXmlToolCall(content: string, specs: ToolSpec[]): FlatXmlCall | undefined {
  if (!content || specs.length === 0) {
    return undefined;
  }
  // v0.9.104 D2.2: the same block and tag reader as the XML protocol, CDATA included.
  const masked = maskCdata(content);
  const block = firstFlatToolBlock(masked, specs.map((s) => s.function?.name));
  if (!block) {
    return undefined;
  }
  const spec = specs.find((s) => s.function.name === block.name);
  const props = schemaProperties(spec);
  const known = props ? new Set(Object.keys(props)) : undefined;
  const args: Record<string, unknown> = {};
  for (const tag of argumentTags(masked.slice(block.start, block.end), content.slice(block.start, block.end))) {
    if (known && !known.has(tag.name)) { continue; }            // only declared params (when schema known)
    if (Object.prototype.hasOwnProperty.call(args, tag.name)) { continue; } // first occurrence wins
    // A CDATA string is exactly what the model wrote.
    args[tag.name] = tag.verbatim && (schemaType(props?.[tag.name]) ?? 'string') === 'string' ? tag.text : coerce(tag.text, props?.[tag.name]);
  }
  return { name: block.name, args };
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
