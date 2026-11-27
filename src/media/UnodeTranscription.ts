import { extname } from 'node:path';
import { readBoundedText } from '../backend/cliRuntime';
import { UNODE_DEFAULT_BASE_URL } from '../backend/openAICompatBaseUrl';
import { hostToolRefusalDetail, type HostToolRefusalDetail } from '../backend/toolSummary';
import { checkedAudio, TranscriptionInputError, type TranscriptionInput } from './TranscriptionInput';
import { splitTranscriptionAudio, TRANSCRIPTION_DURATION_MESSAGE, type TranscriptionAudioPart, type TranscriptionFormat } from './TranscriptionAudio';
import { NANO_PER_USD } from '../models/spend/Money';
import { reservePaidRequest, type RequestBoundary } from '../backend/requestBoundary';
import { unodeTranscriptionCost } from './UnodeTranscriptionPricing';

export type UnodeTranscriptionModel = 'gpt-transcribe' | 'whisper-1';
export interface UnodeTranscriptionUsage {
  seconds?: number;
  pricing: { basis: 'unavailable' } | { basis: string; date: string; estimatedUsdAtList: number };
}

interface Transcript {
  text: string;
  languages: string[];
  segments: Array<{ start: number; end: number; text: string }>;
}

export type TranscriptionPartOutcome =
  | { state: 'refused'; mayHaveCost: false; reason?: 'request-limit' | 'stopped' }
  | { state: 'duration-limit'; mayHaveCost: false; requestId?: string; status: 400 }
  | { state: 'outcome-unknown' | 'service-failed'; mayHaveCost: true; requestId?: string; status?: number }
  | { state: 'succeeded'; mayHaveCost: true; requestId?: string; usage: UnodeTranscriptionUsage; transcript: Transcript }
  | { state: 'withheld'; mayHaveCost: true; requestId?: string; usage: UnodeTranscriptionUsage };

export type TranscriptionPart = Pick<TranscriptionAudioPart, 'startSeconds' | 'endSeconds'> & {
  index: number;
  total: number;
  recordingSeconds: number;
};
type PartReceipt = Pick<TranscriptionPart, 'startSeconds' | 'endSeconds'> & {
  state: TranscriptionPartOutcome['state'];
  mayHaveCost: boolean;
  requestId?: string;
  usage?: UnodeTranscriptionUsage;
};
type CompletedPart = Extract<TranscriptionPartOutcome, { state: 'succeeded' }>;
export type TranscriptionOutcome = Exclude<TranscriptionPartOutcome, CompletedPart>
  | (CompletedPart & { parts?: PartReceipt[] })
  | { state: 'incomplete'; mayHaveCost: boolean; message: string; missing: { startSeconds: number; endSeconds: number }; parts: PartReceipt[] }
  | { state: 'unavailable'; message: HostToolRefusalDetail };

const REPLY_LIMIT = 2_000_000;
const ERROR_REPLY_LIMIT = 8_192;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function seconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined;
}

export function parseUnodeTranscription(body: unknown, model: UnodeTranscriptionModel):
  { transcript: Transcript; usage: UnodeTranscriptionUsage } | undefined {
  const data = object(body);
  if (typeof data?.text !== 'string') return undefined;
  const rawUsage = object(data.usage);
  const duration = (rawUsage?.type === 'duration' ? seconds(rawUsage.seconds) : undefined)
    ?? (model === 'whisper-1' ? seconds(data.duration) : undefined);
  const price = unodeTranscriptionCost(model, duration);
  const languages = (Array.isArray(data.languages) ? data.languages.map(language => object(language)?.code) : [data.language])
    .filter((code): code is string => typeof code === 'string' && /^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(code));
  const segments = (Array.isArray(data.segments) ? data.segments : []).flatMap(raw => {
    const segment = object(raw);
    const start = seconds(segment?.start);
    const end = seconds(segment?.end);
    return start !== undefined && end !== undefined && end >= start && typeof segment?.text === 'string'
      ? [{ start, end, text: segment.text }] : [];
  });
  return {
    transcript: { text: data.text, languages, segments },
    usage: {
      ...(duration === undefined ? {} : { seconds: duration }),
      pricing: price
        ? { basis: price.sourceName, date: price.sourceDate, estimatedUsdAtList: Number(price.nanoUsd) / Number(NANO_PER_USD) }
        : { basis: 'unavailable' },
    },
  };
}

