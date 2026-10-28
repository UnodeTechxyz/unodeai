import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  AUTHENTICODE_BATCH_MAX_FILES,
  AUTHENTICODE_ENCODED_COMMAND,
  AUTHENTICODE_MAX_INPUT_CHARS,
  AUTHENTICODE_OFFLINE_TEXT,
  AUTHENTICODE_SCRIPT,
  AUTHENTICODE_UNAVAILABLE_TEXT,
  checkAuthenticodeSignatures,
  crtCatalogIntermediateMayHaveExpired,
  judgeAuthenticodeFile,
  parseAuthenticodeAnswer,
  readCertificateSubject,
  type AuthenticodeCheckResult,
  type AuthenticodeFile,
  type AuthenticodeRawChain,
  type AuthenticodeRawResult,
  type AuthenticodeSigners,
} from '../windowsAuthenticode';
import type { WindowsPowerShellRequest, WindowsPowerShellRunResult } from '../windowsPowerShell';

/*
 * The publisher-signature check of managed and adopted CLI packages. Windows reports; this module decides, and only the
 * forms listed in its acceptance rule pass. Every test feeds the answer PowerShell would print, so none needs Windows;
 * the real-host run is in windowsAuthenticode.realHost.test.ts.
 */

// ---------------------------------------------------------------------------------------------
// The pinned publishers (the policy's signers, as read from the Codex 0.163.0 package)
// ---------------------------------------------------------------------------------------------

const OPENAI_ROOT = 'F40042E2E5F7E8EF8189FED15519AECE42C3BFA2';
const CRT_CATALOG_ROOT = '3B1EFD3A66EA28B16697394703A72CA340A05BD5';
const CRT_EMBEDDED_ROOT = '8F43288AD272F3103B6FB1428485EA3014C0BCFE';
const INTERMEDIATE_A = '4C07413E5DA89A259A127E1D76F792AF239CD9D9';
const INTERMEDIATE_B = '8E750F459DAF9A79D6370DB747AD2226866AD818';

type Rdns = Array<[string, string]>;
const OPENAI_RDNS: Rdns = [['2.5.4.6', 'US'], ['2.5.4.8', 'California'], ['2.5.4.7', 'San Francisco'], ['2.5.4.10', 'OpenAI OpCo, LLC'], ['2.5.4.3', 'OpenAI OpCo, LLC']];
const CRT_CATALOG_RDNS: Rdns = [['2.5.4.6', 'US'], ['2.5.4.8', 'Washington'], ['2.5.4.7', 'Redmond'], ['2.5.4.10', 'Microsoft Corporation'], ['2.5.4.3', 'Microsoft Windows']];
const CRT_EMBEDDED_RDNS: Rdns = [['2.5.4.6', 'US'], ['2.5.4.8', 'Washington'], ['2.5.4.7', 'Redmond'], ['2.5.4.10', 'Microsoft Corporation'], ['2.5.4.3', 'Microsoft Windows Software Compatibility Publisher']];

const SIGNERS: AuthenticodeSigners = {
  openai: { accepted: [{ signatureType: 'Authenticode', subjectRdns: OPENAI_RDNS, rootThumbprint: OPENAI_ROOT }] },
  'microsoft-crt': {
    accepted: [
      { signatureType: 'Catalog', subjectRdns: CRT_CATALOG_RDNS, rootThumbprint: CRT_CATALOG_ROOT },
      { signatureType: 'Authenticode', subjectRdns: CRT_EMBEDDED_RDNS, rootThumbprint: CRT_EMBEDDED_ROOT },
    ],
  },
};

/** The three real leaf certificates (public data), read statically from the package's files. */
const LEAVES = (JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'authenticode-leaves.json'), 'utf8')) as {
  leaves: Array<{ name: string; thumbprint: string; der: string }>;
}).leaves;
const OPENAI_LEAF = Buffer.from(LEAVES[0].der, 'base64');
const CRT_CATALOG_LEAF = Buffer.from(LEAVES[1].der, 'base64');
const CRT_EMBEDDED_LEAF = Buffer.from(LEAVES[2].der, 'base64');

// ---------------------------------------------------------------------------------------------
// Synthetic DER
// ---------------------------------------------------------------------------------------------

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}
function oid(text: string): Buffer {
  const arcs = text.split('.').map(Number);
  const out = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const encoded = [arc & 0x7f];
    for (let rest = arc >> 7; rest > 0; rest >>= 7) encoded.unshift(0x80 | (rest & 0x7f));
    out.push(...encoded);
  }
  return tlv(0x06, Buffer.from(out));
}
const PRINTABLE = 0x13;
const UTF8 = 0x0c;
const BMP = 0x1e;
function stringValue(tag: number, value: string): Buffer {
  if (tag === BMP) return tlv(tag, Buffer.from(value, 'utf16le').swap16());
  return tlv(tag, Buffer.from(value, tag === UTF8 ? 'utf8' : 'latin1'));
}
type Attribute = [string, string, number?];
const rdn = (...attributes: Attribute[]) =>
  tlv(0x31, ...attributes.map(([type, value, tag = PRINTABLE]) => tlv(0x30, oid(type), stringValue(tag, value))));
const rdnsOf = (pairs: Rdns, tag = PRINTABLE) => pairs.map(([type, value]) => rdn([type, value, tag]));

function certificate(subject: Buffer[], options: { version?: boolean } = {}): Buffer {
  const algorithm = tlv(0x30, oid('1.2.840.113549.1.1.11'), tlv(0x05));
  const tbs = tlv(0x30,
    ...(options.version === false ? [] : [tlv(0xa0, tlv(0x02, Buffer.from([2])))]),
    tlv(0x02, Buffer.from([0x33, 0x01])),
    algorithm,
    tlv(0x30, rdn(['2.5.4.3', 'Test Issuing CA'])),
    tlv(0x30, tlv(0x17, Buffer.from('261013000000Z')), tlv(0x17, Buffer.from('261016000000Z'))),
    tlv(0x30, ...subject),
    tlv(0x30, tlv(0x30, oid('1.2.840.113549.1.1.1'), tlv(0x05)), tlv(0x03, Buffer.from([0x00, 0x30, 0x00]))),
  );
  return tlv(0x30, tbs, algorithm, tlv(0x03, Buffer.from([0x00, 0xab, 0xcd])));
}

// ---------------------------------------------------------------------------------------------
// Answers as PowerShell prints them
// ---------------------------------------------------------------------------------------------

const thumbprintOf = (der: Buffer) => createHash('sha1').update(der).digest('hex').toUpperCase();

function signed(i: number, der: Buffer, overrides: Partial<AuthenticodeRawResult> = {}): AuthenticodeRawResult {
  return { i, status: 'Valid', type: 'Authenticode', leaf: thumbprintOf(der), leafDer: der.toString('base64'), timestamped: true, ...overrides };
}
function unsignedResult(i: number, overrides: Partial<AuthenticodeRawResult> = {}): AuthenticodeRawResult {
  return { i, status: 'NotSigned', type: 'None', leaf: null, leafDer: null, timestamped: false, ...overrides };
}
/**
 * A chain from `der` to `root` through `intermediates`, each element with the statuses given (leaf first). The
 * chain's own status list is every element status once, as .NET reports it, unless `chainStatus` says otherwise.
 */
function chainOf(
  der: Buffer,
  root: string,
  statuses: string[][] = [],
  options: { built?: boolean; intermediates?: string[]; chainStatus?: string[] } = {},
): AuthenticodeRawChain {
  const thumbs = [thumbprintOf(der), ...(options.intermediates ?? [INTERMEDIATE_A, INTERMEDIATE_B]), root];
  const elements = thumbs.map((thumb, k) => ({ thumb, status: statuses[k] ?? [] }));
  return { built: options.built ?? true, status: options.chainStatus ?? [...new Set(elements.flatMap((element) => element.status))], elements };
}

function answerText(results: AuthenticodeRawResult[], chains: Record<string, AuthenticodeRawChain>, extra: Record<string, unknown> = {}): string {
  return `UNODE-AC1:${Buffer.from(JSON.stringify({ v: 1, results, chains, ...extra }), 'utf8').toString('base64')}\r\n`;
}
function exited(stdout: string, code = 0, stderr = ''): WindowsPowerShellRunResult {
  return { status: 'exited', code, signal: null, stdout, stderr };
}

/** Judge one file the way the check does, from one result and its chain. */
function judge(file: AuthenticodeFile, result: AuthenticodeRawResult, chain?: AuthenticodeRawChain, signers = SIGNERS) {
  return judgeAuthenticodeFile(file, result, chain, signers);
}
const openaiFile: AuthenticodeFile = { path: 'C:\\pkg\\bin\\codex.exe', signer: 'openai' };
const crtFile: AuthenticodeFile = { path: 'C:\\pkg\\codex-resources\\voice\\bin\\vcruntime140.dll', signer: 'microsoft-crt' };
const rgFile: AuthenticodeFile = { path: 'C:\\pkg\\codex-path\\rg.exe', signer: 'unsigned' };
const openaiValid = () => judge(openaiFile, signed(0, OPENAI_LEAF), chainOf(OPENAI_LEAF, OPENAI_ROOT, [['NotTimeValid']]));

