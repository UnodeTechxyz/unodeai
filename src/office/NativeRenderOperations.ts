import { randomUUID } from 'node:crypto';
import { NativeOfficeRenderer, type NativeOfficeRenderJob, type NativeOfficeRenderResult } from './NativeOfficeRenderer';

const FOREGROUND_WAIT_MS = 120_000;
type Renderer = NativeOfficeRenderJob['renderer'];
interface Slot { run(): Promise<void>; cancelled: boolean }
/** Shared across agents in this extension host; interactive applications are shared as well. */
const queues = new Map<Renderer, { active: boolean; pending: Slot[] }>();
const activeAuthorityChecks = new Map<string, () => void>();
/** Called by existing permission/grant/network events; no polling or independent scheduled work. */
export function recheckNativeRenderAuthorities(): void { for (const check of [...activeAuthorityChecks.values()]) check(); }
function enqueue(renderer: Renderer, slot: Slot): () => void {
  let queue = queues.get(renderer);
  if (!queue) { queue = { active: false, pending: [] }; queues.set(renderer, queue); }
  queue.pending.push(slot);
  const pump = () => {
    if (queue.active) return;
    const next = queue.pending.shift();
    if (!next) { if (queues.get(renderer) === queue) queues.delete(renderer); return; }
    if (next.cancelled) { pump(); return; }
    queue.active = true;
    void next.run().finally(() => { queue.active = false; pump(); });
  };
  pump();
  return () => { slot.cancelled = true; const index = queue.pending.indexOf(slot); if (index >= 0) queue.pending.splice(index, 1); };
}

export interface NativeRenderOperation {
  operation_id: string;
  state: 'queued' | 'running' | 'finished' | 'cancelled' | 'failed';
  result?: NativeOfficeRenderResult;
  /** Completion of a helper never implies that an interactive Office operation has stopped. */
  stop_requested: boolean;
}
interface Entry {
  view: NativeRenderOperation; controller: AbortController; settled: Promise<void>;
  settle(): void; dequeue(): void; failure?: unknown;
}

/** Agent-owned operation lifetime, deliberately independent of a tool-call/turn waiting lifetime.
 * The public host must supply a source/Commands lease that survives turns and expires with actual authority.
 * Pixel persistence, provider delivery and public admission are supplied by that host, not established here.
 */
export class NativeRenderOperations {
  private readonly entries = new Map<string, Entry>();
  private retired = false;
  constructor(private readonly renderer: Pick<NativeOfficeRenderer, 'render'> = new NativeOfficeRenderer()) {}

  start(input: Omit<NativeOfficeRenderJob, 'operation_id' | 'signal' | 'beforeStart' | 'onPage'> & {
    beforeStart(facts: Parameters<NativeOfficeRenderJob['beforeStart']>[0], signal: AbortSignal): Promise<void>;
    onPage(page: Parameters<NativeOfficeRenderJob['onPage']>[0], signal: AbortSignal, operationId: string): void | Promise<void>;
  }): NativeRenderOperation {
    if (this.retired) throw Error('render-owner-retired');
    // The caller's buffer cannot mutate a queued operation's captured version.
    const { source: inputBytes, ...job } = input;
    const source = Buffer.from(inputBytes);
    const id = 'office-render-' + randomUUID();
    const controller = new AbortController();
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const entry: Entry = { view: { operation_id: id, state: 'queued', stop_requested: false }, controller, settled, settle, dequeue: () => {} };
    this.entries.set(id, entry);
    const current = () => { try { return !this.retired && !controller.signal.aborted && job.current(); } catch { return false; } };
    activeAuthorityChecks.set(id, () => { if (!current()) this.stop(id); });
    const slot: Slot = { cancelled: false, run: async () => {
      try {
        if (!current()) { entry.view.state = 'cancelled'; return; }
        entry.view.state = 'running';
        entry.view.result = await this.renderer.render({ ...job, source, operation_id: id, signal: controller.signal, current,
          beforeStart: facts => job.beforeStart(facts, controller.signal), onPage: page => job.onPage(page, controller.signal, id) });
        entry.view.state = 'finished';
      } catch (error) {
        // Keep trusted gate outcomes for the host's existing outcome projection, never raw status JSON.
        entry.failure = error; entry.view.state = current() ? 'failed' : 'cancelled';
      } finally { activeAuthorityChecks.delete(id); entry.dequeue = () => {}; entry.settle(); }
    } };
    entry.dequeue = enqueue(job.renderer, slot);
    return this.inspect(id)!;
  }

  inspect(id: string): NativeRenderOperation | undefined {
    const entry = this.entries.get(id);
    return entry ? structuredClone(entry.view) : undefined;
  }

  /** Host-only: project through the existing trusted policy outcome handler before returning to a model. */
  failure(id: string): unknown { return this.entries.get(id)?.failure; }

  /** Foreground waiting ends after 120 seconds; the renderer separately bounds a Word/PowerPoint native stage. */
  async wait(id: string, signal?: AbortSignal): Promise<NativeRenderOperation | undefined> {
    const entry = this.entries.get(id); if (!entry) return undefined;
    if (signal?.aborted) return this.inspect(id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake!: () => void;
    const waiting = new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, FOREGROUND_WAIT_MS); });
    signal?.addEventListener('abort', wake, { once: true });
    try { await Promise.race([entry.settled, waiting]); return this.inspect(id); }
    finally { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', wake); }
  }

  stop(id: string): NativeRenderOperation | undefined {
    const entry = this.entries.get(id); if (!entry) return undefined;
    if (entry.view.state === 'queued' || entry.view.state === 'running') {
      entry.view.stop_requested = true; entry.controller.abort();
      if (entry.view.state === 'queued') { entry.dequeue(); entry.dequeue = () => {}; activeAuthorityChecks.delete(id); entry.view.state = 'cancelled'; entry.settle(); }
    }
    return this.inspect(id);
  }

  async dispose(): Promise<NativeRenderOperation[]> {
    this.retired = true;
    for (const id of this.entries.keys()) this.stop(id);
    await Promise.all([...this.entries.values()].map(entry => entry.settled));
    return [...this.entries.keys()].map(id => this.inspect(id)!);
  }
}
