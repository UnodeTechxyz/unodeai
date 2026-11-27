import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { compileFunction } from 'node:vm';
import * as docx from 'docx';
import PptxGenJS from 'pptxgenjs';

export interface DocumentRunnerContext { outputs: Record<string, string>; inputs: Record<string, string>; assets: Record<string, string> }
/** This wrapper provides pinned libraries and a contract, never an OS/JavaScript sandbox. */
export async function executeDocumentProgram(file: string, digest: string, context: DocumentRunnerContext): Promise<void> {
  const bytes = await readFile(file);
  if (!/^[0-9a-f]{64}$/.test(digest) || createHash('sha256').update(bytes).digest('hex') !== digest) throw Error('program-changed');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const hostRequire = createRequire(__filename);
  const require = (id: string) => id === 'docx' ? docx : id === 'pptxgenjs' ? PptxGenJS : hostRequire(id);
  const module: { exports: unknown } = { exports: {} };
  const initialize = compileFunction(source, ['exports', 'require', 'module', '__filename', '__dirname'], { filename: file });
  initialize(module.exports, require, module, file, dirname(file));
  if (typeof module.exports !== 'function') throw Error('program-must-export-function');
  await module.exports(context);
}

if (process.send && process.argv[4] !== '--context') {
  process.once('message', async context => {
    try {
      if (!context || typeof context !== 'object') throw Error('invalid-context');
      await executeDocumentProgram(process.argv[2], process.argv[3], context as DocumentRunnerContext);
      process.exitCode = 0;
    } catch (error) {
      const kind = error instanceof SyntaxError ? 'syntax' : error instanceof TypeError ? 'type' : 'runtime';
      process.send?.({ type: 'unode-office-runner-error', kind }); process.exitCode = 1;
    }
    finally { process.disconnect?.(); }
  });
} else if (process.argv[4] === '--context') {
  void (async () => {
    const bytes = await readFile(process.argv[5]);
    if (!/^[0-9a-f]{64}$/.test(process.argv[6] ?? '') || createHash('sha256').update(bytes).digest('hex') !== process.argv[6]) throw Error('context-changed');
    const context = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!context || typeof context !== 'object' || Object.keys(context).sort().join(',') !== 'assets,inputs,outputs'
      || Object.values(context).some(value => !value || typeof value !== 'object' || Array.isArray(value)
        || Object.values(value).some(file => typeof file !== 'string'))) throw Error('invalid-context');
    await executeDocumentProgram(process.argv[2], process.argv[3], context);
  })().catch(() => { process.exitCode = 1; });
}