// ---------------------------------------------------------------------------------------------
// A fake runner for whole checks
// ---------------------------------------------------------------------------------------------

type Respond = (paths: string[], run: number) => WindowsPowerShellRunResult;

function fakeRunner(respond: Respond) {
  const requests: WindowsPowerShellRequest[] = [];
  const runPowerShell = async (request: WindowsPowerShellRequest) => {
    requests.push(request);
    const input = JSON.parse(Buffer.from(request.input, 'base64').toString('utf8')) as { v: number; files: string[] };
    return respond(input.files, requests.length - 1);
  };
  const inputs = () => requests.map((request) => (JSON.parse(Buffer.from(request.input, 'base64').toString('utf8')) as { files: string[] }).files);
  return { runPowerShell, requests, inputs };
}

/** Every file answers as a well-signed member of its signer (the Codex package's real leaves). */
function honestAnswer(files: AuthenticodeFile[]): Respond {
  return (paths) => {
    const results: AuthenticodeRawResult[] = [];
    const chains: Record<string, AuthenticodeRawChain> = {};
    paths.forEach((sentPath, i) => {
      const file = files.find((candidate) => candidate.path === sentPath);
      if (file?.signer === 'unsigned') {
        results.push(unsignedResult(i));
      } else if (file?.signer === 'microsoft-crt') {
        results.push(signed(i, CRT_CATALOG_LEAF, { type: 'Catalog' }));
        chains[thumbprintOf(CRT_CATALOG_LEAF)] = chainOf(CRT_CATALOG_LEAF, CRT_CATALOG_ROOT, [['NotTimeValid']], { intermediates: [INTERMEDIATE_A] });
      } else {
        results.push(signed(i, OPENAI_LEAF));
        chains[thumbprintOf(OPENAI_LEAF)] = chainOf(OPENAI_LEAF, OPENAI_ROOT, [['NotTimeValid']]);
      }
    });
    return exited(answerText(results, chains));
  };
}

function check(files: AuthenticodeFile[], respond: Respond) {
  const runner = fakeRunner(respond);
  const result = checkAuthenticodeSignatures(
    { files, signers: SIGNERS, ownedFolder: 'C:\\owned\\work', ownedTmp: 'C:\\owned\\work\\tmp', workspaceRoots: ['C:\\repo'] },
    { runPowerShell: runner.runPowerShell },
  );
  return { result, runner };
}

/** The 32 PE files of the Codex 0.163.0 package: 30 OpenAI, the CRT, and rg.exe without a signature. */
function codexPackage(): AuthenticodeFile[] {
  const files: AuthenticodeFile[] = [];
  for (let k = 0; k < 30; k += 1) files.push({ path: `C:\\pkg\\codex-resources\\voice\\bin\\lib${k}.dll`, signer: 'openai' });
  files.push(crtFile, rgFile, { path: 'C:\\pkg\\codex-package.json', signer: 'none' });
  return files;
}

// =============================================================================================
// The fixed script
// =============================================================================================

describe('the fixed Authenticode script', () => {
  it('is pinned by the SHA-256 of the encoded command, which is exactly what PowerShell receives', () => {
    expect(createHash('sha256').update(AUTHENTICODE_ENCODED_COMMAND).digest('hex'))
      .toBe('4cc61ea6b4923c909d79af5f26415581d138207815f0273b7c7b9f9b9478ae64');
    expect(Buffer.from(AUTHENTICODE_ENCODED_COMMAND, 'base64').toString('utf16le')).toBe(AUTHENTICODE_SCRIPT);
  });

  it('checks the language mode before anything else, and calls the cmdlet module-qualified', () => {
    const lines = AUTHENTICODE_SCRIPT.split('\n');
    expect(lines[1]).toBe("if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { 'UNODE-AC1:CLM'; exit 3 }");
    expect(AUTHENTICODE_SCRIPT).toContain('Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath');
  });

  it('records built, each element\'s own statuses leaf first, and the leaf\'s DER, and builds online without the root, 15 s, ignoring time validity', () => {
    expect(AUTHENTICODE_SCRIPT).toContain('$built = $ch.Build($c)');
    expect(AUTHENTICODE_SCRIPT).toContain('built = [bool]$built');
    expect(AUTHENTICODE_SCRIPT).toContain('foreach ($e in $ch.ChainElements)');
    expect(AUTHENTICODE_SCRIPT).toContain('foreach ($t in $e.ChainElementStatus)');
    expect(AUTHENTICODE_SCRIPT).toContain('$r.leafDer = [Convert]::ToBase64String($c.RawData)');
    expect(AUTHENTICODE_SCRIPT).not.toContain('.Subject');
    expect(AUTHENTICODE_SCRIPT).toContain("$ch.ChainPolicy.RevocationMode = 'Online'");
    expect(AUTHENTICODE_SCRIPT).toContain("$ch.ChainPolicy.RevocationFlag = 'ExcludeRoot'");
    expect(AUTHENTICODE_SCRIPT).toContain('$ch.ChainPolicy.UrlRetrievalTimeout = [TimeSpan]::FromSeconds(15)');
    expect(AUTHENTICODE_SCRIPT).toContain("$ch.ChainPolicy.VerificationFlags = 'IgnoreNotTimeValid'");
  });

  it('records the chain\'s own status list beside each element\'s', () => {
    expect(AUTHENTICODE_SCRIPT).toContain('status = @(foreach ($t in $ch.ChainStatus) { [string]$t.Status }); elements = $elements');
  });

  it('switches progress records off after the language-mode check, and leaves errors stopping the script', () => {
    const lines = AUTHENTICODE_SCRIPT.split('\n');
    expect(lines[0]).toBe("$ErrorActionPreference = 'Stop'");
    expect(lines[2]).toBe("$ProgressPreference = 'SilentlyContinue'");
  });
});

// =============================================================================================
// Parsing (fail closed)
// =============================================================================================

