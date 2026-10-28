import type { AgentConfig } from '../types';
import { BUILTIN_TOOL_DEFAULTS_REVISION } from '../roles/BuiltinToolDefaults';

export interface AgentRosterEditPort {
  members(): AgentConfig[];
  revision(): number;
  currentWorkspace(): boolean;
  persist(members: AgentConfig[]): Promise<void>;
  reloadFromFile?(): Promise<void | string>;
  notice?(message: string): void;
}

/** Ordinary roster saves and staged Builder edits share a lane. A form edit never publishes authority before its write.
 * Other existing roster callers can still mutate live records: detect that across the awaited write,
 * repair the store from the live roster and refuse the stale edit. This is not cross-window CAS. */
export class AgentRosterEdits {
  private tail: Promise<unknown> = Promise.resolve();
  private replacing = false;
  private readonly unsavedRevocations = new Set<string>();
  constructor(private readonly port: AgentRosterEditPort) {}

  get admissionAllowed(): boolean { return !this.replacing; }
  requireRecovery(): void {
    void this.enqueue(async () => {
      try {
        if (!this.port.reloadFromFile) return;
        const notice = await this.port.reloadFromFile();
        this.port.notice?.(notice ?? 'The team file and the running team disagreed; UnodeAi reloaded the team from the file.');
      } catch {
        this.port.notice?.('The team file could not be reloaded. The current team is still available; you can reopen the team file.');
      }
    });
  }

  /** A failed Off save remains effective in this window, including a same-ID team loaded later. */
  overlayUnsavedOff(members: readonly AgentConfig[]): AgentConfig[] {
    return members.map(member => this.unsavedRevocations.has(member.id) ? { ...member,
      allowedTools: (member.allowedTools ?? []).filter(tool => tool !== 'execute'),
      executePreference: 'deny', builtinToolDefaultsRevision: BUILTIN_TOOL_DEFAULTS_REVISION,
      ...(member.backend === 'codex' || member.toolCeiling === 'native-default' ? { toolCeiling: 'bounded' as const } : {}),
    } : member);
  }
  private async persist(members: AgentConfig[], explicitOnId?: string): Promise<void> {
    const rows = this.overlayUnsavedOff(members).map(member => member.id === explicitOnId ? members.find(row => row.id === member.id)! : member);
    await this.port.persist(structuredClone(rows));
    for (const member of rows) if (member.executePreference === 'deny' || member.id === explicitOnId) this.unsavedRevocations.delete(member.id);
  }

  /** Revoke before the first asynchronous step. A failed save/stop must never re-grant commands or
   * let a team switch discard this window's unsaved choice. Only retrying this revocation clears it. */
  revokeCommands(candidate: AgentConfig, current: AgentConfig, isCurrent: () => boolean,
    stop: () => Promise<void>, publish: () => void, scopeCurrent: () => boolean = () => true): Promise<boolean> {
    if (candidate.id !== current.id || candidate.executePreference !== 'deny' || candidate.allowedTools?.includes('execute')
      || candidate.toolCeiling === 'native-default' || this.replacing || !isCurrent() || !this.port.members().includes(current)) return Promise.resolve(false);
    this.unsavedRevocations.add(current.id);
    current.allowedTools = (current.allowedTools ?? []).filter(tool => tool !== 'execute');
    current.executePreference = 'deny'; current.builtinToolDefaultsRevision = BUILTIN_TOOL_DEFAULTS_REVISION;
    if (current.toolCeiling === 'native-default' || current.backend === 'codex') current.toolCeiling = 'bounded';
    const unchanged = this.capture();
    // stop() detaches the old runtime synchronously, so its copied tool registry cannot execute while
    // this operation waits behind an earlier roster write. Observe rejection immediately as well.
    let stopped: Promise<void>;
    try { stopped = stop(); } catch (error) { stopped = Promise.reject(error); }
    void stopped.catch(() => undefined);
    return this.enqueue(async () => {
      // Stop detaches synchronously; lack of confirmation must not delay durable Off.
      void stopped.catch(() => this.port.notice?.(`Run commands is off for ${current.name} in this window; its old process did not confirm it stopped.`));
      if (!unchanged() || !scopeCurrent()) throw new Error('The revoked agent changed before saving.');
      await this.persist(structuredClone(this.port.members().map(member => member === current ? candidate : member)));
      if (!unchanged() || !scopeCurrent()) { await this.persist(structuredClone(this.port.members())); throw new Error('The revoked agent changed during saving.'); }
      try { publish(); }
      catch (error) { await this.persist(structuredClone(this.port.members())); throw error; }
      this.unsavedRevocations.delete(current.id);
      return true;
    }).catch(error => {
      this.port.notice?.(`Run commands is off for ${current.name} in this window; it could not be saved yet.`);
      throw error;
    });
  }

