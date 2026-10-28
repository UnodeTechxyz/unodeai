/*---------------------------------------------------------------------------------------------
 * v0.9.97: publisher signatures of a CLI package's files, as Windows reports them.
 *
 * Windows PowerShell reads each file's Authenticode signature with `Get-AuthenticodeSignature` and builds the signer's
 * chain once per distinct signer certificate. Reading a signature starts nothing from the file. The fixed script
 * reports, per file, the signature status and type, whether it is timestamped, and the signer certificate's own bytes;
 * per chain, whether it built, its own status list, and each element's thumbprint and status list, leaf first. A
 * status the chain reports must be one this module knows and must appear on an element, or the answer is not read.
 * This module decides.
 *
 * One file passes only as listed here, and everything not listed fails:
 * - its status is `Valid`, with a signature type one of the signer's alternatives names (OpenAI: `Authenticode` only;
 *   a catalog match on a vendor file is refused), and it is timestamped;
 * - its chain has at least two elements and ends at that alternative's pinned root;
 * - the leaf may carry `NotTimeValid`, `RevocationStatusUnknown` and `OfflineRevocation`; an intermediate only the two
 *   revocation statuses; the root nothing. Any other status, or one this module does not know, fails;
 * - one exception: a Microsoft CRT file matched through its Catalog alternative may also have intermediates that report
 *   `NotTimeValid`, when Windows judged the catalog signature `Valid` at its trusted timestamp and the caller has just
 *   verified the file's bytes against their pinned digest. Windows judges each certificate at the time of the
 *   timestamp; the chain built here, at the current time, then shows an intermediate that has expired since. No other
 *   signer or alternative gets this, and the root and every other status are judged as above;
 * - a chain that did not build passes only when every status it reports is allowed where it is and one of them says
 *   revocation could not be checked; such a file is shown as "revocation not confirmed (offline)";
 * - the subject of the signer certificate, read from its DER, is exactly the alternative's RDN list: the same order,
 *   the same count, each RDN single-valued, each value equal after decoding (the ASN.1 string type does not matter).
 * A file listed as unsigned must report `NotSigned` / `None`; a file that is not a PE is never sent. `Revoked`
 * anywhere in a chain fails the file and is reported apart from every other failure. Leaf thumbprints are never
 * compared with any recorded value: they change with every release, and the file's bytes are pinned anyway.
 *
 * No answer is ever a pass. PowerShell missing, restricted to constrained language, stopped at its time limit, over
 * its output limit, or printing anything but exactly one well-formed answer line makes the whole check `unavailable`.
 *--------------------------------------------------------------------------------------------*/

import Ajv from 'ajv';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import {
  encodePowerShellScript,
  runWindowsPowerShell,
  type WindowsPowerShellDeps,
  type WindowsPowerShellRequest,
  type WindowsPowerShellRunResult,
} from './windowsPowerShell';

// ---------------------------------------------------------------------------------------------
// The fixed script
// ---------------------------------------------------------------------------------------------

/**
 * The script, exactly as it runs. The chain is built online, without the root, with a 15 s retrieval limit and with
 * `IgnoreNotTimeValid`: `Valid` already honours the trusted timestamp, and a signer certificate may since have expired.
 * The chain's own status list is reported beside each element's. Progress records are switched off, so they cannot
 * fill the bounded stderr diagnostic; errors still stop the script. A test pins the SHA-256 of
 * `AUTHENTICODE_ENCODED_COMMAND`, so a change here is a reviewed change.
 */
