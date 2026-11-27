import { createHash } from 'node:crypto';
export interface NativeSkillProjectionInput { name: string; description: string; source: Buffer; frontmatterKeys: readonly string[]; resourcePaths: readonly string[] }
/** Provider discovery is entirely generated; original instruction/preprocessor bodies arrive only through host reads. */
export function nativeSkillEntry(skill: NativeSkillProjectionInput, loadTool = 'load_skill', readTool = 'read_skill_file') {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(skill.name) || skill.name.length < 4 || skill.name.length > 64 || typeof skill.description !== 'string'
    || ![loadTool, readTool].every(name => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))) throw Error('invalid native skill identity');
  const scalar = JSON.stringify(skill.description).replace(/[!`\u007f-\u009f\u2028\u2029]/gu, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
  const markdown = `---\nname: ${skill.name}\ndescription: ${scalar}\n---\n\nUse the host tool ${loadTool} with { "name": "${skill.name}" } to read this granted skill's instructions and resource_root. Follow its returned continuation until complete. Use ${readTool} to read supporting files as data.\nResolve original helper and asset paths against that returned resource_root, not this generated entry. Loading executes nothing. Helpers use the ordinary command authority; explicit Off remains Off.\n`;
  return { markdown, report: { source_sha256: createHash('sha256').update(skill.source).digest('hex'), omitted_frontmatter_fields: skill.frontmatterKeys.filter(key => key !== 'name' && key !== 'description'),
    original_body: 'host-load-only', original_resources: 'installed-root-only', omitted_resource_paths: [...skill.resourcePaths] } };
}
