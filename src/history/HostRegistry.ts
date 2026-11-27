/*---------------------------------------------------------------------------------------------
 *  UnodeAi - which extension hosts that share a folder are proven gone (v0.9.110 §3.4)
 *  Each host publishes `hosts/<hostInstanceId>.json` once, complete, with the process identity the operating system
 *  gives it. A host without a record, or whose identity cannot be judged, is never gone: what it holds stays held.
 *--------------------------------------------------------------------------------------------*/

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { writeDurably } from './durableFiles';
import {
  parseProcessIdentityRecord,
  type ProcessIdentityAdapter,
  type ProcessIdentityRecord,
} from '../host/processIdentity/ProcessIdentityHost';

const HOST_ID = /^[A-Za-z0-9-]{1,80}$/;

export class HostRegistry {
  private published: Promise<void> | undefined;

  constructor(private readonly dir: string, private readonly deps: {
    hostInstanceId: string;
    selfIdentity: () => Promise<ProcessIdentityRecord | undefined>;
    identity: ProcessIdentityAdapter;
  }) {}

  /** Publish this host's record once; a host whose identity cannot be proven publishes none. */
  publishSelf(): Promise<void> {
    this.published ??= (async () => {
      const identity = await this.deps.selfIdentity().catch(() => undefined);
      if (!identity) return;
      await fsp.mkdir(this.dir, { recursive: true });
      await writeDurably(path.join(this.dir, `${this.deps.hostInstanceId}.json`),
        `${JSON.stringify({ hostInstanceId: this.deps.hostInstanceId, identity })}\n`).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
    })().catch(() => undefined);
    return this.published;
  }

  /** The hosts among `ids` proven gone. */
  async hostsGone(ids: readonly string[]): Promise<ReadonlySet<string>> {
    const records: Array<{ id: string; record: ProcessIdentityRecord }> = [];
    for (const id of ids) {
      if (!HOST_ID.test(id) || id === this.deps.hostInstanceId) continue;
      try {
        const stored = JSON.parse(await fsp.readFile(path.join(this.dir, `${id}.json`), 'utf8')) as { hostInstanceId?: unknown; identity?: unknown };
        const record = parseProcessIdentityRecord(stored.identity);
        if (stored.hostInstanceId === id && record) records.push({ id, record });
      } catch {
        // No record: unknown, never gone.
      }
    }
    if (records.length === 0) return new Set();
    const answers = await this.deps.identity.liveness(records.map((entry) => entry.record)).catch(() => []);
    return new Set(records.filter((_, index) => answers[index] === 'gone').map((entry) => entry.id));
  }
}