export const AUTHENTICODE_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { 'UNODE-AC1:CLM'; exit 3 }
$ProgressPreference = 'SilentlyContinue'
try {
  $in = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:UNODE_AC_INPUT)))
  $results = New-Object System.Collections.ArrayList
  $chains = @{}
  for ($i = 0; $i -lt @($in.files).Count; $i++) {
    $s = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath @($in.files)[$i]
    $c = $s.SignerCertificate
    $r = [ordered]@{ i = $i; status = [string]$s.Status; type = [string]$s.SignatureType
                     leaf = $null; leafDer = $null; timestamped = [bool]$s.TimeStamperCertificate }
    if ($c) {
      $r.leaf = $c.Thumbprint; $r.leafDer = [Convert]::ToBase64String($c.RawData)
      if (-not $chains.ContainsKey($c.Thumbprint)) {
        $ch = New-Object System.Security.Cryptography.X509Certificates.X509Chain
        $ch.ChainPolicy.RevocationMode = 'Online'
        $ch.ChainPolicy.RevocationFlag = 'ExcludeRoot'
        $ch.ChainPolicy.UrlRetrievalTimeout = [TimeSpan]::FromSeconds(15)
        $ch.ChainPolicy.VerificationFlags = 'IgnoreNotTimeValid'
        $built = $ch.Build($c)
        $elements = @(foreach ($e in $ch.ChainElements) {
          [ordered]@{ thumb = $e.Certificate.Thumbprint; status = @(foreach ($t in $e.ChainElementStatus) { [string]$t.Status }) } })
        $chains[$c.Thumbprint] = [ordered]@{ built = [bool]$built
          status = @(foreach ($t in $ch.ChainStatus) { [string]$t.Status }); elements = $elements }
      }
    }
    [void]$results.Add($r)
  }
  $json = ConvertTo-Json -Compress -Depth 8 ([ordered]@{ v = 1; results = $results; chains = $chains })
  'UNODE-AC1:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
} catch { 'UNODE-AC1:ERR'; exit 4 }
`;

/** What `-EncodedCommand` receives. */
export const AUTHENTICODE_ENCODED_COMMAND = encodePowerShellScript(AUTHENTICODE_SCRIPT);

/** The one variable that carries the input: base64 of UTF-8 JSON `{ v: 1, files: [absolute paths] }`. */
export const AUTHENTICODE_INPUT_VARIABLE = 'UNODE_AC_INPUT';
/** The longest input of one run; more files go into further runs. */
export const AUTHENTICODE_MAX_INPUT_CHARS = 24 * 1024;
/**
 * The most files in one run. Each result carries its signer certificate (about 3 KiB of base64 for the leaves seen),
 * so this keeps one answer well inside `AUTHENTICODE_MAX_OUTPUT_BYTES`.
 */
export const AUTHENTICODE_BATCH_MAX_FILES = 32;
export const AUTHENTICODE_BATCH_TIMEOUT_MS = 90_000;
export const AUTHENTICODE_MAX_OUTPUT_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/** How a file of a package is signed, as its policy entry lists it. */
export type AuthenticodeSignerToken = 'openai' | 'microsoft-crt' | 'unsigned' | 'none';
/** The signers that have pinned identities. */
export type AuthenticodePublisher = 'openai' | 'microsoft-crt';

/** One accepted identity of a publisher. */
export interface AuthenticodeSignerRule {
  signatureType: 'Authenticode' | 'Catalog';
  /** The signer certificate's subject, RDN by RDN in DER order, each `[oid, value]`. */
  subjectRdns: ReadonlyArray<readonly [string, string]>;
  /** The thumbprint of the chain's last element, 40 hex digits. */
  rootThumbprint: string;
}

/** Each publisher's accepted identities; one alternative passing is enough. */
export type AuthenticodeSigners = Readonly<Record<AuthenticodePublisher, { readonly accepted: readonly AuthenticodeSignerRule[] }>>;

export interface AuthenticodeFile {
  /** Absolute Windows path. */
  path: string;
  signer: AuthenticodeSignerToken;
  /**
   * True only when the caller has just verified that this file's bytes equal the SHA-256 its policy entry pins. The
   * entry's pin for the Microsoft CRT is itself checked, when the entry is made, to equal the package's own record of
   * that DLL. Only then may a CRT catalog chain with an expired intermediate pass.
   */
  pinnedDigestVerified?: boolean;
}

export interface AuthenticodeCheckRequest {
  files: readonly AuthenticodeFile[];
  signers: AuthenticodeSigners;
  /** A folder the caller owns: PowerShell's working folder. */
  ownedFolder: string;
  /** A folder the caller owns: PowerShell's TEMP and TMP. */
  ownedTmp: string;
  workspaceRoots?: readonly string[];
  worktreeRoots?: readonly string[];
}

export interface AuthenticodeCheckDeps extends WindowsPowerShellDeps {
  /** One run of the fixed script; `runWindowsPowerShell` with the other dependencies by default. */
  runPowerShell?: (request: WindowsPowerShellRequest) => Promise<WindowsPowerShellRunResult>;
}

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

export type AuthenticodeUnavailableReason = 'powershell-not-found' | 'constrained-language' | 'no-answer';

/** The fixed words for each reason, as the card, the dialog and the manifest show them. */
export const AUTHENTICODE_UNAVAILABLE_TEXT: Readonly<Record<AuthenticodeUnavailableReason, string>> = {
  'powershell-not-found': 'PowerShell not found',
  'constrained-language': 'PowerShell is restricted by policy (constrained language)',
  'no-answer': 'the signature check did not finish or returned an unreadable answer',
};

/** How an accepted signed file whose chain could not be checked for revocation is shown. */
export const AUTHENTICODE_OFFLINE_TEXT = 'revocation not confirmed (offline)';

export type AuthenticodeRevocation = 'confirmed-online' | 'not-confirmed-offline';

export type AuthenticodeFileVerdict =
  | {
    path: string;
    signer: AuthenticodePublisher;
    accepted: true;
    /** Which of the signer's alternatives passed (its index in `accepted`). */
    alternative: number;
    signatureType: 'Authenticode' | 'Catalog';
    revocation: AuthenticodeRevocation;
  }
  | { path: string; signer: 'unsigned'; accepted: true }
  | {
    path: string;
    signer: AuthenticodeSignerToken;
    accepted: false;
    /** A certificate of the file's chain is revoked: the version is bad, not merely unverified. */
    revoked: boolean;
    reason: string;
    /** What Windows reported, for the record. */
    reported: { status: string; type: string };
  };

export type AuthenticodeCheckResult =
  | {
    status: 'checked';
    /** True only when every file that was sent passed. */
    accepted: boolean;
    /** True when any file failed because a certificate of its chain is revoked. */
    revoked: boolean;
    /** One verdict per file that was sent, in the order of the request. */
    files: AuthenticodeFileVerdict[];
    /** The files listed `none`, which are not PE files and were not sent. */
    notSent: string[];
    /** Accepted files per signer. */
    counts: Record<AuthenticodePublisher | 'unsigned', number>;
    /** The accepted files that carry no signature, to be named as not verified. */
    unsignedFiles: string[];
    /** `not-confirmed-offline` when any accepted signed file is; `not-applicable` when none is signed. */
    revocation: AuthenticodeRevocation | 'not-applicable';
  }
  | { status: 'unavailable'; reason: AuthenticodeUnavailableReason; message: string; diagnostic: string };

// ---------------------------------------------------------------------------------------------
// Parsing the answer
// ---------------------------------------------------------------------------------------------

export interface AuthenticodeRawResult {
  i: number;
  status: string;
  type: string;
  leaf: string | null;
  leafDer: string | null;
  timestamped: boolean;
}

export interface AuthenticodeRawChain {
  built: boolean;
  /** The chain's own status list (`X509Chain.ChainStatus`). */
  status: string[];
  /** Leaf first, root last. */
  elements: Array<{ thumb: string; status: string[] }>;
}

export type AuthenticodeParse =
  | { ok: true; results: AuthenticodeRawResult[]; chains: Record<string, AuthenticodeRawChain> }
  | { ok: false; reason: AuthenticodeUnavailableReason; diagnostic: string };

const THUMBPRINT = '^[0-9A-F]{40}$';
const BASE64_TEXT = '^[A-Za-z0-9+/]+={0,2}$';
const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['v', 'results', 'chains'],
  properties: {
    v: { const: 1 },
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['i', 'status', 'type', 'leaf', 'leafDer', 'timestamped'],
        properties: {
          i: { type: 'integer', minimum: 0 },
          status: { type: 'string', maxLength: 64 },
          type: { type: 'string', maxLength: 64 },
          leaf: { anyOf: [{ type: 'null' }, { type: 'string', pattern: THUMBPRINT }] },
          leafDer: { anyOf: [{ type: 'null' }, { type: 'string', maxLength: 65_536, pattern: BASE64_TEXT }] },
          timestamped: { type: 'boolean' },
        },
      },
    },
    chains: {
      type: 'object',
      propertyNames: { pattern: THUMBPRINT },
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['built', 'status', 'elements'],
        properties: {
          built: { type: 'boolean' },
          status: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 64 } },
          elements: {
            type: 'array',
            minItems: 1,
            maxItems: 16,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['thumb', 'status'],
              properties: {
                thumb: { type: 'string', pattern: THUMBPRINT },
                status: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 64 } },
              },
            },
          },
        },
      },
    },
  },
} as const;

let validateAnswer: ((value: unknown) => boolean) | undefined;
function answerIsWellFormed(value: unknown): boolean {
  validateAnswer ??= new Ajv({ strict: true, allErrors: false }).compile(ANSWER_SCHEMA);
  return validateAnswer(value);
}

const ANSWER_LINE = /^UNODE-AC1:([A-Za-z0-9+/]+={0,2})$/;

/**
 * Read one run's answer for `fileCount` files. Accepted only when PowerShell exited 0 and printed exactly one line
 * `UNODE-AC1:<base64>` whose UTF-8 JSON passes the schema with `v: 1`, has one result for each index `0..n-1` and no
 * other, and carries the chain of every signer certificate it names, built from that certificate, and no other chain.
 * Every status a chain reports for itself, `NoError` aside, must be one this module knows and must appear on one of
 * its elements: a failure .NET reports only for the whole chain would otherwise go unjudged.
 */
export function parseAuthenticodeAnswer(run: WindowsPowerShellRunResult, fileCount: number): AuthenticodeParse {
  const noAnswer = (diagnostic: string): AuthenticodeParse => ({ ok: false, reason: 'no-answer', diagnostic });
  if (run.status === 'unavailable') {
    return {
      ok: false,
      reason: run.reason === 'not-found' ? 'powershell-not-found' : 'no-answer',
      diagnostic: joinDiagnostic(run.detail, run.stderr),
    };
  }
  const text = run.stdout.trim();
  if (text === 'UNODE-AC1:CLM') return { ok: false, reason: 'constrained-language', diagnostic: joinDiagnostic('', run.stderr) };
  if (run.code !== 0) return noAnswer(joinDiagnostic(`PowerShell exited ${run.code ?? `on ${run.signal ?? 'an unknown signal'}`}`, run.stderr));
  const line = ANSWER_LINE.exec(text);
  if (!line) return noAnswer(joinDiagnostic('PowerShell did not print exactly one answer line', run.stderr));
  const encoded = line[1];
  const bytes = Buffer.from(encoded, 'base64');
  if (encoded.length % 4 !== 0 || bytes.toString('base64') !== encoded) return noAnswer('the answer is not canonical base64');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return noAnswer('the answer is not UTF-8 JSON');
  }
  if (!answerIsWellFormed(value)) return noAnswer('the answer does not have the expected form');
  const answer = value as { results: AuthenticodeRawResult[]; chains: Record<string, AuthenticodeRawChain> };
  if (answer.results.length !== fileCount) {
    return noAnswer(`the answer has ${answer.results.length} results for ${fileCount} files`);
  }
  const byIndex: AuthenticodeRawResult[] = [];
  for (const result of answer.results) {
    if (result.i >= fileCount || byIndex[result.i] !== undefined) return noAnswer(`the answer has an unexpected or repeated index ${result.i}`);
    byIndex[result.i] = result;
  }
  const leaves = new Set<string>();
  for (const result of byIndex) {
    if ((result.leaf === null) !== (result.leafDer === null)) return noAnswer(`result ${result.i} names a signer certificate only in part`);
    if (result.leaf === null || result.leafDer === null) continue;
    // The certificate whose subject is read is the one whose chain was built: its thumbprint is the SHA-1 of its DER.
    const thumbprint = createHash('sha1').update(Buffer.from(result.leafDer, 'base64')).digest('hex').toUpperCase();
    if (thumbprint !== result.leaf) return noAnswer(`result ${result.i} carries a certificate that is not its signer certificate`);
    const chain = Object.hasOwn(answer.chains, result.leaf) ? answer.chains[result.leaf] : undefined;
    if (!chain) return noAnswer(`the answer has no chain for the signer certificate of result ${result.i}`);
    if (chain.elements[0].thumb !== result.leaf) return noAnswer(`the chain for result ${result.i} does not start at its signer certificate`);
    for (const status of chain.status) {
      if (status === 'NoError') continue;
      if (!KNOWN_CHAIN_STATUSES.has(status)) return noAnswer(`the chain for result ${result.i} reports a status this check does not know`);
      if (!chain.elements.some((element) => element.status.includes(status))) {
        return noAnswer(`the chain for result ${result.i} reports ${status} for the whole chain but on none of its certificates`);
      }
    }
    leaves.add(result.leaf);
  }
  if (Object.keys(answer.chains).some((thumbprint) => !leaves.has(thumbprint))) return noAnswer('the answer has a chain no result names');
  return { ok: true, results: byIndex, chains: answer.chains };
}

function joinDiagnostic(detail: string, stderr: string): string {
  return [detail, stderr.trim() ? `stderr: ${stderr.trim()}` : ''].filter(Boolean).join('; ');
}

// ---------------------------------------------------------------------------------------------
// The subject of a certificate, read from its DER
// ---------------------------------------------------------------------------------------------

/** One attribute of an RDN: `[oid, decoded value]`. */
export type SubjectAttribute = [oid: string, value: string];

/** The subject's RDNs in DER order; an RDN with more than one attribute is multi-valued. */
export type CertificateSubjectRead =
  | { ok: true; rdns: SubjectAttribute[][] }
  | { ok: false; problem: string };

class DerError extends Error {}

interface Tlv { tag: number; start: number; end: number }

function readTlv(der: Uint8Array, offset: number, limit: number): Tlv {
  if (offset + 2 > limit) throw new DerError('truncated element');
  const tag = der[offset];
  if ((tag & 0x1f) === 0x1f) throw new DerError('a multi-byte tag');
  const first = der[offset + 1];
  let length: number;
  let header = 2;
  if (first < 0x80) {
    length = first;
  } else {
    const count = first & 0x7f;
    if (count === 0) throw new DerError('an indefinite length');
    if (count > 4 || offset + 2 + count > limit) throw new DerError('an unreadable length');
    if (der[offset + 2] === 0) throw new DerError('a length with a leading zero');
    length = 0;
    for (let k = 0; k < count; k += 1) length = length * 256 + der[offset + 2 + k];
    if (length < 0x80) throw new DerError('a long-form length for a short element');
    header += count;
  }
  const start = offset + header;
  const end = start + length;
  if (end > limit) throw new DerError('an element longer than its container');
  return { tag, start, end };
}

/** The elements that fill `parent` exactly. */
function childrenOf(der: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let offset = parent.start; offset < parent.end;) {
    const child = readTlv(der, offset, parent.end);
    out.push(child);
    offset = child.end;
  }
  return out;
}

function expectTag(element: Tlv | undefined, tag: number, what: string): Tlv {
  if (!element || element.tag !== tag) throw new DerError(`${what} is missing or has another type`);
  return element;
}

function decodeOid(der: Uint8Array, element: Tlv): string {
  if (element.end === element.start) throw new DerError('an empty object identifier');
  const arcs: number[] = [];
  let value = 0;
  let fresh = true;
  for (let offset = element.start; offset < element.end; offset += 1) {
    const byte = der[offset];
    if (fresh && byte === 0x80) throw new DerError('an object identifier with a padded arc');
    value = value * 128 + (byte & 0x7f);
    if (value > Number.MAX_SAFE_INTEGER) throw new DerError('an object identifier arc too large');
    fresh = (byte & 0x80) === 0;
    if (fresh) {
      if (arcs.length === 0) arcs.push(value < 40 ? 0 : value < 80 ? 1 : 2, value < 80 ? value % 40 : value - 80);
      else arcs.push(value);
      value = 0;
    }
  }
  if (!fresh) throw new DerError('a truncated object identifier');
  return arcs.join('.');
}

const PRINTABLE = /^[A-Za-z0-9 '()+,\-./:=?]*$/;

/** The value of a directory string, decoded; a type whose characters are not fixed (T.61) is refused. */
function decodeString(der: Uint8Array, element: Tlv): string {
  const bytes = der.subarray(element.start, element.end);
  const ascii = (allowed: (byte: number) => boolean, what: string) => {
    if (!bytes.every(allowed)) throw new DerError(`${what} with a character outside its set`);
    return Buffer.from(bytes).toString('latin1');
  };
  switch (element.tag) {
    case 0x0c: // UTF8String
      try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        throw new DerError('a UTF8String that is not UTF-8');
      }
    case 0x13: { // PrintableString
      const text = ascii((byte) => byte < 0x80, 'a PrintableString');
      if (!PRINTABLE.test(text)) throw new DerError('a PrintableString with a character outside its set');
      return text;
    }
    case 0x16: return ascii((byte) => byte < 0x80, 'an IA5String');
    case 0x1a: return ascii((byte) => byte >= 0x20 && byte < 0x7f, 'a VisibleString');
    case 0x12: return ascii((byte) => byte === 0x20 || (byte >= 0x30 && byte <= 0x39), 'a NumericString');
    case 0x1e: { // BMPString: UCS-2, big-endian
      if (bytes.length % 2 !== 0) throw new DerError('a BMPString of odd length');
      let text = '';
      for (let k = 0; k < bytes.length; k += 2) {
        const unit = bytes[k] * 256 + bytes[k + 1];
        if (unit >= 0xd800 && unit <= 0xdfff) throw new DerError('a BMPString with a surrogate');
        text += String.fromCharCode(unit);
      }
      return text;
    }
    case 0x1c: { // UniversalString: UCS-4, big-endian
      if (bytes.length % 4 !== 0) throw new DerError('a UniversalString whose length is not a multiple of four');
      let text = '';
      for (let k = 0; k < bytes.length; k += 4) {
        const point = ((bytes[k] << 24) >>> 0) + (bytes[k + 1] << 16) + (bytes[k + 2] << 8) + bytes[k + 3];
        if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw new DerError('a UniversalString with an invalid character');
        text += String.fromCodePoint(point);
      }
      return text;
    }
    default:
      throw new DerError(`a value of ASN.1 type 0x${element.tag.toString(16)}, which is not a string this check reads`);
  }
}

/**
 * The subject Name of an X.509 certificate: Certificate → TBSCertificate → subject, as the ordered list of its RDNs,
 * each the list of its `[oid, decoded value]` attributes. Strict DER: definite minimal lengths, single-byte tags, every
 * element inside its container, nothing after the certificate. Anything else is a problem, never a guess.
 */
export function readCertificateSubject(der: Uint8Array): CertificateSubjectRead {
  try {
    const certificate = expectTag(readTlv(der, 0, der.length), 0x30, 'the certificate');
    if (certificate.end !== der.length) throw new DerError('bytes after the certificate');
    const parts = childrenOf(der, certificate);
    if (parts.length !== 3) throw new DerError('a certificate without exactly three parts');
    const tbs = expectTag(parts[0], 0x30, 'the TBSCertificate');
    expectTag(parts[1], 0x30, 'the signature algorithm');
    expectTag(parts[2], 0x03, 'the signature');
    const fields = childrenOf(der, tbs);
    const first = fields[0]?.tag === 0xa0 ? 1 : 0;
    expectTag(fields[first], 0x02, 'the serial number');
    expectTag(fields[first + 1], 0x30, 'the TBS signature algorithm');
    expectTag(fields[first + 2], 0x30, 'the issuer');
    expectTag(fields[first + 3], 0x30, 'the validity');
    const subject = expectTag(fields[first + 4], 0x30, 'the subject');
    expectTag(fields[first + 5], 0x30, 'the subject public key');
    const rdns = childrenOf(der, subject).map((rdn) => {
      const attributes = childrenOf(der, expectTag(rdn, 0x31, 'an RDN'));
      if (attributes.length === 0) throw new DerError('an empty RDN');
      return attributes.map((attribute): SubjectAttribute => {
        const pair = childrenOf(der, expectTag(attribute, 0x30, 'an attribute'));
        if (pair.length !== 2) throw new DerError('an attribute without exactly a type and a value');
        return [decodeOid(der, expectTag(pair[0], 0x06, 'an attribute type')), decodeString(der, pair[1])];
      });
    });
    return { ok: true, rdns };
  } catch (error) {
    if (error instanceof DerError) return { ok: false, problem: `the signer certificate cannot be read: ${error.message}` };
    throw error;
  }
}

/** Why `rdns` is not exactly `expected`, or undefined when it is. */
export function subjectMismatch(rdns: readonly SubjectAttribute[][], expected: ReadonlyArray<readonly [string, string]>): string | undefined {
  if (rdns.length !== expected.length) return `the subject has ${rdns.length} RDNs, not ${expected.length}`;
  for (let k = 0; k < expected.length; k += 1) {
    if (rdns[k].length !== 1) return `RDN ${k + 1} of the subject is multi-valued`;
    const [oid, value] = rdns[k][0];
    if (oid !== expected[k][0] || value !== expected[k][1]) return `RDN ${k + 1} of the subject is not the pinned ${expected[k][0]}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Acceptance of one file
