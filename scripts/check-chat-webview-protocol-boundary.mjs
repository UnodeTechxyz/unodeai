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

// v0.9.88 §5.5: every block type the host sends must have a branch in the webview renderer, or that content
// would silently render as nothing. The verbatim block is the newest; the check covers them all.
const markdownSource = fs.readFileSync(new URL('../src/views/markdown.ts', import.meta.url), 'utf8');
const blockUnion = markdownSource.match(/export type MarkdownBlock =([\s\S]*?);\n/)?.[1] ?? '';
const blockTypes = [...blockUnion.matchAll(/type: '([a-z]+)'/g)].map((match) => match[1]);
const renderer = fs.readFileSync(new URL('../src/views/liveBlocks.ts', import.meta.url), 'utf8');

function assertEveryBlockRendered(types, source) {
  if (types.length < 6) {
    throw new Error(`Chat webview protocol boundary check found only ${types.length} block types in MarkdownBlock.`);
  }
  const missing = types.filter((type) => !source.includes(`block.type === '${type}'`));
  if (missing.length > 0) {
    throw new Error(`The chat webview renderer has no branch for block type(s): ${missing.join(', ')}.`);
  }
}

assertEveryBlockRendered(blockTypes, renderer);
let plantedBlockRejected = false;
try {
  assertEveryBlockRendered([...blockTypes, 'planted'], renderer);
} catch {
  plantedBlockRejected = true;
}
if (!plantedBlockRejected) {
  throw new Error('Chat webview protocol boundary check did not reject a block type without a renderer branch.');
}

console.log(`Chat webview protocol boundary check passed (${blockTypes.length} block types rendered).`);
