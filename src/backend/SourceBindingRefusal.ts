import type { HostToolOutcome } from './toolSummary';

/** Actual refused source identity stays on host objects; JSON/model/log projections never include this symbol. */
const stoppedSource = Symbol('host-source-binding-refusal');
type BoundRefusal = { [stoppedSource]?: string };
export function withSourceBindingRefusal(outcome: HostToolOutcome, physical: string | undefined): HostToolOutcome {
  if (outcome.status !== 'refused' || !physical) return outcome;
  return Object.assign({ ...outcome }, { [stoppedSource]: physical });
}
export function sourceBindingRefusalPath(outcome: object): string | undefined {
  return (outcome as BoundRefusal)[stoppedSource];
}
