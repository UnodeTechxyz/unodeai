import fs from 'node:fs';

const providerPath = new URL('../src/views/ChatViewProvider.ts', import.meta.url);
const manualMessageGuard = /typeof\s+msg\s*\./;

function assertNoManualMessageValidators(source) {
  if (manualMessageGuard.test(source)) {
    throw new Error('ChatViewProvider must parse webview traffic at the protocol boundary; found a manual `typeof msg.*` validator.');
  }
}

const provider = fs.readFileSync(providerPath, 'utf8');
assertNoManualMessageValidators(provider);

// Keep this check falsifiable: a planted old-style validator must make the guard fail.
let plantedViolationRejected = false;
try {
  assertNoManualMessageValidators(`${provider}\nif (typeof msg.agentId === 'string') {}`);
} catch {
  plantedViolationRejected = true;
}
if (!plantedViolationRejected) {
  throw new Error('Chat webview protocol boundary check did not reject its planted violation.');
}

console.log('Chat webview protocol boundary check passed.');
