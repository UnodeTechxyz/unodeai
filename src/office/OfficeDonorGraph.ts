// Fixed cross-presentation dependency graph import; no resolver or native application.
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { opcRelationshipsPart } from '../content/OpcReadPackage';
import { xmlAttribute } from '../content/WorkbookXml';
import { OFFICE_NS, OFFICE_REL, type OfficePackage } from './OfficePackage';
import { officeXmlElements, removeOfficeElements } from './OfficeXmlElements';
import { currentOfficeRelationships, type OfficeCloneStore } from './OfficePartCloner';
import { mutateOfficeXml } from './OfficeXmlMutations';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
/** Copies every reachable donor dependency, including layouts/master/theme cycles, to a private collision-free URI folder.
 * Links to other donor slides are omitted and their typed hyperlinks neutralized, never copied as hidden dependencies.
 * Main-presentation backlinks point to the destination main. Missing internal links stay unavailable under fresh names.
 */
export async function importOfficeDonorGraph(donor: OfficePackage, root: string, destination: OfficeCloneStore, main: string, progress: () => void) {
  const directory = `ppt/unode-import-${randomUUID()}`; const copies = new Map<string, string>(); const queue: string[] = [];
  const omittedByOwner = new Map<string, Set<string>>();
  const kinds = new Map<string, Set<string>>(); let unavailable = 0; let unknownTypes = 0; const auxiliarySlides = 0;
  const read = async (name: string) => { const chunks: Buffer[] = []; for await (const chunk of donor.zip.bytes(name)) { progress(); chunks.push(Buffer.from(chunk)); } return Buffer.concat(chunks); };
  const allocate = async (source: string) => {
    const prior = copies.get(source); if (prior) return prior;
    const extension = posix.extname(donor.zip.memberName(source)); const suffix = /^\.[A-Za-z0-9]{1,16}$/.test(extension) ? extension : '.bin';
    let member: string; do { member = `${directory}/part-${randomUUID()}${suffix}`; } while (destination.has('/' + member) || destination.has(opcRelationshipsPart('/' + member)));
    const type = donor.part(source)?.contentType; if (!type) unknownTypes++;
    const rels = opcRelationshipsPart(source); const omitted = new Set<string>();
    if (donor.zip.has(rels)) for (const relation of await currentOfficeRelationships(await read(rels), source, progress)) {
      if (!relation.external && relation.target !== root && (relation.kind === 'slide' || relation.target && donor.part(relation.target)?.contentType?.endsWith('presentationml.slide+xml'))) omitted.add(relation.id);
    }
    omittedByOwner.set(source, omitted);
    let content: Buffer = await read(source);
    if (omitted.size && type?.endsWith('+xml')) {
      const parsed = officeXmlElements(content, progress);
      content = removeOfficeElements(parsed, parsed.elements.filter(element => OFFICE_NS.a.includes(element.tag.uri)
        && ['hlinkClick', 'hlinkMouseOver', 'hlinkHover'].includes(element.tag.local)
        && Object.values(element.tag.attributes).some(attribute => OFFICE_REL.includes(attribute.uri) && attribute.local === 'id' && omitted.has(attribute.value))));
    }
    const name = destination.add(member, content, type ?? 'application/octet-stream'); copies.set(source, name); queue.push(source); return name;
  };
  const imported = await allocate(root);
  for (let at = 0; at < queue.length; at++) {
    const source = queue[at]; const name = copies.get(source)!; const relationships = opcRelationshipsPart(source); if (!donor.zip.has(relationships)) continue;
    const bytes = await read(relationships); const targets = new Map<string, string>(); const omittedSlideLinks = omittedByOwner.get(source)!;
    for (const relation of await currentOfficeRelationships(bytes, source, progress)) {
      if (relation.external) continue;
      if (omittedSlideLinks.has(relation.id)) continue;
      let target: string; let missingMember: string | undefined;
      if (!relation.target || !donor.zip.has(relation.target)) {
        unavailable++; missingMember = directory + '/unavailable-' + randomUUID(); target = '/' + missingMember;
      } else if (relation.target === donor.main.name) target = main;
      else {
        target = await allocate(relation.target);
        const references = kinds.get(relation.kind) ?? new Set<string>(); references.add(target); kinds.set(relation.kind, references);
      }
      targets.set(relation.id, posix.relative(posix.dirname('/' + destination.member(name)), '/' + (missingMember ?? destination.member(target))));
    }
    const parsed = officeXmlElements(bytes, progress);
    const withoutSlideLinks = removeOfficeElements(parsed, parsed.elements.filter(element => element.tag.uri === PKG && element.tag.local === 'Relationship'
      && omittedSlideLinks.has(xmlAttribute(element.tag, 'Id') ?? '')));
    const rewritten = mutateOfficeXml(withoutSlideLinks, (tag, parents) => {
      if (parents.length !== 1 || tag.uri !== PKG || tag.local !== 'Relationship') return;
      const id = xmlAttribute(tag, 'Id'); if (!id || !targets.has(id)) return;
      const raw = xmlAttribute(tag, 'Target')!; const suffix = raw.search(/[?#]/);
      return { name: 'Target', value: targets.get(id)! + (suffix < 0 ? '' : raw.slice(suffix)) };
    }, progress);
    const member = destination.member(name); destination.add(posix.join(posix.dirname(member), '_rels', posix.basename(member) + '.rels'), rewritten, 'application/vnd.openxmlformats-package.relationships+xml');
  }
  return { root: imported, copies, kinds, unavailable, unknownTypes, auxiliarySlides };
}
