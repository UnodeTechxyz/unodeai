import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Compile only fixed host validation code. Skill files are byte data, never module inputs or imports.
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const packageUrl = new URL('../package.json', import.meta.url).href;
const result = await build({
  absWorkingDir: projectRoot,
  stdin: { contents: "export { SkillRegistry, parseSkillMarkdown, validateSkillTree } from './src/skills/SkillRegistry'; export { skillResourceText } from './src/skills/SkillResourceTree';",
    resolveDir: projectRoot, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'node18', packages: 'external',
  banner: { js: `import { createRequire as hostCreateRequire } from 'node:module'; const require = hostCreateRequire(${JSON.stringify(packageUrl)});` },
  logLevel: 'silent',
});
export const { SkillRegistry, parseSkillMarkdown, validateSkillTree, skillResourceText } = await import(
  'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text + '\n//# sourceURL=unode-skill-runtime-validation.mjs\n').toString('base64'));
