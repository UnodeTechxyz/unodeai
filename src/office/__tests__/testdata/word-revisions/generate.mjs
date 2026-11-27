#!/usr/bin/env node
// Test fixture generator, not part of the product. Windows with Microsoft Word only.
//
// 1. Builds a synthetic seed DOCX with three fictional authors: insert, delete, nested deletion of another
//    author's insertion, move, inserted paragraph, deleted paragraph mark, format changes, an inserted table
//    row, a header revision, a two-paragraph comment with a reply (thread resolved) and a point comment.
// 2. word-check.ps1 opens it in a new, owned, hidden Word instance and saves it with Word (SaveAs2, DOCX), so
//    the committed fixture is Word's own serialization (part names, relationship types, content types,
//    paraIds, comment metadata). Word then reports its revisions and comments and its own Accept All and
//    Reject All text for the body and the first-section header; those texts are the expected views.
// 3. The core-properties "last modified by" value Word writes is replaced by a fictional name; nothing else
//    is changed after Word saved the file.
//
// Run from the repository root: node src/office/__tests__/testdata/word-revisions/generate.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const here = dirname(fileURLToPath(import.meta.url));
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const ns = `xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml" xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14 w15 w16cid"`;
const A = 'w:author="Avery Fixture"'; const B = 'w:author="Blake Fixture"'; const C = 'w:author="Casey Fixture"';
const d = day => `w:date="2026-11-0${day}T09:00:00Z"`;
const t = text => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const gone = text => `<w:r><w:delText xml:space="preserve">${text}</w:delText></w:r>`;
const body = [
  `<w:p>${t('Alpha ')}<w:del w:id="101" ${A} ${d(1)}>${gone('old ')}</w:del><w:ins w:id="102" ${A} ${d(1)}>${t('new ')}</w:ins>${t('text.')}</w:p>`,
  `<w:p>${t('Keep ')}<w:ins w:id="103" ${A} ${d(1)}><w:del w:id="104" ${B} ${d(2)}>${gone('drop ')}</w:del></w:ins>${t('this.')}</w:p>`,
  `<w:p>${t('Before ')}<w:moveFromRangeStart w:id="105" ${C} ${d(3)} w:name="move1"/><w:moveFrom w:id="106" ${C} ${d(3)}>${t('moved words ')}</w:moveFrom><w:moveFromRangeEnd w:id="105"/>${t('after.')}</w:p>`,
  `<w:p><w:pPr><w:rPr><w:ins w:id="107" ${B} ${d(2)}/></w:rPr></w:pPr><w:ins w:id="108" ${B} ${d(2)}>${t('Brand new paragraph.')}</w:ins></w:p>`,
  `<w:p>${t('Target: ')}<w:moveToRangeStart w:id="109" ${C} ${d(3)} w:name="move1"/><w:moveTo w:id="110" ${C} ${d(3)}>${t('moved words ')}</w:moveTo><w:moveToRangeEnd w:id="109"/>${t('here.')}</w:p>`,
  `<w:p><w:pPr><w:rPr><w:del w:id="111" ${A} ${d(1)}/></w:rPr></w:pPr>${t('First half ')}</w:p>`,
  `<w:p>${t('second half.')}</w:p>`,
  `<w:p><w:pPr><w:jc w:val="center"/><w:pPrChange w:id="112" ${C} ${d(3)}><w:pPr/></w:pPrChange></w:pPr><w:r><w:rPr><w:b/><w:rPrChange w:id="113" ${C} ${d(3)}><w:rPr/></w:rPrChange></w:rPr><w:t>Bold now.</w:t></w:r></w:p>`,
  `<w:p>${t('See ')}<w:commentRangeStart w:id="1"/><w:commentRangeStart w:id="2"/>${t('commented words')}<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r><w:commentRangeEnd w:id="2"/><w:r><w:commentReference w:id="2"/></w:r>${t(' and a point')}<w:r><w:commentReference w:id="3"/></w:r>${t('.')}</w:p>`,
  `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid>`
    + `<w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr><w:p>${t('Row one')}</w:p></w:tc></w:tr>`
    + `<w:tr><w:trPr><w:ins w:id="114" ${A} ${d(1)}/></w:trPr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:rPr><w:ins w:id="115" ${A} ${d(1)}/></w:rPr></w:pPr><w:ins w:id="116" ${A} ${d(1)}>${t('Row two')}</w:ins></w:p></w:tc></w:tr></w:tbl>`,
  `<w:p>${t('End.')}</w:p>`,
  `<w:sectPr><w:headerReference w:type="default" r:id="rIdH1"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`,
].join('');
const header = `<w:hdr ${ns}><w:p>${t('Header ')}<w:ins w:id="117" ${B} ${d(2)}>${t('draft ')}</w:ins>${t('title')}</w:p></w:hdr>`;
const commentParagraph = (id, text, first) => `<w:p w14:paraId="${id}" w14:textId="77777777">${first ? '<w:r><w:annotationRef/></w:r>' : ''}${t(text)}</w:p>`;
const comments = `<w:comments ${ns}>`
  + `<w:comment w:id="1" ${A} ${d(4)} w:initials="AF">${commentParagraph('1A000001', 'First comment line.', true)}${commentParagraph('1A000002', 'Second line.', false)}</w:comment>`
  + `<w:comment w:id="2" ${B} ${d(5)} w:initials="BF">${commentParagraph('1B000001', 'Reply text.', true)}</w:comment>`
  + `<w:comment w:id="3" ${C} ${d(6)} w:initials="CF">${commentParagraph('1C000001', 'Point note.', true)}</w:comment></w:comments>`;
