/*---------------------------------------------------------------------------------------------
 *  UnodeAi - XmlToolProtocol
 *  Cline-style XML tool calls for models that are less reliable with native function calling.
 *--------------------------------------------------------------------------------------------*/

import type { ToolSpec } from '../WorkspaceTools';
import {
  AssistantMessageView,
  ParsedToolCall,
  ProtocolHistoryMessage,
  ToolProtocol,
} from './ToolProtocol';
import { recoverLeakedToolCalls } from './leakedToolCalls';
import { argumentTags, firstFlatToolBlock, maskCdata, type XmlArgumentTag } from './xmlBlocks';

type JsonSchemaish = {
  type?: unknown;
  description?: unknown;
  properties?: Record<string, unknown>;
  required?: unknown;
};

export class XmlToolProtocol implements ToolProtocol {
  public readonly sendsNativeTools = false;

  private nextId = 0;

  constructor(private readonly specs: ToolSpec[] = []) { }

  renderToolGuide(specs: ToolSpec[] = this.specs): string {
    const toolSections = specs.length > 0
      ? specs.map((spec) => renderToolSpec(spec)).join('\n\n')
      : 'No tools are currently available.';

    return [
      'XML tool calling protocol',
      '',
      'When you need to use a tool, output exactly one tool block and then stop. One message may call one tool only.',
      'The block TAG is the tool name; each child tag is an argument. Required arguments must be present.',
      'When no tool is needed, answer normally and do not write a tool block.',
      'If a tool fails, read the error, correct the arguments or choose another approach, and do not retry the exact same call unchanged.',
      '',
      'Format example (the outer tag is the tool name itself — no wrapper):',
      '<write_file>',
      '<path>src/foo.ts</path>',
      '<content>export const x = 1;',
      '</content>',
      '</write_file>',
      '',
      // v0.9.104 D2.2: the one escape, CDATA; entities are not decoded.
      'An argument whose text contains markup or a closing tag (HTML, XML, or a literal </content>) goes inside',
      '<![CDATA[ ... ]]>, which is taken exactly as written. Do not replace characters with entities such as &lt;.',
      '',
      'Available tools:',
      toolSections,
    ].join('\n');
  }

  parseCalls(msg: AssistantMessageView): ParsedToolCall[] {
    try {
      const content = msg.content ?? '';
      // v0.9.104 D2.2: CDATA sections are blanked first, so their content cannot open or close a block or a tag; values
      // are cut from the reply at the same offsets.
      const masked = maskCdata(content);

      // 1. FLAT format (primary, Cline-style): a block whose tag IS a known tool name, e.g.
      //    <read_file><path>x</path></read_file>. One level, no wrapper — so a model can't mis-close an
      //    outer <use_tool> (the stall that motivated this format). Anchored on known names, so a stray
      //    <tool> in prose can't be mistaken for a call.
      const flat = firstFlatToolBlock(masked, this.specs.map((spec) => spec.function.name));
      if (flat) {
        const tags = argumentTags(masked.slice(flat.start, flat.end), content.slice(flat.start, flat.end));
        return [{ id: `xml-${++this.nextId}`, name: flat.name, args: this.extractArgs(flat.name, tags) }];
      }

      // 2. LEGACY wrapper (back-compat, mis-close tolerant): <use_tool><tool>NAME</tool>…</use_tool>.
      //    Keeps in-flight sessions and models that still emit the old shape working.
      const body = firstUseToolBody(masked);
      if (body !== undefined) {
        const tags = argumentTags(masked.slice(body.start, body.end), content.slice(body.start, body.end));
        const toolName = tags.find((tag) => tag.name === 'tool')?.text.trim();
        if (!toolName) {
          return [];
        }
        return [{ id: `xml-${++this.nextId}`, name: toolName, args: this.extractArgs(toolName, tags.filter((t) => t.name !== 'tool')) }];
      }

      // 3. LEAKED native tokens (e.g. DeepSeek's DSML invoke/parameter markup) — recover so XML mode,
      //    which we recommend for weaker models, doesn't dead-end on exactly the models it's meant to help.
      return recoverLeakedToolCalls(content).map((c) => ({
        id: `xml-rec-${++this.nextId}`,
        name: c.name,
        args: c.args,
      }));
    } catch {
      return [];
    }
  }

