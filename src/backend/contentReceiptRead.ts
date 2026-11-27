/*---------------------------------------------------------------------------------------------
 *  UnodeAi - Content receipt reads (v0.9.88 §5.5)
 *
 *  A coordinator's host read_file result becomes a content receipt only when the host knows the model got
 *  all of it. The host builds the model-facing result itself: the receipt line first, so no tail cut can remove
 *  it; whole lines only, sized to the route's transport bound; and on Codex a check line last.
 *--------------------------------------------------------------------------------------------*/

import { relocateHistoricalRead, type HistoricalReadFact } from '../compaction/ReadReferenceProjection';
import type { TurnContentReceipt, TurnContentReceiptDelivery } from './TeamTools';
import { PUBLISH_CONTENT_RECEIPT_TOOL } from './TurnContentDelivery';
import { receiptTextSize, type ReceiptReadBudget, type WorkspaceToolRunResult, type WorkspaceTools } from './WorkspaceTools';

/** Receipt ids are `receipt-<uuid>`; sizing uses a stand-in of the same length before the id exists. */
const RECEIPT_ID_STAND_IN = `receipt-${'0'.repeat(36)}`;
/** End-check codes are 12 hex characters (6 random bytes). */
const END_CHECK_STAND_IN = '0'.repeat(12);

export function contentReceiptLine(receiptId: string): string {
  return `[host content receipt: ${receiptId}] The lines below are exact file content the host holds. If the user `
    + `asked to see them, call ${PUBLISH_CONTENT_RECEIPT_TOOL} with this receipt_id; never retype them. A prose claim `
    + 'that the content was shown does not publish it.';
}

export function contentReceiptEndLine(receiptId: string, endCheck: string): string {
  return `[end of host content receipt ${receiptId}; check code: ${endCheck}. Pass it as end_check when you publish `
    + 'this receipt.]';
}

/** The model-facing text: receipt line, the read output unchanged, then the check line when there is one. */
export function composeContentReceiptResult(receiptId: string, output: string, endCheck?: string): string {
  return `${contentReceiptLine(receiptId)}\n${output}${endCheck === undefined ? '' : `\n${contentReceiptEndLine(receiptId, endCheck)}`}`;
}

function reservedFor(unit: ReceiptReadBudget['unit'], endCheck: boolean): number {
  return receiptTextSize(composeContentReceiptResult(RECEIPT_ID_STAND_IN, '', endCheck ? END_CHECK_STAND_IN : undefined), unit);
}

export interface ContentReceiptReadOptions {
  /** The route's bound for the whole model-facing result, in `unit`. */
  unit: ReceiptReadBudget['unit'];
  limit: number;
  delivery: TurnContentReceiptDelivery;
  register: (content: string, delivery: TurnContentReceiptDelivery) => TurnContentReceipt | { id: string; endCheck?: string } | undefined;
}

export interface ContentReceiptReadResult {
  result: WorkspaceToolRunResult;
  /** What the model receives. Without a receipt it is the ordinary read output. */
  text: string;
  /**
   * What a person sees on the tool card: the read output without the lines the host added for the model. The host
   * knows which lines it added; nothing is inferred from how text looks, since a file can contain look-alike lines.
   */
  displayText: string;
  receipt?: { id: string; endCheck?: string };
  /** Where the read's payload sits inside `text`, for a successful read whose payload the host located. */
  historicalRead?: HistoricalReadFact;
}

/**
 * Read for a receipt. The read is sized so the composed result fits `limit`; the receipt is registered only if it
 * still fits once composed (a notice added after sizing, such as a teammate's edit warning, could push it over),
 * and only for the exact content placed in the result.
 */
export async function runContentReceiptRead(
  tools: WorkspaceTools,
  args: Record<string, unknown>,
  options: ContentReceiptReadOptions,
): Promise<ContentReceiptReadResult> {
  const endCheck = options.delivery === 'end-check';
  const result = await tools.run('read_file', args, {
    receiptBudget: { unit: options.unit, limit: options.limit, reserved: reservedFor(options.unit, endCheck) },
  });
  const unchanged: ContentReceiptReadResult = {
    result,
    text: result.output,
    displayText: result.output,
    ...(result.historicalRead ? { historicalRead: result.historicalRead } : {}),
  };
  if (result.status !== 'success' || result.readContent === undefined) {
    return unchanged;
  }
  // v0.9.94: a line-numbered view is for citing lines. Each of its lines carries a number the file does not hold,
  // so it is not "exact content" to show a person, and its result names one id only: the short read receipt.
  if (args.line_numbers === true) {
    return unchanged;
  }
  const sized = composeContentReceiptResult(RECEIPT_ID_STAND_IN, result.output, endCheck ? END_CHECK_STAND_IN : undefined);
  if (receiptTextSize(sized, options.unit) > options.limit) {
    return unchanged;
  }
  const receipt = options.register(result.readContent, options.delivery);
  if (!receipt) {
    return unchanged;
  }
  const text = composeContentReceiptResult(receipt.id, result.output, receipt.endCheck);
  // The output follows the receipt line and its line break unchanged, so its payload moves by exactly that much.
  const historicalRead = result.historicalRead
    && relocateHistoricalRead(result.historicalRead, text, contentReceiptLine(receipt.id).length + 1);
  return {
    result,
    text,
    displayText: result.output,
    receipt: { id: receipt.id, ...(receipt.endCheck === undefined ? {} : { endCheck: receipt.endCheck }) },
    ...(historicalRead ? { historicalRead } : {}),
  };
}
