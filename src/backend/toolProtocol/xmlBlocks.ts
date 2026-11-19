/*---------------------------------------------------------------------------------------------
 *  UnodeAi - xmlBlocks
 *  v0.9.104 D2.2 (ROADMAP: "define embedded-delimiter escaping and bound many-tool matching"): the one place both XML
 *  readers find a flat tool block and its argument tags, the XML tool protocol and the native protocol's recovery of
 *  flat XML a model leaked into its text.
 *
 *  Escaping. An argument may be wrapped in <![CDATA[ ... ]]>. Its content is then taken verbatim: markup inside it,
 *  such as a literal </content> or even </write_file> in a file being written, neither closes a tag nor starts one.
 *  Without CDATA, a value ends at the first closing tag of its name, as before, and entities such as &amp; are never
 *  decoded: code that contains them must arrive unchanged.
 *
 *  How. Blocks and tags are found in a masked copy where every CDATA section is replaced by spaces of the same length:
 *  no tag can start or end inside one, and every offset in the masked copy is the same offset in the reply. Values are
 *  then cut from the reply itself at those offsets, so nothing in it is ever replaced by an in-band marker (Codex's
 *  audit of 6b6ff997, F1: a private-use marker could be genuine file content), and no offset is taken from a
 *  lower-cased copy, whose length can differ (F2: U+0130 lower-cases to two code units).
 *
 *  Bounds. Matching uses fixed patterns, whatever the number of tools; a parse builds none. Nothing is truncated: a long
 *  file written in one call is legitimate.
 *--------------------------------------------------------------------------------------------*/

const CDATA_SECTION = /<!\[CDATA\[[\s\S]*?\]\]>/g;
// Codex's audit of 5c296230, F3: one section only, so its content never crosses a terminator. Adjacent sections
// (the way to write a literal terminator) are not one value: each gives its content.
const ONE_CDATA_VALUE = /^\s*<!\[CDATA\[((?:(?!\]\]>)[\s\S])*)\]\]>\s*$/;
const CDATA_CONTENT = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

export interface XmlArgumentTag {
  name: string;
  text: string;
  /** True when the whole value was one CDATA section: its text is exactly the section's content. */
  verbatim: boolean;
}

/** The reply with every CDATA section blanked to spaces of the same length; offsets match the reply's. */
export function maskCdata(content: string): string {
  return content.replace(CDATA_SECTION, (section) => ' '.repeat(section.length));
}

/**
 * The earliest block whose tag is a known tool name and that has its closing tag, as offsets of its body in the masked
 * text (and so in the reply). One pass over the opening tags, the names looked up in a map; tag names are ASCII
 * ([A-Za-z_][\w.-]*), so comparing them lower-cased changes no offset. Tool names match regardless of case, as before.
 */
export function firstFlatToolBlock(masked: string, toolNames: readonly (string | undefined)[]): { name: string; start: number; end: number } | undefined {
  const byName = new Map<string, string>();
  for (const name of toolNames) if (name) byName.set(name.toLowerCase(), name);
  if (byName.size === 0) return undefined;
  for (const opening of masked.matchAll(/<([A-Za-z_][\w.-]*)\b[^>]*>/g)) {
    const key = opening[1].toLowerCase();
    const name = byName.get(key);
    if (!name) continue;
    const start = (opening.index ?? 0) + opening[0].length;
    const closing = /<\/([A-Za-z_][\w.-]*)>/g;
    closing.lastIndex = start;
    for (let found = closing.exec(masked); found; found = closing.exec(masked)) {
      if (found[1].toLowerCase() === key) return { name, start, end: found.index };
    }
  }
  return undefined;
}

/**
 * The argument tags directly in a block body, in order: found in the masked body, their values cut from the reply's
 * body at the same offsets. A value that is one CDATA section is verbatim; other CDATA sections give their content.
 */
export function argumentTags(maskedBody: string, body: string): XmlArgumentTag[] {
  const tags: XmlArgumentTag[] = [];
  for (const match of maskedBody.matchAll(/<([A-Za-z_][\w.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
    const valueStart = (match.index ?? 0) + match[0].length - match[2].length - match[1].length - 3;
    const value = body.slice(valueStart, valueStart + match[2].length);
    const whole = ONE_CDATA_VALUE.exec(value);
    tags.push(whole
      ? { name: match[1], text: whole[1], verbatim: true }
      : { name: match[1], text: value.replace(CDATA_CONTENT, (_section, inner: string) => inner), verbatim: false });
  }
  return tags;
}
