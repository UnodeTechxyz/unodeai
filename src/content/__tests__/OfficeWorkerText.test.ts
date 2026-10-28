import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const source = ts.createSourceFile('OfficeWorker.ts', readFileSync(resolve('src/content/OfficeWorker.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const names = ['xmlText', 'decodeXml', 'docxBlocks'];
const functions = source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node)
  && !!node.name && names.includes(node.name.text));
expect(functions).toHaveLength(names.length);
const js = ts.transpileModule(functions.map(node => node.getText(source)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const actual = new Function(`${js}; return { xmlText, docxBlocks };`)() as { xmlText(xml: string): string; docxBlocks(xml: string): string[] };

describe('actual bounded Office worker text extraction', () => {
  it('preserves escaped angle brackets rather than treating decoded source text as markup', () => {
    expect(actual.xmlText('<w:r><w:t>A &lt; B &amp; C &gt; D</w:t></w:r>')).toBe('A < B & C > D');
    expect(actual.xmlText('<w:t>&lt;script&gt;not executable&lt;/script&gt;</w:t>')).toBe('<script>not executable</script>');
  });
  it('decodes entities exactly once and retains paragraphs, breaks, Unicode and numbering', () => {
    expect(actual.xmlText('<w:t>&amp;lt; &#x1F600; &#233; &quot;x&quot;</w:t>')).toBe('&lt; 😀 é "x"');
    expect(actual.docxBlocks('<w:p><w:r><w:t>1.01 合同</w:t><w:br/><w:t>契約</w:t></w:r></w:p><w:p><w:t>계약</w:t></w:p>'))
      .toEqual(['1.01 合同\n契約', '계약']);
  });
});
