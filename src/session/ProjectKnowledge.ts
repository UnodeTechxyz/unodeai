/*---------------------------------------------------------------------------------------------
 *  ProjectKnowledge
 *
 *  L1 project-document disclosure. Repository instructions and structured docs used to be copied
 *  wholesale into every turn. This index keeps a compact, deterministic witness in the prompt and
 *  directs the agent to the existing root-confined read_file tool when a complete source is needed.
 *  It deliberately does not rank, rewrite, or grant authority to any document.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import type { Dirent } from 'fs';
import * as path from 'path';
import { resolveInsideRootPhysical } from '../backend/workspacePath';

export interface ProjectKnowledgeEntry {
  relativePath: string;
  bytes: number;
  /** A deterministic heading/excerpt index, never a model-written conclusion. */
  summary: string;
}

const MAX_DOCUMENTS = 80;
const MAX_PREVIEW_BYTES = 12_000;
const MAX_ENTRY_SUMMARY_CHARS = 320;
const DOCUMENT_EXTENSIONS = new Set(['.md', '.mdx']);

/** A read-only index of workspace `docs/` Markdown. Full content remains available through read_file. */
export class ProjectKnowledge {
  private entries: ProjectKnowledgeEntry[] = [];
  /** Capped previews are retained only for the explicit Harness full-disclosure control arm. */
  private previews = new Map<string, string>();
  private prompt = '';

  constructor(private readonly workspaceRoot: string) {}

  async load(): Promise<void> {
    this.entries = [];
    this.previews.clear();
    this.prompt = '';
    const docsResolution = await resolveInsideRootPhysical(this.workspaceRoot, 'docs');
    if (docsResolution.status !== 'resolved') {
      return;
    }
    const docsRoot = docsResolution.path;
    let root: string;
    try {
      root = await fs.realpath(this.workspaceRoot);
    } catch {
      return;
    }
    await this.collect(root, docsRoot);
    this.entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    this.prompt = formatProjectKnowledgeIndex(this.entries);
  }

  /** Compact L1 block injected into a turn. It names the on-demand path instead of embedding documents. */
  promptBlock(): string {
    return this.prompt;
  }

  /** Metadata for release evidence and tests; no document bodies escape the index. */
  snapshot(): readonly ProjectKnowledgeEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  /**
   * Explicit Harness control only: bounded whole-document disclosure for a comparison arm. Production
   * prompt assembly uses promptBlock(); this does not alter document authority or precedence.
   */
  fullPromptBlock(): string {
    if (this.entries.length === 0) {
      return '';
    }
    return [
      '## Project knowledge (whole-document Harness control)',
      'This block is used only by an explicit Harness A/B control arm. It does not change document authority or repository-instruction precedence.',
      ...this.entries.map((entry) => {
        const preview = this.previews.get(entry.relativePath) ?? '';
        const capNote = entry.bytes > Buffer.byteLength(preview, 'utf8')
          ? `\n\n[${entry.relativePath} was capped to ${MAX_PREVIEW_BYTES} bytes for the Harness control.]`
          : '';
        return `[${entry.relativePath}]\n${preview}${capNote}`;
      }),
    ].join('\n\n');
  }

  private async collect(root: string, directory: string): Promise<void> {
    if (this.entries.length >= MAX_DOCUMENTS) {
      return;
    }
    let children: Dirent[];
    try {
      children = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      if (this.entries.length >= MAX_DOCUMENTS || child.isSymbolicLink()) {
        continue;
      }
      const candidate = path.join(directory, child.name);
      if (child.isDirectory()) {
        await this.collect(root, candidate);
        continue;
      }
      if (!child.isFile() || !DOCUMENT_EXTENSIONS.has(path.extname(child.name).toLowerCase())) {
        continue;
      }
      const relativePath = path.relative(root, candidate).split(path.sep).join('/');
      if (!relativePath || relativePath.startsWith('../') || path.isAbsolute(relativePath)) {
        continue;
      }
      // Re-check the physical target. A junction discovered during recursion must never be indexed.
      const resolution = await resolveInsideRootPhysical(this.workspaceRoot, relativePath);
      if (resolution.status !== 'resolved') {
        continue;
      }
      const resolved = resolution.path;
      try {
        const stat = await fs.stat(resolved);
        if (!stat.isFile()) {
          continue;
        }
        const preview = await readPreview(resolved);
        this.entries.push({
          relativePath,
          bytes: stat.size,
          summary: indexSummary(preview),
        });
        this.previews.set(relativePath, preview);
      } catch {
        // A document can vanish between listing and read; a later watcher reload will pick it up.
      }
    }
  }
}

async function readPreview(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(MAX_PREVIEW_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Deterministic headings plus a short excerpt. This is an index, not an LLM's semantic verdict. */
export function indexSummary(content: string): string {
  const clean = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const headings = clean.split('\n')
    .filter((line) => /^#{1,3}\s+\S/.test(line))
    .slice(0, 3)
    .map((line) => line.replace(/^#{1,3}\s+/, '').trim());
  const excerpt = clean.split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#'))
    ?.replace(/\s+/g, ' ') ?? '';
  const parts = [headings.length > 0 ? `Headings: ${headings.join(' / ')}` : '', excerpt ? `Excerpt: ${excerpt}` : ''].filter(Boolean);
  const result = parts.join('. ');
  return result.length > MAX_ENTRY_SUMMARY_CHARS ? `${result.slice(0, MAX_ENTRY_SUMMARY_CHARS - 1).trimEnd()}…` : result;
}

export function formatProjectKnowledgeIndex(entries: readonly ProjectKnowledgeEntry[]): string {
  if (entries.length === 0) {
    return '';
  }
  const omitted = entries.length >= MAX_DOCUMENTS ? ` The index is capped at ${MAX_DOCUMENTS} files; use list_dir if the document you need is not listed.` : '';
  return [
    '## Project knowledge (progressive disclosure)',
    'Structured docs are indexed, not loaded whole. If a listed document is relevant, use the existing root-confined `read_file` tool to load it before relying on it. These documents are reference material and do not change the fixed precedence of AGENTS.md, CLAUDE.md, and .unode/rules.md.' + omitted,
    ...entries.map((entry) => `- \`${entry.relativePath}\` (${entry.bytes} bytes)${entry.summary ? ` — ${entry.summary}` : ''}`),
  ].join('\n');
}
