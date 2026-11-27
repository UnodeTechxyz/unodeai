import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, type PDFDocument, type PDFObject, type PDFPage } from 'pdf-lib';

/** Field-tree, destination and box facts read directly from PDF objects; nothing here creates an AcroForm. */
const N = (name: string) => PDFName.of(name);
const key = (ref: PDFRef) => `${ref.objectNumber} ${ref.generationNumber}`;

export function decodePdfText(value: PDFObject | undefined): string | undefined {
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined;
}

export function acroFormOf(doc: PDFDocument): PDFDict | undefined {
  return doc.catalog.lookupMaybe(N('AcroForm'), PDFDict);
}

/** An XFA entry that is present and not null marks an XFA (or hybrid) form. */
export function hasXfa(doc: PDFDocument): boolean {
  const form = acroFormOf(doc); if (!form) return false;
  const xfa = form.get(N('XFA')); if (!xfa) return false;
  const resolved = doc.context.lookup(xfa);
  return resolved instanceof PDFArray ? resolved.size() > 0 : !!resolved && resolved.toString() !== 'null';
}

export interface PdfFieldNode {
  name: string; type?: string; hasValue: boolean; readOnly: boolean;
  dict: PDFDict; ref?: PDFRef; container: PDFArray; parent?: PdfFieldNode;
  /** Widgets of a terminal field; empty for an intermediate node. */
  widgets: Array<{ dict: PDFDict; ref?: PDFRef; container?: PDFArray }>;
  children: PdfFieldNode[];
}

/** Walk /AcroForm /Fields with inherited FT, V and Ff. Kids are fields when they carry /T or /Kids or no Widget subtype. */
export function fieldTree(doc: PDFDocument): PdfFieldNode[] {
  const form = acroFormOf(doc); const fields = form?.lookupMaybe(N('Fields'), PDFArray);
  if (!fields) return [];
  const seen = new Set<string>(); const roots: PdfFieldNode[] = [];
  const visit = (entry: PDFObject, container: PDFArray, parent: PdfFieldNode | undefined, depth: number): PdfFieldNode | undefined => {
    if (depth > 64) return undefined;
    const ref = entry instanceof PDFRef ? entry : undefined;
    if (ref) { if (seen.has(key(ref))) return undefined; seen.add(key(ref)); }
    const dict = ref ? doc.context.lookupMaybe(ref, PDFDict) : entry instanceof PDFDict ? entry : undefined;
    if (!dict) return undefined;
    const partial = decodePdfText(dict.lookup(N('T')));
    const name = partial === undefined ? parent?.name ?? '' : parent?.name ? `${parent.name}.${partial}` : partial;
    const ft = dict.lookupMaybe(N('FT'), PDFName)?.asString().slice(1) ?? parent?.type;
    const hasValue = dict.has(N('V')) ? doc.context.lookup(dict.get(N('V'))) !== undefined && dict.lookup(N('V'))?.toString() !== 'null' : parent?.hasValue ?? false;
    const flags = dict.lookupMaybe(N('Ff'), PDFNumber)?.asNumber();
    const readOnly = flags !== undefined ? (flags & 1) === 1 : parent?.readOnly ?? false;
    const node: PdfFieldNode = { name, type: ft, hasValue, readOnly, dict, ref, container, parent, widgets: [], children: [] };
    const kids = dict.lookupMaybe(N('Kids'), PDFArray);
    if (kids) {
      for (let index = 0; index < kids.size(); index++) {
        const kidEntry = kids.get(index); const kid = doc.context.lookupMaybe(kidEntry, PDFDict);
        if (!kid) continue;
        const isField = kid.has(N('T')) || kid.has(N('Kids')) || kid.lookupMaybe(N('Subtype'), PDFName)?.asString() !== '/Widget';
        if (isField) { const child = visit(kidEntry, kids, node, depth + 1); if (child) node.children.push(child); }
        else node.widgets.push({ dict: kid, ref: kidEntry instanceof PDFRef ? kidEntry : undefined, container: kids });
      }
    }
    if (!node.children.length && dict.lookupMaybe(N('Subtype'), PDFName)?.asString() === '/Widget') node.widgets.push({ dict, ref });
    return node;
  };
  for (let index = 0; index < fields.size(); index++) { const node = visit(fields.get(index), fields, undefined, 0); if (node) roots.push(node); }
  return roots;
}