describe('parseAuthenticodeAnswer: only one well-formed answer line is an answer', () => {
  const one = () => answerText([signed(0, OPENAI_LEAF)], { [thumbprintOf(OPENAI_LEAF)]: chainOf(OPENAI_LEAF, OPENAI_ROOT) });

  it('accepts exit 0 with exactly one answer line, its results in index order', () => {
    const results = [unsignedResult(1), signed(0, OPENAI_LEAF)];
    const parsed = parseAuthenticodeAnswer(exited(answerText(results, { [thumbprintOf(OPENAI_LEAF)]: chainOf(OPENAI_LEAF, OPENAI_ROOT) })), 2);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.results.map((result) => result.i)).toEqual([0, 1]);
  });

  it('reads UNODE-AC1:CLM as PowerShell restricted by policy, whatever the exit code', () => {
    for (const code of [3, 0]) {
      const parsed = parseAuthenticodeAnswer(exited('UNODE-AC1:CLM\r\n', code), 1);
      expect(parsed).toMatchObject({ ok: false, reason: 'constrained-language' });
    }
    expect(AUTHENTICODE_UNAVAILABLE_TEXT['constrained-language']).toBe('PowerShell is restricted by policy (constrained language)');
  });

  it.each([
    ['ERR', exited('UNODE-AC1:ERR\r\n', 4)],
    ['a non-zero exit with a valid line', exited('', 1)],
    ['no output', exited('')],
    ['an extra line after the answer', exited('')],
    ['a warning line before the answer', exited('')],
    ['a signal', { status: 'exited', code: null, signal: 'SIGKILL', stdout: '', stderr: '' } as WindowsPowerShellRunResult],
    ['a timeout', { status: 'unavailable', reason: 'timeout', detail: 'Windows PowerShell did not finish within 90 seconds', stderr: '' } as WindowsPowerShellRunResult],
    ['more than 256 KiB', { status: 'unavailable', reason: 'output-limit', detail: 'Windows PowerShell wrote more than 262144 bytes', stderr: '' } as WindowsPowerShellRunResult],
    ['a spawn failure', { status: 'unavailable', reason: 'spawn-failed', detail: 'EACCES', stderr: '' } as WindowsPowerShellRunResult],
  ])('%s is no answer', (label, given) => {
    let run = given;
    if (label === 'a non-zero exit with a valid line') run = exited(one(), 1);
    if (label === 'an extra line after the answer') run = exited(`${one()}${one()}`);
    if (label === 'a warning line before the answer') run = exited(`WARNING: something\r\n${one()}`);
    const parsed = parseAuthenticodeAnswer(run, 1);
    expect(parsed).toMatchObject({ ok: false, reason: 'no-answer' });
    expect(AUTHENTICODE_UNAVAILABLE_TEXT['no-answer']).toBe('the signature check did not finish or returned an unreadable answer');
  });

  it('reads PowerShell not found as such', () => {
    const parsed = parseAuthenticodeAnswer({ status: 'unavailable', reason: 'not-found', detail: 'no SystemRoot', stderr: '' }, 1);
    expect(parsed).toMatchObject({ ok: false, reason: 'powershell-not-found' });
    expect(AUTHENTICODE_UNAVAILABLE_TEXT['powershell-not-found']).toBe('PowerShell not found');
  });

  it('refuses a result count different from the number of files sent', () => {
    expect(parseAuthenticodeAnswer(exited(one()), 2)).toMatchObject({ ok: false, reason: 'no-answer' });
    const two = answerText([unsignedResult(0), unsignedResult(1)], {});
    expect(parseAuthenticodeAnswer(exited(two), 1)).toMatchObject({ ok: false, reason: 'no-answer' });
    expect(parseAuthenticodeAnswer(exited(answerText([], {})), 1)).toMatchObject({ ok: false, reason: 'no-answer' });
  });

  it('refuses a missing or a repeated index', () => {
    const missing = answerText([unsignedResult(0), unsignedResult(2)], {});
    expect(parseAuthenticodeAnswer(exited(missing), 2)).toMatchObject({ ok: false, reason: 'no-answer' });
    const repeated = answerText([unsignedResult(0), unsignedResult(0)], {});
    expect(parseAuthenticodeAnswer(exited(repeated), 2)).toMatchObject({ ok: false, reason: 'no-answer' });
  });

  it.each([
    ['another version', () => answerText([unsignedResult(0)], {}, { v: 2 })],
    ['an extra field', () => answerText([unsignedResult(0)], {}, { note: 'x' })],
    ['an extra field in a result', () => answerText([{ ...unsignedResult(0), subject: 'CN=x' } as AuthenticodeRawResult], {})],
    ['a missing field in a result', () => {
      const { timestamped: _omitted, ...partial } = unsignedResult(0);
      return answerText([partial as AuthenticodeRawResult], {});
    }],
    ['a lower-case thumbprint', () => answerText([signed(0, OPENAI_LEAF, { leaf: thumbprintOf(OPENAI_LEAF).toLowerCase() })], {
      [thumbprintOf(OPENAI_LEAF).toLowerCase()]: chainOf(OPENAI_LEAF, OPENAI_ROOT),
    })],
    ['a status list that is not a list', () => answerText([signed(0, OPENAI_LEAF)], {
      [thumbprintOf(OPENAI_LEAF)]: { built: true, elements: [{ thumb: thumbprintOf(OPENAI_LEAF), status: 'NotTimeValid' }] } as unknown as AuthenticodeRawChain,
    })],
    ['a leaf without its chain', () => answerText([signed(0, OPENAI_LEAF)], {})],
    ['a chain no result names', () => answerText([unsignedResult(0)], { [thumbprintOf(OPENAI_LEAF)]: chainOf(OPENAI_LEAF, OPENAI_ROOT) })],
    ['a chain that does not start at the leaf', () => answerText([signed(0, OPENAI_LEAF)], {
      [thumbprintOf(OPENAI_LEAF)]: chainOf(CRT_CATALOG_LEAF, OPENAI_ROOT),
    })],
    ['a certificate that is not the signer certificate', () => answerText([signed(0, OPENAI_LEAF, { leafDer: CRT_CATALOG_LEAF.toString('base64') })], {
      [thumbprintOf(OPENAI_LEAF)]: chainOf(OPENAI_LEAF, OPENAI_ROOT),
    })],
    ['a thumbprint without a certificate', () => answerText([signed(0, OPENAI_LEAF, { leafDer: null })], {
      [thumbprintOf(OPENAI_LEAF)]: chainOf(OPENAI_LEAF, OPENAI_ROOT),
    })],
    ['JSON that is not an object', () => `UNODE-AC1:${Buffer.from('[1]').toString('base64')}`],
    ['bytes that are not UTF-8', () => `UNODE-AC1:${Buffer.from([0x7b, 0xff, 0x7d, 0x20]).toString('base64')}`],
    ['base64 that is not canonical', () => 'UNODE-AC1:e31='],
    ['a chain without its own status list', () => {
      const { status: _omitted, ...withoutStatus } = chainOf(OPENAI_LEAF, OPENAI_ROOT);
      return answerText([signed(0, OPENAI_LEAF)], { [thumbprintOf(OPENAI_LEAF)]: withoutStatus as AuthenticodeRawChain });
    }],
  ])('refuses %s', (_label, text) => {
    expect(parseAuthenticodeAnswer(exited(text()), 1)).toMatchObject({ ok: false, reason: 'no-answer' });
  });
});

// Codex's ruling (2026-10-21): every chain-level status must be known and appear on an element.
describe('parseAuthenticodeAnswer: the chain\'s own status list is bound to its elements', () => {
  const answerWith = (chain: AuthenticodeRawChain) => parseAuthenticodeAnswer(exited(answerText([signed(0, OPENAI_LEAF)], { [thumbprintOf(OPENAI_LEAF)]: chain })), 1);

  it('reads a chain whose own statuses each appear on an element, an empty list, and NoError', () => {
    expect(answerWith(chainOf(OPENAI_LEAF, OPENAI_ROOT, [['NotTimeValid'], ['OfflineRevocation']])).ok).toBe(true);
    expect(answerWith(chainOf(OPENAI_LEAF, OPENAI_ROOT, [], { chainStatus: [] })).ok).toBe(true);
    expect(answerWith(chainOf(OPENAI_LEAF, OPENAI_ROOT, [], { chainStatus: ['NoError'] })).ok).toBe(true);
  });

  it('is no answer when the chain reports a status that none of its certificates carries', () => {
    for (const planted of ['NotSignatureValid', 'PartialChain', 'NotTimeValid', 'Revoked']) {
      expect(answerWith(chainOf(OPENAI_LEAF, OPENAI_ROOT, [], { chainStatus: [planted] }))).toMatchObject({ ok: false, reason: 'no-answer' });
    }
    // Present on an element, but another chain-level status is not.
    expect(answerWith(chainOf(OPENAI_LEAF, OPENAI_ROOT, [['NotTimeValid']], { chainStatus: ['NotTimeValid', 'UntrustedRoot'] })))
      .toMatchObject({ ok: false, reason: 'no-answer' });
  });

  it('is no answer when the chain reports a status this check does not know, even if an element carries it', () => {
    expect(answerWith(chainOf(OPENAI_LEAF, OPENAI_ROOT, [['SomethingNew']], { chainStatus: ['SomethingNew'] })))
      .toMatchObject({ ok: false, reason: 'no-answer' });
  });
});

// =============================================================================================
// The subject of a certificate
// =============================================================================================

