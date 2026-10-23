export interface MalformedToolCall {
  name: string;
  markup: string;
  index: number;
}

/**
 * Detect whitespace between `<` and a known tool name. Tool-looking examples in fenced code,
 * inline code, or Markdown quotes remain ordinary quoted text and can never become actions.
 */
export function findMalformedKnownToolCall(
  content: string,
  knownToolNames: ReadonlySet<string>,
): MalformedToolCall | undefined {
  return findMalformedKnownToolCalls(content, knownToolNames)[0];
}

/** All actionable malformed openings, used by the streaming display filter as the same decision source. */
export function findMalformedKnownToolCalls(
  content: string,
  knownToolNames: ReadonlySet<string>,
): MalformedToolCall[] {
  const found: MalformedToolCall[] = [];
  let inFence: '`' | '~' | undefined;
  let offset = 0;
  for (const line of content.split(/(?<=\n)/)) {
    const trimmed = line.trimStart();
    const fence = trimmed.match(/^(`{3,}|~{3,})/);
    if (fence) {
      const kind = fence[1][0] as '`' | '~';
      if (!inFence) inFence = kind;
      else if (inFence === kind) inFence = undefined;
      offset += line.length;
      continue;
    }
    if (inFence || /^\s*>/.test(line)) {
      offset += line.length;
      continue;
    }

    const visible = stripInlineCode(line);
    // A tool call begins its own line. Mentioning `use < memory_note> syntax` is prose, not an action.
    const pattern = /^[ \t]*<\s+([A-Za-z][\w.-]*)\b[^>]*>/g;
    for (let match = pattern.exec(visible); match; match = pattern.exec(visible)) {
      const canonical = [...knownToolNames].find((name) => name.toLowerCase() === match[1].toLowerCase());
      if (canonical) found.push({
        name: canonical,
        markup: match[0].trimStart(),
        index: offset + match.index + match[0].length - match[0].trimStart().length,
      });
    }
    offset += line.length;
  }
  return found;
}

function stripInlineCode(line: string): string {
  let output = '';
  for (let index = 0; index < line.length;) {
    if (line[index] !== '`') {
      output += line[index++];
      continue;
    }
    let ticks = 1;
    while (line[index + ticks] === '`') ticks++;
    const marker = '`'.repeat(ticks);
    const close = line.indexOf(marker, index + ticks);
    if (close < 0) {
      output += ' '.repeat(line.length - index);
      break;
    }
    output += ' '.repeat(close + ticks - index);
    index = close + ticks;
  }
  return output;
}
