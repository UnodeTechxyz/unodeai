export const READ_WORKBOOK_TOOL = 'read_workbook';
export const READ_WORKBOOK_SPEC = { type: 'function' as const, returnsExternalContent: true as const, function: {
  name: READ_WORKBOOK_TOOL,
  description: 'Read CSV or XLSX without changing the source or running commands. CSV fields stay literal strings. Inspect reports source metadata, sheets and byte hash. '
    + 'Range reads use A1 coordinates and opaque continuation cursors, bound to unchanged source bytes and parse settings. '
    + 'Supply exactly one of path or source_ref on every read. snapshot_ref is returned evidence for transform_workbook sources[].snapshot_ref; it is not a read_workbook input. '
    + 'Long cells are delivered in byte-identified fragments; whole_value is true only for a complete value in one fragment. '
    + 'Prepared fragments do not by themselves prove model delivery or full displayed coverage. Keep reading next_cursor until null. '
    + 'No formulas execute and numeric-looking fields stay exact text. Nonstandard spaces after closing quotes are accepted and omitted from field values. '
    + 'XLSX returns typed stored values and saved formula caches, never recalculates formulas or refreshes external links/macros. Dates retain raw serials and epoch; serial 60 is identified. '
    + 'XLSX default visibility all includes hidden data; visible-only uses saved row/column hidden state, not a recomputed filter. '
    + 'Inspect may page workbook/sheet records. XLSX oversized records use JSON-UTF8 fragments that must be reassembled before interpreting typed values. '
    + 'Absent/merged rectangles avoid inventing values. This is selected package parsing, not full schema validation or native display verification.',
  parameters: { type: 'object', additionalProperties: false, properties: {
    path: { type: 'string', description: 'Current authorized file path, relative to the working folder/read root or absolute within granted file access.' },
    source_ref: { type: 'string', description: 'Original-byte user attachment id currently granted to this agent. Supply exactly one of path/source_ref and keep it for continuation.' },
    operation: { type: 'string', enum: ['inspect', 'range'], description: 'Defaults to inspect. Range returns typed cell fragments.' },
    sheet_id: { type: 'string', description: 'Sheet identifier from inspect. CSV uses csv:1; XLSX defaults to the first readable worksheet in workbook order.' },
    visibility: { type: 'string', enum: ['all', 'visible-only'], description: 'XLSX saved hidden row/column state; all by default. CSV supports all.' },
    range: { type: 'string', description: 'A1 or A1:C20; omitted reads the observed rectangular extent, including absent fields.' },
    cursor: { type: 'string', description: 'Opaque next_cursor from the previous response. Use the same path; omit range/parse settings to inherit them.' },
    encoding: { type: 'string', enum: ['utf-8', 'utf-16le', 'utf-16be', 'gb18030'], description: 'Strict UTF-8 by default (BOM recognized). Other encodings require explicit selection.' },
    delimiter: { type: 'string', description: 'Explicit delimiter; otherwise detected and reported. Duplicate and empty headers are kept as ordinary fields.' },
  } },
} };
