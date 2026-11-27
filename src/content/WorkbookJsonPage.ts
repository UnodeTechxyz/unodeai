import { TextDecoder } from 'node:util';
import { workbookOutputSize, type PageBudget } from './WorkbookPage';
export interface WorkbookItemPage { prepared_fragments: unknown[]; next_cursor: string | null; remaining: unknown }
/** A partial cell record is JSON data, never a truncated typed numeric value. */
export function appendWorkbookJsonItem(page: WorkbookItemPage, kind: string, id: string, record: unknown, offset: number,
  budget: PageBudget, position: (end: number, total: number) => void): 'whole' | 'partial' | 'full' {
  const raw = Buffer.from(JSON.stringify(record), 'utf8');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= raw.length) throw new Error('invalid-cursor');
  const fits = () => workbookOutputSize(JSON.stringify(page), budget) + budget.reserved <= budget.limit;
  if (!offset) {
    page.prepared_fragments.push({ kind, id, record }); position(raw.length, raw.length);
    if (fits()) return 'whole'; page.prepared_fragments.pop();
  }
  const length = Math.min(raw.length - offset, budget.limit * 4);
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(offset, offset + length), { stream: length < raw.length - offset });
  const fragment = { kind: `${kind}-fragment`, id, encoding: 'json-utf8', text: '', start_byte: offset, end_byte: offset, total_bytes: raw.length, whole_record: false };
  page.prepared_fragments.push(fragment);
  const set = (end: number) => {
    if (end && end < decoded.length && decoded.charCodeAt(end - 1) >= 0xd800 && decoded.charCodeAt(end - 1) <= 0xdbff) end--;
    fragment.text = decoded.slice(0, end); fragment.end_byte = offset + Buffer.byteLength(fragment.text, 'utf8'); position(fragment.end_byte, raw.length);
  };
  let low = 0; let high = decoded.length;
  while (low < high) { const middle = Math.ceil((low + high) / 2); set(middle); if (fits()) low = middle; else high = middle - 1; }
  set(low);
  if (!fits() || fragment.end_byte === offset) {
    page.prepared_fragments.pop(); position(offset, raw.length);
    if (!page.prepared_fragments.length) throw new Error('route-bound-too-small'); return 'full';
  }
  return fragment.end_byte === raw.length ? 'whole' : 'partial';
}
