import type { DocumentDataFact } from '../content/document/DocumentDataBinding';
import type { PresentationDataFact } from './PresentationDataBinding';
import type { PresentationChartFact } from './PresentationChartBinding';

export interface OfficeWriteLineage {
  format: 'docx' | 'pptx' | 'pdf'; sourceSha256?: string;
  /** v0.9.108: the source was converted (PDF -> DOCX by Word), a derivation whose pages cannot be mapped (13.13). */
  sourceKind?: 'pdf-conversion';
  /** v0.9.108: the other PDFs an edit_pdf output takes pages from (later merge inputs, replace_pages sources). */
  pageSourceSha256?: readonly string[];
  dataBindings?: readonly (DocumentDataFact | PresentationDataFact | PresentationChartFact)[];
}
/** Only the common verified host byte-commit boundary creates this observation. */
export interface OfficeWrittenFact extends OfficeWriteLineage {
  operationId: string; artifactId: string; sha256: string; bytes: number; previousSha256?: string;
  agentId: string; attemptId?: string; requestId?: string; turnId?: string;
  effect: 'created' | 'replaced' | 'unchanged'; restorePointId?: string;
}
