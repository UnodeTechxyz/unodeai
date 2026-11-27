import type { SearchOperation, SearchTurn, UnodeSearchPorts } from '../backend/UnodeSearchHost';
import type { SentTranscriptionOutcome, TranscriptionOperation, TranscriptionTask } from '../media/TranscriptionHost';
import type { RequestLimitMeter } from './RequestLimitMeter';
import type { SpendCoordinator } from './SpendCoordinator';

type UsageOrigin = { requestId?: string; agentId: string };
type TokenFigure = { inputTokens: number; outputTokens: number };
type SearchOutcome = Parameters<NonNullable<UnodeSearchPorts['settled']>>[2];

interface Ports {
  currentRequestId(agentId: string): string | undefined;
  meter: Pick<RequestLimitMeter, 'beginUsageUnit' | 'noteModelRequest' | 'settleUsageUnit'>;
  spend(): Pick<SpendCoordinator, 'transcriptionUsage' | 'publicSearchUsage'> | undefined;
  onSpendError(): void;
}

function captureOperations<Operation extends { operationId: string }, Outcome>(
  ports: Ports, captureSpend: (origin: UsageOrigin, operation: Operation) => ((outcome: Outcome) => void) | undefined,
) {
  const captures = new WeakMap<Operation, { requestId?: string; settleSpend?: (outcome: Outcome) => void }>();
  return {
    start(agentId: string, operation: Operation): void {
      const requestId = ports.currentRequestId(agentId);
      if (requestId) {
        ports.meter.beginUsageUnit({ usageUnitId: operation.operationId, requestId, agentId }, 'request');
        ports.meter.noteModelRequest(operation.operationId);
      }
      try {
        captures.set(operation, { requestId, settleSpend: captureSpend({ requestId, agentId }, operation) });
      } catch {
        captures.set(operation, { requestId });
        ports.onSpendError();
      }
    },
    settle(operation: Operation, outcome: Outcome, tokens: TokenFigure | undefined): string | undefined {
      const capture = captures.get(operation);
      captures.delete(operation);
      ports.meter.settleUsageUnit(operation.operationId, tokens);
      try { capture?.settleSpend?.(outcome); }
      catch { ports.onSpendError(); }
      return capture?.requestId;
    },
  };
}

/** Capture the request at send time. A later turn must not receive this operation's receipt or tokens. */
export function createPaidToolAccounting(ports: Ports) {
  const transcription = captureOperations<TranscriptionOperation, SentTranscriptionOutcome>(
    ports, (origin, operation) => ports.spend()?.transcriptionUsage(origin, operation),
  );
  const search = captureOperations<SearchOperation, SearchOutcome>(
    ports, (origin, operation) => ports.spend()?.publicSearchUsage(origin, operation),
  );

  return {
    transcription: {
      started: (task: TranscriptionTask, operation: TranscriptionOperation) => transcription.start(task.agentId, operation),
      settled: (operation: TranscriptionOperation, outcome: SentTranscriptionOutcome) => {
        // gpt-transcribe is billed by duration. The token-billed Whisper does not report a token figure.
        const noTokens = operation.route.model === 'gpt-transcribe' || outcome.state === 'duration-limit';
        transcription.settle(operation, outcome, noTokens ? { inputTokens: 0, outputTokens: 0 } : undefined);
      },
    },
    search: {
      started: (turn: SearchTurn, operation: SearchOperation) => search.start(turn.agentId, operation),
      settled: (operation: SearchOperation, outcome: SearchOutcome) => {
        const usage = 'details' in outcome ? outcome.details.usage : undefined;
        const input = usage?.input_tokens;
        const output = usage?.output_tokens;
        return search.settle(operation, outcome, input === undefined || output === undefined ? undefined : {
          inputTokens: input + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0),
          outputTokens: output,
        });
      },
    },
  };
}
