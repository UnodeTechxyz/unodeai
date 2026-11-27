import type { WorkbookWriteResult, WorkbookEditCode } from './WorkbookEditContracts';

/** The structured part of a saved workbook receipt; built from the host read-back, never from the model's request. */
export interface WorkbookWriteReceipt { kind: 'workbook-edited' | 'workbook-created'; version: 1; workbook_edit_ref?: string; path: string; bytes: number; sha256: string; sourceSha256?: string;
  effect: 'created' | 'replaced' | 'unchanged'; restorePointId?: string; cells_written: number; formulas_written: string[]; number_formats_added: number;
  calc_chain_removed: boolean; full_calc_on_load: boolean; recalculated: false }

const list = (items: readonly string[], limit = 40) => items.length > limit ? `${items.slice(0, limit).join(', ')} and ${items.length - limit} more` : items.join(', ');
const EFFECT_TEXT = { network: 'may access the network when Excel opens or calculates it', 'native-code': 'may run local code when Excel calculates it', 'external-workbook': 'refers to another workbook' } as const;

export function workbookWriteReceiptText(result: WorkbookWriteResult, receipt: WorkbookWriteReceipt, physical: string): string {
  const formulas = result.formulas_written.map(item => `${item.sheet_id}!${item.cell} = ${item.formula.length > 120 ? item.formula.slice(0, 117) + '...' : item.formula}`);
  const lines = [
    `Saved ${result.kind === 'workbook-created' ? 'new' : receipt.effect === 'unchanged' ? 'unchanged' : 'edited'} XLSX to ${receipt.path}.`, `Full path written: ${physical}`,
    `Bytes: ${receipt.bytes}. SHA-256: ${receipt.sha256}.`,
    ...(result.sourceSha256 ? [`Inspected source SHA-256: ${result.sourceSha256}.`] : []),
    `Sheets: ${result.sheets.map(sheet => `${sheet.sheet_id} "${sheet.name}"`).join(', ')}.`,
    `Value cells written (${result.values_written.length}): ${result.values_written.length ? list(result.values_written) : 'none'}.`,
    `Formula cells written (${formulas.length}): ${formulas.length ? list(formulas, 30) : 'none'}.`,
    ...(result.formats_written ? [`Cells with a number format set: ${result.formats_written}; new number formats added: ${result.number_formats_added}.`] : []),
    'Recalculated: no. Formula cells were saved without cached results and UnodeAi did not calculate them, so no formula result is known from this save. '
      + (receipt.workbook_edit_ref && result.formulas_written.length ? `To calculate them, call recalculate_workbook with targets.from_receipt "${receipt.workbook_edit_ref}" where offered. ` : '')
      + (result.full_calc_on_load ? 'fullCalcOnLoad is set: Excel calculates the workbook when it opens the file. ' : '')
      + (result.kind === 'workbook-edited' ? 'Other saved results in this workbook keep their stored values, which may now be out of date until the workbook is recalculated.' : ''),
    ...(result.calc_mode_manual ? ['This workbook uses manual calculation: Excel will not recalculate automatically when it opens it; press F9 in Excel or run recalculate_workbook where offered.'] : []),
    ...(result.calc_chain_removed ? ['The calculation chain part was removed because formulas changed; Excel rebuilds it.'] : []),
    ...(result.array_cells_cleared.length ? [`Array formula range cells cleared because the array's first cell was rewritten: ${list(result.array_cells_cleared)}.`] : []),
    ...(result.calculated_column_notes.length ? [`These cells are in a table calculated column and now differ from its formula: ${list(result.calculated_column_notes)}.`] : []),
    ...(result.tables_extended.length ? [`Tables extended by the appended rows: ${list(result.tables_extended)}.`] : []),
    ...result.formula_effects.map(item => `${item.sheet_id}!${item.cell} ${item.effects.map(effect => EFFECT_TEXT[effect]).join(' and ')}.`),
    ...(result.data_sources.length ? [`Values filled from host data: ${list(result.data_sources.map(item => `${item.sheet_id}!${item.cell} from ${item.transformation_ref} ${item.field} row ${item.row}`), 20)}.`] : []),
    ...(result.template_converted ? ['The template was saved as an ordinary workbook (.xlsx).'] : []),
    result.kind === 'workbook-edited'
      ? `Untouched part byte checks passed: ${result.preserved_parts}. Changed parts: ${result.changed_parts}. Added parts: ${result.added_parts}. Removed parts: ${result.removed_parts}. Untouched cells checked: ${result.untouched_cells_checked}. Preservation digest: ${result.preservation_digest}.`
      : `Every written cell was read back from the saved package (${result.added_parts} parts).`,
    `Receipt: ${JSON.stringify(receipt)}`,
  ];
  return lines.join('\n');
}

