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

// v0.9.97: the same for inline spans. A file link or a refused link the renderer had no branch for would show as
// nothing, and the reason beside a refused link would be lost.
const inlineUnion = markdownSource.match(/export type MarkdownInline =([\s\S]*?);\n/)?.[1] ?? '';
const spanTypes = [...inlineUnion.matchAll(/type: '([A-Za-z]+)'/g)].map((match) => match[1]);

function assertEverySpanRendered(types, source) {
  if (types.length < 7) {
    throw new Error(`Chat webview protocol boundary check found only ${types.length} span types in MarkdownInline.`);
  }
  const missing = types.filter((type) => !source.includes(`span.type === '${type}'`));
  if (missing.length > 0) {
    throw new Error(`The chat webview renderer has no branch for span type(s): ${missing.join(', ')}.`);
  }
}

assertEverySpanRendered(spanTypes, renderer);
let plantedSpanRejected = false;
try {
  assertEverySpanRendered([...spanTypes, 'planted'], renderer);
} catch {
  plantedSpanRejected = true;
}
if (!plantedSpanRejected) {
  throw new Error('Chat webview protocol boundary check did not reject a span type without a renderer branch.');
}

// v0.9.97: a click on a reply's file link names the conversation shown and the link's host-issued id. It is the one
// message whose host handler can open a file from a reply; a path, folder, URI or command field added to it would
// hand the webview what the host must decide. Widening it is a deliberate change of this list, never a side effect.
const protocolSource = fs.readFileSync(new URL('../src/views/chatWebviewProtocol.ts', import.meta.url), 'utf8');
const FILE_LINK_FIELDS = ['command', 'agentId', 'referenceId'];

function assertFileLinkClickNamesOnlyAnId(source) {
  const declared = source.match(/\n {2}openFileReference: \[([^\]]*)\],/)?.[1];
  if (declared === undefined) {
    throw new Error('Chat webview protocol boundary check found no openFileReference field list.');
  }
  const fields = [...declared.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  if (fields.join(',') !== FILE_LINK_FIELDS.join(',')) {
    throw new Error(`A file link click may carry only ${FILE_LINK_FIELDS.join(', ')}; it declares ${fields.join(', ')}.`);
  }
}

assertFileLinkClickNamesOnlyAnId(protocolSource);
let plantedFieldRejected = false;
try {
  assertFileLinkClickNamesOnlyAnId(protocolSource.replace(
    "\n  openFileReference: ['command', 'agentId', 'referenceId'],",
    "\n  openFileReference: ['command', 'agentId', 'referenceId', 'path'],",
  ));
} catch {
  plantedFieldRejected = true;
}
if (!plantedFieldRejected) {
  throw new Error('Chat webview protocol boundary check did not reject a file link click that names a path.');
}

console.log(`Chat webview protocol boundary check passed (${blockTypes.length} block types and ${spanTypes.length} span types rendered; a file link click names only its id).`);
