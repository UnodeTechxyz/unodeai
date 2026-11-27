import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { wordPdfConvertProposal } from '../WordPdfConvertPlatform';
import { WINDOWS_WORD_PDF_CONVERT_SCRIPT } from '../../WindowsWordPdfScript';
import { encodePowerShellScript } from '../../../host/windowsPowerShell';

const root = path.win32.join(path.win32.parse(process.cwd()).root || '\\', 'SystemRootFixture');

it('proposes the fixed Word helper through the system Windows PowerShell, with its script identity', () => {
  const proposal = wordPdfConvertProposal('win32', { SystemRoot: root }, file => file);
  if ('unavailable' in proposal) throw Error('expected a proposal');
  expect(proposal.executable).toBe(path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  expect(proposal.command.startsWith('& "' + proposal.executable + '" ')).toBe(true);
  expect(proposal.command.endsWith(' ' + encodePowerShellScript(WINDOWS_WORD_PDF_CONVERT_SCRIPT))).toBe(true);
  expect(proposal.scriptSha256).toBe(createHash('sha256').update(WINDOWS_WORD_PDF_CONVERT_SCRIPT).digest('hex'));
});

it('has no proposal on other platforms, or without a resolvable system PowerShell', () => {
  expect(wordPdfConvertProposal('linux', { SystemRoot: root }, file => file)).toEqual({ unavailable: 'platform-unsupported' });
  expect(wordPdfConvertProposal('darwin', { SystemRoot: root }, file => file)).toEqual({ unavailable: 'platform-unsupported' });
  expect(wordPdfConvertProposal('win32', {}, file => file)).toEqual({ unavailable: 'powershell-unavailable' });
  expect(wordPdfConvertProposal('win32', { SystemRoot: root }, () => { throw Error('missing'); })).toEqual({ unavailable: 'powershell-unavailable' });
});