  /** Reserve admission before waiting for earlier ordinary saves. No nested calls to this lane. */
  replace<T>(isCurrent: () => boolean, operation: () => Promise<T>): Promise<T> {
    if (!this.admissionAllowed || !isCurrent()) return Promise.reject(new Error('The team changed. Reopen the team picker and try again.'));
    this.replacing = true;
    return this.enqueue(async () => {
      if (!isCurrent()) throw new Error('The team changed. Reopen the team picker and try again.');
      if (this.unsavedRevocations.size > 0) {
        try { await this.persist(this.port.members()); } catch { /* Retry without blocking the switch. */ }
      }
      return operation();
    }).finally(() => { this.replacing = false; });
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }

  save(): Promise<void> {
    return this.enqueue(() => {
      if (!this.port.currentWorkspace()) throw new Error('The workspace changed; the roster was not saved.');
      return this.persist(structuredClone(this.port.members()));
    });
  }
  retryUnsaved(): Promise<void> {
    return this.unsavedRevocations.size === 0 ? Promise.resolve() : this.save();
  }

  capture(): () => boolean {
    const revision = this.port.revision();
    const members = this.port.members();
    const bytes = JSON.stringify(members);
    return () => {
      const now = this.port.members();
      return this.port.currentWorkspace() && revision === this.port.revision()
        && members.length === now.length && members.every((member, i) => member === now[i])
        && JSON.stringify(now) === bytes;
    };
  }

  commit(candidate: AgentConfig, current: AgentConfig | undefined, isCurrent: () => boolean,
    publish: () => void, validateSource?: () => Promise<boolean>): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.admissionAllowed || !isCurrent()) return false;
      if (validateSource && !await validateSource()) return false;
      if (!this.admissionAllowed || !isCurrent()) return false;
      const members = this.port.members();
      if (current ? !members.includes(current) : members.some(member => member.id === candidate.id)) return false;
      const next = current ? members.map(member => member === current ? candidate : member) : [...members, candidate];
      await this.persist(structuredClone(next), candidate.executePreference === 'allow' ? candidate.id : undefined);
      let sourceValid = true;
      try { if (validateSource) sourceValid = await validateSource(); } catch { sourceValid = false; }
      if (!sourceValid || !this.admissionAllowed || !isCurrent()) {
        // Do not resurrect a removed agent or overwrite an edit made while storage was pending.
        // A failed repair remains a reported persistence failure, never an apparent successful edit.
        await this.persist(structuredClone(this.port.members()));
        return false;
      }
      try {
        publish();
      } catch (error) {
        await this.persist(structuredClone(this.port.members()));
        throw error;
      }
      return true;
    });
  }

  /** Existing host-owned roster edits (for example integration revocation) must not write an old
   * roster behind a queued team replacement. Their own live publication remains synchronous. */
  commitRoster(members: AgentConfig[], isCurrent: () => boolean, publish: () => void,
    validateSource?: () => Promise<boolean>): Promise<boolean> {
    const captured = structuredClone(members);
    return this.enqueue(async () => {
      if (!this.admissionAllowed || !isCurrent()) return false;
      if (validateSource && !await validateSource()) return false;
      if (!this.admissionAllowed || !isCurrent()) return false;
      await this.persist(captured);
      let sourceValid = true;
      try { if (validateSource) sourceValid = await validateSource(); } catch { sourceValid = false; }
      if (!sourceValid || !this.admissionAllowed || !isCurrent()) {
        await this.persist(structuredClone(this.port.members())); return false;
      }
      try { publish(); }
      catch (error) { await this.persist(structuredClone(this.port.members())); throw error; }
      return true;
    });
  }
}