describe('readCertificateSubject: the subject RDNs from the DER', () => {
  it('reads the three real leaves as their pinned subjects', () => {
    expect(readCertificateSubject(OPENAI_LEAF)).toEqual({ ok: true, rdns: OPENAI_RDNS.map((pair) => [pair]) });
    expect(readCertificateSubject(CRT_CATALOG_LEAF)).toEqual({ ok: true, rdns: CRT_CATALOG_RDNS.map((pair) => [pair]) });
    expect(readCertificateSubject(CRT_EMBEDDED_LEAF)).toEqual({ ok: true, rdns: CRT_EMBEDDED_RDNS.map((pair) => [pair]) });
    for (const leaf of LEAVES) expect(thumbprintOf(Buffer.from(leaf.der, 'base64'))).toBe(leaf.thumbprint);
  });

  it('reads the subject, not the issuer, with and without a version field', () => {
    const subject = rdnsOf([['2.5.4.3', 'Only Me']]);
    expect(readCertificateSubject(certificate(subject))).toEqual({ ok: true, rdns: [[['2.5.4.3', 'Only Me']]] });
    expect(readCertificateSubject(certificate(subject, { version: false }))).toEqual({ ok: true, rdns: [[['2.5.4.3', 'Only Me']]] });
  });

  it('reports a multi-valued RDN as one RDN with several attributes', () => {
    const der = certificate([rdn(['2.5.4.6', 'US']), rdn(['2.5.4.10', 'OpenAI OpCo, LLC'], ['2.5.4.3', 'OpenAI OpCo, LLC'])]);
    expect(readCertificateSubject(der)).toEqual({
      ok: true,
      rdns: [[['2.5.4.6', 'US']], [['2.5.4.10', 'OpenAI OpCo, LLC'], ['2.5.4.3', 'OpenAI OpCo, LLC']]],
    });
  });

  it('decodes UTF8String, BMPString and long object identifiers', () => {
    const der = certificate([rdn(['2.5.4.3', 'Zoë 张三', UTF8]), rdn(['2.5.4.10', 'Ünïcode', BMP]), rdn(['1.3.6.1.4.1.311.60.2.1.3', 'US'])]);
    expect(readCertificateSubject(der)).toEqual({
      ok: true,
      rdns: [[['2.5.4.3', 'Zoë 张三']], [['2.5.4.10', 'Ünïcode']], [['1.3.6.1.4.1.311.60.2.1.3', 'US']]],
    });
  });

  const good = certificate(rdnsOf(OPENAI_RDNS));
  const indexOfText = (der: Buffer, text: string) => der.indexOf(Buffer.from(text, 'latin1'));
  it.each([
    ['empty input', () => Buffer.alloc(0)],
    ['a truncated certificate', () => good.subarray(0, good.length - 5)],
    ['a byte after the certificate', () => Buffer.concat([good, Buffer.from([0])])],
    ['an indefinite length', () => Buffer.concat([Buffer.from([0x30, 0x80]), good.subarray(2)])],
    ['a non-minimal length', () => {
      const body = good.subarray(4);
      return Buffer.concat([Buffer.from([0x30, 0x83, 0x00, (body.length >> 8) & 0xff, body.length & 0xff]), body]);
    }],
    ['a long-form length for a short element', () => tlv(0x30, Buffer.from([0x30, 0x81, 0x01, 0x00]))],
    ['a multi-byte tag', () => tlv(0x30, tlv(0x30, Buffer.from([0x1f, 0x81, 0x01, 0x00])), tlv(0x30), tlv(0x03, Buffer.from([0])))],
    ['a certificate that is not a SEQUENCE', () => Buffer.concat([Buffer.from([0x31]), good.subarray(1)])],
    ['a PrintableString with a character outside its set', () => certificate([rdn(['2.5.4.3', 'OpenAI@OpCo'])])],
    ['a UTF8String that is not UTF-8', () => {
      const der = certificate([rdn(['2.5.4.3', 'OpenAI', UTF8])]);
      der[indexOfText(der, 'OpenAI')] = 0xff;
      return der;
    }],
    ['a TeletexString', () => certificate([rdn(['2.5.4.3', 'OpenAI', 0x14])])],
    ['an attribute without a value', () => certificate([tlv(0x31, tlv(0x30, oid('2.5.4.3')))])],
    ['an empty RDN', () => certificate([tlv(0x31)])],
    ['an object identifier with a padded arc', () => certificate([tlv(0x31, tlv(0x30, tlv(0x06, Buffer.from([0x55, 0x80, 0x04])), stringValue(PRINTABLE, 'x')))])],
    ['a truncated object identifier', () => certificate([tlv(0x31, tlv(0x30, tlv(0x06, Buffer.from([0x55, 0x84])), stringValue(PRINTABLE, 'x')))])],
    ['a missing subject public key', () => {
      const algorithm = tlv(0x30, oid('1.2.840.113549.1.1.11'), tlv(0x05));
      const tbs = tlv(0x30, tlv(0x02, Buffer.from([1])), algorithm, tlv(0x30), tlv(0x30), tlv(0x30, ...rdnsOf(OPENAI_RDNS)));
      return tlv(0x30, tbs, algorithm, tlv(0x03, Buffer.from([0])));
    }],
  ])('refuses %s', (_label, der) => {
    const read = readCertificateSubject(der());
    expect(read.ok).toBe(false);
  });

  it('fails the file when the signer certificate cannot be read', () => {
    const broken = Buffer.concat([OPENAI_LEAF, Buffer.from([0])]);
    const verdict = judge(openaiFile, signed(0, broken), chainOf(broken, OPENAI_ROOT));
    expect(verdict).toMatchObject({ accepted: false, revoked: false });
    expect(!verdict.accepted && verdict.reason).toMatch(/cannot be read/);
  });
});

// =============================================================================================
// Acceptance of one file
// =============================================================================================

describe('judgeAuthenticodeFile: OpenAI', () => {
  it('accepts a Valid, timestamped, embedded signature from the pinned subject and root, with the leaf expired since', () => {
    expect(openaiValid()).toEqual({
      path: openaiFile.path, signer: 'openai', accepted: true, alternative: 0, signatureType: 'Authenticode', revocation: 'confirmed-online',
    });
  });

  it('accepts the leaf with no status at all (the other way .NET may report an ignored time validity)', () => {
    expect(judge(openaiFile, signed(0, OPENAI_LEAF), chainOf(OPENAI_LEAF, OPENAI_ROOT))).toMatchObject({ accepted: true });
  });

  it.each(['NotSigned', 'HashMismatch', 'NotTrusted', 'UnknownError', 'NotSupportedFileFormat', 'Incompatible', 'SomethingNew'])(
    'refuses a %s signature where one is expected', (status) => {
      const result = status === 'NotSigned' ? unsignedResult(0) : signed(0, OPENAI_LEAF, { status });
      const chain = status === 'NotSigned' ? undefined : chainOf(OPENAI_LEAF, OPENAI_ROOT);
      expect(judge(openaiFile, result, chain)).toMatchObject({ accepted: false, revoked: false });
    },
  );

  it('refuses a catalog match on an OpenAI file, even when an alternative names Catalog', () => {
    const result = signed(0, OPENAI_LEAF, { type: 'Catalog' });
    const chain = chainOf(OPENAI_LEAF, OPENAI_ROOT);
    expect(judge(openaiFile, result, chain)).toMatchObject({ accepted: false });
    const lenient: AuthenticodeSigners = {
      ...SIGNERS,
      openai: { accepted: [{ signatureType: 'Catalog', subjectRdns: OPENAI_RDNS, rootThumbprint: OPENAI_ROOT }] },
    };
    expect(judge(openaiFile, result, chain, lenient)).toMatchObject({ accepted: false });
  });

  it('refuses a signature without a timestamp', () => {
    expect(judge(openaiFile, signed(0, OPENAI_LEAF, { timestamped: false }), chainOf(OPENAI_LEAF, OPENAI_ROOT))).toMatchObject({ accepted: false });
  });

  it('refuses a chain that ends at another root, or has fewer than two elements', () => {
    expect(judge(openaiFile, signed(0, OPENAI_LEAF), chainOf(OPENAI_LEAF, CRT_CATALOG_ROOT))).toMatchObject({ accepted: false });
    const lone: AuthenticodeRawChain = { built: true, status: [], elements: [{ thumb: thumbprintOf(OPENAI_LEAF), status: [] }] };
    expect(judge(openaiFile, signed(0, OPENAI_LEAF), lone)).toMatchObject({ accepted: false });
    // A one-element chain is refused even when that element is the pinned root itself.
    const selfRooted: AuthenticodeSigners = { ...SIGNERS, openai: { accepted: [{ ...SIGNERS.openai.accepted[0], rootThumbprint: thumbprintOf(OPENAI_LEAF) }] } };
    const verdict = judge(openaiFile, signed(0, OPENAI_LEAF), lone, selfRooted);
    expect(verdict).toMatchObject({ accepted: false });
    expect(!verdict.accepted && verdict.reason).toMatch(/not at least two/);
    const rootOnlyAfterLeaf = chainOf(OPENAI_LEAF, OPENAI_ROOT, [], { intermediates: [] });
    expect(judge(openaiFile, signed(0, OPENAI_LEAF), rootOnlyAfterLeaf)).toMatchObject({ accepted: true });
  });

  it('never compares the leaf thumbprint: another leaf of the same subject and root passes', () => {
    const another = certificate(rdnsOf(OPENAI_RDNS));
    expect(thumbprintOf(another)).not.toBe(thumbprintOf(OPENAI_LEAF));
    expect(judge(openaiFile, signed(0, another), chainOf(another, OPENAI_ROOT))).toMatchObject({ accepted: true });
  });
});

