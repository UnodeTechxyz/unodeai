import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTHENTICODE_BATCH_TIMEOUT_MS,
  AUTHENTICODE_ENCODED_COMMAND,
  AUTHENTICODE_INPUT_VARIABLE,
  AUTHENTICODE_MAX_INPUT_CHARS,
  AUTHENTICODE_MAX_OUTPUT_BYTES,
  checkAuthenticodeSignatures,
  parseAuthenticodeAnswer,
  readCertificateSubject,
  type AuthenticodeSigners,
} from '../windowsAuthenticode';
import { runWindowsPowerShell } from '../windowsPowerShell';

/*
 * The real runner and parser on this Windows host: the system's PowerShell reads signatures of files already on disk.
 * Nothing is executed from those files. The Node executable running the tests is the signed file; a PE stub written
 * here, never started, is the unsigned one. The OpenAI rule is not applied to Node: this proves the script, the
 * runner and the parser against real Windows output, not a publisher.
 */

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function ownedFolder(): { cwd: string; tmp: string; root: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'unode-authenticode-'));
  folders.push(root);
  const tmp = path.join(root, 'tmp');
  mkdirSync(tmp);
  return { cwd: root, tmp, root };
}

/** A minimal PE32+ image with no signature. It is written to be read, never started. */
function unsignedPeStub(): Buffer {
  const image = Buffer.alloc(0x400);
  image.write('MZ', 0, 'latin1');
  image.writeUInt32LE(0x40, 0x3c);
  image.write('PE\0\0', 0x40, 'latin1');
  const coff = 0x44;
  image.writeUInt16LE(0x8664, coff);
  image.writeUInt16LE(1, coff + 2);
  image.writeUInt16LE(0xf0, coff + 16);
  image.writeUInt16LE(0x22, coff + 18);
  const optional = coff + 20;
  image.writeUInt16LE(0x20b, optional);
  image.writeUInt32LE(0x1000, optional + 16);
  image.writeBigUInt64LE(0x140000000n, optional + 24);
  image.writeUInt32LE(0x1000, optional + 32);
  image.writeUInt32LE(0x200, optional + 36);
  image.writeUInt16LE(6, optional + 48);
  image.writeUInt32LE(0x2000, optional + 56);
  image.writeUInt32LE(0x200, optional + 60);
  image.writeUInt16LE(3, optional + 68);
  image.writeUInt32LE(16, optional + 108);
  const section = optional + 0xf0;
  image.write('.text', section, 'latin1');
  image.writeUInt32LE(0x1000, section + 8);
  image.writeUInt32LE(0x1000, section + 12);
  image.writeUInt32LE(0x200, section + 16);
  image.writeUInt32LE(0x200, section + 20);
  image.writeUInt32LE(0x60000020, section + 36);
  image[0x200] = 0xc3;
  return image;
}

async function readSignatures(files: string[]) {
  const { cwd, tmp } = ownedFolder();
  const run = await runWindowsPowerShell({
    encodedCommand: AUTHENTICODE_ENCODED_COMMAND,
    inputVariable: AUTHENTICODE_INPUT_VARIABLE,
    input: Buffer.from(JSON.stringify({ v: 1, files }), 'utf8').toString('base64'),
    maxInputChars: AUTHENTICODE_MAX_INPUT_CHARS,
    cwd,
    tmp,
    timeoutMs: AUTHENTICODE_BATCH_TIMEOUT_MS,
    maxStdoutBytes: AUTHENTICODE_MAX_OUTPUT_BYTES,
  });
  return parseAuthenticodeAnswer(run, files.length);
}

describe.runIf(process.platform === 'win32')('Authenticode on a real Windows host', () => {
  it('reads process.execPath as a Valid, timestamped Authenticode signature, with a readable chain and subject', async () => {
    const parsed = await readSignatures([process.execPath]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const [result] = parsed.results;
    expect(result).toMatchObject({ i: 0, status: 'Valid', type: 'Authenticode', timestamped: true });
    expect(result.leaf).toMatch(/^[0-9A-F]{40}$/);
    const chain = parsed.chains[result.leaf as string];
    expect(chain.elements.length).toBeGreaterThanOrEqual(2);
    expect(chain.elements[0].thumb).toBe(result.leaf);
    const subject = readCertificateSubject(Buffer.from(result.leafDer as string, 'base64'));
    expect(subject.ok).toBe(true);
    expect(subject.ok && subject.rdns.length).toBeGreaterThan(0);
  }, 120_000);

  it('reads a written unsigned PE stub, in a folder with a non-ASCII name, as not Valid', async () => {
    const { root } = ownedFolder();
    const folder = path.join(root, '签名-ü');
    mkdirSync(folder);
    const stub = path.join(folder, 'stub.exe');
    writeFileSync(stub, unsignedPeStub());
    const parsed = await readSignatures([stub]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.results[0].status).not.toBe('Valid');
    expect(parsed.results[0]).toMatchObject({ status: 'NotSigned', type: 'None', leaf: null, leafDer: null });

    // The same file through the whole check: accepted only as an unsigned file, refused where a signature is expected.
    const signers: AuthenticodeSigners = {
      openai: { accepted: [{ signatureType: 'Authenticode', subjectRdns: [['2.5.4.3', 'OpenAI OpCo, LLC']], rootThumbprint: 'F40042E2E5F7E8EF8189FED15519AECE42C3BFA2' }] },
      'microsoft-crt': { accepted: [{ signatureType: 'Catalog', subjectRdns: [['2.5.4.3', 'Microsoft Windows']], rootThumbprint: '3B1EFD3A66EA28B16697394703A72CA340A05BD5' }] },
    };
    const { cwd, tmp } = ownedFolder();
    const checked = await checkAuthenticodeSignatures({
      files: [{ path: stub, signer: 'unsigned' }, { path: stub, signer: 'openai' }], signers, ownedFolder: cwd, ownedTmp: tmp,
    });
    expect(checked).toMatchObject({ status: 'checked', accepted: false, revoked: false, counts: { unsigned: 1, openai: 0 }, unsignedFiles: [stub] });
  }, 120_000);
});