// ---------------------------------------------------------------------------------------------

/** Every name .NET gives an `X509ChainStatusFlags` value; a name outside this list is unknown and fails. */
const KNOWN_CHAIN_STATUSES = new Set([
  'NoError', 'NotTimeValid', 'NotTimeNested', 'Revoked', 'NotSignatureValid', 'NotValidForUsage', 'UntrustedRoot',
  'RevocationStatusUnknown', 'Cyclic', 'InvalidExtension', 'InvalidPolicyConstraints', 'InvalidBasicConstraints',
  'InvalidNameConstraints', 'HasNotSupportedNameConstraint', 'HasNotDefinedNameConstraint',
  'HasNotPermittedNameConstraint', 'HasExcludedNameConstraint', 'PartialChain', 'CtlNotTimeValid',
  'CtlNotSignatureValid', 'CtlNotValidForUsage', 'HasWeakSignature', 'OfflineRevocation', 'NoIssuanceChainPolicy',
  'ExplicitDistrust', 'HasNotSupportedCriticalExtension',
]);
/** The statuses that say revocation could not be checked. */
const OFFLINE_STATUSES = new Set(['RevocationStatusUnknown', 'OfflineRevocation']);
const LEAF_ALLOWED = new Set(['NotTimeValid', 'RevocationStatusUnknown', 'OfflineRevocation']);
const INTERMEDIATE_ALLOWED = new Set(['RevocationStatusUnknown', 'OfflineRevocation']);
/** An intermediate of a Microsoft CRT catalog chain, and only when `crtCatalogIntermediateMayHaveExpired` holds. */
const CRT_CATALOG_INTERMEDIATE_ALLOWED = new Set([...INTERMEDIATE_ALLOWED, 'NotTimeValid']);
const ROOT_ALLOWED = new Set<string>();

