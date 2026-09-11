/**
 * A single, non-throwing boundary for persistence that is intentionally started in the background.
 *
 * Session events cannot await roster persistence without changing their synchronous semantics, but
 * silently dropping a rejected save leaves the UI ahead of durable state. Keep the rejection visible
 * and deduplicate an unchanged failure until a later save succeeds.
 */
export interface BackgroundPersistenceReporterDeps {
  logError: (message: string) => void;
  showError: (message: string) => unknown;
}

export class BackgroundPersistenceReporter {
  private lastFailure?: string;

  constructor(private readonly deps: BackgroundPersistenceReporterDeps) {}

  report(operation: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    const fingerprint = `${operation}\n${detail}`;
    if (this.lastFailure === fingerprint) {
      return;
    }
    this.lastFailure = fingerprint;

    this.deps.logError(`UnodeAi could not ${operation}: ${detail}`);
    void Promise.resolve(this.deps.showError(
      `UnodeAi could not ${operation}. Changes may be lost after reload. Check the UnodeAi output channel for details.`
    ));
  }

  clear(): void {
    this.lastFailure = undefined;
  }
}

/** Start a persistence operation without allowing a rejected promise to become an unhandled rejection. */
export function runBackgroundPersistence(
  operation: () => Promise<void> | PromiseLike<void>,
  reporter: BackgroundPersistenceReporter,
  description: string,
): void {
  void Promise.resolve()
    .then(operation)
    .then(
      () => reporter.clear(),
      (error) => reporter.report(description, error),
    );
}
