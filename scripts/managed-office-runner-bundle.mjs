import assert from 'node:assert/strict';
import { isBuiltin } from 'node:module';
export const MANAGED_OFFICE_RUNNER_ENTRY = 'src/office/DocumentRunner.ts';
export function assertManagedOfficeRunnerBundleGraph(metafile) {
  const outputs = Object.values(metafile.outputs).filter(output => output.entryPoint?.replaceAll('\\', '/').endsWith(MANAGED_OFFICE_RUNNER_ENTRY));
  assert.equal(outputs.length, 1, 'Managed Office requires exactly one fixed runner entry');
  const inputs = Object.keys(outputs[0].inputs).map(input => input.replaceAll('\\', '/'));
  for (const name of ['docx', 'pptxgenjs']) assert(inputs.some(input => input.includes('/' + name + '/')), 'Managed Office must bundle its fixed ' + name + ' dependency');
  assert(!inputs.some(input => /(^|\/)skills\//.test(input)), 'Skill source must never become managed runner code');
  for (const imported of outputs[0].imports) assert(!imported.external || isBuiltin(imported.path), 'Managed Office must bundle runtime libraries');
}
