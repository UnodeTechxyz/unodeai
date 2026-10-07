export interface UnifiedDiff {
  text: string;
  truncated: boolean;
}

export interface UnifiedDiffOptions {
  maxChars?: number;
  contextLines?: number;
}

const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_CONTEXT_LINES = 3;

export function createUnifiedDiff(
  oldText: string | null | undefined,
  newText: string,
  filePath: string,
  options: UnifiedDiffOptions = {}
): UnifiedDiff {
  const oldLines = splitLines(oldText ?? '');
  const newLines = splitLines(newText);
  const maxChars = Math.max(0, Math.floor(options.maxChars ?? DEFAULT_MAX_CHARS));
  const contextLines = Math.max(0, Math.floor(options.contextLines ?? DEFAULT_CONTEXT_LINES));

  if (oldText === newText) {
    return capDiff(`--- ${filePath}\n+++ ${filePath}\n@@ no changes @@\n`, maxChars);
  }

  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const beforeStart = Math.max(0, prefix - contextLines);
  const oldChangedEnd = oldLines.length - suffix;
  const newChangedEnd = newLines.length - suffix;
  const oldAfterEnd = Math.min(oldLines.length, oldChangedEnd + contextLines);
  const newAfterEnd = Math.min(newLines.length, newChangedEnd + contextLines);

  const out: string[] = [
    `--- ${filePath}`,
    `+++ ${filePath}`,
    `@@ -${beforeStart + 1},${oldAfterEnd - beforeStart} +${beforeStart + 1},${newAfterEnd - beforeStart} @@`,
  ];

  for (let i = beforeStart; i < prefix; i++) {
    out.push(` ${oldLines[i]}`);
  }
  for (let i = prefix; i < oldChangedEnd; i++) {
    out.push(`-${oldLines[i]}`);
  }
  for (let i = prefix; i < newChangedEnd; i++) {
    out.push(`+${newLines[i]}`);
  }
  for (let i = oldChangedEnd; i < oldAfterEnd; i++) {
    out.push(` ${oldLines[i]}`);
  }

  return capDiff(out.join('\n') + '\n', maxChars);
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  return text.replace(/\r\n/g, '\n').split('\n');
}

function capDiff(text: string, maxChars: number): UnifiedDiff {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  if (maxChars <= 0) {
    return { text: '[diff truncated]', truncated: true };
  }
  const suffix = '\n[diff truncated]';
  return {
    text: text.slice(0, Math.max(0, maxChars - suffix.length)) + suffix,
    truncated: true,
  };
}
