/*---------------------------------------------------------------------------------------------
 *  UnodeAi - BoundedCommandOutput (v0.9.96)
 *  A streaming accumulator for command output that keeps the beginning AND the end. A failing build or
 *  test prints its useful error last, so a head-only cut hid exactly the part an agent needed. Memory is
 *  bounded to a head and a tail plus counters, however long the command runs. ANSI escape sequences are
 *  removed before anything is counted, also when a sequence is split across two chunks. vscode-free.
 *--------------------------------------------------------------------------------------------*/

/** UTF-16 code units kept from the beginning of the output. */
export const COMMAND_OUTPUT_HEAD_CHARS = 8_000;
/** UTF-16 code units kept from the end of the output. */
export const COMMAND_OUTPUT_TAIL_CHARS = 8_000;
/** The model-facing ceiling of one command result, framing included. */
export const COMMAND_OUTPUT_MAX_CHARS = 16_000;

/** A pending escape sequence longer than this is not a terminal control sequence; it is released as text. */
const MAX_PENDING_ESCAPE = 4_096;

export function omittedOutputMarker(omitted: number): string {
  return `…[omitted ${omitted} characters; showing command output head and tail]…`;
}

const COMPLETE_ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** An escape sequence that has started but not ended yet, anchored at the end of the text. */
const INCOMPLETE_ESCAPE_AT_END = /\x1b(?:\[[0-9;?]*|\][^\x07\x1b]*\x1b?)?$/;

/** Removes CSI and OSC sequences, carrying an incomplete one over to the next chunk. */
export class AnsiStripper {
  private pending = '';

  push(chunk: string): string {
    let text = this.pending + chunk;
    this.pending = '';
    const incomplete = INCOMPLETE_ESCAPE_AT_END.exec(text);
    if (incomplete && incomplete[0].length <= MAX_PENDING_ESCAPE) {
      this.pending = incomplete[0];
      text = text.slice(0, incomplete.index);
    }
    return text.replace(COMPLETE_ESCAPES, '');
  }

  /** The stream ended: whatever is still pending was not an escape sequence after all. */
  flush(): string {
    const rest = this.pending.replace(COMPLETE_ESCAPES, '');
    this.pending = '';
    return rest;
  }
}

/** Whatever a caller needs to show bounded output: the text within a ceiling, and how much there was. */
export interface CommandOutputCapture {
  readonly totalChars: number;
  renderWithin(maxChars: number): string;
}

const markerLine = (omitted: number) => `\n${omittedOutputMarker(omitted)}\n`;
const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

export class BoundedCommandOutput implements CommandOutputCapture {
  private head = '';
  private tail = '';
  private total = 0;
  private readonly ansi = new AnsiStripper();
  private finished = false;

  constructor(
    private readonly headLimit = COMMAND_OUTPUT_HEAD_CHARS,
    private readonly tailLimit = COMMAND_OUTPUT_TAIL_CHARS,
  ) {}

  /** Add a raw chunk as the stream delivered it. */
  push(chunk: string): void {
    if (this.finished || !chunk) return;
    this.add(this.ansi.push(chunk));
  }

  /** The stream ended. Idempotent. */
  finish(): void {
    if (this.finished) return;
    this.add(this.ansi.flush());
    this.finished = true;
  }

  /** Characters of stripped output seen, including any that were not kept. */
  get totalChars(): number {
    return this.total;
  }

  /** Characters seen but held neither in the head nor in the tail. */
  get droppedChars(): number {
    return this.total - this.head.length - this.tail.length;
  }

  private add(text: string): void {
    if (!text) return;
    this.total += text.length;
    let rest = text;
    if (this.head.length < this.headLimit) {
      const room = this.headLimit - this.head.length;
      this.head += rest.slice(0, room);
      rest = rest.slice(room);
    }
    if (!rest) return;
    this.tail = rest.length >= this.tailLimit
      ? rest.slice(rest.length - this.tailLimit)
      : (this.tail + rest).slice(-this.tailLimit);
  }

  /**
   * The output within `maxChars` UTF-16 code units. Short output comes back whole. Longer output keeps its
   * beginning and its end around one marker that says how much was left out; the marker's room is reserved
   * first, the head takes the odd unit, and neither side splits a surrogate pair.
   */
  renderWithin(maxChars: number): string {
    this.finish();
    const ceiling = Math.max(0, Math.floor(maxChars));
    if (this.droppedChars === 0 && this.total <= ceiling) return this.head + this.tail;
    // Reserve room for the longest marker this output can need (its count is at most the total), so the
    // exact count always fits, whatever its number of digits.
    const room = ceiling - markerLine(this.total).length;
    if (room <= 0) return omittedOutputMarker(this.total).slice(0, ceiling);
    // With nothing dropped, head and tail together are the whole output, and both ends come from it.
    const whole = this.droppedChars === 0 ? this.head + this.tail : undefined;
    const prefix = whole ?? this.head;
    const suffix = whole ?? this.tail;
    let headShow = Math.min(prefix.length, Math.ceil(room / 2));
    const tailShow0 = Math.min(suffix.length, room - headShow);
    // A short side gives its unused room to the other one.
    headShow = Math.min(prefix.length, room - tailShow0);
    let tailShow = tailShow0;
    if (headShow > 0 && isHighSurrogate(prefix.charCodeAt(headShow - 1))) headShow -= 1;
    if (tailShow > 0 && isLowSurrogate(suffix.charCodeAt(suffix.length - tailShow))) tailShow -= 1;
    const omitted = this.total - headShow - tailShow;
    return `${prefix.slice(0, headShow)}${markerLine(omitted)}${suffix.slice(suffix.length - tailShow)}`;
  }
}

/** Plain text bounded the same way, for a caller that holds a whole string rather than a stream. */
export function boundedText(text: string, maxChars: number): string {
  const output = new BoundedCommandOutput(Math.max(COMMAND_OUTPUT_HEAD_CHARS, maxChars), Math.max(COMMAND_OUTPUT_TAIL_CHARS, maxChars));
  output.push(text);
  return output.renderWithin(maxChars);
}
