/*---------------------------------------------------------------------------------------------
 *  UnodeAi - StreamJsonParser
 *  Line-buffered NDJSON parser for agent stdout (Claude Code stream-json, etc.)
 *
 *  Pure and side-effect free so it can be unit-tested without spawning a process.
 *  Child-process stdout arrives in arbitrary chunks: a single `data` event may contain
 *  half a line, several lines, or a line split across two events. This buffers partial
 *  lines and only emits complete, successfully-parsed JSON objects.
 *--------------------------------------------------------------------------------------------*/

export interface ParseResult {
  /** Successfully parsed JSON objects, in order. */
  objects: unknown[];
  /** Raw lines that were non-empty but failed to parse as JSON (e.g. log noise). */
  garbage: string[];
}

export class StreamJsonParser {
  private buffer = '';

  /**
   * Feed a chunk of stdout. Returns whatever complete JSON objects (and unparseable
   * non-empty lines) became available. Any trailing partial line is retained internally.
   */
  push(chunk: string): ParseResult {
    this.buffer += chunk;

    const objects: unknown[] = [];
    const garbage: string[] = [];

    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const rawLine = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      const line = rawLine.trim();
      if (line.length === 0) {
        continue;
      }

      try {
        objects.push(JSON.parse(line));
      } catch {
        garbage.push(line);
      }
    }

    return { objects, garbage };
  }

  /**
   * Flush any buffered trailing content (used when the stream closes without a final
   * newline). Returns the same shape as `push`.
   */
  flush(): ParseResult {
    const remainder = this.buffer.trim();
    this.buffer = '';

    if (remainder.length === 0) {
      return { objects: [], garbage: [] };
    }

    try {
      return { objects: [JSON.parse(remainder)], garbage: [] };
    } catch {
      return { objects: [], garbage: [remainder] };
    }
  }

  reset(): void {
    this.buffer = '';
  }
}