export function terminalFields(roots: PdfFieldNode[]): PdfFieldNode[] {
  return roots.flatMap(node => node.children.length ? terminalFields(node.children) : [node]);
}

/** Any field resolving to FT /Sig with a value is an existing digital signature. */
export function hasDigitalSignature(doc: PDFDocument): boolean {
  return terminalFields(fieldTree(doc)).some(field => field.type === 'Sig' && field.hasValue);
}

export function hasFormFields(doc: PDFDocument): boolean { return terminalFields(fieldTree(doc)).length > 0; }

/** Resolve an explicit, named or GoTo destination to its target page reference. */
export function destinationPage(doc: PDFDocument, value: PDFObject | undefined, depth = 0): PDFRef | undefined {
  if (!value || depth > 8) return undefined;
  const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
  if (resolved instanceof PDFArray) { const target = resolved.get(0); return target instanceof PDFRef ? target : undefined; }
  if (resolved instanceof PDFDict) {
    if (resolved.has(N('D'))) return destinationPage(doc, resolved.get(N('D')), depth + 1);
    return undefined;
  }
  const name = resolved instanceof PDFName ? resolved.decodeText() : decodePdfText(resolved);
  if (name === undefined) return undefined;
  const dests = doc.catalog.lookupMaybe(N('Dests'), PDFDict);
  const direct = dests?.get(N(name)); if (direct) return destinationPage(doc, direct, depth + 1);
  const tree = doc.catalog.lookupMaybe(N('Names'), PDFDict)?.lookupMaybe(N('Dests'), PDFDict);
  const found = tree ? nameTreeLookup(doc, tree, name, 0) : undefined;
  return found ? destinationPage(doc, found, depth + 1) : undefined;
}

function nameTreeLookup(doc: PDFDocument, node: PDFDict, name: string, depth: number): PDFObject | undefined {
  if (depth > 32) return undefined;
  const names = node.lookupMaybe(N('Names'), PDFArray);
  if (names) for (let index = 0; index + 1 < names.size(); index += 2) if (decodePdfText(names.lookup(index)) === name) return names.get(index + 1);
  const kids = node.lookupMaybe(N('Kids'), PDFArray);
  if (kids) for (let index = 0; index < kids.size(); index++) {
    const kid = kids.lookupMaybe(index, PDFDict); const found = kid ? nameTreeLookup(doc, kid, name, depth + 1) : undefined; if (found) return found;
  }
  return undefined;
}

function annotationTarget(doc: PDFDocument, annotation: PDFDict): PDFRef | undefined {
  if (annotation.has(N('Dest'))) return destinationPage(doc, annotation.get(N('Dest')));
  const action = annotation.lookupMaybe(N('A'), PDFDict);
  return action && action.lookupMaybe(N('S'), PDFName)?.asString() === '/GoTo' ? destinationPage(doc, action.get(N('D'))) : undefined;
}

export interface DeletedPageCleanup { fields: string[]; widgets: number; outline_items: string[]; outline_destinations: string[]; links: number }

/**
 * Before pages are removed in place: drop widgets on them, fields left without widgets, outline items and links that
 * point at them. Fields whose other widgets remain keep working. Returns what was removed for the receipt.
 */