export function workbookWritePreview(result: WorkbookWriteResult, display: string): string {
  return `${result.kind === 'workbook-created' ? 'Create workbook' : 'Apply inspected workbook edits'}.\nDestination: ${display}\nSheets: ${result.sheets.map(sheet => sheet.name).join(', ')}\n`
    + `Value cells: ${result.values_written.length}; formula cells: ${result.formulas_written.length}; formatted cells: ${result.formats_written}\nBytes: ${result.bytes.byteLength}\nSHA-256: ${result.sha256}`;
}

/** One concrete next step per failure, so the model can continue without guessing. */
export function workbookEditFailureHint(code: WorkbookEditCode | string, tool: 'edit_workbook' | 'write_workbook', issue?: { location: string; issue: string }): string {
  const at = issue ? ` (${issue.location}: ${issue.issue})` : '';
  switch (code) {
    case 'invalid-workbook-edits': return `Invalid ${tool} input${at}. Correct that field and send the request again.`;
    case 'invalid-formula': return `Formula text cannot be stored${at}. Send formula text without control characters, with balanced parentheses and at most 8192 characters.`;
    case 'invalid-cell-ref': return `Cell reference outside the worksheet${at}. Use A1 references within XFD1048576.`;
    case 'snapshot-unavailable': return 'This snapshot is not held by this agent’s current request. Call read_workbook with operation inspect on the source path, then use its snapshot_ref and sheet_id values.';
    case 'source-changed': return 'Source bytes changed since inspect. Call read_workbook inspect again and use its new snapshot_ref.';
    case 'source-unreadable': return 'The inspected source is no longer readable. Inspect it again once it is readable.';
    case 'source-unavailable': return 'The inspected source is no longer available to this request. Inspect an authorized path or attachment again.';
    case 'unavailable-worksheet': return `That sheet cannot be written${at}. Use a worksheet sheet_id without a gap from read_workbook inspect; chart and macro sheets are not edited.`;
    case 'workbook-macros-unsupported': return 'This workbook contains macros (xlsm/xltm or a VBA project); UnodeAi does not edit macro workbooks. Ask the user to save a macro-free .xlsx copy in Excel, or make the change in Excel.';
    case 'workbook-signed': return 'This workbook is digitally signed and any change would break the signature. Ask the user whether to remove the signature in Excel first, or make the change in Excel.';
    case 'sheet-protected': return `That sheet is protected${at}. Other sheets remain writable. Ask the user to unprotect it in Excel (Review > Unprotect Sheet) if they want UnodeAi to write there.`;
    case 'formula-range-partial': return `Only part of a shared or array formula range was written${at}. Write every cell of that range in one request (for an array, include its first cell), or change only number formats there.`;
    case 'table-structure-unsupported': return `Table structure cannot be changed here${at}. Write inside the table's data rows, or ask the user to change headers or totals in Excel.`;
    case 'workbook-structure-unsupported': return `This area cannot be written safely${at}. Write outside it, or ask the user to change it in Excel.`;
    case 'merged-cell-covered': return `That cell is covered by a merged range${at}. Write the merged range's first cell instead.`;
    case 'workbook-data-unavailable': return `The host data value cannot be written${at}. Use a current transformation_ref, field and row from this agent's transform_workbook result, or write a formula.`;
    case 'destination-extension-mismatch': return 'Use a destination path ending in .xlsx.';
    case 'unsupported-workbook-package': return 'This file is not a supported XLSX workbook package. Ask the user to save it as .xlsx in Excel, then inspect that copy.';
    case 'unsupported-xml-dtd': case 'unsupported-xml-encoding': return 'The workbook XML uses a declaration UnodeAi does not read. Ask the user to save a fresh .xlsx copy in Excel.';
    case 'workbook-output-check-failed': return 'The written workbook did not pass its read-back check, so it was not saved. Try a smaller change, or report this file to the user.';
    case 'cancelled': return 'The workbook write stopped or its access changed.';
    case 'out-of-memory': return 'The workbook writer reached its memory budget. Use a smaller workbook copy or fewer cells per request.';
    case 'worker-unavailable': return 'The workbook writer is unavailable in this installation.';
    default: return 'The workbook could not be written and verified by this writer.';
  }
}
