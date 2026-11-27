import { killProcessTreeByPid } from '../backend/processTree';

interface TestTransport {
  start(): Promise<void>;
  close(): Promise<void>;
  readonly pid?: number | null;
}

/**
 * A test owns its whole subprocess tree. The SDK can close its transport during failed initialize,
 * so wrap close before connecting and capture the PID before close can dispose it.
 */
export function guardMcpTestTransport(transport: TestTransport, signal: AbortSignal): () => Promise<void> {
  const start = transport.start.bind(transport);
  const close = transport.close.bind(transport);
  let cleanup: Promise<void> | undefined;
  const removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  const finish = (): Promise<void> => {
    if (cleanup) return cleanup;
    const pid = transport.pid;
    cleanup = (async () => {
      removeAbortListener();
      if (pid) await killProcessTreeByPid(pid);
      await close();
    })();
    return cleanup;
  };
  const onAbort = (): void => { void finish().catch(() => undefined); };
  signal.addEventListener('abort', onAbort, { once: true });
  transport.close = finish;
  transport.start = async () => {
    signal.throwIfAborted();
    // The SDK assigns the child as it starts spawning, before it waits for the spawn notification.
    const started = start();
    if (signal.aborted) onAbort();
    await started;
    if (signal.aborted) {
      await finish();
      signal.throwIfAborted();
    }
  };
  return finish;
}

/** Keep both the transport start and each SDK request inside the test's phase deadline. */
export async function raceMcpTestCancellation<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {};
  const cancellation = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Connection test cancelled.'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, cancellation]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