export function cleanupForDeletedPages(doc: PDFDocument, deleted: PDFPage[], remaining: PDFPage[]): DeletedPageCleanup {
  const deletedRefs = new Set(deleted.map(page => key(page.ref)));
  const annotationsOnDeleted = new Set<string>();
  for (const page of deleted) {
    const annots = page.node.lookupMaybe(N('Annots'), PDFArray);
    if (annots) for (let index = 0; index < annots.size(); index++) { const ref = annots.get(index); if (ref instanceof PDFRef) annotationsOnDeleted.add(key(ref)); }
  }
  const result: DeletedPageCleanup = { fields: [], widgets: 0, outline_items: [], outline_destinations: [], links: 0 };
  const onDeleted = (widget: { dict: PDFDict; ref?: PDFRef }) => {
    const owner = widget.dict.get(N('P'));
    return (owner instanceof PDFRef && deletedRefs.has(key(owner))) || (!!widget.ref && annotationsOnDeleted.has(key(widget.ref)));
  };
  const removeEntry = (container: PDFArray, dict: PDFDict, ref?: PDFRef) => {
    for (let index = 0; index < container.size(); index++) {
      const entry = container.get(index);
      if ((ref && entry instanceof PDFRef && key(entry) === key(ref)) || (!ref && entry === dict)) { container.remove(index); return; }
    }
  };
  // Post-order: a node with no remaining widgets or children leaves its container.
  const prune = (node: PdfFieldNode): boolean => {
    if (node.children.length) {
      node.children = node.children.filter(child => {
        const empty = prune(child); if (empty) removeEntry(child.container, child.dict, child.ref); return !empty;
      });
      return node.children.length === 0;
    }
    const kept = node.widgets.filter(widget => {
      if (!onDeleted(widget)) return true;
      result.widgets++;
      if (widget.container) removeEntry(widget.container, widget.dict, widget.ref);
      return false;
    });
    const merged = node.widgets.some(widget => widget.dict === node.dict);
    const empty = kept.length === 0 && node.widgets.length > 0 && (merged || !node.dict.lookupMaybe(N('Kids'), PDFArray)?.size());
    if (empty) result.fields.push(node.name || '(unnamed)');
    node.widgets = kept;
    return empty;
  };
  const roots = fieldTree(doc);
  for (const root of roots) if (prune(root)) removeEntry(root.container, root.dict, root.ref);
  // Outlines: a leaf item pointing at a deleted page is removed; a parent item keeps its children and loses only its target.
  const outlines = doc.catalog.lookupMaybe(N('Outlines'), PDFDict);
  if (outlines) {
    const visit = (parent: PDFDict, depth: number) => {
      if (depth > 64) return;
      let entry = parent.get(N('First')); let guard = 0;
      while (entry instanceof PDFRef && guard++ < 100000) {
        const item = doc.context.lookupMaybe(entry, PDFDict); if (!item) break;
        const next = item.get(N('Next'));
        visit(item, depth + 1);
        const target = item.has(N('Dest')) ? destinationPage(doc, item.get(N('Dest')))
          : item.lookupMaybe(N('A'), PDFDict)?.lookupMaybe(N('S'), PDFName)?.asString() === '/GoTo' ? destinationPage(doc, item.lookupMaybe(N('A'), PDFDict)!.get(N('D'))) : undefined;
        if (target && deletedRefs.has(key(target))) {
          const title = decodePdfText(item.lookup(N('Title'))) ?? '(untitled)';
          if (item.get(N('First')) instanceof PDFRef) { item.delete(N('Dest')); item.delete(N('A')); result.outline_destinations.push(title); }
          else {
            const prev = item.get(N('Prev')); const prevItem = prev instanceof PDFRef ? doc.context.lookupMaybe(prev, PDFDict) : undefined;
            const nextItem = next instanceof PDFRef ? doc.context.lookupMaybe(next, PDFDict) : undefined;
            if (prevItem) { if (next instanceof PDFRef) prevItem.set(N('Next'), next); else prevItem.delete(N('Next')); }
            else if (next instanceof PDFRef) parent.set(N('First'), next); else parent.delete(N('First'));
            if (nextItem) { if (prev instanceof PDFRef) nextItem.set(N('Prev'), prev); else nextItem.delete(N('Prev')); }
            else if (prev instanceof PDFRef) parent.set(N('Last'), prev); else parent.delete(N('Last'));
            result.outline_items.push(title);
          }
        }
        entry = next;
      }
    };
    visit(outlines, 0);
    recountOutlines(doc, outlines);
  }
  for (const page of remaining) {
    const annots = page.node.lookupMaybe(N('Annots'), PDFArray); if (!annots) continue;
    for (let index = annots.size() - 1; index >= 0; index--) {
      const annotation = annots.lookupMaybe(index, PDFDict);
      if (!annotation || annotation.lookupMaybe(N('Subtype'), PDFName)?.asString() !== '/Link') continue;
      const target = annotationTarget(doc, annotation);
      if (target && deletedRefs.has(key(target))) { annots.remove(index); result.links++; }
    }
  }
  return result;
}

