import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const Papa = require('papaparse');
const { SaxesParser } = require('saxes');
async function csv(chunks: string[], delimiter = ','): Promise<string[][]> {
  return await new Promise((resolve, reject) => {
    const rows: string[][] = [];
    Papa.parse(Readable.from(chunks), { delimiter, dynamicTyping: false, skipEmptyLines: false,
      step(result: { data: string[]; errors: unknown[] }) { if (result.errors.length) reject(new Error('invalid CSV')); rows.push(result.data); },
      complete() { resolve(rows); }, error: reject });
  });
}
describe('pinned workbook parser compatibility admission (not product entry evidence)', () => {
  it('keeps literals, duplicate/empty headers, quoted delimiter/newline and trailing empty fields across chunks', async () => {
    expect(await csv(['name,name,\r\n"a,', 'b","x\r\n', 'y",=1+1\r\n0,,\r\n'])).toEqual([
      ['name', 'name', ''], ['a,b', 'x\r\ny', '=1+1'], ['0', '', ''],
    ]);
    expect(await csv(['a\tb\n  \t\n\t'], '\t')).toEqual([['a', 'b'], ['  ', ''], ['', '']]);
    await expect(csv(['x,"unfinished'])).rejects.toThrow('invalid CSV');
  });
  it('parses namespace XML incrementally and leaves DTD handling to explicit host rejection', () => {
    const texts: string[] = []; const parser = new SaxesParser({ xmlns: true });
    parser.on('text', (text: string) => texts.push(text));
    parser.write('<r xmlns="urn:x"><c>A &amp; B</c>').write('</r>').close(); expect(texts).toEqual(['A & B']);
    expect(() => new SaxesParser().write('<r>&unknown;</r>').close()).toThrow();
    const dtd = new SaxesParser(); let declaration = '';
    dtd.on('doctype', (value: string) => { declaration = value; });
    dtd.write('<!DOCTYPE r SYSTEM "https://invalid.example/no-network"><r/>').close(); expect(declaration).toContain('invalid.example');
  });
});