type ChainJudgement = { ok: true; revocation: AuthenticodeRevocation } | { ok: false; reason: string };

/**
 * Whether this file's chain may have intermediates that expired after the signature was made. Only a file its entry
 * lists as `microsoft-crt`, judged against that signer's Catalog alternative, whose catalog signature Windows reports
 * `Valid` and timestamped, and whose bytes the caller has just verified against their pinned digest. The pinned
 * subject and root are then checked for this alternative exactly as for every other.
 */
export function crtCatalogIntermediateMayHaveExpired(file: AuthenticodeFile, rule: AuthenticodeSignerRule, result: AuthenticodeRawResult): boolean {
  return file.signer === 'microsoft-crt'
    && rule.signatureType === 'Catalog'
    && result.status === 'Valid'
    && result.type === 'Catalog'
    && result.timestamped === true
    && file.pinnedDigestVerified === true;
}

/** The chain against one pinned root. `Revoked` is judged before this, for every file. */
function judgeChain(chain: AuthenticodeRawChain, rootThumbprint: string, intermediateAllowed: ReadonlySet<string>): ChainJudgement {
  const { elements } = chain;
  if (elements.length < 2) return { ok: false, reason: `its chain has ${elements.length} element, not at least two` };
  const last = elements.length - 1;
  if (elements[last].thumb !== rootThumbprint.toUpperCase()) return { ok: false, reason: 'its chain does not end at the pinned root' };
  for (let k = 0; k <= last; k += 1) {
    const allowed = k === 0 ? LEAF_ALLOWED : k === last ? ROOT_ALLOWED : intermediateAllowed;
    const where = k === 0 ? 'the signer certificate' : k === last ? 'the root' : `intermediate ${k}`;
    for (const status of elements[k].status) {
      if (allowed.has(status)) continue;
      return {
        ok: false,
        reason: KNOWN_CHAIN_STATUSES.has(status)
          ? `${where} of its chain reports ${status}`
          : `${where} of its chain reports a status this check does not know ("${status}")`,
      };
    }
  }
  const offline = elements.some((element) => element.status.some((status) => OFFLINE_STATUSES.has(status)));
  if (!chain.built && !offline) return { ok: false, reason: 'its chain did not build, and no status says revocation could not be checked' };
  return { ok: true, revocation: offline ? 'not-confirmed-offline' : 'confirmed-online' };
}

