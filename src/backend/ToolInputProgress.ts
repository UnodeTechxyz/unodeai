/**
 * v0.9.99: what the host can say about a tool call while the model is still writing its arguments. For a Write,
 * Edit or document call those arguments are the file content, so this is where the time goes. Display only: it is
 * never a deadline, never sent to the model, and carries no content beyond the target's file name.
 */
export interface ToolInputProgress {
  /** The tool's name, once the provider has sent it. */
  tool?: string;
  /** The file name (not the path) of the call's target, once its value has fully arrived. */
  target?: string;
  /** UTF-8 bytes of argument text received so far for this call. */
  bytes: number;
}

const TARGET_KEY = /"(?:path|file_path|filePath|target_path|output_path|filename|file)"\s*:\s*"((?:[^"\\]|\\.){1,1024})"/;

/** The target's file name from partial JSON arguments, or undefined until its whole string value has arrived. */
export function partialArgumentTarget(partialArguments: string): string | undefined {
  const match = TARGET_KEY.exec(partialArguments);
  if (!match) return undefined;
  let value: string;
  try { value = JSON.parse(`"${match[1]}"`) as string; } catch { return undefined; }
  const name = value.split(/[\\/]/).filter(Boolean).at(-1);
  return name ? name.slice(0, 120) : undefined;
}

export function toolInputProgress(tool: string | undefined, partialArguments: string): ToolInputProgress {
  const target = partialArgumentTarget(partialArguments);
  return {
    ...(tool ? { tool: tool.slice(0, 80) } : {}),
    ...(target ? { target } : {}),
    bytes: Buffer.byteLength(partialArguments, 'utf8'),
  };
}

export function parseToolInputProgress(value: unknown): ToolInputProgress | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.bytes !== 'number' || !Number.isSafeInteger(raw.bytes) || raw.bytes < 0) return undefined;
  const text = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;
  return {
    bytes: raw.bytes,
    ...(text(raw.tool, 80) ? { tool: raw.tool as string } : {}),
    ...(text(raw.target, 120) ? { target: raw.target as string } : {}),
  };
}
