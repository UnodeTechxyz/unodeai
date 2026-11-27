import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  inspectTranscriptionAudio, TRANSCRIPTION_MAX_BYTES, TRANSCRIPTION_MAX_SECONDS, type TranscriptionAudio,
} from './TranscriptionAudio';

export class TranscriptionInputError extends Error {
  constructor(readonly code: 'upload-limit-unverified' | 'audio-format-unsupported' | 'audio-size-unsupported'
    | 'audio-duration-unsupported' | 'audio-source-changed', readonly byteLimit?: number) {
    super(code);
  }
}

export interface TranscriptionInput {
  readonly name: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  /** Rechecks the same physical binding after authority or egress waits. */
  current(): Promise<boolean>;
}

export function checkedAudio(bytes: Buffer, verifiedLimit: number | undefined): TranscriptionAudio {
  if (verifiedLimit === undefined || !Number.isSafeInteger(verifiedLimit) || verifiedLimit < 12) throw new TranscriptionInputError('upload-limit-unverified');
  const byteLimit = Math.min(TRANSCRIPTION_MAX_BYTES, verifiedLimit);
  if (bytes.length > byteLimit) throw new TranscriptionInputError('audio-size-unsupported', byteLimit);
  const audio = inspectTranscriptionAudio(bytes);
  if (!audio) throw new TranscriptionInputError('audio-format-unsupported');
  if (audio.seconds > TRANSCRIPTION_MAX_SECONDS) throw new TranscriptionInputError('audio-duration-unsupported');
  return audio;
}

function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

/** The caller supplies a physical path from the existing Read boundary and a verified limit for the exact adapter. */
export async function captureAudioFile(physical: string, verifiedLimit: number | undefined,
  stillAllowed: () => boolean, sourceName = basename(physical)): Promise<TranscriptionInput> {
  if (verifiedLimit === undefined || !Number.isSafeInteger(verifiedLimit) || verifiedLimit < 12) throw new TranscriptionInputError('upload-limit-unverified');
  const byteLimit = Math.min(TRANSCRIPTION_MAX_BYTES, verifiedLimit);
  const name = basename(sourceName);
  if (!stillAllowed()) throw new TranscriptionInputError('audio-source-changed');
  const file = await open(physical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    .catch(() => { throw new TranscriptionInputError('audio-source-changed'); });
  try {
    const initial = await file.stat({ bigint: true });
    if (!initial.isFile()) throw new TranscriptionInputError('audio-format-unsupported');
    if (initial.size > BigInt(byteLimit)) throw new TranscriptionInputError('audio-size-unsupported', byteLimit);
    const current = async () => {
      if (!stillAllowed()) return false;
      try {
        const binding = await stat(physical, { bigint: true });
        return sameFile(initial, binding) && stillAllowed();
      } catch { return false; }
    };
    if (!await current()) throw new TranscriptionInputError('audio-source-changed');
    const bytes = Buffer.alloc(Number(initial.size));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length || !await current()) throw new TranscriptionInputError('audio-source-changed');
    checkedAudio(bytes, byteLimit);
    return { name, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), current };
  } catch (error) {
    if (error instanceof TranscriptionInputError) throw error;
    throw new TranscriptionInputError('audio-source-changed');
  } finally {
    await file.close();
  }
}
