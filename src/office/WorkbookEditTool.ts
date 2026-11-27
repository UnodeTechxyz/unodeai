export const EDIT_WORKBOOK_TOOL = 'edit_workbook';
export const WRITE_WORKBOOK_TOOL = 'write_workbook';
const VALUE = { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' },
  { type: 'object', additionalProperties: false, properties: { date: { type: 'string', description: 'YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS; stored as a date serial in the workbook date system, formatted yyyy-mm-dd unless a number format is given.' } }, required: ['date'] },
  { type: 'object', additionalProperties: false, properties: { from: { type: 'object', additionalProperties: false, properties: {
    transformation_ref: { type: 'string' }, field: { type: 'string' }, row: { type: 'integer', minimum: 1 } }, required: ['transformation_ref', 'field', 'row'] } }, required: ['from'] }] };
const ROWS = { type: 'array', minItems: 1, items: { type: 'array', minItems: 1, items: VALUE } };
const FORMULAS_NOTE = 'Formula text without a leading = (one leading = is ignored), e.g. B2+C2+D2 or SUM(B2:B9).';
const DERIVED = 'When the user states a relationship (for example A = B+C+D, a total, a difference or a share), write a formula, not the number you computed; write a fixed number only when the user explicitly asks for fixed values. ';
const HONEST = 'Formulas are stored without cached results and are NOT recalculated by UnodeAi: the receipt lists formula cells separately from value cells, and fullCalcOnLoad asks Excel to calculate when the file is opened. Never report a formula result you did not read from a recalculated file. ';

export const EDIT_WORKBOOK_SPEC = { type: 'function' as const, function: {
  name: EDIT_WORKBOOK_TOOL,
  description: 'Preserving edit of an existing XLSX/XLTX inspected with read_workbook. Requires current Read access to the inspected source and Write access to the destination .xlsx (the source path itself only with actual Write access). '
    + 'Use snapshot_ref and sheet_id values from this agent’s read_workbook inspect. Edits apply in order, and later edits of the same cell win: set_cells (rectangular values for an A1 range), set_formulas (cell to formula text), set_number_format (format only; values and formulas stay), append_rows (rows after the last row with content, starting at column A; formulas per column letter may use {row} for the new row number). '
    + DERIVED + HONEST
    + 'Values: string, number, boolean, null (clears value and formula, keeps the format), {date} or {from: {transformation_ref, field, row}} for an exact value from this agent’s transform_workbook result (source recorded). Strings are written inline; shared strings are not changed. '
    + 'Only written cells, their formats and calculation metadata change: other cells, sheets and parts keep their bytes and are checked after saving. Any formula change removes the calculation chain part. A manual calculation mode is kept and reported. '
    + 'Formulas that use the network (WEBSERVICE, IMAGE, STOCKHISTORY), call local code (CALL, REGISTER.ID, RTD, DDE) or link other workbooks are written as asked; the receipt says what Excel may do when it calculates them. '
    + 'Refused with a code and a next step, never approximated: macro workbooks (workbook-macros-unsupported), signed workbooks (workbook-signed), content or format writes to a protected sheet (sheet-protected; other sheets stay writable), part of a shared or array formula range (formula-range-partial), table header or totals rows and appends under a table with a totals row (table-structure-unsupported), pivot table areas, data tables and cells linking other workbooks (workbook-structure-unsupported), covered cells of a merged range (merged-cell-covered), references beyond XFD1048576 (invalid-cell-ref). '
    + 'Writing inside an array formula range through its first cell clears the rest of that range; appending directly under a table without totals extends the table and fills its calculated columns. Rows and columns are never inserted or deleted, sheets are never added, renamed or removed. '
    + 'Source bytes must still match the inspected version; after any change, inspect again before the next edit.',
  parameters: { type: 'object', additionalProperties: false, properties: {
    schema_version: { type: 'integer', enum: [1] },
    path: { type: 'string', description: 'Authorized destination .xlsx. May be the inspected source path only with actual Write access.' },
    snapshot_ref: { type: 'string', description: 'The snapshot_ref returned by this agent’s read_workbook inspect of the source.' },
    edits: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, properties: {
      op: { type: 'string', enum: ['set_cells', 'set_formulas', 'set_number_format', 'append_rows'] },
      sheet_id: { type: 'string', description: 'sheet_id from read_workbook inspect, such as sheet-1.' },
      range: { type: 'string', description: 'For set_cells and set_number_format: an ordered A1 range such as B2:D4 (a single cell is allowed).' },
      values: { ...ROWS, description: 'For set_cells: exactly one row per range row and one value per range column.' },
      cells: { type: 'object', additionalProperties: { type: 'string' }, description: `For set_formulas: A1 cell to formula text. ${FORMULAS_NOTE}` },
      rows: { ...ROWS, description: 'For append_rows: rows of values starting at column A; use null where a formula column is filled.' },
      formulas: { type: 'object', additionalProperties: { type: 'string' }, description: `For append_rows: column letter to formula text applied to every appended row; {row} becomes that row number. ${FORMULAS_NOTE}` },
      number_format: { type: 'string', description: 'Number format code such as 0.00, 0%, #,##0.00 or yyyy-mm-dd. Required for set_number_format; optional for set_cells/set_formulas.' },
      number_formats: { type: 'object', additionalProperties: { type: 'string' }, description: 'For append_rows: column letter to number format code.' },
    }, required: ['op', 'sheet_id'] } },
  }, required: ['schema_version', 'path', 'snapshot_ref', 'edits'] },
} };

export const WRITE_WORKBOOK_SPEC = { type: 'function' as const, function: {
  name: WRITE_WORKBOOK_TOOL,
  description: 'Create a new XLSX workbook from typed values and formulas. Requires Write access to the destination .xlsx; an existing file is replaced only with actual Write access. '
    + 'Each sheet has a name, optional bold header row, rows of values (string, number, boolean, null, {date} or {from} as in edit_workbook), optional column widths and number formats, and an optional frozen header. '
    + 'formulas maps a column letter to formula text applied to every data row ({row} becomes that row number), or an A1 cell to one formula. ' + FORMULAS_NOTE + ' '
    + DERIVED + HONEST
    + 'The saved file is read back and every written cell is checked against the request. For changes to an existing workbook use read_workbook and edit_workbook instead.',
  parameters: { type: 'object', additionalProperties: false, properties: {
    schema_version: { type: 'integer', enum: [1] },
    path: { type: 'string', description: 'Authorized destination .xlsx path.' },
    sheets: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, properties: {
      name: { type: 'string', description: '1 to 31 characters without [ ] : * ? / \\; unique in the workbook.' },
      header: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Optional header row (row 1, bold). Data rows then start at row 2.' },
      rows: { type: 'array', items: { type: 'array', minItems: 1, items: VALUE }, description: 'Data rows starting at column A.' },
      columns: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { width: { type: 'number', minimum: 0, maximum: 255 }, number_format: { type: 'string' } } },
        description: 'Optional per-column settings in column order (A first): width in characters and number format code.' },
      formulas: { type: 'object', additionalProperties: { type: 'string' }, description: 'Column letter (every data row, {row} placeholder) or A1 cell to formula text.' },
      freeze_header: { type: 'boolean', description: 'Keep the header row visible while scrolling.' },
    }, required: ['name', 'rows'] } },
  }, required: ['schema_version', 'path', 'sheets'] },
} };
