/**
 * Compile-time contract for v0.9.91 tool and turn outcomes. Nothing here runs: `tsc` (build and release gates)
 * checks these types, and a contract that loosens makes one of the assertions below fail to compile. Test files
 * are outside the TypeScript project, so an `@ts-expect-error` there is never checked; these assertions are.
 */
import type { BackendEvent, LiveTurnResult, TurnResult } from './AgentBackend';
import type { HostToolOutcome, ToolResultFact } from './toolSummary';

type IsAssignable<From, To> = [From] extends [To] ? true : false;
type Holds<T extends true> = T;
type Refused<T extends false> = T;

// A tool result fact admits only its own status's field, and only the host refuses.
export type SuccessIsAFact = Holds<IsAssignable<{ status: 'success'; observedBy: 'provider-protocol' }, ToolResultFact>>;
export type HostRefusalIsAFact = Holds<IsAssignable<{ status: 'refused'; observedBy: 'host'; reason: 'consent' }, ToolResultFact>>;
export type ProviderFailureIsAFact = Holds<IsAssignable<{ status: 'failed'; observedBy: 'provider-protocol'; failureKind: 'error' }, ToolResultFact>>;
export type SuccessCannotCarryAFailureKind = Refused<IsAssignable<{ status: 'success'; observedBy: 'host'; failureKind: 'error' }, ToolResultFact>>;
export type SuccessCannotCarryAReason = Refused<IsAssignable<{ status: 'success'; observedBy: 'host'; reason: 'consent' }, ToolResultFact>>;
export type RefusalNeedsAReason = Refused<IsAssignable<{ status: 'refused'; observedBy: 'host' }, ToolResultFact>>;
export type OnlyTheHostRefuses = Refused<IsAssignable<{ status: 'refused'; observedBy: 'provider-protocol'; reason: 'consent' }, ToolResultFact>>;
export type FailureNeedsAKind = Refused<IsAssignable<{ status: 'failed'; observedBy: 'host' }, ToolResultFact>>;
export type BlockedIsNotAFailureKind = Refused<IsAssignable<{ status: 'failed'; observedBy: 'host'; failureKind: 'blocked' }, ToolResultFact>>;
export type FailureCannotCarryAReason = Refused<IsAssignable<{ status: 'failed'; observedBy: 'host'; failureKind: 'error'; reason: 'scope' }, ToolResultFact>>;

// A host outcome is built from the same decision.
export type HostSuccessIsAnOutcome = Holds<IsAssignable<{ source: 'host'; contentSource: 'host'; status: 'success'; output: string }, HostToolOutcome>>;
export type BareTextIsNotAnOutcome = Refused<IsAssignable<string, HostToolOutcome>>;
export type HostSuccessCannotCarryAFailureKind = Refused<IsAssignable<{ source: 'host'; contentSource: 'host'; status: 'success'; output: string; failureKind: 'error' }, HostToolOutcome>>;
export type HostRefusalNeedsAReason = Refused<IsAssignable<{ source: 'host'; contentSource: 'host'; status: 'refused'; output: string }, HostToolOutcome>>;
export type HostRefusalMayContainExternalOutput = Holds<IsAssignable<{ source: 'host'; contentSource: 'mixed-external'; status: 'refused'; reason: 'capability'; output: string }, HostToolOutcome>>;
export type HostFailureCannotBeBlocked = Refused<IsAssignable<{ source: 'host'; contentSource: 'host'; status: 'failed'; output: string; failureKind: 'blocked' }, HostToolOutcome>>;

// Live tool events carry the host's call id.
export type ToolUseCarriesACallId = Holds<IsAssignable<{ kind: 'tool_use'; callId: string; name: string; input: unknown }, BackendEvent>>;
export type ToolUseWithoutACallId = Refused<IsAssignable<{ kind: 'tool_use'; name: string; input: unknown }, BackendEvent>>;
export type ToolResultWithoutACallId = Refused<IsAssignable<{ kind: 'tool_result'; name: string; ok: boolean; summary: string }, BackendEvent>>;

// Every live terminal path states its delivery; only restored data may lack it.
export type LiveTurnIsComplete = Holds<IsAssignable<{ kind: 'turn_complete'; result: { text: string; isError: boolean; responseOutcome: { kind: 'reply' } } }, BackendEvent>>;
export type LiveTurnNeedsADelivery = Refused<IsAssignable<{ kind: 'turn_complete'; result: { text: string; isError: boolean } }, BackendEvent>>;
export type RestoredResultIsNotLive = Refused<IsAssignable<TurnResult, LiveTurnResult>>;
