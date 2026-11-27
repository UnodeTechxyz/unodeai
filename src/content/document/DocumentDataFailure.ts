import { DocumentFailure } from './DocumentContracts';
export class DocumentDataFailure extends DocumentFailure {
  constructor(readonly bindingIssue: 'selection' | 'source-text-unrepresentable') { super('invalid-input'); }
}
