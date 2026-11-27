import { xlsxRange } from '../content/XlsxSheet';
import { WorkbookEditFailure } from './WorkbookEditContracts';

export const RECALCULATE_WORKBOOK_TOOL = 'recalculate_workbook';
export type WorkbookRecalcTargets = { from_receipt: string } | { cells: Array<{ sheet_id: string; refs: string[] }> };
export interface WorkbookRecalcRequest { schema_version: 1; path: string; adapter: 'auto' | 'excel' | 'libreoffice'; write_cache: boolean; targets: WorkbookRecalcTargets }
export interface WorkbookRecalcTarget { sheet_id: string; position: number; cell: string }
/** One cell value read from an engine's recalculated copy. `recalculated` is set only for a value the engine actually produced. */
export interface WorkbookRecalcValue { sheet_id: string; cell: string; type: 'n' | 'str' | 'b' | 'e' | 'blank'; value: string | null; recalculated: boolean; error?: string }
export interface WorkbookRecalcEffects {
  network: Array<{ location: string; hosts: string[]; dynamic: boolean }>; native: string[]; external_links: number;
  connections: Array<{ name: string; location: string; kind: 'web' | 'local'; hosts: string[] }>;
}
export interface WorkbookRecalcScan extends WorkbookRecalcEffects { sha256: string; date1904: boolean; sheets: Array<{ sheet_id: string; name: string; position: number }>; targets: WorkbookRecalcTarget[];
  /** Excel 4 macro sheets the engine's private copy will not contain, and the targets (sheet_id!cell) that may depend on them. */
  macro_sheets: string[]; macro_dependent: string[] }
/** Host-issued record of a saved edit_workbook/write_workbook output; never accepted from the model as trusted data. */
export interface WorkbookEditRecord { ref: string; agentId: string; attemptId?: string; physical: string; sha256: string; formulas: Array<{ sheet_id: string; cell: string; formula: string }> }

export const WORKBOOK_RECALC_MAX_TARGETS = 10_000;
/** Spreadsheet error values as the engines report them; Excel's CVErr numbers are mapped here, never guessed. */
export const XLSX_CVERR: ReadonlyMap<number, string> = new Map([[2000, '#NULL!'], [2007, '#DIV/0!'], [2015, '#VALUE!'], [2023, '#REF!'], [2029, '#NAME?'],
  [2036, '#NUM!'], [2042, '#N/A'], [2043, '#GETTING_DATA'], [2045, '#SPILL!'], [2046, '#CONNECT!'], [2047, '#BLOCKED!'], [2048, '#UNKNOWN!'], [2049, '#FIELD!'], [2050, '#CALC!']]);

/**
 * Engine errors that are not the workbook's calculated result, with the reason each is reported unrecalculated:
 * #NAME? is a function the engine cannot run (a macro-sheet function with macros disabled included), #BLOCKED! an
 * evaluation the engine blocked (an XLM-dependent function with XLM macros disabled, or an inaccessible resource).
 * They keep their observed text and are never written as cached results. Other errors, such as #DIV/0!, are computed.
 */
