import { posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { opcPartName, opcRelationshipsPart, opcRelationshipTarget } from '../content/OpcReadPackage';
import { readWorkbookXml, xmlAttribute } from '../content/WorkbookXml';
import { OFFICE_REL, type OfficeRelationship, type OfficePackage } from './OfficePackage';
import { mutateOfficeXml } from './OfficeXmlMutations';
import { OfficeEditFailure } from './OfficeEditContracts';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
export interface OfficeCloneStore { read(name: string): Promise<Buffer>; member(name: string): string; has(name: string): boolean;
  contentType(name: string): string | undefined; add(member: string, bytes: Buffer, contentType: string): string }
const fail = (): never => { throw new OfficeEditFailure('unsupported-package-preservation'); };
const shared = new Set(['slideLayout', 'slideMaster', 'notesMaster', 'handoutMaster', 'theme']);

/** Collect exclusively owned parts after primary relationships are removed; outside incoming edges keep shared data. */
export async function unreferencedOfficeOwnedParts(store: OfficeCloneStore & { names(): string[] }, roots: Iterable<string>, presentation: string, progress: () => void) {
  const edges = new Map<string, Array<{ target: string; kind: string }>>();
  for (const owner of ['/', ...store.names().filter(name => !/\/_RELS\/[^/]*\.RELS$/i.test(name))]) {
    const rels = opcRelationshipsPart(owner); const outgoing: Array<{ target: string; kind: string }> = [];
    if (store.has(rels)) {
      outgoing.push({ target: rels, kind: '$relationships' });
      for (const relation of await currentOfficeRelationships(await store.read(rels), owner, progress)) if (!relation.external && relation.target && store.has(relation.target)) outgoing.push({ target: relation.target, kind: relation.kind });
    }
    edges.set(owner, outgoing); progress();
  }
  const candidates = new Set(roots); const queue = [...candidates];
  for (let at = 0; at < queue.length; at++) for (const edge of edges.get(queue[at]) ?? []) {
    if (shared.has(edge.kind) || edge.kind === 'slide' || edge.target === presentation || candidates.has(edge.target)) continue;
    candidates.add(edge.target); queue.push(edge.target);
  }
  const retained = new Set<string>(); const retainedQueue: string[] = [];
  for (const [owner, outgoing] of edges) if (!candidates.has(owner)) for (const edge of outgoing) if (candidates.has(edge.target) && !retained.has(edge.target)) { retained.add(edge.target); retainedQueue.push(edge.target); }
  for (let at = 0; at < retainedQueue.length; at++) for (const edge of edges.get(retainedQueue[at]) ?? []) if (candidates.has(edge.target) && !retained.has(edge.target)) { retained.add(edge.target); retainedQueue.push(edge.target); }
  return { removed: new Set([...candidates].filter(name => !retained.has(name))), retained: retained.size };
}

/** Parse current mutable relationships, including parts added earlier in the same edit transaction. */
export async function currentOfficeRelationships(bytes: Buffer, owner: string, progress: () => void): Promise<OfficeRelationship[]> {
  const output: OfficeRelationship[] = []; const ids = new Set<string>(); let depth = 0;
  await readWorkbookXml((async function* () { for (let at = 0; at < bytes.length; at += 65536) yield bytes.subarray(at, at + 65536); })(), { open(tag) {
    depth++; if (depth === 1 && (tag.uri !== PKG || tag.local !== 'Relationships')) return fail();
    if (depth !== 2 || tag.uri !== PKG || tag.local !== 'Relationship') return;
    const id = xmlAttribute(tag, 'Id'); const type = xmlAttribute(tag, 'Type'); const target = xmlAttribute(tag, 'Target');
    if (!id || !type || target === undefined || ids.has(id)) return fail(); ids.add(id);
    const base = OFFICE_REL.find(base => type.startsWith(base + '/'));
    const relation: OfficeRelationship = { id, type, kind: base ? type.slice(base.length + 1) : 'unknown', external: xmlAttribute(tag, 'TargetMode') === 'External' };
    if (!relation.external) { try { relation.target = opcRelationshipTarget(owner, target); } catch { relation.invalidTarget = true; } }
    output.push(relation);
  }, close() { depth--; } }, progress); return output;
}

/** Cache the original owned closure while hashing once, avoiding a second inflation of large chart/media parts. */
export async function officeSlideOwnedParts(pkg: OfficePackage, root: string): Promise<Set<string>> {
  const parts = new Set<string>([root]); const queue = [root];
  for (let at = 0; at < queue.length; at++) {
    const owner = queue[at]; const rels = opcRelationshipsPart(owner); if (pkg.zip.has(rels)) parts.add(rels);
    for (const relation of await pkg.relations(owner)) {
      if (relation.external || !relation.target || !pkg.zip.has(relation.target) || shared.has(relation.kind) || relation.kind === 'slide' || relation.target === pkg.main.name || parts.has(relation.target)) continue;
      parts.add(relation.target); queue.push(relation.target);
    }
  }
  return parts;
}

/** Same-presentation owned graph copy. Global masters/layouts/theme and other slide destinations stay shared. */
export async function cloneOfficeSlideGraph(store: OfficeCloneStore, root: string, presentation: string, progress: () => void) {
  const copies = new Map<string, string>(); let unavailable = 0; let unknownTypes = 0;
  const fresh = (source: string) => {
    const old = store.member(source);
    for (;;) {
      const member = posix.join(posix.dirname(old), `unode-${randomUUID()}${posix.extname(old) || '.xml'}`); const name = opcPartName('/' + member);
      if (!store.has(name) && !store.has(opcRelationshipsPart(name))) return member;
    }
  };
  const allocate = async (source: string) => {
    const prior = copies.get(source); if (prior) return prior;
    const type = store.contentType(source); if (!type) unknownTypes++;
    const name = store.add(fresh(source), await store.read(source), type ?? 'application/octet-stream'); copies.set(source, name); return name;
  };
  const cloned = await allocate(root); const queue = [root];
  for (let at = 0; at < queue.length; at++) {
    const source = queue[at]; const name = copies.get(source)!; const rels = opcRelationshipsPart(source); if (!store.has(rels)) continue;
    const bytes = await store.read(rels); const relations = await currentOfficeRelationships(bytes, source, progress); const remap = new Map<string, string>();
    for (const relation of relations) {
      if (relation.external) continue;
      if (!relation.target || !store.has(relation.target)) { unavailable++; continue; }
      let target = copies.get(relation.target);
      if (!target && !shared.has(relation.kind) && relation.kind !== 'slide' && relation.target !== presentation) {
        target = await allocate(relation.target); queue.push(relation.target);
      }
      if (target) remap.set(relation.id, posix.relative(posix.dirname('/' + store.member(name)), '/' + store.member(target)));
    }
    const rewritten = mutateOfficeXml(bytes, (tag, parents) => {
      if (parents.length !== 1 || tag.uri !== PKG || tag.local !== 'Relationship') return;
      const id = xmlAttribute(tag, 'Id'); if (!id || !remap.has(id)) return;
      const raw = xmlAttribute(tag, 'Target')!; const suffix = raw.search(/[?#]/);
      return { name: 'Target', value: remap.get(id)! + (suffix < 0 ? '' : raw.slice(suffix)) };
    }, progress);
    const member = store.member(name); store.add(posix.join(posix.dirname(member), '_rels', posix.basename(member) + '.rels'), rewritten,
      store.contentType(rels) ?? 'application/vnd.openxmlformats-package.relationships+xml'); progress();
  }
  return { root: cloned, parts: copies.size, unavailable, unknownTypes };
}