interface SendOptions {
  model: UnodeTranscriptionModel; verifiedLimit?: number; secret: string; signal: AbortSignal;
  current(): boolean;
  boundary?: RequestBoundary;
  credentialsCurrent?(): Promise<boolean>;
  onSend?(seconds: number, part: TranscriptionPart): void;
  onPartSettled?(part: TranscriptionPart, outcome: Exclude<TranscriptionPartOutcome, { state: 'refused' }>): void;
  fetch?: typeof fetch;
}

/** Called after Read, model egress and the audio egress gate, with the exact checked input. */
export async function sendUnodeTranscription(input: TranscriptionInput, options: SendOptions): Promise<TranscriptionOutcome> {
  if (options.signal.aborted) return { state: 'refused', mayHaveCost: false, reason: 'stopped' };
  const audio = checkedAudio(input.bytes, options.verifiedLimit);
  const prepared = prepareParts(input.bytes, audio, options.verifiedLimit);
  if (!prepared) {
    return { state: 'unavailable', message: hostToolRefusalDetail('This recording cannot be split safely for transcription. Export it as PCM WAV or MP3 and try again.') };
  }

  const receipts: PartReceipt[] = [];
  const completed: Array<{ result: CompletedPart; startSeconds: number; leadingSeconds: number }> = [];
  for (const [index, { bytes, startSeconds, endSeconds, seconds, leadingSeconds = 0 }] of prepared.entries()) {
    const part = { index, total: prepared.length, startSeconds, endSeconds, recordingSeconds: audio.seconds };
    const result = await sendPart(input, options, part, bytes, audio.format, seconds);
    if (result.state !== 'refused') options.onPartSettled?.(part, result);
    if (prepared.length === 1) return result;
    const { state, mayHaveCost } = result;
    receipts.push({ startSeconds, endSeconds, state, mayHaveCost,
      ...('requestId' in result && result.requestId ? { requestId: result.requestId } : {}),
      ...('usage' in result ? { usage: result.usage } : {}) });
    if (result.state !== 'succeeded') {
      const missing = { startSeconds, endSeconds: prepared[prepared.length - 1].endSeconds };
      const range = `${audioTime(missing.startSeconds)}–${audioTime(missing.endSeconds)}`;
      return { state: 'incomplete', mayHaveCost: receipts.some(receipt => receipt.mayHaveCost), missing, parts: receipts,
        message: `Transcription is incomplete. Missing audio from ${range}. ${partFailureMessage(result)}` };
    }
    completed.push({ result, startSeconds, leadingSeconds });
  }

  return {
    state: 'succeeded', mayHaveCost: true, parts: receipts,
    usage: joinedUsage(completed.map(({ result }) => result.usage)),
    transcript: {
      text: completed.map(({ result }) => result.transcript.text.trim()).filter(Boolean).join('\n'),
      languages: [...new Set(completed.flatMap(({ result }) => result.transcript.languages))],
      segments: completed.flatMap(({ result, startSeconds, leadingSeconds }) => result.transcript.segments.map(segment => ({
        ...segment,
        start: startSeconds + Math.max(0, segment.start - leadingSeconds),
        end: startSeconds + Math.max(0, segment.end - leadingSeconds),
      }))),
    },
  };
}

function partFailureMessage(result: Exclude<TranscriptionPartOutcome, CompletedPart>): string {
  switch (result.state) {
    case 'duration-limit': return TRANSCRIPTION_DURATION_MESSAGE;
    case 'outcome-unknown': return 'The gateway did not confirm the result and may have charged for that part. Automatic retry was skipped.';
    case 'service-failed': return 'The gateway could not transcribe that part.';
    case 'withheld': return 'The task’s access changed before that part could be returned.';
    case 'refused':
      if (result.reason === 'request-limit') return 'The request limit stopped the upload.';
      if (result.reason === 'stopped') return 'The task stopped before this part was uploaded.';
      return 'The task no longer authorises this upload.';
  }
}

function prepareParts(bytes: Buffer, audio: ReturnType<typeof checkedAudio>, limit: number | undefined) {
  const parts = splitTranscriptionAudio(bytes, audio);
  if (!parts?.length) return undefined;
  if (parts[0].bytes === bytes) return [{ ...parts[0], seconds: audio.seconds }];
  try {
    return parts.map(part => ({ ...part, seconds: checkedAudio(part.bytes, limit).seconds }));
  } catch (error) {
    if (error instanceof TranscriptionInputError) return undefined;
    throw error;
  }
}

