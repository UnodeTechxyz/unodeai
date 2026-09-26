#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  UnodeAi - catalog signing helper
 *
 *  Produces / verifies a DETACHED Ed25519 signature over a hosted catalog.json, so the extension can
 *  reject a tampered hosted-catalog push (see CATALOG_PUBLIC_KEY_PEM / verifyCatalogSignature
 *  in src/marketplace/catalogSource.ts). The signature is base64 over the EXACT file bytes.
 *
 *  Usage:
 *    node scripts/sign-catalog.mjs --genkey [out-prefix]
 *        → writes <out-prefix>.key.pem (PRIVATE — keep secret, never commit) and
 *                 <out-prefix>.pub.pem (PUBLIC  — paste into CATALOG_PUBLIC_KEY_PEM).
 *          Defaults out-prefix to ./roam-catalog.
 *
 *    node scripts/sign-catalog.mjs <catalog.json> <private-key.pem>
 *        → writes <catalog.json>.sig (base64 detached signature). Commit catalog.json + catalog.json.sig
 *          to the roam-skills repo so installs fetch both.
 *
 *    node scripts/sign-catalog.mjs --verify <catalog.json> <catalog.json.sig> <public-key.pem>
 *        → exits 0 if the signature verifies, 1 otherwise (handy in CI).
 *
 *  Publishing flow: run --genkey once, paste the PUBLIC pem into the bundled constant, store the PRIVATE
 *  pem in the publish secret store, then sign on every catalog change.
 *--------------------------------------------------------------------------------------------*/

import { generateKeyPairSync, createPublicKey, createPrivateKey, sign as edSign, verify as edVerify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);

function genkey(prefix = 'roam-catalog') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  writeFileSync(`${prefix}.key.pem`, privPem);
  writeFileSync(`${prefix}.pub.pem`, pubPem);
  console.log(`Wrote ${prefix}.key.pem (PRIVATE — keep secret, do NOT commit)`);
  console.log(`Wrote ${prefix}.pub.pem (PUBLIC  — paste into ROAM_CATALOG_PUBLIC_KEY_PEM)`);
  console.log('\nPublic key:\n' + pubPem);
}

function signFile(catalogPath, privateKeyPath) {
  const bytes = readFileSync(catalogPath); // exact bytes — the extension verifies over these
  const key = createPrivateKey(readFileSync(privateKeyPath, 'utf8'));
  const sig = edSign(null, bytes, key).toString('base64');
  const outPath = `${catalogPath}.sig`;
  writeFileSync(outPath, sig + '\n');
  console.log(`Wrote ${outPath} (${sig.length} base64 chars)`);
}

function verifyFile(catalogPath, sigPath, publicKeyPath) {
  const bytes = readFileSync(catalogPath);
  const sig = Buffer.from(readFileSync(sigPath, 'utf8').trim(), 'base64');
  const key = createPublicKey(readFileSync(publicKeyPath, 'utf8'));
  const ok = edVerify(null, bytes, key, sig);
  console.log(ok ? 'OK: signature verifies' : 'FAIL: signature does NOT verify');
  process.exit(ok ? 0 : 1);
}

try {
  if (args[0] === '--genkey') {
    genkey(args[1]);
  } else if (args[0] === '--verify') {
    if (args.length < 4) { throw new Error('usage: --verify <catalog.json> <catalog.json.sig> <public-key.pem>'); }
    verifyFile(args[1], args[2], args[3]);
  } else if (args.length >= 2) {
    signFile(args[0], args[1]);
  } else {
    console.error('usage:\n  sign-catalog.mjs --genkey [out-prefix]\n  sign-catalog.mjs <catalog.json> <private-key.pem>\n  sign-catalog.mjs --verify <catalog.json> <catalog.json.sig> <public-key.pem>');
    process.exit(2);
  }
} catch (err) {
  console.error(`sign-catalog failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
