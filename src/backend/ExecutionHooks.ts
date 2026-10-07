/*---------------------------------------------------------------------------------------------
 *  UnodeAi - host-owned execution hooks
 *
 *  Declarations select a shipped host action by id. They are deliberately not scripts, not repository
 *  files, and not a model tool surface. The only effect a hook can have is to block a currently allowed
 *  action; it has no vocabulary for granting authority.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';

export const EXECUTION_HOOK_POINTS = ['PreTool', 'PostWrite', 'EndTurn', 'on-failure'] as const;
export type ExecutionHookPoint = typeof EXECUTION_HOOK_POINTS[number];

export interface ExecutionHookDeclaration {
  id: string;
  point: ExecutionHookPoint;
  /** Human approval is an ownership fact, not model-supplied metadata. */
  appliedBy: 'human';
  timeoutMs: number;
  maxOutputBytes: number;
  onFailure: 'block';
}

export interface ExecutionHookContext {
  point: ExecutionHookPoint;
  toolName?: string;
  writtenPath?: string;
  failure?: string;
}

export interface ExecutionHookActionResult {
  /** false only tightens the enclosing action; true never grants a new capability. */
  allow?: boolean;
  output?: string;
}

export type ExecutionHookAction = (context: Readonly<ExecutionHookContext>, signal: AbortSignal) =>
  Promise<ExecutionHookActionResult> | ExecutionHookActionResult;

export type ExecutionHookResult = { allow: true; output?: string } | { allow: false; reason: string };

/** Persisted by the extension in its own workspace state, never in a repository-controlled file. */
export interface ExecutionHookApprovalRecord {
  version: 1;
  digest: string;
  origin: string;
}

export interface NormalizedExecutionHookCandidate {
  declarations: readonly ExecutionHookDeclaration[];
  normalized: string;
  digest: string;
}

const POINTS = new Set<string>(EXECUTION_HOOK_POINTS);
const AUTHORITY_FIELDS = new Set(['command', 'commands', 'write', 'writeScope', 'writeScopes', 'network', 'networkDestination', 'networkDestinations', 'mcp', 'mcpServer', 'mcpServers', 'grant', 'grants', 'permissions']);
const DECLARATION_FIELDS = new Set(['id', 'point', 'appliedBy', 'timeoutMs', 'maxOutputBytes', 'onFailure']);
const MAX_HOOK_TIMEOUT_MS = 60_000;
const MAX_HOOK_OUTPUT_BYTES = 65_536;

/** Reject anything that resembles a grant before looking at ordinary declaration syntax. */
export function validateExecutionHookDeclaration(value: unknown): ExecutionHookDeclaration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Execution hook declaration is unreadable; action blocked.');
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (AUTHORITY_FIELDS.has(key)) {
      throw new Error(`Execution hook authority grant "${key}" is forbidden.`);
    }
    if (!DECLARATION_FIELDS.has(key)) {
      throw new Error(`Execution hook declaration contains unsupported field "${key}".`);
    }
  }
  if (typeof raw.id !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(raw.id)) {
    throw new Error('Execution hook declaration id is invalid.');
  }
  if (typeof raw.point !== 'string' || !POINTS.has(raw.point)) {
    throw new Error('Execution hook declaration point is invalid.');
  }
  if (raw.appliedBy !== 'human') {
    throw new Error('Execution hook declarations require human application.');
  }
  const timeoutMs = raw.timeoutMs;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_HOOK_TIMEOUT_MS) {
    throw new Error(`Execution hook time ceiling must be 1-${MAX_HOOK_TIMEOUT_MS}ms.`);
  }
  const maxOutputBytes = raw.maxOutputBytes;
  if (typeof maxOutputBytes !== 'number' || !Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > MAX_HOOK_OUTPUT_BYTES) {
    throw new Error(`Execution hook output ceiling must be 1-${MAX_HOOK_OUTPUT_BYTES} bytes.`);
  }
  if (raw.onFailure !== 'block') {
    throw new Error('Execution hook failure behaviour must be block.');
  }
  return {
    id: raw.id,
    point: raw.point as ExecutionHookPoint,
    appliedBy: 'human',
    timeoutMs,
    maxOutputBytes,
    onFailure: 'block',
  };
}

/**
 * Parse the inert setting into canonical text before an approval can bind to it. Object-key order and
 * harmless whitespace cannot change the decision; any material declaration edit does. This function does
 * not construct or register a hook.
 */
