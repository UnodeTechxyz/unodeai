import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { workerHeapMb, workerScript } from '../content/ContentAssetStore';
import { OFFICE_RENDER_PURE_ERROR, type OfficeRenderPureJob } from './OfficeRenderPureContracts';

/** CPU/memory isolation only. This worker never owns a native application/helper process or a user file target. */
export class OfficeRenderPureHost {
  constructor(private readonly script = workerScript('OfficeRenderPureWorker.js')) {}
  async run<T>(request: OfficeRenderPureJob, inputBytes: number, signal: AbortSignal, current: () => boolean): Promise<T> {
    const live = () => { try { return !signal.aborted && current(); } catch { return false; } };
    if (!live()) throw Error('cancelled');
    if (!this.script) throw Error('render-worker-unavailable');
    // Copying holds parsed XML trees, not only compressed ZIP input. Preserve the existing host read budget
    // rather than assigning a tiny compressed file only the parser's minimum heap; retain the machine ceiling.
    const resourceMb = Number.isSafeInteger(request.memoryBudget) && request.memoryBudget > 0 ? Math.ceil(request.memoryBudget / 1_048_576) : 0;
    if (!resourceMb) throw Error('out-of-memory');
    const heapMb = Math.min(workerHeapMb(Math.max(inputBytes, request.memoryBudget)), Math.max(workerHeapMb(inputBytes), resourceMb));
    const worker = new Worker(this.script, { resourceLimits: { maxOldGenerationSizeMb: heapMb } });
    const id = randomUUID(); let response: { ok: boolean; value?: T; code?: string } | undefined;
    let workerError = false;
    return await new Promise<T>((resolve, reject) => {
      const stop = () => { void worker.terminate().catch(() => { workerError = true; }); };
      worker.once('error', () => { workerError = true; });
      worker.on('message', (message: { id: string; ok: boolean; value?: T; code?: string }) => {
        if (message?.id === id && !response) response = message;
      });
      worker.once('exit', code => {
        signal.removeEventListener('abort', stop);
        if (!live()) reject(Error('cancelled'));
        else if (!workerError && code === 0 && response?.ok) resolve(response.value!);
        else reject(Error(response?.code && OFFICE_RENDER_PURE_ERROR.test(response.code) ? response.code : 'render-worker-failed'));
      });
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop(); else try { worker.postMessage({ ...request, id }); } catch { workerError = true; stop(); }
    });
  }
}
