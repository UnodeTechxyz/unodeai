export const RENDER_OFFICE_TOOL = 'render_office';
export const INSPECT_OFFICE_OPERATION_TOOL = 'inspect_operation';
export const STOP_OFFICE_OPERATION_TOOL = 'stop_operation';
export const OFFICE_RENDER_SPECS = [
  { type: 'function' as const, function: {
    name: RENDER_OFFICE_TOOL,
    description: 'Render the exact DOCX/PPTX snapshot returned by inspect_office using installed Word, PowerPoint or LibreOffice on Windows. Specify auto to use the workspace renderer preference, or word, powerpoint or libreoffice explicitly. Automatic PowerPoint skips an already-running application. LibreOffice uses a fresh private profile and fixed input/PDF filters; it never changes the user profile. Nothing is installed automatically. The original is unchanged; a private passive copy removes active/external content and reports its differences. Commands, trust, source access and current native-child network restrictions apply. Normal generation does not require rendering. After 120 seconds the same operation continues in the background; inspect_operation queries it without rerunning. Native stages have a five-minute limit that fails the render. UnodeAi never force-ends Word or PowerPoint: the helper closes its own copy and quits only its own empty private instance; LibreOffice ends only its own private-profile conversion. After Stop or the limit, native_stop reports separately whether the application closed, was left running or is still closing. Captured pages, delivery to a model and independent visual review are separate facts. Native Office/private profiles are not an OS/network sandbox.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      snapshot_ref: { type: 'string', description: 'Exact snapshot_ref returned by inspect_office on this DOCX/PPTX in this agent context. Call inspect_office first; never construct a ref from a file hash, read_workbook or transform_workbook result.' }, adapter_id: { type: 'string', enum: ['auto', 'word', 'powerpoint', 'libreoffice'], description: 'auto follows the user renderer preference and installed candidates; explicit names select that app for this request. Application detection is not operation qualification.' },
      pages: { type: 'object', additionalProperties: false, properties: { start: { type: 'integer', minimum: 1 }, end: { type: 'integer', minimum: 1 } }, required: ['start', 'end'], description: 'Inclusive original page/slide ordinals to retain for delivery; omit for all. Native capture can still process other pages.' },
    }, required: ['snapshot_ref', 'adapter_id'] },
  } },
  { type: 'function' as const, function: {
    name: INSPECT_OFFICE_OPERATION_TOOL,
    description: 'Query this agent’s existing Office render operation; never starts another render. wait=true waits up to 120 seconds for the same operation. Captured page assets are not proof a model viewed them.',
    parameters: { type: 'object', additionalProperties: false, properties: { operation_id: { type: 'string' }, wait: { type: 'boolean' }, cursor: { type: 'string', description: 'Opaque next_cursor for the next image-asset batch of this operation; no rerender.' } }, required: ['operation_id'] },
  } },
  { type: 'function' as const, function: {
    name: STOP_OFFICE_OPERATION_TOOL,
    description: 'Stop this agent’s existing render operation at once; none of its later output is used. UnodeAi never force-ends Word or PowerPoint: the helper closes only its own copy at its next checkpoint and quits only its own empty private instance; LibreOffice ends only its own private-profile conversion. native_stop reports separately whether the application closed, was left running or is still closing; other documents are never closed or killed.',
    parameters: { type: 'object', additionalProperties: false, properties: { operation_id: { type: 'string' } }, required: ['operation_id'] },
  } },
];
