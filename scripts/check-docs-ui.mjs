import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

function read(relative) {
  return readFileSync(resolve(root, relative), 'utf8');
}

function unique(values) {
  return [...new Set(values)];
}

function markdownSection(text, heading) {
  const start = text.indexOf(heading);
  if (start < 0) { return ''; }
  const end = text.indexOf('\n## ', start + heading.length);
  return text.slice(start, end < 0 ? text.length : end);
}

function htmlSection(text, id) {
  const start = text.indexOf(`<section id="${id}">`);
  if (start < 0) { return ''; }
  const end = text.indexOf('\n      <section ', start + 1);
  return text.slice(start, end < 0 ? text.length : end);
}

function providerCardLabels(settingsSource) {
  const start = settingsSource.indexOf('private providerCard(');
  const end = settingsSource.indexOf('\n  private ', start + 1);
  const card = settingsSource.slice(start, end < 0 ? settingsSource.length : end);
  return unique([...card.matchAll(/<button[^>]*>([A-Z][^<${]*)<\/button>/g)]
    .map((match) => match[1].trim())
    .filter(Boolean));
}

function modelParamLabels(agentBuilderSource) {
  return unique([...agentBuilderSource.matchAll(/<label for="mp_[^"]+">([^<]+)<\/label>/g)]
    .map((match) => match[1].trim()));
}

function responseFormatLabels(agentBuilderSource) {
  const block = agentBuilderSource.match(/const responseFormatOptions:[\s\S]*?\n\s*\];/)?.[0] ?? '';
  return [...block.matchAll(/\[['"][^'"]*['"],\s*['"]([^'"]+)['"]\]/g)].map((match) => match[1]);
}

function commandTitles(packageJson) {
  return unique(packageJson.contributes.commands.map(({ title }) => title));
}

function missing(expected, text) {
  return expected.filter((value) => !text.includes(value));
}

export function docsUiViolations({ settingsSource, agentBuilderSource, packageJson, usage, wiki }) {
  const providerActions = providerCardLabels(settingsSource);
  const modelLabels = [...modelParamLabels(agentBuilderSource), ...responseFormatLabels(agentBuilderSource)];
  const commands = commandTitles(packageJson);
  const usageSettings = markdownSection(usage, '## 10. Settings');
  const usageCommands = markdownSection(usage, '## 16. Command Reference');
  const wikiSettings = htmlSection(wiki, 'settings');
  const wikiCommands = htmlSection(wiki, 'commands');
  const violations = [];

  for (const [label, docs] of [
    ['USAGE.md §10', usageSettings],
    ['docs/wiki/index.html Settings', wikiSettings],
  ]) {
    for (const value of missing(providerActions, docs)) {
      violations.push(`${label} is missing provider-card action label: ${value}`);
    }
    for (const value of missing(modelLabels, docs)) {
      violations.push(`${label} is missing model-tuning label or option: ${value}`);
    }
  }

  for (const [label, docs] of [
    ['USAGE.md §16', usageCommands],
    ['docs/wiki/index.html Command Reference', wikiCommands],
  ]) {
    for (const title of missing(commands, docs)) {
      violations.push(`${label} is missing contributed command title: ${title}`);
    }
  }
  return violations;
}

function currentInputs() {
  return {
    settingsSource: read('src/views/SettingsPanel.ts'),
    agentBuilderSource: read('src/views/AgentBuilderPanel.ts'),
    packageJson: JSON.parse(read('package.json')),
    usage: read('USAGE.md'),
    wiki: read('docs/wiki/index.html'),
  };
}

function runSelfTest() {
  const inputs = currentInputs();
  const changedLabel = inputs.settingsSource.replace('Set as default', 'Make primary');
  const labelViolations = docsUiViolations({ ...inputs, settingsSource: changedLabel });
  if (!labelViolations.some((violation) => violation.includes('Make primary'))) {
    throw new Error('self-test failed: a changed provider-card label did not make the docs gate fail');
  }
  console.log('check:docs-ui self-test passed (a planted provider-label drift fails).');
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
} else {
  const violations = docsUiViolations(currentInputs());
  if (violations.length > 0) {
    throw new Error(`check:docs-ui failed:\n- ${violations.join('\n- ')}`);
  }
  console.log('check:docs-ui passed.');
}
