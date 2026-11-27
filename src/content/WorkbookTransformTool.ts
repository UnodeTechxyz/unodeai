export const TRANSFORM_WORKBOOK_TOOL = 'transform_workbook';
const text = { type: 'string' };
export const TRANSFORM_WORKBOOK_SPEC = { type: 'function' as const, returnsExternalContent: true as const, function: {
  name: TRANSFORM_WORKBOOK_TOOL,
  description: 'Compute from host-held read_workbook snapshot_ref values using named steps, without commands, source writes, formula execution or external refresh. '
    + 'Use operation compute with sources, steps and optional output step id; read pages with operation read plus returned data_ref or next_cursor. '
    + 'Sources must have been read in the current request; re-read the named source to acquire a current request snapshot if needed. '
    + 'Source columns use A/B/C identifiers within the selected A1 range; select can rename them and explicitly parse string numbers with as_number. No locale guessing. '
    + 'group is a logical grouping for aggregate; select preserves only selected grouping fields. Predicates use typed comparisons; strings use UTF-16 lexical order. '
    + 'Every step has id, input, operation. Additional fields by operation: select: columns; filter: predicate, optional missing; group: by ONLY (no fields); aggregate: fields, optional missing; unit-convert: column, optional as, factor, optional offset, from_unit, to_unit. '
    + 'Grouping does not sum: follow group with a separate aggregate step. Header names are not automatic source column aliases. '
    + 'Example for CSV with Region in A and Sales in B, header in row 1: {"sources":[{"name":"sales","snapshot_ref":"RETURNED_REF","range":"A2:B4"}],"steps":[{"id":"named","input":"sales","operation":"select","columns":[{"column":"A","as":"Region"},{"column":"B","as":"Sales","as_number":true}]},{"id":"regions","input":"named","operation":"group","by":["Region"]},{"id":"totals","input":"regions","operation":"aggregate","fields":[{"field":"Sales","operation":"sum","as":"TotalSales"}]}],"output":"totals"}. '
    + 'Missing/errors propagate by default. Explicit exclude-with-counts records partial coverage. An unresolved filter propagates to later aggregates. '
    + 'Merged covered cells are structural and not counted twice; grouping uses their actual same-snapshot anchor label, with saved hidden restrictions preserved. '
    + 'Hidden rows/columns are included by default; visible-only uses saved state only. Select data rows explicitly when the source has a header row. '
    + 'Numeric results are exact numerator/denominator strings. Unit factors/offsets and unit names are explicit declared parameters. '
    + 'Results are host computations, not model-supplied totals or proof of model delivery. Table-cell records have firstRow/field/repeat for identical logical row runs. '
    + 'Reassemble any json-utf8 record fragments before interpreting them; continue next_cursor until null. Data refs remain scoped to this agent and live source read authority.',
  parameters: { type: 'object', additionalProperties: false, properties: {
    operation: { type: 'string', enum: ['compute', 'read'], description: 'Defaults to compute.' },
    sources: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      name: text, snapshot_ref: text, sheet_id: text, range: text, visibility: { type: 'string', enum: ['all', 'visible-only'] },
    }, required: ['name', 'snapshot_ref'] } },
    steps: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      id: text, input: { type: 'string', description: 'A source name or earlier step id.' },
      operation: { type: 'string', enum: ['select', 'filter', 'group', 'aggregate', 'unit-convert'] },
      columns: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { column: text, as: text, as_number: { type: 'boolean' } }, required: ['column'] } },
      by: { type: 'array', items: text, description: 'group only. Source column letters or fields from the input step; does not aggregate.' },
      fields: { type: 'array', description: 'aggregate only; never put fields on a group step.', items: { type: 'object', additionalProperties: false, properties: {
        operation: { type: 'string', enum: ['sum', 'count', 'min', 'max', 'average'] }, field: text, as: text,
      }, required: ['operation', 'as'] } },
      predicate: { type: 'object', additionalProperties: false, properties: {
        column: text, operator: { type: 'string', enum: ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'is-missing', 'is-error'] },
        value: { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', enum: ['number', 'string', 'boolean'] }, value: { type: ['string', 'boolean'] } }, required: ['kind', 'value'] },
      }, required: ['column', 'operator'] },
      missing: { type: 'string', enum: ['propagate', 'exclude-with-counts'] }, column: text, as: text, factor: text, offset: text, from_unit: text, to_unit: text,
    }, required: ['id', 'input', 'operation'] } },
    output: { type: 'string', description: 'Output source/step id; defaults to the last step. Only its dependency chain is executed.' },
    transformation_ref: text, data_ref: text, cursor: text,
  } },
} };