describe('judgeAuthenticodeFile: the Microsoft CRT', () => {
  it('accepts alternative 1: Catalog, CN=Microsoft Windows, root 3B1EFD3A…', () => {
    const verdict = judge(crtFile, signed(0, CRT_CATALOG_LEAF, { type: 'Catalog' }), chainOf(CRT_CATALOG_LEAF, CRT_CATALOG_ROOT, [['NotTimeValid']], { intermediates: [INTERMEDIATE_A] }));
    expect(verdict).toMatchObject({ accepted: true, alternative: 0, signatureType: 'Catalog' });
  });

  it('accepts alternative 2: embedded Authenticode, CN=Microsoft Windows Software Compatibility Publisher, root 8F43288A…', () => {
    const verdict = judge(crtFile, signed(0, CRT_EMBEDDED_LEAF), chainOf(CRT_EMBEDDED_LEAF, CRT_EMBEDDED_ROOT, [], { intermediates: [INTERMEDIATE_A] }));
    expect(verdict).toMatchObject({ accepted: true, alternative: 1, signatureType: 'Authenticode' });
  });

  it.each([
    ['the catalog subject with the embedded type and root', () => [signed(0, CRT_CATALOG_LEAF), chainOf(CRT_CATALOG_LEAF, CRT_EMBEDDED_ROOT)]],
    ['the embedded subject as a catalog match', () => [signed(0, CRT_EMBEDDED_LEAF, { type: 'Catalog' }), chainOf(CRT_EMBEDDED_LEAF, CRT_CATALOG_ROOT)]],
    ['the catalog subject at the embedded root', () => [signed(0, CRT_CATALOG_LEAF, { type: 'Catalog' }), chainOf(CRT_CATALOG_LEAF, CRT_EMBEDDED_ROOT)]],
    ['another Microsoft subject at a pinned root', () => {
      const der = certificate(rdnsOf([...CRT_CATALOG_RDNS.slice(0, 4), ['2.5.4.3', 'Microsoft Corporation']]));
      return [signed(0, der, { type: 'Catalog' }), chainOf(der, CRT_CATALOG_ROOT)];
    }],
    ['the OpenAI identity', () => [signed(0, OPENAI_LEAF), chainOf(OPENAI_LEAF, OPENAI_ROOT)]],
  ])('refuses a third form: %s', (_label, given) => {
    const [result, chain] = given() as [AuthenticodeRawResult, AuthenticodeRawChain];
    expect(judge(crtFile, result, chain)).toMatchObject({ accepted: false });
  });
});

describe('judgeAuthenticodeFile: chain element statuses', () => {
  const ALL_FLAGS = [
    'NoError', 'NotTimeValid', 'NotTimeNested', 'Revoked', 'NotSignatureValid', 'NotValidForUsage', 'UntrustedRoot',
    'RevocationStatusUnknown', 'Cyclic', 'InvalidExtension', 'InvalidPolicyConstraints', 'InvalidBasicConstraints',
    'InvalidNameConstraints', 'HasNotSupportedNameConstraint', 'HasNotDefinedNameConstraint',
    'HasNotPermittedNameConstraint', 'HasExcludedNameConstraint', 'PartialChain', 'CtlNotTimeValid',
    'CtlNotSignatureValid', 'CtlNotValidForUsage', 'HasWeakSignature', 'OfflineRevocation', 'NoIssuanceChainPolicy',
    'ExplicitDistrust', 'HasNotSupportedCriticalExtension',
  ];
  const at = (position: number, status: string, built = true) => {
    const statuses: string[][] = [[], [], [], []];
    statuses[position] = [status];
    return judge(openaiFile, signed(0, OPENAI_LEAF), chainOf(OPENAI_LEAF, OPENAI_ROOT, statuses, { built }));
  };
  const LEAF = 0;
  const INTERMEDIATE = 1;
  const ROOT = 3;

  it.each(ALL_FLAGS.filter((flag) => !['NotTimeValid', 'RevocationStatusUnknown', 'OfflineRevocation'].includes(flag)))(
    'refuses %s on the leaf', (flag) => { expect(at(LEAF, flag)).toMatchObject({ accepted: false }); },
  );
  it.each(ALL_FLAGS.filter((flag) => !['RevocationStatusUnknown', 'OfflineRevocation'].includes(flag)))(
    'refuses %s on an intermediate', (flag) => { expect(at(INTERMEDIATE, flag)).toMatchObject({ accepted: false }); },
  );
  it.each(ALL_FLAGS)('refuses %s on the root', (flag) => { expect(at(ROOT, flag)).toMatchObject({ accepted: false }); });

  it.each(['SomethingNew', 'NotTimeValid, Revoked', 'nottimevalid', ''])('refuses the unknown value "%s" anywhere', (status) => {
    for (const position of [LEAF, INTERMEDIATE, 2, ROOT]) expect(at(position, status)).toMatchObject({ accepted: false });
  });

  it('accepts NotTimeValid on the leaf only, refusing it on an intermediate and on the root', () => {
    expect(at(LEAF, 'NotTimeValid')).toMatchObject({ accepted: true, revocation: 'confirmed-online' });
    expect(at(INTERMEDIATE, 'NotTimeValid')).toMatchObject({ accepted: false });
    expect(at(2, 'NotTimeValid')).toMatchObject({ accepted: false });
    expect(at(ROOT, 'NotTimeValid')).toMatchObject({ accepted: false });
  });

  it('accepts the offline statuses on the leaf and the intermediates and shows the revocation as not confirmed', () => {
    for (const status of ['RevocationStatusUnknown', 'OfflineRevocation']) {
      for (const position of [LEAF, INTERMEDIATE, 2]) {
        expect(at(position, status)).toMatchObject({ accepted: true, revocation: 'not-confirmed-offline' });
        expect(at(position, status, false)).toMatchObject({ accepted: true, revocation: 'not-confirmed-offline' });
      }
    }
    expect(AUTHENTICODE_OFFLINE_TEXT).toBe('revocation not confirmed (offline)');
  });

  it('refuses a chain that did not build unless a status at an allowed place says revocation could not be checked', () => {
    expect(judge(openaiFile, signed(0, OPENAI_LEAF), chainOf(OPENAI_LEAF, OPENAI_ROOT, [], { built: false }))).toMatchObject({ accepted: false });
    expect(at(LEAF, 'NotTimeValid', false)).toMatchObject({ accepted: false });
    const offlineWithExpiredLeaf = chainOf(OPENAI_LEAF, OPENAI_ROOT, [['NotTimeValid', 'OfflineRevocation'], ['RevocationStatusUnknown']], { built: false });
    expect(judge(openaiFile, signed(0, OPENAI_LEAF), offlineWithExpiredLeaf)).toMatchObject({ accepted: true, revocation: 'not-confirmed-offline' });
    const offlineAtRoot = chainOf(OPENAI_LEAF, OPENAI_ROOT, [[], [], [], ['OfflineRevocation']], { built: false });
    expect(judge(openaiFile, signed(0, OPENAI_LEAF), offlineAtRoot)).toMatchObject({ accepted: false });
  });

  it('fails a revoked certificate anywhere as revoked, apart from every other failure', () => {
    for (const position of [LEAF, INTERMEDIATE, 2, ROOT]) {
      const verdict = at(position, 'Revoked');
      expect(verdict).toMatchObject({ accepted: false, revoked: true });
    }
    const revokedAndNotValid = judge(openaiFile, signed(0, OPENAI_LEAF, { status: 'NotTrusted' }), chainOf(OPENAI_LEAF, OPENAI_ROOT, [['Revoked']]));
    expect(revokedAndNotValid).toMatchObject({ accepted: false, revoked: true });
    expect(at(INTERMEDIATE, 'UntrustedRoot')).toMatchObject({ accepted: false, revoked: false });
    expect(at(INTERMEDIATE, 'OfflineRevocation')).toMatchObject({ accepted: true });
  });
});

