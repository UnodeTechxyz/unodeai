/*---------------------------------------------------------------------------------------------
 *  UnodeAi - durable write and exclusive publish (v0.9.110 §3.2, §3.4)
 *  The SpendStore principle (state/SpendStore.ts): write the complete file under a private name, flush it, then
 *  publish it under its final name with link(), which never replaces an existing name and makes readers see only
 *  complete files. A file system without hard links publishes by exclusive create instead; a reader then treats a
 *  young unreadable file as still being written.
 *--------------------------------------------------------------------------------------------*/

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/** Error codes that mean the file system has no hard links. */
export const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK', 'EINVAL']);

export class PublishTakenError extends Error {
  constructor(readonly target: string) {
    super(`${path.basename(target)} was published by another writer`);
  }
}

/** Create `file` exclusively, write all of `text`, flush, close. */
export async function writeDurably(file: string, text: string): Promise<void> {
  const handle = await fsp.open(file, 'wx');
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface PublishState {
  hardLinks: boolean;
}

/**
 * Publish `text` as `target`, which must not exist. `staging` is a private name in the same folder tree; it is
 * removed afterwards whatever happened. Throws `PublishTakenError` when another writer published `target` first.
 */
export async function publishExclusive(staging: string, target: string, text: string, state: PublishState, log?: (line: string) => void): Promise<void> {
  if (state.hardLinks) {
    await writeDurably(staging, text);
    try {
      await fsp.link(staging, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (code === 'EEXIST') throw new PublishTakenError(target);
      if (!NO_HARD_LINKS.has(code)) throw error;
      state.hardLinks = false;
      log?.(`Task history publishes by exclusive create: this file system has no hard links (${code}).`);
    } finally {
      await fsp.rm(staging, { force: true }).catch(() => undefined);
    }
  }
  try {
    await writeDurably(target, text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new PublishTakenError(target);
    throw error;
  }
}
