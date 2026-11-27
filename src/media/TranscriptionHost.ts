import { randomUUID } from 'node:crypto';
import { UNODE_DEFAULT_BASE_URL } from '../backend/openAICompatBaseUrl';
import { awaitRequestBoundary, type RequestBoundary } from '../backend/requestBoundary';
import { hostToolRefusalDetail } from '../backend/toolSummary';
import { formatUsd } from '../models/spend/Money';
import type { MediaEgressRequest } from './MediaEgress';
import { TRANSCRIPTION_DURATION_MESSAGE, TRANSCRIPTION_MAX_BYTES } from './TranscriptionAudio';
import { TranscriptionInputError, type TranscriptionInput } from './TranscriptionInput';
import { sendUnodeTranscription, type TranscriptionOutcome, type TranscriptionPartOutcome, type UnodeTranscriptionModel } from './UnodeTranscription';
import { unodeTranscriptionCost } from './UnodeTranscriptionPricing';

export interface TranscriptionRoute {
  readonly connectionId: 'unode';
  readonly revision: number;
  readonly endpointBase: typeof UNODE_DEFAULT_BASE_URL;
  readonly model: UnodeTranscriptionModel;
  readonly secretName: string;
  readonly verifiedLimit?: number;
}

export interface TranscriptionTask {
  readonly agentId: string;
  readonly turnId: string;
  readonly signal: AbortSignal;
  boundary?: RequestBoundary;
  current(): boolean;
  prepare(verifiedLimit: number): Promise<TranscriptionInput | undefined>;
}

export interface TranscriptionOperation {
  operationId: string;
  route: TranscriptionRoute;
}
export type SentTranscriptionOutcome = Exclude<TranscriptionPartOutcome, { state: 'refused' }>;
type TranscriptionResult = Exclude<TranscriptionOutcome, { state: 'refused' | 'unavailable' }>;

type TranscriptionReceipt = {
  operationId: string;
  agentId: string;
  turnId: string;
  connectionId: string;
  connectionRevision: number;
  endpointBase: string;
  model: string;
  filename: string;
  byteCount: number;
  sha256: string;
  outcome: Exclude<TranscriptionResult, { state: 'succeeded' }> | Omit<Extract<TranscriptionResult, { state: 'succeeded' }>, 'transcript'>;
};

interface Ports {
  route(agentId: string): TranscriptionRoute | undefined;
  secret(name: string): Promise<string | undefined>;
  modelEgress(route: TranscriptionRoute, task: TranscriptionTask): Promise<void>;
  audioEgress(request: MediaEgressRequest, task: TranscriptionTask): Promise<void>;
  egressCurrent(route: TranscriptionRoute): boolean;
  activity(task: TranscriptionTask, text: string): void;
  started?(task: TranscriptionTask, operation: TranscriptionOperation): void;
  settled?(operation: TranscriptionOperation, outcome: SentTranscriptionOutcome): void;
  receipt(record: TranscriptionReceipt): void;
  fetch?: typeof fetch;
}

type SentMetadata = {
  operationId: string;
  filename: string;
  byteCount: number;
  model: UnodeTranscriptionModel;
  receiver: string;
};
type Result = (TranscriptionResult & { media: SentMetadata }) | Extract<TranscriptionOutcome, { state: 'refused' | 'unavailable' }>;

export class TranscriptionHost {
  constructor(private readonly ports: Ports) {}

  availableFor(agentId: string): boolean {
    const limit = this.ports.route(agentId)?.verifiedLimit;
    return typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 12;
  }

