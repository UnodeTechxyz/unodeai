/**
 * v0.9.99: where a part of a text may start or end without splitting one character. A character outside the Basic
 * Multilingual Plane (an emoji, a supplementary CJK character) is two UTF-16 code units; a part that ends after the
 * first or starts at the second cannot be encoded as UTF-8 on its own and loses that character. Every pager that
 * delivers a text in parts snaps its boundaries with these.
 */

function isHighSurrogate(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }
function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }

/** `index`, or the start of the pair it falls inside: a part boundary there keeps the pair whole on its later side. */
export function wholeCharacterIndex(text: string, index: number): number {
  return index > 0
    && index < text.length
    && isHighSurrogate(text.charCodeAt(index - 1))
    && isLowSurrogate(text.charCodeAt(index))
    ? index - 1
    : index;
}

/** The end of the one whole character that starts at `index` (two code units for a pair), at most the text's end. */
export function wholeCharacterEndFrom(text: string, index: number): number {
  if (index >= text.length) return text.length;
  return isHighSurrogate(text.charCodeAt(index)) && isLowSurrogate(text.charCodeAt(index + 1)) ? index + 2 : index + 1;
}