const OID = /^[0-2](\.(0|[1-9][0-9]*))+$/;

function ruleProblem(rule: AuthenticodeSignerRule | undefined): string | undefined {
  if (!rule || (rule.signatureType !== 'Authenticode' && rule.signatureType !== 'Catalog')) return 'an alternative has no valid signature type';
  if (typeof rule.rootThumbprint !== 'string' || !/^[0-9A-Fa-f]{40}$/.test(rule.rootThumbprint)) return 'an alternative has no valid root thumbprint';
  if (!Array.isArray(rule.subjectRdns) || rule.subjectRdns.length === 0) return 'an alternative has no subject';
  const pairsValid = rule.subjectRdns.every((pair) => Array.isArray(pair) && pair.length === 2
    && typeof pair[0] === 'string' && OID.test(pair[0]) && typeof pair[1] === 'string');
  return pairsValid ? undefined : 'an alternative has a malformed subject RDN';
}

/**
 * One file's result against the signer its entry lists. `chain` is the chain of the result's signer certificate,
 * when it has one. Everything this does not accept fails.
 */
export function judgeAuthenticodeFile(
  file: AuthenticodeFile,
  result: AuthenticodeRawResult,
  chain: AuthenticodeRawChain | undefined,
  signers: AuthenticodeSigners,
): AuthenticodeFileVerdict {
  const fail = (reason: string, revoked = false): AuthenticodeFileVerdict => ({
    path: file.path, signer: file.signer, accepted: false, revoked, reason,
    reported: { status: result.status, type: result.type },
  });
  // A revoked certificate makes the version bad whatever else is true of the file.
  if (chain?.elements.some((element) => element.status.includes('Revoked'))) return fail('a certificate of its chain is revoked', true);

  if (file.signer === 'unsigned') {
    if (result.status === 'NotSigned' && result.type === 'None' && result.leaf === null) {
      return { path: file.path, signer: 'unsigned', accepted: true };
    }
    return fail(`it is listed as unsigned, but Windows reports ${result.status} / ${result.type}`);
  }
  if (file.signer !== 'openai' && file.signer !== 'microsoft-crt') return fail('a file that is not a PE is never checked');

  const signer = file.signer;
  const accepted = Object.hasOwn(signers, signer) ? signers[signer]?.accepted : undefined;
  if (!Array.isArray(accepted) || accepted.length === 0) return fail(`no identity is pinned for ${signer}`);
  const invalid = accepted.map(ruleProblem).find((problem) => problem !== undefined);
  if (invalid) return fail(`the pinned identity of ${signer} is invalid: ${invalid}`);

  if (result.status !== 'Valid') return fail(`Windows reports its signature as ${result.status}`);
  if (!result.timestamped) return fail('its signature has no timestamp');
  if (result.leaf === null || result.leafDer === null || !chain) return fail('Windows reports no signer certificate');
  const subject = readCertificateSubject(Buffer.from(result.leafDer, 'base64'));
  if (!subject.ok) return fail(subject.problem);

  const reasons: string[] = [];
  for (let k = 0; k < accepted.length; k += 1) {
    const rule = accepted[k];
    // A vendor file is signed by the vendor itself: a catalog match never stands for OpenAI.
    if (signer === 'openai' && rule.signatureType !== 'Authenticode') {
      reasons.push(`alternative ${k + 1} is not an embedded signature`);
      continue;
    }
    if (result.type !== rule.signatureType) {
      reasons.push(`alternative ${k + 1} expects ${rule.signatureType}, not ${result.type}`);
      continue;
    }
    const intermediateAllowed = crtCatalogIntermediateMayHaveExpired(file, rule, result) ? CRT_CATALOG_INTERMEDIATE_ALLOWED : INTERMEDIATE_ALLOWED;
    const judged = judgeChain(chain, rule.rootThumbprint, intermediateAllowed);
    if (!judged.ok) {
      reasons.push(`alternative ${k + 1}: ${judged.reason}`);
      continue;
    }
    const mismatch = subjectMismatch(subject.rdns, rule.subjectRdns);
    if (mismatch) {
      reasons.push(`alternative ${k + 1}: ${mismatch}`);
      continue;
    }
    return { path: file.path, signer, accepted: true, alternative: k, signatureType: rule.signatureType, revocation: judged.revocation };
  }
  return fail(`its signature is not a pinned ${signer} signature (${reasons.join('; ')})`);
}

