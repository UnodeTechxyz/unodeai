/*---------------------------------------------------------------------------------------------
 * Bounded content-intake observations. This is the only shape that may cross from a temporary
 * asset into durable run accounting; it intentionally has no URL, path, query, bytes or text.
 *--------------------------------------------------------------------------------------------*/

export type PdfContentReceiptAction = 'stored' | 'read' | 'searched';
export type ImageContentReceiptAction = 'stored' | 'sent' | 'refused' | 'omitted';
export type ConversationContentReceiptAction = 'read' | 'searched';

export interface PdfContentReceiptObservation {
  /** Host-generated temporary asset id. Portable export remaps it to a document-local ordinal. */
  assetId: string;
  contentClass: 'pdf';
  action: PdfContentReceiptAction;
  extractionAttempted: boolean;
  extractionSucceeded: boolean;
  /** Present only after a successful page-scoped extraction or search. */
  pages?: {
    start: number;
    end: number;
    total: number;
    /** A read extracts pages; a search records only the range it searched. */
    extracted?: number;
  };
  truncated: boolean;
  ocrRequired: boolean;
}

/** A vision-routing receipt says only what happened, never where it went or what it contained. */
export interface ImageContentReceiptObservation {
  assetId: string;
  contentClass: 'image';
  action: ImageContentReceiptAction;
  processingClass: 'local-storage' | 'remote-vision';
  consentOutcome: 'approved' | 'declined' | 'not-requested';
}

/** A bounded read of the calling agent's own MessageBus transcript. No entry text or query is retained. */
export interface ConversationContentReceiptObservation {
  contentClass: 'conversation';
  action: ConversationContentReceiptAction;
  entries: {
    start: number;
    end: number;
    total: number;
    /** A read returns entries; a search only reports the span it consulted. */
    returned?: number;
  };
}

export type ContentReceiptObservation = PdfContentReceiptObservation | ImageContentReceiptObservation | ConversationContentReceiptObservation;

export function sanitizeContentReceipt(value: ContentReceiptObservation): ContentReceiptObservation | undefined {
  if (!value) {
    return undefined;
  }
  if (value.contentClass === 'conversation') {
    if (!['read', 'searched'].includes(value.action) || !validRange(value.entries)) {
      return undefined;
    }
    if ((value.action === 'read') !== (value.entries.returned !== undefined)) {
      return undefined;
    }
    if (value.entries.returned !== undefined &&
        (!Number.isInteger(value.entries.returned) || value.entries.returned < 0 || value.entries.returned > value.entries.end - value.entries.start + 1)) {
      return undefined;
    }
    return {
      contentClass: 'conversation',
      action: value.action,
      entries: { ...value.entries },
    };
  }
  if (!/^content-[1-9]\d*$/.test(value.assetId)) {
    return undefined;
  }
  if (value.contentClass === 'image') {
    if (!['stored', 'sent', 'refused', 'omitted'].includes(value.action) ||
        (value.processingClass !== 'local-storage' && value.processingClass !== 'remote-vision') ||
        (value.consentOutcome !== 'approved' && value.consentOutcome !== 'declined' && value.consentOutcome !== 'not-requested')) {
      return undefined;
    }
    const validState =
      (value.action === 'stored' && value.processingClass === 'local-storage' && value.consentOutcome === 'not-requested') ||
      (value.action === 'sent' && value.processingClass === 'remote-vision' && value.consentOutcome === 'approved') ||
      (value.action === 'refused' && value.processingClass === 'remote-vision' && value.consentOutcome === 'declined') ||
      (value.action === 'omitted' && value.processingClass === 'remote-vision' && value.consentOutcome === 'not-requested');
    return validState
      ? {
        assetId: value.assetId,
        contentClass: 'image',
        action: value.action,
        processingClass: value.processingClass,
        consentOutcome: value.consentOutcome,
      }
      : undefined;
  }
  if (value.contentClass !== 'pdf' || !['stored', 'read', 'searched'].includes(value.action) ||
      typeof value.extractionAttempted !== 'boolean' || typeof value.extractionSucceeded !== 'boolean' ||
      typeof value.truncated !== 'boolean' || typeof value.ocrRequired !== 'boolean') {
    return undefined;
  }
  if (!value.extractionAttempted && value.extractionSucceeded) {
    return undefined;
  }
  if ((value.action === 'stored' && (value.extractionAttempted || value.extractionSucceeded || value.pages)) ||
      (value.action !== 'stored' && !value.extractionAttempted)) {
    return undefined;
  }
  if (!value.pages) {
    return {
      assetId: value.assetId,
      contentClass: value.contentClass,
      action: value.action,
      extractionAttempted: value.extractionAttempted,
      extractionSucceeded: value.extractionSucceeded,
      truncated: value.truncated,
      ocrRequired: value.ocrRequired,
    };
  }
  const { start, end, total, extracted } = value.pages;
  if (!validRange({ start, end, total }) ||
      (extracted !== undefined && (!Number.isInteger(extracted) || extracted < 0 || extracted > end - start + 1))) {
    return undefined;
  }
  if (!value.extractionSucceeded) {
    return undefined;
  }
  if ((value.action === 'read' && extracted === undefined) ||
      (value.action === 'searched' && extracted !== undefined)) {
    return undefined;
  }
  return {
    assetId: value.assetId,
    contentClass: value.contentClass,
    action: value.action,
    extractionAttempted: value.extractionAttempted,
    extractionSucceeded: value.extractionSucceeded,
    pages: { start, end, total, ...(extracted === undefined ? {} : { extracted }) },
    truncated: value.truncated,
    ocrRequired: value.ocrRequired,
  };
}

function validRange(value: { start: number; end: number; total: number }): boolean {
  return [value.start, value.end, value.total].every((number) => Number.isInteger(number) && number >= 1)
    && value.start <= value.end && value.end <= value.total;
}