// Codex's ruling on the CRT catalog chain (2026-10-21): Microsoft Windows Production PCA 2011 expired on 2026-10-19,
// so the catalog chain of the package's vcruntime140.dll, built at the current time, reports NotTimeValid on its leaf
// and its intermediate while Windows reports the catalog signature Valid at its timestamp. Only the microsoft-crt
// Catalog alternative may accept that, and only with every other condition in place.
describe('judgeAuthenticodeFile: the Microsoft CRT catalog chain with an expired intermediate', () => {
  const PCA_2011 = '580A6F4CC4E4B669B9EBDC1B2B3E087B80D0678D';
  const crtPinned: AuthenticodeFile = { ...crtFile, pinnedDigestVerified: true };
  const catalogResult = (overrides: Partial<AuthenticodeRawResult> = {}) => signed(0, CRT_CATALOG_LEAF, { type: 'Catalog', ...overrides });
  /** The chain as this host reported it on 2026-10-21: leaf and intermediate expired, root valid. */
  const recordedChain = (statuses: string[][] = [['NotTimeValid'], ['NotTimeValid'], []], root = CRT_CATALOG_ROOT, options: { built?: boolean } = {}) =>
    chainOf(CRT_CATALOG_LEAF, root, statuses, { intermediates: [PCA_2011], ...options });

  it('accepts the recorded chain for a microsoft-crt file whose bytes were verified, through the Catalog alternative', () => {
    expect(recordedChain().status).toEqual(['NotTimeValid']);
    expect(judge(crtPinned, catalogResult(), recordedChain()))
      .toMatchObject({ accepted: true, signer: 'microsoft-crt', alternative: 0, signatureType: 'Catalog', revocation: 'confirmed-online' });
  });

  it('refuses the same chain when the caller has not verified the file\'s bytes against their pinned digest', () => {
    expect(judge(crtFile, catalogResult(), recordedChain())).toMatchObject({ accepted: false });
    expect(judge({ ...crtFile, pinnedDigestVerified: false }, catalogResult(), recordedChain())).toMatchObject({ accepted: false });
  });

  it('refuses identical statuses for an openai file and for the CRT\'s embedded Authenticode alternative', () => {
    const expiredIntermediate = [['NotTimeValid'], ['NotTimeValid'], []];
    const openai = judge({ ...openaiFile, pinnedDigestVerified: true }, signed(0, OPENAI_LEAF),
      chainOf(OPENAI_LEAF, OPENAI_ROOT, expiredIntermediate, { intermediates: [INTERMEDIATE_A] }));
    expect(openai).toMatchObject({ accepted: false });
    const embedded = judge(crtPinned, signed(0, CRT_EMBEDDED_LEAF),
      chainOf(CRT_EMBEDDED_LEAF, CRT_EMBEDDED_ROOT, expiredIntermediate, { intermediates: [INTERMEDIATE_A] }));
    expect(embedded).toMatchObject({ accepted: false });
  });

  it.each([
    ['no timestamp', () => [catalogResult({ timestamped: false }), recordedChain()]],
    ['a Windows verdict other than Valid', () => [catalogResult({ status: 'UnknownError' }), recordedChain()]],
    ['a hash mismatch', () => [catalogResult({ status: 'HashMismatch' }), recordedChain()]],
    ['the embedded type for the catalog leaf', () => [signed(0, CRT_CATALOG_LEAF), recordedChain()]],
    ['another subject at the catalog root', () => [signed(0, OPENAI_LEAF, { type: 'Catalog' }),
      chainOf(OPENAI_LEAF, CRT_CATALOG_ROOT, [['NotTimeValid'], ['NotTimeValid'], []], { intermediates: [PCA_2011] })]],
    ['another root', () => [catalogResult(), recordedChain(undefined, OPENAI_ROOT)]],
    ['NotTimeValid on the root', () => [catalogResult(), recordedChain([['NotTimeValid'], ['NotTimeValid'], ['NotTimeValid']])]],
    ['an unknown status beside NotTimeValid on the intermediate', () => [catalogResult(), recordedChain([['NotTimeValid'], ['NotTimeValid', 'SomethingNew'], []])]],
  ])('refuses the expired intermediate with %s', (_label, given) => {
    const [result, chain] = given() as [AuthenticodeRawResult, AuthenticodeRawChain];
    expect(judge(crtPinned, result, chain)).toMatchObject({ accepted: false, revoked: false });
  });

  it('fails a revoked certificate anywhere in the chain as revoked', () => {
    for (const statuses of [[['NotTimeValid'], ['NotTimeValid', 'Revoked'], []], [['Revoked'], ['NotTimeValid'], []], [['NotTimeValid'], ['NotTimeValid'], ['Revoked']]]) {
      expect(judge(crtPinned, catalogResult(), recordedChain(statuses))).toMatchObject({ accepted: false, revoked: true });
    }
  });

  it.each([
    'NotTimeNested', 'NotSignatureValid', 'NotValidForUsage', 'UntrustedRoot', 'Cyclic', 'InvalidExtension',
    'InvalidPolicyConstraints', 'InvalidBasicConstraints', 'InvalidNameConstraints', 'HasNotSupportedNameConstraint',
    'HasNotDefinedNameConstraint', 'HasNotPermittedNameConstraint', 'HasExcludedNameConstraint', 'PartialChain',
    'CtlNotTimeValid', 'CtlNotSignatureValid', 'CtlNotValidForUsage', 'HasWeakSignature', 'NoIssuanceChainPolicy',
    'ExplicitDistrust', 'HasNotSupportedCriticalExtension', 'NoError',
  ])('still refuses %s on the intermediate beside NotTimeValid', (flag) => {
    expect(judge(crtPinned, catalogResult(), recordedChain([['NotTimeValid'], ['NotTimeValid', flag], []]))).toMatchObject({ accepted: false });
  });

  it('keeps the offline rule as it was: offline statuses show as not confirmed, and an unbuilt chain needs one', () => {
    expect(judge(crtPinned, catalogResult(), recordedChain([['NotTimeValid'], ['NotTimeValid', 'OfflineRevocation'], []])))
      .toMatchObject({ accepted: true, revocation: 'not-confirmed-offline' });
    expect(judge(crtPinned, catalogResult(), recordedChain(undefined, CRT_CATALOG_ROOT, { built: false }))).toMatchObject({ accepted: false });
  });

  // The check as a whole already refuses a non-Valid verdict, a missing timestamp and a type the alternative does not
  // name before it consults this condition. The condition still states every part of the ruling, each tested here.
  it('holds only with every condition of the ruling, each one needed on its own', () => {
    const catalogRule = SIGNERS['microsoft-crt'].accepted[0];
    const embeddedRule = SIGNERS['microsoft-crt'].accepted[1];
    const holds = (file: AuthenticodeFile, rule: typeof catalogRule, result: AuthenticodeRawResult) => crtCatalogIntermediateMayHaveExpired(file, rule, result);
    expect(holds(crtPinned, catalogRule, catalogResult())).toBe(true);
    expect(holds({ ...crtPinned, signer: 'openai' }, catalogRule, catalogResult())).toBe(false);
    expect(holds(crtPinned, embeddedRule, catalogResult())).toBe(false);
    expect(holds(crtPinned, catalogRule, catalogResult({ status: 'UnknownError' }))).toBe(false);
    expect(holds(crtPinned, catalogRule, catalogResult({ type: 'Authenticode' }))).toBe(false);
    expect(holds(crtPinned, catalogRule, catalogResult({ timestamped: false }))).toBe(false);
    expect(holds(crtFile, catalogRule, catalogResult())).toBe(false);
  });

  it('accepts every intermediate of the chain having expired, but never the root', () => {
    const twoIntermediates = chainOf(CRT_CATALOG_LEAF, CRT_CATALOG_ROOT, [['NotTimeValid'], ['NotTimeValid'], ['NotTimeValid'], []], { intermediates: [PCA_2011, INTERMEDIATE_A] });
    expect(judge(crtPinned, catalogResult(), twoIntermediates)).toMatchObject({ accepted: true });
  });
});

describe('judgeAuthenticodeFile: the subject rule', () => {
  const withSubject = (der: Buffer) => judge(openaiFile, signed(0, der), chainOf(der, OPENAI_ROOT));

  it('accepts the exact RDN list', () => {
    expect(withSubject(certificate(rdnsOf(OPENAI_RDNS)))).toMatchObject({ accepted: true });
  });

  it('refuses another order', () => {
    expect(withSubject(certificate(rdnsOf([...OPENAI_RDNS].reverse())))).toMatchObject({ accepted: false });
  });

  it('refuses an extra RDN, before, inside or after the pinned ones, and a missing one', () => {
    const extra: [string, string] = ['2.5.4.11', 'Engineering'];
    expect(withSubject(certificate(rdnsOf([...OPENAI_RDNS, extra])))).toMatchObject({ accepted: false });
    expect(withSubject(certificate(rdnsOf([extra, ...OPENAI_RDNS])))).toMatchObject({ accepted: false });
    expect(withSubject(certificate(rdnsOf([...OPENAI_RDNS.slice(0, 2), extra, ...OPENAI_RDNS.slice(2)])))).toMatchObject({ accepted: false });
    expect(withSubject(certificate(rdnsOf(OPENAI_RDNS.slice(1))))).toMatchObject({ accepted: false });
  });

  it('refuses a multi-valued RDN, whether it merges two pinned RDNs or adds an attribute to one', () => {
    const merged = certificate([...rdnsOf(OPENAI_RDNS.slice(0, 3)), rdn(['2.5.4.10', 'OpenAI OpCo, LLC'], ['2.5.4.3', 'OpenAI OpCo, LLC'])]);
    expect(withSubject(merged)).toMatchObject({ accepted: false });
    const widened = certificate([...rdnsOf(OPENAI_RDNS.slice(0, 4)), rdn(['2.5.4.3', 'OpenAI OpCo, LLC'], ['2.5.4.11', 'Engineering'])]);
    const verdict = withSubject(widened);
    expect(verdict).toMatchObject({ accepted: false });
    expect(!verdict.accepted && verdict.reason).toMatch(/RDN 5 of the subject is multi-valued/);
  });

  it('refuses a value that differs only in case or by a space, and another attribute type with the same value', () => {
    expect(withSubject(certificate(rdnsOf([...OPENAI_RDNS.slice(0, 4), ['2.5.4.3', 'OPENAI OPCO, LLC']])))).toMatchObject({ accepted: false });
    expect(withSubject(certificate(rdnsOf([...OPENAI_RDNS.slice(0, 4), ['2.5.4.3', 'OpenAI OpCo, LLC ']])))).toMatchObject({ accepted: false });
    expect(withSubject(certificate(rdnsOf([...OPENAI_RDNS.slice(0, 4), ['2.5.4.11', 'OpenAI OpCo, LLC']])))).toMatchObject({ accepted: false });
  });

  it('accepts a different string type with an equal value: the rule compares decoded values', () => {
    expect(withSubject(certificate(rdnsOf(OPENAI_RDNS, UTF8)))).toMatchObject({ accepted: true });
    expect(withSubject(certificate(rdnsOf(OPENAI_RDNS, BMP)))).toMatchObject({ accepted: true });
    // The real OpenAI leaf with its PrintableString CN re-tagged as UTF8String (same bytes, same length).
    const retagged = Buffer.from(OPENAI_LEAF);
    const cn = retagged.lastIndexOf(Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03, 0x13]));
    expect(cn).toBeGreaterThan(0);
    retagged[cn + 5] = UTF8;
    expect(readCertificateSubject(retagged)).toEqual({ ok: true, rdns: OPENAI_RDNS.map((pair) => [pair]) });
    expect(withSubject(retagged)).toMatchObject({ accepted: true });
    // That byte is the subject's: a T.61 tag there makes the subject unreadable.
    retagged[cn + 5] = 0x14;
    expect(readCertificateSubject(retagged).ok).toBe(false);
  });
});

