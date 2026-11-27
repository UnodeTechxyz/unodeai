import * as path from 'node:path';

export const BUILD_OFFICE_TOOL = 'build_office';
export type ManagedOfficeFormat = 'docx' | 'pptx';
export interface ManagedOutput { name: string; path: string; format: ManagedOfficeFormat }
export interface ManagedOfficeRun { operation: 'run'; program_ref: string; input_snapshot_refs: string[]; asset_refs: string[]; outputs: ManagedOutput[] }
export type ManagedOfficeRequest = ManagedOfficeRun | { operation: 'prepare'; draft: string; source: string; final: boolean };
export function managedOfficeRequest(value: Record<string, unknown>): ManagedOfficeRequest {
  const fail = (): never => { throw new Error('invalid-managed-office-request'); };
  const keys = (allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
  if (value.operation === 'prepare') {
    if (!keys(['operation', 'draft', 'source', 'final']) || typeof value.draft !== 'string' || !value.draft.trim()
      || typeof value.source !== 'string' || (value.final !== undefined && typeof value.final !== 'boolean')) return fail();
    return { operation: 'prepare', draft: value.draft, source: value.source, final: value.final === true };
  }
  if (value.operation !== 'run' || !keys(['operation', 'format', 'program_ref', 'input_snapshot_refs', 'asset_refs', 'outputs'])
    || (value.format !== undefined && !['docx', 'pptx'].includes(String(value.format)))
    || typeof value.program_ref !== 'string' || !/^program-[0-9a-f]{32}$/.test(value.program_ref)
    || !Array.isArray(value.outputs) || value.outputs.length === 0) return fail();
  const refs = (items: unknown, pattern: RegExp): string[] => {
    if (items === undefined) return [];
    if (!Array.isArray(items) || items.some(item => typeof item !== 'string' || !pattern.test(item)) || new Set(items).size !== items.length) return fail();
    return items;
  };
  const outputs: ManagedOutput[] = value.outputs.map(output => {
    const format = output?.format ?? value.format;
    if (!output || typeof output !== 'object' || Array.isArray(output)
      || Object.keys(output).some(key => !['name', 'path', 'format'].includes(key))
      || typeof output.name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(output.name)
      || typeof output.path !== 'string' || !output.path || output.path.includes('\0')
      || !['docx', 'pptx'].includes(format) || path.extname(output.path).toLowerCase() !== '.' + format) return fail();
    return { name: output.name, path: output.path, format };
  });
  if (new Set(outputs.map(output => output.name)).size !== outputs.length
    || new Set(outputs.map(output => output.path)).size !== outputs.length) return fail();
  return { operation: 'run', program_ref: value.program_ref,
    input_snapshot_refs: refs(value.input_snapshot_refs, /^(?:office|workbook)-[a-zA-Z0-9-]+$/),
    asset_refs: refs(value.asset_refs, /^content-[1-9]\d*$/), outputs };
}

export const BUILD_OFFICE_SPEC = { type: 'function' as const, function: {
  name: BUILD_OFFICE_TOOL,
  description: 'Generate advanced editable Word/PowerPoint files with model-written JavaScript under ordinary Commands authority. '
    + 'First prepare source parts using operation=prepare, draft, source and final=true on the last part; the host returns a fixed-hash program_ref. '
    + 'Then operation=run with that program_ref, format, input_snapshot_refs, asset_refs and declared outputs. Each output may override the common format. '
    + 'Inputs may be this request’s inspect_office or read_workbook snapshots; those references supply current read authority, never another agent’s files. '
    + 'Source is CommonJS: module.exports = async ctx => { ... }. require("docx") and require("pptxgenjs") resolve fixed bundled libraries. '
    + 'ctx.outputs maps declared names to staged paths; ctx.inputs and ctx.assets map supplied refs to copied paths. Use fs to write only the desired outputs. '
    + 'This is ordinary JavaScript with the user account authority, not an OS sandbox; other script effects are not verified or restored. '
    + 'Only checked declared staged outputs saved by the host receive file receipts. Built-in write_document/write_presentation work without Commands. '
    + 'Prepare writes only a private draft. Running uses current command policy, folder access and Stop; it adds no separate trusted-Skill approval.',
  parameters: { type: 'object', additionalProperties: false, properties: {
    operation: { type: 'string', enum: ['prepare', 'run'] }, format: { type: 'string', enum: ['docx', 'pptx'] }, draft: { type: 'string' }, source: { type: 'string' }, final: { type: 'boolean' },
    program_ref: { type: 'string' }, input_snapshot_refs: { type: 'array', items: { type: 'string' } },
    asset_refs: { type: 'array', items: { type: 'string' } }, outputs: { type: 'array', minItems: 1, items: {
      type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, path: { type: 'string' }, format: { type: 'string', enum: ['docx', 'pptx'] } },
      required: ['name', 'path'],
    } },
  }, required: ['operation'] },
} };
