/**
 * The production navigation boundary (`OrchestrationHostAdapter.openFileReference` and
 * `openRecordedWorkspaceFile`) over a fake host: real folders on disk, a recorded editor instead of VS Code, and
 * recorded notices. Only the runtime ports the boundary uses are provided; any other call fails the test.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { vi } from 'vitest';
import {
  OrchestrationHostAdapter,
  type CoordinatorRuntimePort,
  type OrchestrationEvidencePort,
} from '../../../host/orchestration/OrchestrationHostAdapter';
import type { FileLinkPosition } from '../../fileLinks';
import type { AgentConfig } from '../../../types';

export interface OpenedFile {
  path: string;
  position?: FileLinkPosition;
}

export interface NavigationNotice {
  message: string;
  /** Present when the notice offered to copy this reference. */
  reference?: string;
}

export interface NavigationHost {
  adapter: OrchestrationHostAdapter;
  /** What the fake editor opened, in order. */
  opened: OpenedFile[];
  /** Every notice shown, in order. */
  notices: NavigationNotice[];
  configs: Map<string, AgentConfig>;
  /** The workspace folders as the host reports them now. */
  folders: string[];
  /** The folder the user chooses when asked; undefined cancels. */
  pick: ReturnType<typeof vi.fn<(folders: readonly string[], reference: string) => Promise<string | undefined>>>;
  /** False makes the workspace report a remote or virtual folder. */
  local: { value: boolean };
  /** True makes the editor fail to open the next file. */
  editorFails: { value: boolean };
}

export function navigationHost(folders: string[], agents: AgentConfig[]): NavigationHost {
  const configs = new Map(agents.map((config) => [config.id, config]));
  const host: NavigationHost = {
    adapter: undefined as unknown as OrchestrationHostAdapter,
    opened: [],
    notices: [],
    configs,
    folders,
    pick: vi.fn<(folders: readonly string[], reference: string) => Promise<string | undefined>>(async () => undefined),
    local: { value: true },
    editorFails: { value: false },
  };
  const runtime: Partial<CoordinatorRuntimePort> = {
    workspace: () => ({
      root: () => {
        if (!host.folders[0]) throw new Error('Open a workspace folder before using this UnodeAi action.');
        return host.folders[0];
      },
      roots: () => [...host.folders],
      isTrusted: () => true,
      additionalReadRoots: () => [],
      allFoldersLocal: () => host.local.value,
    }),
    configForAgent: (id) => configs.get(id),
    warnUser: (message) => { host.notices.push({ message }); },
    warnFileNavigation: (message, reference) => { host.notices.push({ message, reference }); },
    pickFileLinkFolder: (choices, reference) => host.pick(choices, reference),
    openRecordedFile: async (filePath, position) => {
      if (host.editorFails.value) throw new Error('the editor could not open it');
      host.opened.push({ path: filePath, ...(position ? { position } : {}) });
    },
  };
  const unexpected = new Proxy(runtime, {
    get(target, property) {
      if (property in target) return target[property as keyof CoordinatorRuntimePort];
      if (typeof property === 'string' && property !== 'then') {
        return () => { throw new Error(`the navigation boundary called runtime.${property}`); };
      }
      return undefined;
    },
  }) as CoordinatorRuntimePort;
  host.adapter = new OrchestrationHostAdapter(unexpected, {} as OrchestrationEvidencePort);
  return host;
}

export function agentConfig(id: string, extra: Partial<AgentConfig> = {}): AgentConfig {
  return { id, name: id, role: 'developer', provider: { providerId: 'openai' }, model: 'test-model', ...extra } as AgentConfig;
}

/** A fresh folder (its real path) holding `files`, removed by `cleanup`. */
export function tempFolder(files: Record<string, string> = {}, prefix = 'unode-fopen-'): { root: string; cleanup(): void } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  for (const [relative, text] of Object.entries(files)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Let the boundary's async steps (a folder choice, the editor open) settle. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}
