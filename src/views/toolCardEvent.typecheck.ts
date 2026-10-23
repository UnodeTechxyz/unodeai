/**
 * Compile-time contract for v0.9.91 tool card events. Nothing here runs: `tsc` checks these types, so a tool event
 * that loosens to a bare label or loses its call id makes one of the assertions below fail to compile.
 */
import type { SessionToolEvent } from '../session/SessionManager';
import type { ChatToolEvent } from './ChatViewProvider';

type IsAssignable<From, To> = [From] extends [To] ? true : false;
type Holds<T extends true> = T;
type Refused<T extends false> = T;

type Success = { status: 'success'; observedBy: 'host' };

// A Session tool event pairs by call id, and its result carries the typed fact, never a label in its place.
export type SessionUseCarriesACallId = Holds<IsAssignable<{ phase: 'use'; callId: string; name: string; epoch: number }, SessionToolEvent>>;
export type SessionResultCarriesAFact = Holds<IsAssignable<{ phase: 'result'; callId: string; name: string; epoch: number; outcome: Success }, SessionToolEvent>>;
export type SessionUseNeedsACallId = Refused<IsAssignable<{ phase: 'use'; name: string; epoch: number }, SessionToolEvent>>;
export type SessionResultNeedsAFact = Refused<IsAssignable<{ phase: 'result'; callId: string; name: string; epoch: number; ok: true }, SessionToolEvent>>;

// The chat's own event has the same shape.
export type ChatResultCarriesAFact = Holds<IsAssignable<{ phase: 'result'; callId: string; name: string; outcome: Success }, ChatToolEvent>>;
export type ChatResultNeedsAFact = Refused<IsAssignable<{ phase: 'result'; callId: string; name: string; ok: false; failureKind: 'blocked' }, ChatToolEvent>>;
export type ChatResultNeedsACallId = Refused<IsAssignable<{ phase: 'result'; name: string; outcome: Success }, ChatToolEvent>>;
