declare module 'papaparse' {
  import type { Readable } from 'node:stream';
  interface CsvResult { data: string[]; errors: Array<{ type: string; code: string }>; meta: { delimiter: string } }
  interface CsvParser { abort(): void }
  const Papa: {
    parse(input: string, options: { delimiter: string; newline: '\n' | '\r' | '\r\n'; dynamicTyping: false; skipEmptyLines: true; preview: number }): CsvResult;
    parse(input: Readable, options: { delimiter: string; newline: '\n' | '\r' | '\r\n'; dynamicTyping: false; skipEmptyLines: false;
      step(result: CsvResult, parser: CsvParser): void; complete(): void; error(error: unknown): void }): void;
  };
  export default Papa;
}