  async transcribe(task: TranscriptionTask): Promise<Result> {
    if (task.signal.aborted) return { state: 'refused', mayHaveCost: false, reason: 'stopped' };
    const route = this.ports.route(task.agentId);
    if (!route) return { state: 'unavailable',
      message: hostToolRefusalDetail('Choose a supported audio model in Agent Builder → Media models or in Settings → Providers.') };
    const limit = route.verifiedLimit;
    if (limit === undefined || !Number.isSafeInteger(limit) || limit < 12) {
      return { state: 'unavailable', message: hostToolRefusalDetail('The Unode transcription upload limit is awaiting gateway verification.') };
    }
    const admitted = () => {
      const active = this.ports.route(task.agentId);
      return !task.signal.aborted && task.current() && active?.connectionId === route.connectionId
        && active.revision === route.revision && active.endpointBase === route.endpointBase && active.model === route.model
        && active.secretName === route.secretName && active.verifiedLimit === limit;
    };
    const refused = { state: 'refused', mayHaveCost: false } as const;
    if (!admitted()) return refused;
    let audio: TranscriptionInput | undefined;
    try {
      audio = await task.prepare(limit);
    } catch (error) {
      if (!(error instanceof TranscriptionInputError)) throw error;
      const message = error.code === 'audio-size-unsupported'
        ? (error.byteLimit ?? TRANSCRIPTION_MAX_BYTES) === TRANSCRIPTION_MAX_BYTES
          ? hostToolRefusalDetail('Transcription accepts at most 25,000,000 bytes per recording. Split the recording into smaller parts, each 25 minutes or less and within the upload size limit.')
          : hostToolRefusalDetail('This recording exceeds the connection’s upload size limit. Split the recording into smaller parts, each 25 minutes or less and within the upload size limit.')
        : error.code === 'audio-duration-unsupported' ? TRANSCRIPTION_DURATION_MESSAGE
        : error.code === 'audio-format-unsupported' ? hostToolRefusalDetail('Choose a readable WAV or MP3 recording with a valid audio header.')
          : hostToolRefusalDetail('The recording changed or its read access expired. Reopen the task before requesting transcription.');
      return { state: 'unavailable', message };
    }
    if (!audio || !admitted() || !await audio.current()) return refused;
    const secret = await this.ports.secret(route.secretName);
    if (!admitted()) return refused;
    if (!secret?.trim()) return { state: 'unavailable',
      message: hostToolRefusalDetail('Set the API key on the Unode card in Settings → Providers.') };
    const host = new URL(route.endpointBase).host;
    try {
      await this.ports.modelEgress(route, task);
      if (!admitted() || !await audio.current() || !admitted()) return refused;
      if (task.boundary && await awaitRequestBoundary(task.boundary, 'effect', { tool: 'transcribe_audio', signal: task.signal }) === 'stopped') {
        return { ...refused, reason: 'request-limit' };
      }
      if (!admitted() || !await audio.current() || !admitted()) return refused;
      await this.ports.audioEgress({ host, provider: `Unode (${route.model})`, kind: 'transcription', mediaClass: 'audio',
        byteCount: audio.bytes.length }, task);
    } catch { return refused; }
    const current = () => admitted() && this.ports.egressCurrent(route);
    if (!current() || await this.ports.secret(route.secretName) !== secret || !current()) return refused;
    const operation: TranscriptionOperation = { operationId: 'transcription-' + randomUUID(), route };
    let partOperation = operation;
    const result = await sendUnodeTranscription(audio, {
      model: route.model, verifiedLimit: limit, secret, signal: task.signal, current,
      boundary: task.boundary,
      credentialsCurrent: async () => await this.ports.secret(route.secretName) === secret,
      onSend: (_seconds, part) => {
        partOperation = part.total === 1 ? operation : { route, operationId: `${operation.operationId}-part-${part.index + 1}` };
        try { this.ports.started?.(task, partOperation); } catch { /* Spend visibility cannot gate an approved upload. */ }
        if (part.index !== 0) return;
        const price = unodeTranscriptionCost(route.model, part.recordingSeconds);
        const duration = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(part.recordingSeconds);
        const estimate = price ? `About ${formatUsd(price.nanoUsd)} at list (${duration} s).` : `Price estimate unavailable (${duration} s).`;
        const partCount = part.total > 1 ? ` in ${part.total} parts` : '';
        try { this.ports.activity(task, `Transcribing ${audio.name} (${audio.bytes.length} bytes) with ${route.model} on Unode at ${host}${partCount}. ${estimate}`); }
        catch { /* Activity visibility cannot gate an approved upload. */ }
      },
      onPartSettled: (_part, outcome) => {
        try { this.ports.settled?.(partOperation, outcome); } catch { /* Spend visibility cannot change the upload outcome. */ }
      },
      fetch: this.ports.fetch,
    });
    if (result.state === 'refused' || result.state === 'unavailable') return result;
    const { operationId } = operation;
    const { transcript: _privateText, ...outcome } = result.state === 'succeeded' ? result : { ...result, transcript: undefined };
    try {
      this.ports.receipt({ operationId, turnId: task.turnId, agentId: task.agentId, connectionId: route.connectionId, connectionRevision: route.revision,
        endpointBase: route.endpointBase, model: route.model, filename: audio.name, byteCount: audio.bytes.length, sha256: audio.sha256, outcome });
    } catch { /* History visibility does not change the upload outcome. */ }
    return { ...result, media: { operationId, filename: audio.name, byteCount: audio.bytes.length, model: route.model, receiver: host } };
  }
}