describe('judgeAuthenticodeFile: files without a signer, and pinned identities', () => {
  it('accepts an unsigned file only as NotSigned / None', () => {
    expect(judge(rgFile, unsignedResult(0))).toEqual({ path: rgFile.path, signer: 'unsigned', accepted: true });
    expect(judge(rgFile, unsignedResult(0, { status: 'UnknownError' }))).toMatchObject({ accepted: false });
    expect(judge(rgFile, unsignedResult(0, { type: 'Authenticode' }))).toMatchObject({ accepted: false });
    expect(judge(rgFile, signed(0, OPENAI_LEAF), chainOf(OPENAI_LEAF, OPENAI_ROOT))).toMatchObject({ accepted: false });
    expect(judge(rgFile, signed(0, OPENAI_LEAF, { status: 'NotSigned', type: 'None' }), chainOf(OPENAI_LEAF, OPENAI_ROOT))).toMatchObject({ accepted: false });
  });

  it('never judges a non-PE file as passed', () => {
    expect(judge({ path: 'C:\\pkg\\codex-package.json', signer: 'none' }, unsignedResult(0))).toMatchObject({ accepted: false });
  });

  it('fails a signed file whose publisher has no valid pinned identity', () => {
    const result = signed(0, OPENAI_LEAF);
    const chain = chainOf(OPENAI_LEAF, OPENAI_ROOT);
    const cases: unknown[] = [
      { ...SIGNERS, openai: { accepted: [] } },
      { 'microsoft-crt': SIGNERS['microsoft-crt'] },
      { ...SIGNERS, openai: { accepted: [{ signatureType: 'Authenticode', subjectRdns: OPENAI_RDNS, rootThumbprint: 'F40042' }] } },
      { ...SIGNERS, openai: { accepted: [{ signatureType: 'Authenticode', subjectRdns: [], rootThumbprint: OPENAI_ROOT }] } },
      { ...SIGNERS, openai: { accepted: [{ signatureType: 'Authenticode', subjectRdns: [['CN', 'OpenAI OpCo, LLC']], rootThumbprint: OPENAI_ROOT }] } },
      { ...SIGNERS, openai: { accepted: [{ signatureType: 'Embedded', subjectRdns: OPENAI_RDNS, rootThumbprint: OPENAI_ROOT }] } },
    ];
    for (const signers of cases) expect(judge(openaiFile, result, chain, signers as AuthenticodeSigners)).toMatchObject({ accepted: false });
  });

  it('compares the root thumbprint without regard to the case the rule is written in', () => {
    const lower: AuthenticodeSigners = { ...SIGNERS, openai: { accepted: [{ ...SIGNERS.openai.accepted[0], rootThumbprint: OPENAI_ROOT.toLowerCase() }] } };
    expect(judge(openaiFile, signed(0, OPENAI_LEAF), chainOf(OPENAI_LEAF, OPENAI_ROOT), lower)).toMatchObject({ accepted: true });
  });
});

// =============================================================================================
// The whole check
// =============================================================================================