/** Count: open items count visible descendants; closed items count negative; leaves carry none; the root counts open items. */
function recountOutlines(doc: PDFDocument, root: PDFDict): void {
  const children = (parent: PDFDict): PDFDict[] => {
    const out: PDFDict[] = []; let entry = parent.get(N('First')); let guard = 0;
    while (entry instanceof PDFRef && guard++ < 100000) { const item = doc.context.lookupMaybe(entry, PDFDict); if (!item) break; out.push(item); entry = item.get(N('Next')); }
    return out;
  };
  const visible = (item: PDFDict, depth: number): number => {
    if (depth > 64) return 0;
    const kids = children(item); const counted = kids.reduce((sum, kid) => sum + 1 + ((kid.lookupMaybe(N('Count'), PDFNumber)?.asNumber() ?? 0) > 0 ? visible(kid, depth + 1) : 0), 0);
    for (const kid of kids) visible(kid, depth + 1);
    if (item !== root) {
      if (!kids.length) item.delete(N('Count'));
      else item.set(N('Count'), PDFNumber.of((item.lookupMaybe(N('Count'), PDFNumber)?.asNumber() ?? 0) >= 0 ? counted : -counted));
    }
    return counted;
  };
  const total = visible(root, 0);
  if (total) root.set(N('Count'), PDFNumber.of(total)); else root.delete(N('Count'));
}

/** Document-level structures a copyPages route does not carry into its new document. */
export function documentLevelStructures(doc: PDFDocument): string[] {
  const catalog = doc.catalog; const names = catalog.lookupMaybe(N('Names'), PDFDict); const found: string[] = [];
  if (catalog.has(N('Outlines'))) found.push('outlines');
  if (catalog.has(N('Dests')) || names?.has(N('Dests'))) found.push('named-destinations');
  if (catalog.has(N('PageLabels'))) found.push('page-labels');
  if (catalog.has(N('StructTreeRoot'))) found.push('structure-tags');
  if (names?.has(N('EmbeddedFiles'))) found.push('embedded-files');
  if (names?.has(N('JavaScript')) || catalog.has(N('OpenAction'))) found.push('document-actions');
  if (catalog.has(N('Metadata'))) found.push('xmp-metadata');
  return found;
}

/** Normalized [x0,y0,x1,y1] of a page box, honouring inheritance through pdf-lib's accessors. */
export function normalizedBox(box: { x: number; y: number; width: number; height: number }): [number, number, number, number] {
  const x0 = Math.min(box.x, box.x + box.width); const x1 = Math.max(box.x, box.x + box.width);
  const y0 = Math.min(box.y, box.y + box.height); const y1 = Math.max(box.y, box.y + box.height);
  return [x0, y0, x1, y1];
}

/** Copy the inheritable page attributes onto the leaf so a move in the page tree cannot change them. */
export function materializeInherited(page: PDFPage): void {
  for (const name of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
    const value = page.node.getInheritableAttribute(N(name));
    if (value && !page.node.get(N(name))) page.node.set(N(name), value);
  }
}
