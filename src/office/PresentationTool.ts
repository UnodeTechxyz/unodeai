export const WRITE_PRESENTATION_TOOL = 'write_presentation';
const box = { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number', exclusiveMinimum: 0 }, h: { type: 'number', exclusiveMinimum: 0 } };
const position = ['x', 'y', 'w', 'h'];
const color = { type: 'string', pattern: '^#?[a-fA-F0-9]{6}$' };
const object = (type: string, properties: Record<string, unknown>, required: string[]) => ({ type: 'object', additionalProperties: false,
  properties: { type: { type: 'string', enum: [type] }, ...box, ...properties }, required: ['type', ...position, ...required] });

export const WRITE_PRESENTATION_SPEC = { type: 'function' as const, function: {
  name: WRITE_PRESENTATION_TOOL,
  description: 'Create an editable .pptx presentation with text, tables, native charts, simple shapes and current static PNG or standard 8-bit JPEG image assets. JPEG orientation is normalized into a lossless PNG rendition; source bytes stay unchanged and both hashes are recorded. Image boxes contain the full image at its displayed aspect ratio. Positions are in inches. '
    + 'For one complete deck omit draft; final may be omitted, true or false and the complete deck is written normally. '
    + 'Only use a named draft for parts: first append slides with final:false or omitted, then final:true saves all held slides plus the final call. Invalid input does not establish a held draft. If no draft was held, resend the complete deck without draft. '
    + 'Bar/line series in one chart share identical ordered labels; a pie object has one series (use separate objects for several pies). '
    + 'A chart may use data_from {transformation_ref,label_field,value_fields,rows?:{first,last}}. The host fills actual source values and compares any supplied series. Missing, nonnumeric and overflowing values are blank points. Binary Number precision loss is partial, with exact source values retained as JSON text in slide notes. Data checks read both chart caches and embedded editable workbooks. '
    + 'A table may use data_from from this agent’s transform_workbook: select fields and optional one-based output rows. The host fills a header plus actual exact values, compares any supplied rows, and checks cells in the generated PPTX. Missing/error markers and partial results remain unverified. '
    + 'Use write permission; Commands may stay Off. The host applies the same destination, approval and restore-point rules as other file writes. '
    + 'Only the returned saved-file receipt proves delivery. Page rendering and independent visual review are separate checks.',
  parameters: { type: 'object', additionalProperties: false, properties: {
    schema_version: { type: 'integer', enum: [1] }, path: { type: 'string' },
    draft: { type: 'string', description: 'For a long deck send parts with the same draft name. Each call adds its slides on this machine; no workspace file is written until final: true.' },
    final: { type: 'boolean', description: 'With an already held draft name, final:true assembles accepted parts plus this call’s slides (may be empty). The final call’s path, title and layout apply. Retry with no new slides only when the failure reports that parts were kept. If there is no held draft, send the complete deck without draft. Without draft a boolean final does not change one-shot writing.' },
    deck: { type: 'object', additionalProperties: false, properties: {
      title: { type: 'string' }, layout: { type: 'string', enum: ['wide', 'standard'] },
      slides: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        notes: { type: 'string' }, objects: { type: 'array', items: { anyOf: [
          object('text', { text: { type: 'string' }, fontSize: { type: 'number', exclusiveMinimum: 0 }, bold: { type: 'boolean' }, color }, ['text']),
          object('table', { rows: { type: 'array', minItems: 1, items: { type: 'array', minItems: 1, items: { anyOf: [{ type: 'string' }, { type: 'number' }] } } },
            data_from: { type: 'object', additionalProperties: false, properties: { transformation_ref: { type: 'string' },
              fields: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' } },
              rows: { type: 'object', additionalProperties: false, properties: { first: { type: 'integer', minimum: 1 }, last: { type: 'integer', minimum: 1 } }, required: ['first', 'last'] },
            }, required: ['transformation_ref', 'fields'] },
            fontSize: { type: 'number', exclusiveMinimum: 0 } }, []),
          object('chart', { chartType: { type: 'string', enum: ['bar', 'line', 'pie'] },
            data_from: { type: 'object', additionalProperties: false, properties: { transformation_ref: { type: 'string' }, label_field: { type: 'string', minLength: 1 },
              value_fields: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
              rows: { type: 'object', additionalProperties: false, properties: { first: { type: 'integer', minimum: 1 }, last: { type: 'integer', minimum: 1 } }, required: ['first', 'last'] },
            }, required: ['transformation_ref', 'label_field', 'value_fields'] }, series: { type: 'array', minItems: 1,
            items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' },
              labels: { type: 'array', minItems: 1, items: { type: 'string' } }, values: { type: 'array', minItems: 1, items: { type: 'number' } } },
            required: ['name', 'labels', 'values'] } } }, ['chartType']),
          object('shape', { shape: { type: 'string', enum: ['rect', 'ellipse'] }, fill: color, line: color }, ['shape']),
          object('image', { asset_ref: { type: 'string', description: 'Current authorized content-N static PNG or standard 8-bit JPEG image asset. No URL, base64 or file path.' }, altText: { type: 'string' } }, ['asset_ref']),
        ] } },
      }, required: ['objects'] } },
    }, required: ['slides'] },
  }, required: ['schema_version', 'path', 'deck'] },
} };

export function isPresentationDraftPart(args: unknown): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const call = args as Record<string, unknown>;
  return typeof call.draft === 'string' && call.draft.trim().length > 0 && (call.final === undefined || call.final === false);
}
