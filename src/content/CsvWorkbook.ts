import { createReadStream, openSync, closeSync, writeSync } from 'node:fs';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import Papa from 'papaparse';

export type CsvEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030';
export interface CsvOptions { encoding?: CsvEncoding; delimiter?: string }
export interface CsvManifest { format: 'csv'; sha256: string; rows: number; columns: number; encoding: CsvEncoding;
  delimiter: string; newline: 'LF' | 'CRLF' | 'CR'; delimiterSelection: 'explicit' | 'detected' | 'fallback-comma'; warnings: string[] }
export class CsvInputFailure extends Error {
  constructor(readonly code: 'encoding' | 'delimiter' | 'quotes' | 'source-changed') { super(code); }
}

/** Values and their fixed-width offsets stay on disk; a parser holds only the current logical row. */
export async function parseCsvSnapshot(source: string, directory: string, options: CsvOptions, progress: () => void): Promise<CsvManifest> {
  const encoding = options.encoding ?? 'utf-8';
  if (!['utf-8', 'utf-16le', 'utf-16be', 'gb18030'].includes(encoding)) throw new CsvInputFailure('encoding');
  if (options.delimiter !== undefined && (typeof options.delimiter !== 'string' || !options.delimiter.length
    || /[\r\n"\ufeff]/u.test(options.delimiter))) throw new CsvInputFailure('delimiter');
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(encoding, { fatal: true }); } catch { throw new CsvInputFailure('encoding'); }
  const hash = createHash('sha256'); const input = createReadStream(source);
  const chunks = (async function* () {
    for await (const chunk of input) {
      hash.update(chunk); progress();
      try { yield decoder.decode(chunk, { stream: true }); } catch { throw new CsvInputFailure('encoding'); }
    }
    try { const tail = decoder.decode(); if (tail) yield tail; } catch { throw new CsvInputFailure('encoding'); }
  })();
  let decoded: Readable | undefined;
  const paths = ['values.utf8', 'cells.index', 'rows.index']; const fds: number[] = [];
  let valueOffset = 0; let cellOffset = 0; let rows = 0; let columns = 0; let delimiter = options.delimiter ?? ',';
  let delimiterSelection: CsvManifest['delimiterSelection'] = options.delimiter === undefined ? 'detected' : 'explicit';
  const warnings = new Set<string>();
  try {
    // Papa fixes newline/delimiter from its first chunk. Wait for a complete logical record, not 64 KiB.
    // A first record can be as long as the source; its memory is governed by the same worker resource budget.
    const prefix: string[] = []; let quoted = false; let pendingCr = false; let newline: '\n' | '\r' | '\r\n' | undefined;
    let scanned = 0; let completeRecordsEnd = 0;
    const separators = options.delimiter === undefined ? [',', '\t', '|', ';', '\x1e', '\x1f'] : [options.delimiter];
    const longestSeparator = Math.max(...separators.map(value => value.length));
    let fieldStart = true; let closedQuote = false; let outsideTail = '';
    while (!newline) {
      const next = await chunks.next(); if (next.done) break; prefix.push(next.value);
      for (const character of next.value) {
        if (pendingCr) {
          pendingCr = false; fieldStart = true; closedQuote = false; outsideTail = '';
          if (character === '\n') { newline ??= '\r\n'; scanned++; completeRecordsEnd = scanned; continue; }
          newline ??= '\r'; completeRecordsEnd = scanned;
        }
        scanned += character.length;
        if (character === '"') {
          if (quoted) { quoted = false; closedQuote = true; }
          else if (closedQuote || fieldStart) { quoted = true; closedQuote = false; }
          fieldStart = false; outsideTail = ''; continue;
        }
        closedQuote = false;
        if (!quoted && character === '\r') pendingCr = true;
        else if (!quoted && character === '\n') { newline ??= '\n'; completeRecordsEnd = scanned; fieldStart = true; outsideTail = ''; }
        else if (!quoted) { outsideTail = (outsideTail + character).slice(-longestSeparator); fieldStart = separators.some(value => outsideTail.endsWith(value)); }
      }
    }
    if (!newline) { newline = pendingCr ? '\r' : '\n'; completeRecordsEnd = scanned; }
    if (options.delimiter === undefined) {
      // Ignore empty records only while choosing the separator (including the trailing newline's empty piece).
      // The actual stream below still keeps every empty source record and field.
      // The held chunk may end midway through the NEXT quoted record; never let that fragment bias detection.
      const probe = Papa.parse(prefix.join('').slice(0, completeRecordsEnd), { delimiter: '', newline, dynamicTyping: false, skipEmptyLines: true, preview: 10 });
      delimiter = probe.meta.delimiter;
      if (probe.errors.some(error => error.code === 'UndetectableDelimiter')) {
        delimiterSelection = 'fallback-comma'; warnings.add('Delimiter could not be detected; comma was used. Specify delimiter to choose another reading.');
      }
    }
    decoded = Readable.from((async function* () { for (const text of prefix) yield text; yield* chunks; })());
    for (const file of paths) fds.push(openSync(`${directory}/${file}`, 'wx'));
    const append = (fd: number, bytes: Buffer) => { let at = 0; while (at < bytes.length) at += writeSync(fd, bytes, at); };
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const fail = (error: unknown) => { if (done) return; done = true; input.destroy(); decoded!.destroy(); reject(error); };
      decoded!.on('error', fail);
      Papa.parse(decoded!, { delimiter, newline, dynamicTyping: false, skipEmptyLines: false,
        step(result, parser) {
          if (done) { parser.abort(); return; }
          try {
            for (const error of result.errors) {
              if (error.code === 'UndetectableDelimiter') { delimiterSelection = 'fallback-comma'; warnings.add('Delimiter could not be detected; comma was used. Specify delimiter to choose another reading.'); }
              else throw new CsvInputFailure(error.type === 'Quotes' ? 'quotes' : 'delimiter');
            }
            delimiter = result.meta.delimiter;
            const values = result.data as string[];
            const row = Buffer.alloc(16); row.writeBigUInt64LE(BigInt(cellOffset)); row.writeBigUInt64LE(BigInt(values.length), 8); append(fds[2], row);
            for (const text of values) {
              const bytes = Buffer.from(text, 'utf8'); const entry = Buffer.alloc(16);
              entry.writeBigUInt64LE(BigInt(valueOffset)); entry.writeBigUInt64LE(BigInt(bytes.length), 8);
              append(fds[0], bytes); append(fds[1], entry); valueOffset += bytes.length; cellOffset++;
            }
            columns = Math.max(columns, values.length); rows++; progress();
          } catch (error) { fail(error); parser.abort(); }
        },
        complete() { if (!done) { done = true; resolve(); } }, error: fail,
      });
    });
    return { format: 'csv', sha256: hash.digest('hex'), rows, columns, encoding, delimiter, newline: newline === '\r\n' ? 'CRLF' : newline === '\r' ? 'CR' : 'LF', delimiterSelection, warnings: [...warnings] };
  } finally { input.destroy(); decoded?.destroy(); for (const fd of fds) closeSync(fd); }
}
