import { DocumentFailure } from '../content/document/DocumentContracts';
/** Finite source-format error. Never forward source text or an arbitrary library diagnostic. */
export class PresentationDataFailure extends DocumentFailure {
  readonly dataIssue = 'source-text-unrepresentable';
  constructor() { super('invalid-input'); }
}
