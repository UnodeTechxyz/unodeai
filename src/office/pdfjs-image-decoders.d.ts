declare module 'pdfjs-dist/image_decoders/pdf.image_decoders.mjs' {
  export const VerbosityLevel: { ERRORS: number; WARNINGS: number; INFOS: number };
  export function getVerbosityLevel(): number;
  export function setVerbosityLevel(level: number): void;
  export class JpegImage {
    width: number; height: number;
    parse(data: Uint8Array): void;
    getData(options: { width: number; height: number; forceRGB?: boolean; isSourcePDF?: boolean }): Uint8ClampedArray;
  }
}