function audioTime(seconds: number): string {
  const ms = Math.round(seconds * 1_000);
  const second = String(Math.floor(ms / 1_000) % 60).padStart(2, '0');
  const fraction = ms % 1_000 ? `.${String(ms % 1_000).padStart(3, '0')}` : '';
  return `${Math.floor(ms / 60_000)}:${second}${fraction}`;
}

function joinedUsage(items: UnodeTranscriptionUsage[]): UnodeTranscriptionUsage {
  const durations = items.flatMap(item => item.seconds === undefined ? [] : [item.seconds]);
  const prices = items.flatMap(item => 'estimatedUsdAtList' in item.pricing ? [item.pricing] : []);
  return {
    ...(durations.length === items.length ? { seconds: durations.reduce((sum, seconds) => sum + seconds, 0) } : {}),
    pricing: prices.length === items.length ? {
      ...prices[0],
      estimatedUsdAtList: prices.reduce((sum, price) => sum + Math.round(price.estimatedUsdAtList * Number(NANO_PER_USD)), 0)
        / Number(NANO_PER_USD),
    } : { basis: 'unavailable' },
  };
}

async function sendPart(
  input: TranscriptionInput, options: SendOptions, part: TranscriptionPart, bytes: Buffer, format: TranscriptionFormat, seconds: number,
): Promise<TranscriptionPartOutcome> {
  const refused = (): TranscriptionPartOutcome => options.signal.aborted
    ? { state: 'refused', mayHaveCost: false, reason: 'stopped' } : { state: 'refused', mayHaveCost: false };
  if (options.signal.aborted) return refused();
  if (!options.current() || !await input.current() || options.signal.aborted || !options.current()) return refused();
  const form = new FormData();
  const extension = '.' + format;
  const filename = extname(input.name).toLowerCase() === extension ? input.name : input.name + extension;
  form.append('file', new Blob([Uint8Array.from(bytes)], { type: format === 'mp3' ? 'audio/mpeg' : 'audio/wav' }), filename);
  form.append('model', options.model);
  form.append('response_format', options.model === 'whisper-1' ? 'verbose_json' : 'json');
  const reservation = await reservePaidRequest(options.boundary, { tool: 'transcribe_audio', signal: options.signal });
  if (reservation.status !== 'reserved') return { state: 'refused', mayHaveCost: false, reason: reservation.status };
  let sending = false;
  let requestId: string | undefined;
  try {
    if (!options.current() || options.signal.aborted || (options.credentialsCurrent && !await options.credentialsCurrent())
      || (options.boundary && !await input.current()) || !options.current()) return refused();
    sending = true;
    options.onSend?.(seconds, part);
    const response = await (options.fetch ?? fetch)(UNODE_DEFAULT_BASE_URL + '/audio/transcriptions', {
      method: 'POST', redirect: 'manual', headers: { authorization: 'Bearer ' + options.secret },
      body: form, signal: options.signal,
    });
    const returnedId = response.headers.get('x-request-id');
    if (returnedId && /^[A-Za-z0-9_.:-]{1,256}$/.test(returnedId)) requestId = returnedId;
    if (!response.ok) {
      if (response.status === 400) {
        try {
          const error = object(object(JSON.parse(await readBoundedText(response, ERROR_REPLY_LIMIT)))?.error);
          if (error?.code === 'invalid_value' && typeof error.message === 'string'
            && /\baudio duration\b[^\r\n]*\blonger than 1500 seconds\b/i.test(error.message)) {
            return { state: 'duration-limit', mayHaveCost: false, requestId, status: 400 };
          }
        } catch { /* An unrecognised error stays an opaque service failure. */ }
      } else await response.body?.cancel().catch(() => undefined);
      return { state: 'service-failed', mayHaveCost: true, requestId, status: response.status };
    }
    const body: unknown = JSON.parse(await readBoundedText(response, REPLY_LIMIT));
    const parsed = parseUnodeTranscription(body, options.model);
    if (!parsed) return { state: 'service-failed', mayHaveCost: true, requestId, status: response.status };
    if (options.signal.aborted || !options.current() || !await input.current() || !options.current()) {
      return { state: 'withheld', mayHaveCost: true, requestId, usage: parsed.usage };
    }
    return { state: 'succeeded', mayHaveCost: true, requestId, ...parsed };
  } catch {
    return sending ? { state: 'outcome-unknown', mayHaveCost: true, requestId } : refused();
  } finally {
    if (!sending) reservation.release();
  }
}