const commentsExtended = `<w15:commentsEx ${ns}><w15:commentEx w15:paraId="1A000002" w15:done="1"/><w15:commentEx w15:paraId="1B000001" w15:paraIdParent="1A000002" w15:done="0"/><w15:commentEx w15:paraId="1C000001" w15:done="0"/></w15:commentsEx>`;
const commentsIds = `<w16cid:commentsIds ${ns}><w16cid:commentId w16cid:paraId="1A000002" w16cid:durableId="2A000001"/><w16cid:commentId w16cid:paraId="1B000001" w16cid:durableId="2B000001"/><w16cid:commentId w16cid:paraId="1C000001" w16cid:durableId="2C000001"/></w16cid:commentsIds>`;
const CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.';
const seed = new JSZip();
seed.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
  + `<Override PartName="/word/document.xml" ContentType="${CT}document.main+xml"/><Override PartName="/word/header1.xml" ContentType="${CT}header+xml"/><Override PartName="/word/comments.xml" ContentType="${CT}comments+xml"/>`
  + `<Override PartName="/word/commentsExtended.xml" ContentType="${CT}commentsExtended+xml"/><Override PartName="/word/commentsIds.xml" ContentType="${CT}commentsIds+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`);
seed.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
seed.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdH1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rIdC1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/><Relationship Id="rIdC2" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/><Relationship Id="rIdC3" Type="http://schemas.microsoft.com/office/2016/09/relationships/commentsIds" Target="commentsIds.xml"/></Relationships>`);
seed.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${ns}><w:body>${body}</w:body></w:document>`);
seed.file('word/header1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${header}`);
seed.file('word/comments.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${comments}`);
seed.file('word/commentsExtended.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${commentsExtended}`);
seed.file('word/commentsIds.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${commentsIds}`);
seed.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Fixture</dc:creator></cp:coreProperties>`);

const work = mkdtempSync(join(tmpdir(), 'unode-word-fixture-'));
try {
  const seedPath = join(work, 'seed.docx'); const saved = join(work, 'saved.docx'); const result = join(work, 'result.json'); const jobPath = join(work, 'job.json');
  writeFileSync(seedPath, await seed.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  writeFileSync(jobPath, JSON.stringify({ source: seedPath, saveAs: saved, result }));
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'word-check.ps1'), '-JobFile', jobPath], { encoding: 'utf8', windowsHide: true, timeout: 300000 });
  let raw; try { raw = readFileSync(result, 'utf8'); } catch { throw new Error(`No Word result: ${run.status} ${run.error ?? ''} ${run.stdout} ${run.stderr}`); }
  const report = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (run.status !== 0 || report.error || !report.saved || !report.quit) throw new Error(`Word fixture generation failed: ${run.stderr} ${JSON.stringify(report)}`);
  const zip = await JSZip.loadAsync(readFileSync(saved));
  const core = await zip.file('docProps/core.xml').async('string');
  zip.file('docProps/core.xml', core.replace(/<cp:lastModifiedBy>[^<]*<\/cp:lastModifiedBy>/, '<cp:lastModifiedBy>Fixture</cp:lastModifiedBy>'));
  const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const name = userInfo().username.toLowerCase();
  for (const [member, entry] of Object.entries(zip.files)) if (!entry.dir) {
    const text = (await entry.async('string')).toLowerCase();
    if (name.length > 2 && text.includes(name) || /users[\\/]/.test(text)) throw new Error(`Personal data in ${member}; fixture not written.`);
  }
  writeFileSync(join(here, 'word-revisions.docx'), output);
  writeFileSync(join(here, 'word-revisions.expected.json'), JSON.stringify({
    generator: 'generate.mjs + word-check.ps1', word_version: report.app_version,
    revisions: report.revisions, comments: report.comments, accepted: report.accepted, rejected: report.rejected,
  }, null, 2) + '\n');
  console.log(JSON.stringify({ word: report.app_version, revisions: report.revisions.length, comments: report.comments.length, owned: report.owned, quit: report.quit }));
} finally { rmSync(work, { recursive: true, force: true }); }