describe('checkAuthenticodeSignatures', () => {
  it('reports the Codex package as the dialog needs it: counts per signer, the unsigned file named, revocation', async () => {
    const files = codexPackage();
    const { result, runner } = check(files, honestAnswer(files));
    const checked = await result;
    expect(checked).toMatchObject({
      status: 'checked', accepted: true, revoked: false,
      counts: { openai: 30, 'microsoft-crt': 1, unsigned: 1 },
      unsignedFiles: [rgFile.path],
      notSent: ['C:\\pkg\\codex-package.json'],
      revocation: 'confirmed-online',
    });
    expect(checked.status === 'checked' && checked.files.map((verdict) => verdict.path)).toEqual(files.filter((file) => file.signer !== 'none').map((file) => file.path));
    expect(runner.requests).toHaveLength(1);
  });

  it('never sends a file listed none', async () => {
    const files = codexPackage();
    const { result, runner } = check(files, honestAnswer(files));
    await result;
    expect(runner.inputs().flat()).not.toContain('C:\\pkg\\codex-package.json');
    expect(runner.inputs().flat()).toHaveLength(32);
  });

  it('starts nothing when no file is to be sent', async () => {
    const { result, runner } = check([{ path: 'C:\\pkg\\README.md', signer: 'none' }], () => { throw new Error('ran'); });
    expect(await result).toMatchObject({ status: 'checked', accepted: true, files: [], revocation: 'not-applicable' });
    expect(runner.requests).toHaveLength(0);
  });

  it('sends the fixed encoded script, the input variable, the owned folders and the caller\'s roots, within the bounds', async () => {
    const files = [openaiFile];
    const { result, runner } = check(files, honestAnswer(files));
    await result;
    expect(runner.requests[0]).toMatchObject({
      encodedCommand: AUTHENTICODE_ENCODED_COMMAND,
      inputVariable: 'UNODE_AC_INPUT',
      maxInputChars: 24 * 1024,
      cwd: 'C:\\owned\\work',
      tmp: 'C:\\owned\\work\\tmp',
      timeoutMs: 90_000,
      maxStdoutBytes: 256 * 1024,
      workspaceRoots: ['C:\\repo'],
      worktreeRoots: [],
    });
    expect(JSON.parse(Buffer.from(runner.requests[0].input, 'base64').toString('utf8'))).toEqual({ v: 1, files: [openaiFile.path] });
  });

  it('carries non-ASCII paths to PowerShell unchanged and in order', async () => {
    const files: AuthenticodeFile[] = [
      { path: 'C:\\Users\\张三\\AppData\\Local\\UnodeAi\\cli-store\\codex.exe', signer: 'openai' },
      { path: 'C:\\Users\\Zoë\\naïve\\rg.exe', signer: 'unsigned' },
    ];
    const { result, runner } = check(files, honestAnswer(files));
    expect(await result).toMatchObject({ status: 'checked', accepted: true });
    expect(runner.inputs()).toEqual([files.map((file) => file.path)]);
  });

  it('splits more files than one run takes into further runs, in order, each within the input limit', async () => {
    const files: AuthenticodeFile[] = [];
    for (let k = 0; k < 70; k += 1) files.push({ path: `C:\\pkg\\${'x'.repeat(200)}\\f${k}.dll`, signer: 'openai' });
    const { result, runner } = check(files, honestAnswer(files));
    const checked = await result;
    expect(checked).toMatchObject({ status: 'checked', accepted: true, counts: { openai: 70 } });
    expect(runner.requests.length).toBeGreaterThan(2);
    expect(runner.requests.every((request) => request.input.length <= AUTHENTICODE_MAX_INPUT_CHARS)).toBe(true);
    expect(runner.inputs().every((paths) => paths.length <= AUTHENTICODE_BATCH_MAX_FILES)).toBe(true);
    expect(runner.inputs().flat()).toEqual(files.map((file) => file.path));

    const long: AuthenticodeFile[] = [];
    for (let k = 0; k < 6; k += 1) long.push({ path: `C:\\pkg\\${'y'.repeat(4000)}\\f${k}.dll`, signer: 'openai' });
    const second = check(long, honestAnswer(long));
    expect(await second.result).toMatchObject({ status: 'checked', accepted: true });
    expect(second.runner.requests.length).toBeGreaterThan(1);
    expect(second.runner.requests.every((request) => request.input.length <= AUTHENTICODE_MAX_INPUT_CHARS)).toBe(true);
  });

  it('is unavailable, with no verdict at all, when any one run gives no answer', async () => {
    const files: AuthenticodeFile[] = [];
    for (let k = 0; k < 40; k += 1) files.push({ path: `C:\\pkg\\f${k}.dll`, signer: 'openai' });
    const honest = honestAnswer(files);
    const { result } = check(files, (paths, run) => run === 1
      ? { status: 'unavailable', reason: 'timeout', detail: 'Windows PowerShell did not finish within 90 seconds', stderr: '' }
      : honest(paths, run));
    const checked = await result;
    expect(checked).toEqual({
      status: 'unavailable', reason: 'no-answer', message: 'the signature check did not finish or returned an unreadable answer',
      diagnostic: 'Windows PowerShell did not finish within 90 seconds',
    });
  });

  it.each([
    ['CLM', exited('UNODE-AC1:CLM\r\n', 3), 'constrained-language'],
    ['ERR', exited('UNODE-AC1:ERR\r\n', 4), 'no-answer'],
    ['PowerShell not found', { status: 'unavailable', reason: 'not-found', detail: 'no SystemRoot', stderr: '' } as WindowsPowerShellRunResult, 'powershell-not-found'],
    ['more than 256 KiB', { status: 'unavailable', reason: 'output-limit', detail: 'too much', stderr: '' } as WindowsPowerShellRunResult, 'no-answer'],
  ])('is unavailable on %s, never a pass', async (_label, run, reason) => {
    const { result } = check([openaiFile, rgFile], () => run);
    const checked: AuthenticodeCheckResult = await result;
    expect(checked).toMatchObject({ status: 'unavailable', reason, message: AUTHENTICODE_UNAVAILABLE_TEXT[reason as keyof typeof AUTHENTICODE_UNAVAILABLE_TEXT] });
    expect(checked).not.toHaveProperty('accepted');
  });

  it('is not accepted when one file fails, and reports revoked apart from an ordinary failure', async () => {
    const files: AuthenticodeFile[] = [openaiFile, { path: 'C:\\pkg\\bin\\other.exe', signer: 'openai' }, rgFile];
    const respond = (statuses: string[]): Respond => () => {
      const revokedLeaf = certificate(rdnsOf(OPENAI_RDNS));
      return exited(answerText(
        [signed(0, OPENAI_LEAF), signed(1, revokedLeaf), unsignedResult(2)],
        { [thumbprintOf(OPENAI_LEAF)]: chainOf(OPENAI_LEAF, OPENAI_ROOT), [thumbprintOf(revokedLeaf)]: chainOf(revokedLeaf, OPENAI_ROOT, [[], statuses]) },
      ));
    };
    const revoked = await check(files, respond(['Revoked'])).result;
    expect(revoked).toMatchObject({ status: 'checked', accepted: false, revoked: true, counts: { openai: 1, unsigned: 1 } });
    const ordinary = await check(files, respond(['NotSignatureValid'])).result;
    expect(ordinary).toMatchObject({ status: 'checked', accepted: false, revoked: false });
  });

  it('shows revocation as not confirmed when one accepted signed file could not be checked online', async () => {
    const files: AuthenticodeFile[] = [openaiFile, crtFile];
    const { result } = check(files, () => exited(answerText(
      [signed(0, OPENAI_LEAF), signed(1, CRT_CATALOG_LEAF, { type: 'Catalog' })],
      {
        [thumbprintOf(OPENAI_LEAF)]: chainOf(OPENAI_LEAF, OPENAI_ROOT),
        [thumbprintOf(CRT_CATALOG_LEAF)]: chainOf(CRT_CATALOG_LEAF, CRT_CATALOG_ROOT, [['OfflineRevocation'], ['RevocationStatusUnknown']], { built: false, intermediates: [INTERMEDIATE_A] }),
      },
    )));
    expect(await result).toMatchObject({ status: 'checked', accepted: true, revocation: 'not-confirmed-offline' });
  });

  it('throws before anything runs for a relative path or an unknown signer token', async () => {
    const runner = fakeRunner(() => { throw new Error('ran'); });
    const base = { signers: SIGNERS, ownedFolder: 'C:\\owned', ownedTmp: 'C:\\owned\\tmp' };
    await expect(checkAuthenticodeSignatures({ ...base, files: [{ path: 'bin\\codex.exe', signer: 'openai' }] }, runner)).rejects.toThrow(TypeError);
    await expect(checkAuthenticodeSignatures({ ...base, files: [{ path: 'C:\\x.exe', signer: 'anthropic' as never }] }, runner)).rejects.toThrow(TypeError);
    await expect(checkAuthenticodeSignatures({ ...base, files: [{ path: 'C:\\x.dll', signer: 'microsoft-crt', pinnedDigestVerified: 'yes' as never }] }, runner)).rejects.toThrow(TypeError);
    expect(runner.requests).toHaveLength(0);
  });

  it('passes the package\'s CRT catalog chain with an expired intermediate only for a file whose bytes the caller verified', async () => {
    const pca2011Chain = chainOf(CRT_CATALOG_LEAF, CRT_CATALOG_ROOT, [['NotTimeValid'], ['NotTimeValid'], []], { intermediates: ['580A6F4CC4E4B669B9EBDC1B2B3E087B80D0678D'] });
    const respond: Respond = () => exited(answerText([signed(0, CRT_CATALOG_LEAF, { type: 'Catalog' })], { [thumbprintOf(CRT_CATALOG_LEAF)]: pca2011Chain }));
    const verified = await check([{ ...crtFile, pinnedDigestVerified: true }], respond).result;
    expect(verified).toMatchObject({ status: 'checked', accepted: true, counts: { 'microsoft-crt': 1 } });
    const unverified = await check([crtFile], respond).result;
    expect(unverified).toMatchObject({ status: 'checked', accepted: false, revoked: false, counts: { 'microsoft-crt': 0 } });
  });

  it('is unavailable when one path alone is too long to send', async () => {
    const { result, runner } = check([{ path: `C:\\${'z'.repeat(20_000)}.dll`, signer: 'openai' }], () => { throw new Error('ran'); });
    expect(await result).toMatchObject({ status: 'unavailable', reason: 'no-answer' });
    expect(runner.requests).toHaveLength(0);
  });
});

describe('checkAuthenticodeSignatures through the real runner (fake spawn)', () => {
  class FakeChild extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    pid = 77;
  }

  function throughRunner() {
    const spawned: Array<{ command: string; args: readonly string[]; options: SpawnOptions; child: FakeChild }> = [];
    const killed: ChildProcess[] = [];
    const timers: Array<() => void> = [];
    const result = checkAuthenticodeSignatures(
      { files: [openaiFile], signers: SIGNERS, ownedFolder: 'C:\\owned\\work', ownedTmp: 'C:\\owned\\work\\tmp' },
      {
        platform: 'win32',
        env: { SystemRoot: 'C:\\Windows', PSModulePath: 'C:\\Users\\me\\Documents\\WindowsPowerShell\\Modules', PATH: 'C:\\repo' },
        resolveExecutable: (command) => command,
        spawn: (command, args, options) => {
          const child = new FakeChild();
          spawned.push({ command, args, options, child });
          return child as unknown as ChildProcess;
        },
        killTree: (proc) => { killed.push(proc); },
        setTimer: (callback) => { timers.push(callback); return callback; },
        clearTimer: () => undefined,
      },
    );
    return { result, spawned, killed, timers };
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it('runs the pinned encoded script with the exact environment allowlist and the system PSModulePath', async () => {
    const h = throughRunner();
    await settle();
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0].args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-EncodedCommand', AUTHENTICODE_ENCODED_COMMAND]);
    expect(h.spawned[0].options.env).toEqual({
      SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', TEMP: 'C:\\owned\\work\\tmp', TMP: 'C:\\owned\\work\\tmp',
      PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
      UNODE_AC_INPUT: Buffer.from(JSON.stringify({ v: 1, files: [openaiFile.path] }), 'utf8').toString('base64'),
    });
    expect(h.spawned[0].options.cwd).toBe('C:\\owned\\work');
    h.spawned[0].child.stdout.emit('data', Buffer.from(answerText([signed(0, OPENAI_LEAF)], { [thumbprintOf(OPENAI_LEAF)]: chainOf(OPENAI_LEAF, OPENAI_ROOT) })));
    h.spawned[0].child.emit('close', 0, null);
    expect(await h.result).toMatchObject({ status: 'checked', accepted: true });
  });

  it('kills the tree at the time limit and is unavailable', async () => {
    const h = throughRunner();
    await settle();
    h.timers[0]();
    expect(await h.result).toMatchObject({ status: 'unavailable', reason: 'no-answer' });
    expect(h.killed).toEqual([h.spawned[0].child]);
  });

  it('is unavailable past 256 KiB of output', async () => {
    const h = throughRunner();
    await settle();
    h.spawned[0].child.stdout.emit('data', Buffer.alloc(256 * 1024 + 1, 0x41));
    expect(await h.result).toMatchObject({ status: 'unavailable', reason: 'no-answer' });
    expect(h.killed).toHaveLength(1);
  });
});
