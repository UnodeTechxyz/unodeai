import { DocumentFailure } from './DocumentContracts';
import { assertFontEmbedding, inspectSfntFaces } from './FontEmbeddingPolicy';
import type { DocumentFontFace } from './PdfFontAdapter';

export interface PublicFontkit { create(bytes: Uint8Array, postscriptName?: string): any }
/** Collection-vs-single is a container fact, not "number of faces > 1" or a variation-name guess. */
export function selectDocumentFontFace(fontkit: PublicFontkit, bytes: Uint8Array,
  wanted: { family?: string; postscriptName?: string; style: 'regular' | 'bold' }) {
  const metadata = inspectSfntFaces(bytes);
  const collection = bytes[0] === 0x74 && bytes[1] === 0x74 && bytes[2] === 0x63 && bytes[3] === 0x66;
  const parsed = fontkit.create(bytes);
  const faces: DocumentFontFace[] = collection ? parsed?.fonts : [parsed];
  if (!Array.isArray(faces) || faces.length !== metadata.length) throw new DocumentFailure('font-resource-invalid');
  const matches = faces.map((face, index) => ({ face, index })).filter(({ face, index }) =>
    face && (!wanted.family || face.familyName === wanted.family)
      && (!wanted.postscriptName || face.postscriptName === wanted.postscriptName)
      && (metadata[index].weightClass >= 600) === (wanted.style === 'bold'));
  if (matches.length !== 1) throw new DocumentFailure('font-resource-invalid');
  const { face: declared, index } = matches[0];
  assertFontEmbedding(metadata[index], wanted.style);
  if (typeof declared.postscriptName !== 'string' || !declared.postscriptName) throw new DocumentFailure('font-resource-invalid');
  // fontkit's named collection lookup cannot disambiguate duplicate PS names by weight.
  // A unique family/style match is not sufficient evidence for the face returned by that lookup.
  if (collection && faces.filter(face => face?.postscriptName === declared.postscriptName).length !== 1) throw new DocumentFailure('font-resource-invalid');
  const face: DocumentFontFace = collection ? fontkit.create(bytes, declared.postscriptName) : parsed;
  if (!face || face.postscriptName !== declared.postscriptName || face.familyName !== declared.familyName
    || typeof face.layout !== 'function') throw new DocumentFailure('font-resource-invalid');
  return { face, metadata: metadata[index] };
}
