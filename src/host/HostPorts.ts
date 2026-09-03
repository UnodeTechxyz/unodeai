/*---------------------------------------------------------------------------------------------
 * Narrow host capabilities
 *
 * Domain services receive these capabilities rather than a VS Code namespace.  The concrete VS Code
 * adapters live beside this file; keeping the contracts here makes it possible to exercise callers in
 * plain Node and prevents a second, ambient host dependency from creeping in.
 *--------------------------------------------------------------------------------------------*/

export interface SettingsPort {
  read<T>(key: string, fallback?: T): T | undefined;
  writeGlobal<T>(key: string, value: T | undefined): Promise<void>;
}

export interface SecretPort {
  get(name: string): Promise<string | undefined>;
  has(name: string): Promise<boolean>;
}

export interface WorkspaceFilesPort {
  hasWorkspace(): boolean;
  workspaceRoots(): readonly string[];
}

export interface CommandPresentationPort {
  register(command: string, handler: (...args: unknown[]) => unknown): void;
  info(message: string): Thenable<unknown>;
  warn(message: string): Thenable<unknown>;
}

export interface ClockPort {
  now(): number;
  setInterval(callback: () => void, everyMs: number): { dispose(): void };
}

export interface NetworkTransport {
  fetch(url: string, init?: { headers?: Record<string, string> }): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
}
