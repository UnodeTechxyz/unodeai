import { ConsentGrant, ConsentGrantRegistry } from './ConsentGrants';

/**
 * Codex CLI consent is not an OpenAI API grant. Keeping the two operations in this small owner makes
 * cross-grant escalation and revoke-without-stop directly testable outside the VS Code host.
 */
export class CodexEgressConsent {
  constructor(
    private readonly grants: ConsentGrantRegistry,
    private readonly persist: () => Promise<void>,
    private readonly stopRunningCodex: () => Promise<void>,
  ) {}

  has(host: string, executablePath: string): boolean {
    return this.grants.hasCodex(normalizedHost(host), executablePath);
  }
  list(): ConsentGrant[] { return this.grants.list('codex'); }

  restore(raw: unknown): { migratedLegacy: boolean } {
    return this.grants.restore('codex', raw);
  }

  async grant(host: string, executablePath: string, requester: string): Promise<boolean> {
    const changed = this.grants.grantCodex(normalizedHost(host), executablePath, requester);
    if (changed) await this.persist();
    return changed;
  }

  async revoke(host: string): Promise<boolean> {
    const changed = this.grants.revokeCodexHost(normalizedHost(host));
    if (!changed) return false;
    await this.persist();
    await this.stopRunningCodex();
    return true;
  }
}

function normalizedHost(host: string): string { return host.trim().toLowerCase(); }