// ---------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------

const SIGNER_TOKENS: readonly AuthenticodeSignerToken[] = ['openai', 'microsoft-crt', 'unsigned', 'none'];

function encodeInput(paths: readonly string[]): string {
  return Buffer.from(JSON.stringify({ v: 1, files: paths }), 'utf8').toString('base64');
}

/** Consecutive runs, each within the file and input limits; undefined when one path alone is over the input limit. */
function batchesOf(sent: readonly AuthenticodeFile[]): AuthenticodeFile[][] | undefined {
  const batches: AuthenticodeFile[][] = [];
  let current: AuthenticodeFile[] = [];
  for (const file of sent) {
    const candidate = [...current, file];
    if (candidate.length <= AUTHENTICODE_BATCH_MAX_FILES
      && encodeInput(candidate.map((item) => item.path)).length <= AUTHENTICODE_MAX_INPUT_CHARS) {
      current = candidate;
      continue;
    }
    if (current.length === 0) return undefined;
    batches.push(current);
    current = [file];
    if (encodeInput([file.path]).length > AUTHENTICODE_MAX_INPUT_CHARS) return undefined;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function unavailable(reason: AuthenticodeUnavailableReason, diagnostic: string): AuthenticodeCheckResult {
  return { status: 'unavailable', reason, message: AUTHENTICODE_UNAVAILABLE_TEXT[reason], diagnostic };
}

/**
 * Check every file of `request.files` against the signer it lists. Files listed `none` are not sent. The runs go one
 * after another; one run without an answer makes the whole check `unavailable`, so no file is ever judged on a
 * partial answer. A request built wrongly (a relative path, an unknown signer token) throws a `TypeError`.
 */
export async function checkAuthenticodeSignatures(
  request: AuthenticodeCheckRequest,
  deps: AuthenticodeCheckDeps = {},
): Promise<AuthenticodeCheckResult> {
  for (const file of request.files) {
    if (typeof file.path !== 'string' || !path.win32.isAbsolute(file.path) || file.path.includes('\0')) {
      throw new TypeError(`The signature check was not started: "${String(file.path)}" is not an absolute Windows path.`);
    }
    if (!SIGNER_TOKENS.includes(file.signer)) throw new TypeError(`The signature check was not started: "${String(file.signer)}" is not a signer.`);
    if (file.pinnedDigestVerified !== undefined && typeof file.pinnedDigestVerified !== 'boolean') {
      throw new TypeError('The signature check was not started: pinnedDigestVerified is not true or false.');
    }
  }
  const sent = request.files.filter((file) => file.signer !== 'none');
  const notSent = request.files.filter((file) => file.signer === 'none').map((file) => file.path);
  const batches = batchesOf(sent);
  if (!batches) return unavailable('no-answer', 'a path is too long to be sent to the check');
  const run = deps.runPowerShell ?? ((powerShellRequest: WindowsPowerShellRequest) => runWindowsPowerShell(powerShellRequest, deps));

  // The batches split `sent` in its order, so the verdicts come out in the order of the request.
  const files: AuthenticodeFileVerdict[] = [];
  for (const batch of batches) {
    const answer = parseAuthenticodeAnswer(await run({
      encodedCommand: AUTHENTICODE_ENCODED_COMMAND,
      inputVariable: AUTHENTICODE_INPUT_VARIABLE,
      input: encodeInput(batch.map((file) => file.path)),
      maxInputChars: AUTHENTICODE_MAX_INPUT_CHARS,
      cwd: request.ownedFolder,
      tmp: request.ownedTmp,
      timeoutMs: AUTHENTICODE_BATCH_TIMEOUT_MS,
      maxStdoutBytes: AUTHENTICODE_MAX_OUTPUT_BYTES,
      workspaceRoots: request.workspaceRoots ?? [],
      worktreeRoots: request.worktreeRoots ?? [],
    }), batch.length);
    if (!answer.ok) return unavailable(answer.reason, answer.diagnostic);
    batch.forEach((file, k) => {
      const result = answer.results[k];
      const chain = result.leaf !== null ? answer.chains[result.leaf] : undefined;
      files.push(judgeAuthenticodeFile(file, result, chain, request.signers));
    });
  }

  const counts: Record<AuthenticodePublisher | 'unsigned', number> = { openai: 0, 'microsoft-crt': 0, unsigned: 0 };
  let offline = false;
  let signed = false;
  for (const verdict of files) {
    if (!verdict.accepted) continue;
    counts[verdict.signer] += 1;
    if (verdict.signer === 'unsigned') continue;
    signed = true;
    if (verdict.revocation === 'not-confirmed-offline') offline = true;
  }
  return {
    status: 'checked',
    accepted: files.every((verdict) => verdict.accepted),
    revoked: files.some((verdict) => !verdict.accepted && verdict.revoked),
    files,
    notSent,
    counts,
    unsignedFiles: files.filter((verdict) => verdict.accepted && verdict.signer === 'unsigned').map((verdict) => verdict.path),
    revocation: !signed ? 'not-applicable' : offline ? 'not-confirmed-offline' : 'confirmed-online',
  };
}
