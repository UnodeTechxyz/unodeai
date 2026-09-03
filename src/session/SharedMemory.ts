/*---------------------------------------------------------------------------------------------
 *  UnodeAi - SharedMemory
 *  Team-shared append-only notes at `<workspaceRoot>/.unode/memory/notes.md`.
 *
 *  Kept vscode-free (file IO is injectable) so it is unit-testable; extension.ts wires the
 *  FileSystemWatcher that refreshes the cache when the file changes.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as path from 'path';
import type { ModelTier } from '../types';

export type FileReader = (filePath: string) => Promise<string>;
export type FileAppender = (filePath: string, content: string) => Promise<void>;
export type DirCreator = (dirPath: string) => Promise<void>;

const defaultReader: FileReader = (p) => fs.readFile(p, 'utf8');
const defaultAppender: FileAppender = (p, content) => fs.appendFile(p, content, 'utf8');
const defaultMkdir: DirCreator = (p) => fs.mkdir(p, { recursive: true }).then(() => undefined);

/** The agent selects this structured value; the host never infers it from note prose. */
export type MemoryNoteKind = 'pitfall' | 'contract' | 'decision';

interface ParsedMemoryNote {
  readonly index: number;
  readonly timestamp?: string;
  readonly agentId?: string;
  readonly tier?: ModelTier;
  readonly kind?: MemoryNoteKind;
  readonly text: string;
}

export class SharedMemory {
  private content = '';

  constructor(
    private filePath: string,
    private readFile: FileReader = defaultReader,
    private appendFile: FileAppender = defaultAppender,
    private mkdir: DirCreator = defaultMkdir
  ) {}

  /** Absolute path of the shared memory notes file (`.unode/memory/notes.md`). */
  get path(): string {
    return this.filePath;
  }

  /** Append one sanitized note. Never throws; returns true if it actually wrote, false on failure
   *  (no workspace / unwritable location) so the caller can tell the agent honestly. */
  async append(agentId: string, note: string, tier: ModelTier, kind: MemoryNoteKind): Promise<boolean> {
    try {
      if (!isModelTier(tier) || !isMemoryNoteKind(kind)) return false;
      await this.mkdir(path.dirname(this.filePath));
      const safeAgent = oneLine(agentId || 'agent');
      const safeNote = oneLine(note).slice(0, 500);
      await this.appendFile(this.filePath, `- [${new Date().toISOString()}] [${safeAgent}] [${tier}] [${kind}] ${safeNote}\n`);
      return true;
    } catch {
      return false; // No workspace / unwritable location / creator race.
    }
  }

  /** (Re)read the notes into the cache. Missing/unreadable file -> empty string (not an error). */
  async load(): Promise<string> {
    try {
      this.content = (await this.readFile(this.filePath)) ?? '';
    } catch {
      this.content = '';
    }
    return this.content;
  }

  /**
   * Last-loaded notes wrapped for prompt injection. Contracts survive eviction before recency-selected
   * pitfall, decision, and legacy unknown notes; output remains in file order.
   */
  block(maxNotes = 30): string {
    const notes = this.content
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .map((line, index) => parseMemoryNote(line, index));
    const count = Math.max(0, Math.floor(maxNotes));
    if (count === 0) {
      return '';
    }
    const selectedContracts = notes.filter((note) => note.kind === 'contract').slice(-count);
    const remaining = count - selectedContracts.length;
    const selectedOthers = remaining > 0
      ? notes.filter((note) => note.kind !== 'contract').slice(-remaining)
      : [];
    const selected = [...selectedContracts, ...selectedOthers].sort((left, right) => left.index - right.index);
    if (selected.length === 0) {
      return '';
    }
    return `\n\n<shared_memory>\n${selected.map(renderMemoryNote).join('\n')}\n</shared_memory>`;
  }
}

/** Build the `.unode/memory/notes.md` path under a workspace root. */
export function memoryFilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.unode', 'memory', 'notes.md');
}

/** Collapse newlines and surrounding whitespace into a single readable line. */
export function oneLine(s: string): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

export function isMemoryNoteKind(value: unknown): value is MemoryNoteKind {
  return value === 'pitfall' || value === 'contract' || value === 'decision';
}

function isModelTier(value: unknown): value is ModelTier {
  return value === 'premium' || value === 'standard' || value === 'economy';
}

/** Both append-only formats remain readable; absent stamps are rendered as unknown rather than guessed. */
function parseMemoryNote(line: string, index: number): ParsedMemoryNote {
  const match = /^-\s+\[([^\]]+)\]\s+\[([^\]]+)\](?:\s+\[(premium|standard|economy)\])?(?:\s+\[(pitfall|contract|decision)\])?\s*(.*)$/u.exec(line);
  if (!match) return { index, text: oneLine(line) };
  return {
    index,
    timestamp: match[1],
    agentId: match[2],
    ...(isModelTier(match[3]) ? { tier: match[3] } : {}),
    ...(isMemoryNoteKind(match[4]) ? { kind: match[4] } : {}),
    text: oneLine(match[5]),
  };
}

function renderMemoryNote(note: ParsedMemoryNote): string {
  if (!note.timestamp || !note.agentId) {
    return `- [unknown] [unknown] [unknown] [unknown] ${note.text}`.trimEnd();
  }
  return `- [${note.timestamp}] [${note.agentId}] [${note.tier ?? 'unknown'}] [${note.kind ?? 'unknown'}] ${note.text}`.trimEnd();
}
