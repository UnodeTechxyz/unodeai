import type { WorkbookDeliveryFragment } from './WorkbookDelivery';

/** Actual CSV and typed JSON page vocabularies; metadata and computation coverage are separate. */
export function workbookDeliveryFragments(page: { prepared_fragments: unknown[] }, office = false): { fragments: WorkbookDeliveryFragment[]; unknown: boolean } {
  const fragments: WorkbookDeliveryFragment[] = []; let unknown = false;
  for (const item of page.prepared_fragments) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { unknown = true; continue; }
    const raw = item as Record<string, unknown>;
    if ((raw.kind === 'string' || raw.kind === 'absent') && typeof raw.cell === 'string') {
      const bounds = fragmentBounds(raw); const text = raw.kind === 'absent' ? '' : raw.text;
      if (!bounds || typeof text !== 'string' || Buffer.byteLength(text, 'utf8') !== bounds.end - bounds.start) { unknown = true; continue; }
      fragments.push({ unit: `cell:${raw.cell}`, ...bounds }); continue;
    }
    if ((raw.kind === 'cell-fragment' || raw.kind === 'table-cell-fragment'
      || (office && ['object-fragment', 'slide-fragment', 'paragraph-fragment'].includes(raw.kind as string))) && typeof raw.id === 'string') {
      const bounds = fragmentBounds(raw);
      if (!bounds || raw.encoding !== 'json-utf8' || typeof raw.text !== 'string' || Buffer.byteLength(raw.text, 'utf8') !== bounds.end - bounds.start) { unknown = true; continue; }
      fragments.push({ unit: `${(raw.kind as string).slice(0, -9)}:${raw.id}`, ...bounds }); continue;
    }
    if ((raw.kind === 'cell' || raw.kind === 'table-cell'
      || (office && ['object', 'slide', 'paragraph'].includes(raw.kind as string))) && typeof raw.id === 'string' && raw.record !== undefined) {
      const length = Buffer.byteLength(JSON.stringify(raw.record), 'utf8');
      fragments.push({ unit: `${raw.kind}:${raw.id}`, start: 0, end: length, total: length });
    }
    // Inspection, hidden/excluded regions and computation metadata are distinct from displayed cell values.
  }
  return { fragments, unknown };
}
function fragmentBounds(raw: Record<string, unknown>): { start: number; end: number; total: number } | undefined {
  const start = raw.start_byte; const end = raw.end_byte; const total = raw.total_bytes;
  if (![start, end, total].every(value => Number.isSafeInteger(value) && (value as number) >= 0)
    || (start as number) > (end as number) || (end as number) > (total as number)) return undefined;
  return { start: start as number, end: end as number, total: total as number };
}