/** Reason for a target that may depend on an Excel 4 macro sheet the engine's private copy left out. */
export const MACRO_SHEET_DEPENDENT = 'depends-on-macro-sheet';
export const XLSX_UNAVAILABLE_ERRORS: ReadonlyMap<string, string> = new Map([['#NAME?', 'engine-unsupported-function'], ['#BLOCKED!', 'engine-evaluation-blocked']]);

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = (location: string, issue: string): never => { throw new WorkbookEditFailure('invalid-workbook-edits', { location, issue }); };
export function validateWorkbookRecalcRequest(value: unknown): WorkbookRecalcRequest {
  if (!object(value)) return invalid('request', 'must be an object');
  const extra = Object.keys(value).filter(key => !['schema_version', 'path', 'adapter', 'write_cache', 'targets'].includes(key));
  if (extra.length) return invalid('request', `unsupported fields ${extra.join(', ')}`);
  if (value.schema_version !== 1) return invalid('schema_version', 'must be 1');
  if (typeof value.path !== 'string' || !value.path.trim()) return invalid('path', 'must be the .xlsx workbook path');
  if (value.adapter !== undefined && !['auto', 'excel', 'libreoffice'].includes(value.adapter as string)) return invalid('adapter', 'use auto, excel or libreoffice');
  if (value.write_cache !== undefined && typeof value.write_cache !== 'boolean') return invalid('write_cache', 'must be true or false');
  if (!object(value.targets)) return invalid('targets', 'use {from_receipt: workbook_edit_ref} or {cells: [{sheet_id, refs}]}');
  const targets = value.targets; let parsed: WorkbookRecalcTargets;
  if (Object.keys(targets).length === 1 && typeof targets.from_receipt === 'string' && targets.from_receipt) parsed = { from_receipt: targets.from_receipt };
  else if (Object.keys(targets).length === 1 && Array.isArray(targets.cells) && targets.cells.length) {
    let count = 0;
    parsed = { cells: targets.cells.map((item, index) => {
      const at = `targets.cells[${index}]`;
      if (!object(item) || Object.keys(item).some(key => !['sheet_id', 'refs'].includes(key)) || typeof item.sheet_id !== 'string' || !/^sheet-[1-9]\d*$/.test(item.sheet_id)) return invalid(at, 'use {sheet_id from read_workbook inspect, refs}');
      if (!Array.isArray(item.refs) || !item.refs.length) return invalid(`${at}.refs`, 'must be a nonempty array of A1 cells or ranges');
      const refs = item.refs.map((ref, position) => {
        if (typeof ref !== 'string') return invalid(`${at}.refs[${position}]`, 'must be an A1 cell or range');
        let range; try { range = xlsxRange(ref); } catch { throw new WorkbookEditFailure('invalid-cell-ref', { location: `${at}.refs[${position}]`, issue: 'use an ordered A1 cell or range within XFD1048576' }); }
        count += (range.lastRow - range.firstRow + 1) * (range.lastColumn - range.firstColumn + 1); return ref;
      });
      return { sheet_id: item.sheet_id, refs };
    }) };
    if (count > WORKBOOK_RECALC_MAX_TARGETS) return invalid('targets.cells', `name at most ${WORKBOOK_RECALC_MAX_TARGETS} cells per request`);
  } else return invalid('targets', 'use {from_receipt: workbook_edit_ref} or {cells: [{sheet_id, refs}]}');
  return { schema_version: 1, path: value.path, adapter: (value.adapter as WorkbookRecalcRequest['adapter']) ?? 'auto', write_cache: value.write_cache === true, targets: parsed };
}

export const RECALCULATE_WORKBOOK_SPEC = { type: 'function' as const, function: {
  name: RECALCULATE_WORKBOOK_TOOL,
  description: 'Recalculate formula cells of an XLSX with installed Excel (Windows) or LibreOffice, on a private copy, and report the values the engine produced. '
    + 'Use after edit_workbook or write_workbook (targets.from_receipt = its workbook_edit_ref) or for named cells (targets.cells with sheet_id from read_workbook inspect). '
    + 'Requires Read access to the workbook and Commands; starting the application asks through the ordinary command approval. Plan, read-only and Commands Off do not run it. '
    + 'Formulas that read the web follow this agent’s Web access setting; local or database data connections and formulas that use CALL, REGISTER.ID, RTD or DDE are never run, and the result says why. '
    + 'Links to other workbooks are not refreshed; their saved values are used. Macros stay disabled. An Excel 4 macro sheet does not stop the calculation: the engine\u2019s private copy leaves out every macro sheet and the names on or pointing at one, so nothing in them runs, and a cell that may depend on them is reported unrecalculated (depends-on-macro-sheet). '
    + 'An engine #NAME? or #BLOCKED! is reported as observed but unrecalculated and is never written to the cache. '
    + 'Only cells with an engine value are marked recalculated: errors such as #DIV/0! are reported as they are, and a function the engine does not support is reported unrecalculated. '
    + 'write_cache:true writes only those cached results back into the same workbook through the ordinary write approval, keeping every formula and every other byte; the engine’s own saved file is never used. '
    + 'auto uses Excel when installed, otherwise LibreOffice; it never retries with the other engine. Results bind to the exact workbook bytes: if the file changed after the edit, nothing runs.',
  parameters: { type: 'object', additionalProperties: false, properties: {
    schema_version: { type: 'integer', enum: [1] },
    path: { type: 'string', description: 'The authorized .xlsx workbook path (for from_receipt, the path that edit_workbook/write_workbook saved).' },
    adapter: { type: 'string', enum: ['auto', 'excel', 'libreoffice'], description: 'Calculation engine. Defaults to auto.' },
    write_cache: { type: 'boolean', description: 'Write the recalculated values into the workbook cache. Defaults to false (report only).' },
    targets: { type: 'object', additionalProperties: false, properties: {
      from_receipt: { type: 'string', description: 'workbook_edit_ref from this agent’s edit_workbook or write_workbook receipt: all formula cells it wrote.' },
      cells: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { sheet_id: { type: 'string' }, refs: { type: 'array', items: { type: 'string' } } }, required: ['sheet_id', 'refs'] } },
    } },
  }, required: ['schema_version', 'path', 'targets'] },
} };