export function normalizeExecutionHookCandidate(value: unknown): NormalizedExecutionHookCandidate {
  if (!Array.isArray(value)) {
    throw new Error('Execution hooks setting must be an array of declarations.');
  }
  const declarations = value.map(validateExecutionHookDeclaration);
  const ids = new Set<string>();
  for (const declaration of declarations) {
    if (ids.has(declaration.id)) {
      throw new Error(`Execution hook "${declaration.id}" is declared more than once.`);
    }
    ids.add(declaration.id);
  }
  // validateExecutionHookDeclaration writes the fields in this fixed order, making this a canonical,
  // human-readable JSON representation rather than a hash of arbitrary settings syntax.
  const normalized = JSON.stringify(declarations);
  return {
    declarations,
    normalized,
    digest: createHash('sha256').update(normalized, 'utf8').digest('hex'),
  };
}

/**
 * Host-only registry. `applyHumanTightening` is intentionally the sole mutator: neither a workspace
 * file nor an agent tool can enter this object. Unknown/unreadable actions fail closed at invocation.
 */
export class HostExecutionHooks {
  private readonly declarations: ExecutionHookDeclaration[] = [];
  private readonly actions = new Map<string, ExecutionHookAction>();

  constructor(declarations: readonly unknown[] = [], actions: ReadonlyMap<string, ExecutionHookAction> = new Map()) {
    for (const declaration of declarations) {
      this.applyHumanTightening(declaration, actions.get((declaration as { id?: unknown })?.id as string));
    }
  }

  applyHumanTightening(declaration: unknown, action?: ExecutionHookAction): void {
    const safe = validateExecutionHookDeclaration(declaration);
    if (this.declarations.some((entry) => entry.id === safe.id)) {
      throw new Error(`Execution hook "${safe.id}" is already declared.`);
    }
    this.declarations.push(safe);
    if (action) {
      this.actions.set(safe.id, action);
    }
  }

  async run(point: ExecutionHookPoint, context: Omit<ExecutionHookContext, 'point'> = {}): Promise<ExecutionHookResult> {
    for (const declaration of this.declarations) {
      if (declaration.point !== point) { continue; }
      const action = this.actions.get(declaration.id);
      if (!action) {
        return { allow: false, reason: `Execution hook "${declaration.id}" is unreadable; action blocked.` };
      }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          Promise.resolve(action(Object.freeze({ point, ...context }), controller.signal)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error(`Execution hook "${declaration.id}" exceeded its time ceiling.`));
            }, declaration.timeoutMs);
          }),
        ]);
        const output = String(result?.output ?? '');
        if (Buffer.byteLength(output, 'utf8') > declaration.maxOutputBytes) {
          return { allow: false, reason: `Execution hook "${declaration.id}" exceeded its output ceiling; action blocked.` };
        }
        if (result?.allow === false) {
          return { allow: false, reason: output || `Execution hook "${declaration.id}" blocked the action.` };
        }
      } catch (error) {
        return { allow: false, reason: `${error instanceof Error ? error.message : 'Execution hook failed.'} Action blocked.` };
      } finally {
        if (timer) { clearTimeout(timer); }
      }
    }
    return { allow: true };
  }
}

/**
 * A live host-owned source. Keeping the source lazy matters: an explicit human approval (or a later
 * declaration edit that invalidates it) must take effect for an agent that is already running. The
 * callback itself remains extension-owned; model and repository surfaces only ever supply inert data.
 */
export type ExecutionHooksSource = HostExecutionHooks | (() => HostExecutionHooks | undefined);

export function resolveExecutionHooks(source: ExecutionHooksSource | undefined): HostExecutionHooks | undefined {
  return typeof source === 'function' ? source() : source;
}

/**
 * The only production construction path for a setting candidate. An unapproved candidate returns no
 * registry at all; the candidate cannot turn into a hook merely by appearing in a user/workspace/folder
 * configuration scope. Unknown action ids remain fail-closed in HostExecutionHooks.
 */
export function constructApprovedExecutionHooks(
  candidate: NormalizedExecutionHookCandidate,
  approval: ExecutionHookApprovalRecord | undefined,
  origin: string,
): HostExecutionHooks | undefined {
  if (candidate.declarations.length === 0) { return undefined; }
  if (
    approval?.version !== 1
    || approval.digest !== candidate.digest
    || approval.origin !== origin
  ) {
    return undefined;
  }
  return new HostExecutionHooks(candidate.declarations);
}
