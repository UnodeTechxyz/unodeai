import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLI_COMPATIBILITY_POLICY,
  loadCliCompatibilityPolicy,
  type CliFileSigner,
} from '../../backend/cliCompatibilityPolicy';
import {
  judgeAuthenticodeFile,
  readCertificateSubject,
  type AuthenticodeRawChain,
  type AuthenticodeSigners,
  type AuthenticodeSignerToken,
} from '../windowsAuthenticode';

/**
 * The bundled policy's publisher identities and the Authenticode check meet here: the policy's `signers` is what the
 * check is given, and the three real leaf certificates of the Codex package must pass against it exactly as Windows
 * reports them, each through the alternative its signature type names.
 */

/** Both modules name the same four signer tokens; each type is assignable to the other. */
const tokensMatch: AuthenticodeSignerToken[] = [] as CliFileSigner[];
const tokensMatchBack: CliFileSigner[] = [] as AuthenticodeSignerToken[];
/** The policy's signers are a valid input of the check, with no conversion. */
const signers: AuthenticodeSigners = CLI_COMPATIBILITY_POLICY.signers;

const LEAVES = (JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'authenticode-leaves.json'), 'utf8')) as {
  leaves: Array<{ name: string; thumbprint: string; der: string }>;
}).leaves;

function chainFor(leaf: string, root: string, intermediateStatus: string[] = []): AuthenticodeRawChain {
  return {
    built: true,
    status: intermediateStatus,
    elements: [{ thumb: leaf, status: [] }, { thumb: 'A'.repeat(40), status: intermediateStatus }, { thumb: root, status: [] }],
  };
}

function verdictFor(index: number, signer: 'openai' | 'microsoft-crt', type: 'Authenticode' | 'Catalog', root: string, intermediateStatus?: string[]) {
  const leaf = LEAVES[index];
  return judgeAuthenticodeFile(
    { path: 'C:\\pkg\\file.exe', signer },
    { i: 0, status: 'Valid', type, leaf: leaf.thumbprint, leafDer: leaf.der, timestamped: true },
    chainFor(leaf.thumbprint, root, intermediateStatus),
    signers,
  );
}

describe('the bundled policy signers against the real Codex package certificates', () => {
  it('shares one signer token set and one signer shape with the Authenticode check', () => {
    expect(tokensMatch).toEqual([]);
    expect(tokensMatchBack).toEqual([]);
    expect(loadCliCompatibilityPolicy().ok).toBe(true);
  });

  it('accepts the OpenAI leaf of codex.exe as openai, through the Authenticode alternative', () => {
    const verdict = verdictFor(0, 'openai', 'Authenticode', 'F40042E2E5F7E8EF8189FED15519AECE42C3BFA2');
    expect(verdict).toMatchObject({ accepted: true, signer: 'openai', alternative: 0, signatureType: 'Authenticode' });
  });

  it('accepts the Microsoft catalog leaf as microsoft-crt alternative 1, and the embedded leaf as alternative 2', () => {
    expect(verdictFor(1, 'microsoft-crt', 'Catalog', '3B1EFD3A66EA28B16697394703A72CA340A05BD5'))
      .toMatchObject({ accepted: true, signer: 'microsoft-crt', alternative: 0, signatureType: 'Catalog' });
    expect(verdictFor(2, 'microsoft-crt', 'Authenticode', '8F43288AD272F3103B6FB1428485EA3014C0BCFE'))
      .toMatchObject({ accepted: true, signer: 'microsoft-crt', alternative: 1, signatureType: 'Authenticode' });
  });

  it('never accepts a Microsoft leaf as openai, or the OpenAI leaf as microsoft-crt', () => {
    expect(verdictFor(1, 'openai', 'Catalog', '3B1EFD3A66EA28B16697394703A72CA340A05BD5').accepted).toBe(false);
    expect(verdictFor(2, 'openai', 'Authenticode', '8F43288AD272F3103B6FB1428485EA3014C0BCFE').accepted).toBe(false);
    expect(verdictFor(0, 'microsoft-crt', 'Authenticode', 'F40042E2E5F7E8EF8189FED15519AECE42C3BFA2').accepted).toBe(false);
  });

  it('decodes each real leaf subject to exactly the RDN list the policy pins', () => {
    const pinned = [
      CLI_COMPATIBILITY_POLICY.signers.openai.accepted[0].subjectRdns,
      CLI_COMPATIBILITY_POLICY.signers['microsoft-crt'].accepted[0].subjectRdns,
      CLI_COMPATIBILITY_POLICY.signers['microsoft-crt'].accepted[1].subjectRdns,
    ];
    LEAVES.forEach((leaf, index) => {
      const subject = readCertificateSubject(Buffer.from(leaf.der, 'base64'));
      expect(subject.ok && subject.rdns.map((rdn) => rdn[0])).toEqual(pinned[index]);
    });
  });

  // Since 2026-10-19 the catalog chain's intermediate (Microsoft Windows Production PCA 2011) has expired. Codex's
  // ruling: the microsoft-crt Catalog alternative accepts that for a file whose bytes were verified against its pin.
  it('accepts the catalog leaf with an expired intermediate only for a microsoft-crt file whose bytes were verified', () => {
    const leaf = LEAVES[1];
    const result = { i: 0, status: 'Valid', type: 'Catalog', leaf: leaf.thumbprint, leafDer: leaf.der, timestamped: true };
    const chain = chainFor(leaf.thumbprint, '3B1EFD3A66EA28B16697394703A72CA340A05BD5', ['NotTimeValid']);
    expect(judgeAuthenticodeFile({ path: 'C:\\pkg\\vcruntime140.dll', signer: 'microsoft-crt', pinnedDigestVerified: true }, result, chain, signers))
      .toMatchObject({ accepted: true, alternative: 0, signatureType: 'Catalog' });
    expect(verdictFor(1, 'microsoft-crt', 'Catalog', '3B1EFD3A66EA28B16697394703A72CA340A05BD5', ['NotTimeValid']).accepted).toBe(false);
  });
});