  /** Map a tool block's direct child tags to typed arguments. When the schema is known, only accept
   *  declared parameters (so XML/HTML inside a value like `content` can't inject spurious args) and take
   *  the first occurrence of each. */
  private extractArgs(toolName: string, tags: XmlArgumentTag[]): Record<string, unknown> {
    const spec = this.specs.find((candidate) => candidate.function.name === toolName);
    const known = spec
      ? new Set(Object.keys(schemaProperties(schemaObject(spec.function.parameters))))
      : undefined;
    const args: Record<string, unknown> = {};
    for (const tag of tags) {
      if (known && !known.has(tag.name)) {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(args, tag.name)) {
        continue;
      }
      args[tag.name] = coerceArg(tag.text, paramSchema(spec, tag.name), tag.verbatim);
    }
    return args;
  }

  formatResult(call: ParsedToolCall, output: string): ProtocolHistoryMessage {
    return {
      role: 'user',
      content: `[Tool result: ${call.name}]\n${output}`,
    };
  }
}

function renderToolSpec(spec: ToolSpec): string {
  const params = schemaObject(spec.function.parameters);
  const properties = schemaProperties(params);
  const required = new Set(schemaRequired(params));
  const renderedParams = Object.entries(properties).map(([name, raw]) => {
    const schema = schemaObject(raw);
    const type = schemaType(schema) ?? 'string';
    const marker = required.has(name) ? 'required' : 'optional';
    const description = typeof schema.description === 'string' && schema.description.trim()
      ? ` - ${schema.description.trim()}`
      : '';
    return `  - ${name}: ${type}, ${marker}${description}`;
  });

  const paramText = renderedParams.length > 0
    ? renderedParams.join('\n')
    : '  - none';

  return [
    `Tool: ${spec.function.name}`,
    `Purpose: ${spec.function.description}`,
    'Arguments:',
    paramText,
  ].join('\n');
}

/** The body of the first <use_tool> block, as offsets in `content` (v0.9.104 D2.2: the reply's offsets too). */
function firstUseToolBody(content: string): { start: number; end: number } | undefined {
  // Well-formed: <use_tool>…</use_tool>.
  const closed = /(<use_tool\b[^>]*>)([\s\S]*?)<\/use_tool>/i.exec(content);
  if (closed) {
    const start = closed.index + closed[1].length;
    return { start, end: start + closed[2].length };
  }
  // Weak-model tolerance: the block opened but was MIS-CLOSED — most commonly with </tool> (echoing the
  // inner <tool> tag) or left unclosed entirely — so the strict match above finds nothing and the call
  // silently vanishes (the agent appears to "stall" after printing the block). Capture from the opening
  // tag to end-of-content; directChildTags still extracts <tool> + args, and a stray trailing </tool> is
  // ignored. The format guide tells the model to emit one block then stop, so to-end is safe.
  const open = /(<use_tool\b[^>]*>)[\s\S]*$/i.exec(content);
  return open ? { start: open.index + open[1].length, end: content.length } : undefined;
}

function paramSchema(spec: ToolSpec | undefined, name: string): JsonSchemaish | undefined {
  if (!spec) {
    return undefined;
  }
  return schemaObject(schemaProperties(schemaObject(spec.function.parameters))[name]);
}

function coerceArg(raw: string, schema: JsonSchemaish | undefined, verbatim = false): unknown {
  // v0.9.104 D2.2: a CDATA string is exactly what the model wrote, outer line breaks included.
  if (verbatim && (schemaType(schema) ?? 'string') === 'string') return raw;
  const text = trimOuterLineBreaks(raw);
  switch (schemaType(schema)) {
    case 'integer':
    case 'number':
      return coerceNumber(text);
    case 'boolean':
      return coerceBoolean(text);
    case 'array':
    case 'object':
      return coerceJson(text);
    case 'string':
    default:
      return text;
  }
}

function coerceNumber(text: string): number | string {
  const n = Number(text.trim());
  return Number.isFinite(n) ? n : text;
}

function coerceBoolean(text: string): boolean | string {
  const normalized = text.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  return text;
}

function coerceJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return text;
  }
}

function trimOuterLineBreaks(value: string): string {
  return value.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

function schemaObject(value: unknown): JsonSchemaish {
  return value && typeof value === 'object' ? value as JsonSchemaish : {};
}

function schemaProperties(schema: JsonSchemaish): Record<string, unknown> {
  return schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
}

function schemaRequired(schema: JsonSchemaish): string[] {
  return Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [];
}

function schemaType(schema: JsonSchemaish | undefined): string | undefined {
  const type = schema?.type;
  if (typeof type === 'string') {
    return type;
  }
  if (Array.isArray(type)) {
    return type.find((item): item is string => typeof item === 'string');
  }
  return undefined;
}
