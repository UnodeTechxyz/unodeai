import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export interface ManagedProgram { ref: string; file: string; sha256: string; bytes: number; holder: object }
/** Host drafts are source data until a separately gated run; references belong to one agent/request. */
export class ManagedProgramStore {
  private root?: Promise<string>;
  private queue: Promise<unknown> = Promise.resolve();
  private drafts = new Map<string, { file: string; holder: object; parts: number; pendingHighSurrogate: string }>();
  private programs = new Map<string, ManagedProgram>();
  private retired = false;
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work); this.queue = result.then(() => undefined, () => undefined); return result;
  }
  prepare(name: string, source: string, final: boolean, holder: object) {
    return this.serialize(async () => {
      if (this.retired) throw new Error('managed-program-store-retired');
      let draft = this.drafts.get(name);
      if (draft && draft.holder !== holder) throw new Error('managed-program-draft-request-changed');
      if (!draft) {
        const root = await (this.root ??= mkdtemp(join(tmpdir(), 'unode-office-program-')).then(directory => realpath(directory)));
        draft = { file: join(root, randomUUID() + '.cjs'), holder, parts: 0, pendingHighSurrogate: '' };
        await writeFile(draft.file, '', { flag: 'wx', mode: 0o600 }); this.drafts.set(name, draft);
      }
      const combined = draft.pendingHighSurrogate + source;
      const pending = !final && /[\ud800-\udbff]$/.test(combined) ? combined.slice(-1) : '';
      await appendFile(draft.file, pending ? combined.slice(0, -1) : combined, 'utf8');
      draft.pendingHighSurrogate = pending; draft.parts++;
      if (!final) return { state: 'draft' as const, parts: draft.parts };
      const bytes = await readFile(draft.file); const ref = 'program-' + randomUUID().replaceAll('-', '');
      const program = { ref, file: draft.file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, holder };
      this.programs.set(ref, program); this.drafts.delete(name);
      return { state: 'prepared' as const, program_ref: ref, sha256: program.sha256, bytes: program.bytes, parts: draft.parts };
    });
  }
  async read(ref: string, holder: object): Promise<ManagedProgram> {
    await this.queue;
    const program = this.programs.get(ref);
    if (this.retired || !program || program.holder !== holder) throw new Error('managed-program-unavailable');
    const bytes = await readFile(program.file);
    if (bytes.length !== program.bytes || createHash('sha256').update(bytes).digest('hex') !== program.sha256) throw new Error('managed-program-changed');
    return program;
  }
  dispose(): Promise<void> {
    this.retired = true;
    return this.serialize(async () => { this.drafts.clear(); this.programs.clear(); if (this.root) await rm(await this.root, { recursive: true, force: true }); });
  }
}
