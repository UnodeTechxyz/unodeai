/*
 * v0.9.97 P4: an OpenAI-compatible agent has `save_attachment` as a host tool (review resolution §2 route matrix:
 * "save_attachment: OpenAI-compatible: the host tool"). A turn that is handed the user's attachment saves it byte for
 * byte; a coordinator with teammates saves only under a task contract that selects it, as for write_file.
 */
import { realpathSync } from 'fs';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentFailure } from '../../content/document/DocumentContracts';
import { OpenAICompatBackend, type FetchFn, type StreamFetchFn } from '../OpenAICompatBackend';
import { RunLedger } from '../../observability/RunLedger';
import { buildPortableRunEvidence } from '../../observability/PortableRunEvidence';
import { renderRunEvidencePack } from '../../observability/RunEvidencePack';
import type { BackendEvent } from '../AgentBackend';
import type { AgentConfig } from '../../types';
import { ContentAssetStore } from '../../content/ContentAssetStore';
import { FileWritePolicy } from '../fileWritePolicy';
import { admitUserTurn, attachment, attachmentIds, PNG, sha } from './attachmentSaveFixtures';
import { removeTemporaryFolders, temporaryFolder } from './pathSafetyFixtures';
import { documentInput, documentRouteRenderer, boundDocumentInput, assertBoundDocument } from './documentRouteFixtures';
import { WRITE_DOCUMENT_SPEC } from '../../content/document/DocumentTool';
import { saveHost } from './attachmentSaveFixtures';
import { assertEditablePresentation, presentationRouteRenderer, presentationInput, boundPresentationInput, assertBoundPresentation } from './presentationRouteFixtures';
import { PRESENTATION_PNG, presentationWithImage, assertOriginalPngEmbedded } from './presentationImageFixtures';
import { workbookRouteReader, workbookRouteEditor } from './workbookRouteFixtures';
import { workbookFixture } from '../../office/__tests__/workbookEditFixtures';
import { officeRouteReader, officeRouteEditor, officeRouteDocument, officeRouteParagraph, officeRouteAttachmentQualifier } from './officeInventoryRouteFixtures';
import type { WorkbookPage } from '../../content/WorkbookPage';
import { typedXlsxFixture } from '../../content/__tests__/xlsxFixtures';
import { COMPUTE_CSV, workbookSumPlan, WorkbookRecordCollector } from './workbookComputeFixtures';
import { readOfficeShapeText } from '../../office/OfficeShapeText';
import { wordPictureDocument } from './officeWordPictureFixtures';
import { wordStoryDocument } from './officeWordStoryFixtures';
import { pdfRouteEditor } from './pdfRouteFixtures';
import { makePdf, textPort as pdfTextPort } from '../../office/pdf/__tests__/pdfFixtures';

afterEach(removeTemporaryFolders);

function config(root: string): AgentConfig {
  return {
    id: 'a1', name: 'Worker', role: 'senior-dev', skill: '',
    provider: { providerId: 'roam', apiKeySecretName: 'ROAM_API_KEY' },
    model: 'deepseek-chat', systemPrompt: 'Be terse.', autoApprove: true, allowedTools: ['read', 'write'],
    workingDirectory: root,
  };
}

const toolCall = (name: string, args: Record<string, unknown>, id: string) => ({
  choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
});
const reply = (content: string) => ({ choices: [{ message: { role: 'assistant', content } }] });

describe('v0.9.108 edit_pdf through the actual OpenAI-compatible turn router', () => {
  it('offers view_pdf_pages in the HTTP tool list when the agent may run commands', async () => {
    const h = await saveHost(); await fs.writeFile(path.join(h.root, 'in.pdf'), await makePdf([{ text: 'HTTP page' }])); let output = ''; let offered = false;
    const backend = new OpenAICompatBackend({ ...config(h.root), allowedTools: ['read', 'write', 'execute'] }, async (_url, init) => {
      const body = JSON.parse(init.body); offered ||= body.tools.some((tool: any) => tool.function.name === 'view_pdf_pages');
      const results = body.messages.filter((message: any) => message.role === 'tool');
      const response = !results.length ? toolCall('view_pdf_pages', { path: 'in.pdf', pages: '1' }, 'pages') : (output = String(results.at(-1).content), reply('Done.'));
      return { ok: true, status: 200, text: async () => JSON.stringify(response) };
    }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { fileWrites: h.fileWrites('a1') });
    (backend as any).tools.setPdfPageRasterPlatform(() => undefined); const done = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'turn_complete') resolve(); }));
    try { await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Show page one.'); await done; expect(offered).toBe(true); expect(output).toContain('platform-unsupported'); }
    finally { await backend.stop(); await h.assets.dispose(); }
  });
  it('offers edit_pdf in the HTTP tool list and saves a watermarked, numbered PDF', async () => {
    const h = await saveHost(); const editor = await pdfRouteEditor(); await fs.writeFile(path.join(h.root, 'in.pdf'), await makePdf([{ text: 'HTTP page' }])); let output = '';
    const backend = new OpenAICompatBackend(config(h.root), async (_url, init) => {
      const body = JSON.parse(init.body); expect(body.tools.find((tool: any) => tool.function.name === 'edit_pdf').function.parameters.properties.operations.items.properties.op.enum).toContain('fill_form');
      const results = body.messages.filter((message: any) => message.role === 'tool'); const text = (message: any) => typeof message.content === 'string' ? message.content : message.content.map((block: any) => block.text ?? '').join('\n');
      const response = !results.length ? toolCall('edit_pdf', { schema_version: 1, destination: 'out.pdf', inputs: [{ path: 'in.pdf' }], operations: [{ op: 'add_watermark', text: 'DRAFT' }, { op: 'add_page_numbers' }] }, 'edit-pdf')
        : (output = text(results.at(-1)), reply('Done.'));
      return { ok: true, status: 200, text: async () => JSON.stringify(response) };
    }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { fileWrites: h.fileWrites('a1') });
    (backend as any).tools.setPdfEditor(editor); const done = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'turn_complete') resolve(); }));
    try {
      await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Mark the PDF as a draft.'); await done;
      expect(output).toContain('"kind":"pdf-edited"'); const pages = await pdfTextPort.pages(await fs.readFile(path.join(h.root, 'out.pdf')));
      const page = pages[0].map(item => item.str).join(''); expect(page).toContain('HTTP page'); expect(page).toContain('DRAFT'); expect(page.replace(/\s/g, '')).toContain('1/1');
    } finally { await backend.stop(); await h.assets.dispose(); }
  });
});

describe('D3 document tool through the actual OpenAI-compatible turn router', () => {
  it('O4 assigns a header bookmark through actual HTTP discovery, inspection, worker and save', async () => {
    const h = await saveHost(); const reader = await officeRouteReader(); const editor = await officeRouteEditor(); const source = await wordStoryDocument(); await fs.writeFile(path.join(h.root, 'source.docx'), source); let output = '';
    const backend = new OpenAICompatBackend(config(h.root), async (_url, init) => {
      const body = JSON.parse(init.body); expect(body.tools.find((tool: any) => tool.function.name === 'edit_office').function.parameters.properties.edits.items.properties.op.enum).toContain('set_bookmark_text');
      // v0.9.108 W2: the HTTP tool list carries the tracked-change field and the decision operations.
      expect(body.tools.find((tool: any) => tool.function.name === 'edit_office').function.parameters.properties.track_changes.type).toBe('boolean');
      expect(body.tools.find((tool: any) => tool.function.name === 'edit_office').function.parameters.properties.edits.items.properties.op.enum).toEqual(expect.arrayContaining(['accept_revision', 'reject_revision']));
      // v0.9.108 W1: the Word view parameter reaches the HTTP tool list.
      expect(body.tools.find((tool: any) => tool.function.name === 'inspect_office').function.parameters.properties.view.enum).toEqual(['current', 'original', 'markup']);
      const results = body.messages.filter((message: any) => message.role === 'tool'); const text = (message: any) => typeof message.content === 'string' ? message.content : message.content.map((block: any) => block.text ?? '').join('\n'); let response;
      if (!results.length) response = toolCall('inspect_office', { path: 'source.docx' }, 'inspect-empty-bookmark');
      else if (results.length === 1) { const page = JSON.parse(text(results[0])); response = toolCall('edit_office', { schema_version: 1, track_changes: false, snapshot_ref: page.snapshot_ref, path: 'header-copy.docx', edits: [
        { op: 'set_bookmark_text', target_ref: page.prepared_fragments.find((record: any) => record.kind === 'bookmark' && record.record.story === 'header').id, text: 'Filled HTTP\r\n中文\tvalue' },
        { op: 'replace_text', target_ref: page.prepared_fragments.find((record: any) => record.kind === 'paragraph' && record.record.text === 'Original after').id, find: 'Original after', replace: 'Original after changed' },
      ] }, 'assign-empty-bookmark'); } else { output = text(results.at(-1)); response = reply('Done.'); }
      return { ok: true, status: 200, text: async () => JSON.stringify(response) };
    }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { fileWrites: h.fileWrites('a1') });
    (backend as any).tools.setOfficeReader(reader); (backend as any).tools.setOfficeEditor(editor); const done = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'turn_complete') resolve(); }));
    try {
      await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Assign the empty Customer header bookmark and edit the following original paragraph.'); await done; expect(output).toContain('Edited stored header/footer parts'); expect(output).toContain('paragraphs added 1');
      const saved = await JSZip.loadAsync(await fs.readFile(path.join(h.root, 'header-copy.docx'))); const header = await saved.file('word/header1.xml')!.async('string'); const main = await saved.file('word/document.xml')!.async('string'); expect(header).toContain('Filled HTTP'); expect(header).toContain('中文'); expect(header).toContain('w:bookmarkEnd'); expect(header).not.toContain('data-unode-story'); expect(main).toContain('Original after changed'); const before = await JSZip.loadAsync(source); expect(await saved.file('word/footer1.xml')!.async('nodebuffer')).toEqual(await before.file('word/footer1.xml')!.async('nodebuffer')); expect(await fs.readFile(path.join(h.root, 'source.docx'))).toEqual(source);
    } finally { await backend.stop(); await reader.dispose(); await h.assets.dispose(); }
  });
  it('O4 assigns an empty Word bookmark through actual HTTP discovery, inspection, worker and save', async () => {
    const h = await saveHost(); const reader = await officeRouteReader(); const editor = await officeRouteEditor(); const zip = await JSZip.loadAsync(await officeRouteDocument());
    zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Outside</w:t></w:r></w:p><w:bookmarkStart w:id="7" w:name="Customer"/><w:bookmarkEnd w:id="7"/><w:p><w:r><w:t>Original after</w:t></w:r></w:p></w:body></w:document>');
    const source = await zip.generateAsync({ type: 'nodebuffer' }); await fs.writeFile(path.join(h.root, 'source.docx'), source); let output = '';
    const backend = new OpenAICompatBackend(config(h.root), async (_url, init) => {
      const body = JSON.parse(init.body); expect(body.tools.find((tool: any) => tool.function.name === 'edit_office').function.parameters.properties.edits.items.properties.op.enum).toContain('set_bookmark_text');
      const results = body.messages.filter((message: any) => message.role === 'tool'); const text = (message: any) => typeof message.content === 'string' ? message.content : message.content.map((block: any) => block.text ?? '').join('\n'); let response;
      if (!results.length) response = toolCall('inspect_office', { path: 'source.docx' }, 'inspect-empty-bookmark');
      else if (results.length === 1) { const page = JSON.parse(text(results[0])); response = toolCall('edit_office', { schema_version: 1, track_changes: false, snapshot_ref: page.snapshot_ref, path: 'bookmark-copy.docx', edits: [
        { op: 'set_bookmark_text', target_ref: page.prepared_fragments.find((record: any) => record.kind === 'bookmark').id, text: 'Filled HTTP\r\n中文\tvalue' },
        { op: 'replace_text', target_ref: page.prepared_fragments.find((record: any) => record.kind === 'paragraph' && record.record.text === 'Original after').id, find: 'Original after', replace: 'Original after changed' },
      ] }, 'assign-empty-bookmark'); } else { output = text(results.at(-1)); response = reply('Done.'); }
      return { ok: true, status: 200, text: async () => JSON.stringify(response) };
    }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { fileWrites: h.fileWrites('a1') });
    (backend as any).tools.setOfficeReader(reader); (backend as any).tools.setOfficeEditor(editor); const done = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'turn_complete') resolve(); }));
    try {
      await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Assign the empty Customer bookmark and edit the following original paragraph.'); await done; expect(output).toContain('Assigned stored bookmark text B1; paragraphs added 1');
      const saved = await JSZip.loadAsync(await fs.readFile(path.join(h.root, 'bookmark-copy.docx'))); const xml = await saved.file('word/document.xml')!.async('string'); expect(xml).toContain('Filled HTTP'); expect(xml).toContain('中文'); expect(xml).toContain('Original after changed'); expect(xml).not.toContain('data-unode-private'); expect(xml).toContain('w:bookmarkEnd'); expect((await fs.readFile(path.join(h.root, 'source.docx'))).equals(source)).toBe(true);
    } finally { await backend.stop(); await reader.dispose(); await h.assets.dispose(); }
  });
  it('O4 assigns an empty Word text control through actual HTTP discovery, inspection, worker and save', async () => {
    const h = await saveHost(); const reader = await officeRouteReader(); const editor = await officeRouteEditor(); const zip = await JSZip.loadAsync(await officeRouteDocument());
    zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Outside</w:t></w:r></w:p><w:sdt><w:sdtPr><w:id w:val="23"/><w:alias w:val="Customer"/><w:showingPlcHdr/><w:text/></w:sdtPr><w:sdtContent/></w:sdt><w:p><w:r><w:t>Original after</w:t></w:r></w:p></w:body></w:document>');
    const source = await zip.generateAsync({ type: 'nodebuffer' }); await fs.writeFile(path.join(h.root, 'source.docx'), source); let output = '';
    const backend = new OpenAICompatBackend(config(h.root), async (_url, init) => {
      const body = JSON.parse(init.body); expect(body.tools.find((tool: any) => tool.function.name === 'edit_office').function.parameters.properties.edits.items.properties.op.enum).toContain('set_control_text');
      const results = body.messages.filter((message: any) => message.role === 'tool'); const text = (message: any) => typeof message.content === 'string' ? message.content : message.content.map((block: any) => block.text ?? '').join('\n'); let response;
      if (!results.length) response = toolCall('inspect_office', { path: 'source.docx' }, 'inspect-empty-control');
      else if (results.length === 1) { const page = JSON.parse(text(results[0])); response = toolCall('edit_office', { schema_version: 1, track_changes: false, snapshot_ref: page.snapshot_ref, path: 'control-copy.docx', edits: [
        { op: 'set_control_text', target_ref: page.prepared_fragments.find((record: any) => record.kind === 'content-control').id, text: 'Filled HTTP\r\n中文\tvalue' },
        { op: 'replace_text', target_ref: page.prepared_fragments.find((record: any) => record.kind === 'paragraph' && record.record.text === 'Original after').id, find: 'Original after', replace: 'Original after changed' },
      ] }, 'assign-empty-control'); } else { output = text(results.at(-1)); response = reply('Done.'); }
      return { ok: true, status: 200, text: async () => JSON.stringify(response) };
    }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { fileWrites: h.fileWrites('a1') });
    (backend as any).tools.setOfficeReader(reader); (backend as any).tools.setOfficeEditor(editor); const done = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'turn_complete') resolve(); }));
    try {
      await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Assign the empty Customer text control and edit the following original paragraph.'); await done; expect(output).toContain('Assigned stored control text C1; placeholder flag removed true; paragraphs added 1');
      const saved = await JSZip.loadAsync(await fs.readFile(path.join(h.root, 'control-copy.docx'))); const xml = await saved.file('word/document.xml')!.async('string'); expect(xml).toContain('Filled HTTP'); expect(xml).toContain('中文'); expect(xml).toContain('Original after changed'); expect(xml).not.toContain('showingPlcHdr'); expect((await fs.readFile(path.join(h.root, 'source.docx'))).equals(source)).toBe(true);
    } finally { await backend.stop(); await reader.dispose(); await h.assets.dispose(); }
  });
  it('O4 edits exact Word bookmark/control text through actual HTTP inspection, worker and save', async () => {
    const h = await saveHost(); const reader = await officeRouteReader(); const editor = await officeRouteEditor(); const zip = await JSZip.loadAsync(await officeRouteDocument());
    zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Sample name</w:t></w:r></w:p><w:p><w:bookmarkStart w:id="7" w:name="Customer"/><w:sdt><w:sdtPr><w:id w:val="23"/><w:alias w:val="Customer name"/><w:showingPlcHdr/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>Sample name</w:t></w:r></w:sdtContent></w:sdt><w:bookmarkEnd w:id="7"/></w:p></w:body></w:document>');
    const source = await zip.generateAsync({ type: 'nodebuffer' }); await fs.writeFile(path.join(h.root, 'source.docx'), source); let output = '';
    const backend = new OpenAICompatBackend(config(h.root), async (_url, init) => {
      const body = JSON.parse(init.body); const results = body.messages.filter((message: any) => message.role === 'tool'); const text = (message: any) => typeof message.content === 'string' ? message.content : message.content.map((block: any) => block.text ?? '').join('\n'); let response;
      if (!results.length) response = toolCall('inspect_office', { path: 'source.docx' }, 'inspect-region-text');
      else if (results.length === 1) { const page = JSON.parse(text(results[0])); response = toolCall('edit_office', { schema_version: 1, snapshot_ref: page.snapshot_ref, path: 'region-copy.docx', edits: [
        { op: 'replace_text', target_ref: page.prepared_fragments.find((record: any) => record.kind === 'bookmark').id, find: 'Sample name', replace: 'Exact customer' },
        { op: 'replace_text', target_ref: page.prepared_fragments.find((record: any) => record.kind === 'content-control').id, find: 'Exact customer', replace: 'Final display text' },
      ] }, 'edit-region-text'); } else { output = text(results.at(-1)); response = reply('Done.'); }
      return { ok: true, status: 200, text: async () => JSON.stringify(response) };
    }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { fileWrites: h.fileWrites('a1') });
    (backend as any).tools.setOfficeReader(reader); (backend as any).tools.setOfficeEditor(editor); const done = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'turn_complete') resolve(); }));
    try {
      await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Change only the stored text of the named Word region.'); await done; expect(output).toContain('Stored Word region text targets: B1, C1'); expect(output).toContain('not a completed binding or form-fill operation');
      const saved = await JSZip.loadAsync(await fs.readFile(path.join(h.root, 'region-copy.docx'))); const xml = await saved.file('word/document.xml')!.async('string'); expect(xml).toContain('Final display text'); expect(xml.match(/<w:t>Sample name<\/w:t>/g)).toHaveLength(1); expect(xml).toContain('w:bookmarkStart w:id="7"'); expect(xml).toContain('<w:showingPlcHdr/>'); expect((await fs.readFile(path.join(h.root, 'source.docx'))).equals(source)).toBe(true);
    } finally { await backend.stop(); await reader.dispose(); await h.assets.dispose(); }
  });
  it('O4 delivers actual Word bookmark/control inspection records through the HTTP tool result', async () => {
    const h = await saveHost(); const reader = await officeRouteReader(); const zip = await JSZip.loadAsync(await officeRouteDocument());
    zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:bookmarkStart w:id="7" w:name="Customer"/><w:sdt><w:sdtPr><w:id w:val="23"/><w:alias w:val="Customer name"/><w:showingPlcHdr/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>Sample name</w:t></w:r></w:sdtContent></w:sdt><w:bookmarkEnd w:id="7"/></w:p></w:body></w:document>');
    const source = await zip.generateAsync({ type: 'nodebuffer' }); await fs.writeFile(path.join(h.root, 'source.docx'), source); let inspected = false;
    const backend = new OpenAICompatBackend({ ...config(h.root), allowedTools: ['read'] }, async (_url, init) => {
      const body = JSON.parse(init.body); const results = body.messages.filter((message: any) => message.role === 'tool'); let response;
      if (!results.length) response = toolCall('inspect_office', { path: 'source.docx' }, 'inspect-regions');
      else {
        const message = results.at(-1); const text = typeof message.content === 'string' ? message.content : message.content.map((block: any) => block.text ?? '').join('\n'); const page = JSON.parse(text);
        expect(page.summary).toMatchObject({ controls: 1, bookmarks: 1 }); expect(page.prepared_fragments.find((record: any) => record.id === 'C1').record).toMatchObject({ text: 'Sample name', alias: 'Customer name', control_id: '23', showing_placeholder: true, paragraph_refs: ['D1'] });
        expect(page.prepared_fragments.find((record: any) => record.id === 'B1').record).toMatchObject({ text: 'Sample name', name: 'Customer', paired: true }); inspected = true; response = reply('Inspected.');
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(response) };
    });
    (backend as any).tools.setOfficeReader(reader); const done = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'turn_complete') resolve(); }));
    try { await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Inspect the named Word placeholders.'); await done; expect(inspected).toBe(true); expect((await fs.readFile(path.join(h.root, 'source.docx'))).equals(source)).toBe(true); }
    finally { await backend.stop(); await reader.dispose(); await h.assets.dispose(); }
  });
  it('O4 inserts a Word table through actual HTTP discovery, generation, inspection, worker and save', async () => {
    const h = await saveHost(); const reader = await officeRouteReader(); const editor = await officeRouteEditor(); const renderer = await documentRouteRenderer(); let output = '';
    const backend = new OpenAICompatBackend(config(h.root), async (_url, init) => {
      const body = JSON.parse(init.body); const spec = body.tools.find((tool: any) => tool.function.name === 'edit_office'); expect(spec.function.parameters.properties.edits.items.properties.op.enum).toContain('insert_table');
      const results = body.messages.filter((message: any) => message.role === 'tool'); const text = (message: any) => typeof message.content === 'string' ? message.content : message.content.map((block: any) => block.text ?? '').join('\n'); let response;
      if (!results.length) response = toolCall('write_document', documentInput('docx', 'Original paragraph'), 'write-table-base');
      else if (results.length === 1) response = toolCall('inspect_office', { path: 'out/result.docx' }, 'inspect-table-base');
      else if (results.length === 2) {
        const page = JSON.parse(text(results[1])); const ref = page.prepared_fragments.find((record: any) => record.kind === 'paragraph' && record.record.text === 'Original paragraph').id;
        response = toolCall('edit_office', { schema_version: 1, path: 'out/table-copy.docx', snapshot_ref: page.snapshot_ref, edits: [
          { op: 'insert_table', target_ref: ref, position: 'before', header_row: true, rows: [['Team', 'Literal value'], ['中文', '0.3']] },
          { op: 'replace_text', target_ref: ref, find: 'Original paragraph', replace: 'Original paragraph after table' },
        ] }, 'insert-word-table');
      } else { output = text(results.at(-1)); response = reply('Done.'); }
      return { ok: true, status: 200, text: async () => JSON.stringify(response) };
    }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { fileWrites: h.fileWrites('a1'), documentRenderer: renderer });
    (backend as any).tools.setOfficeReader(reader); (backend as any).tools.setOfficeEditor(editor);
    const done = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'turn_complete') resolve(); }));
    try {
      await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Create Word and insert a table before the original paragraph.'); await done; expect(output).toContain('Inserted Word table 2×2 before'); expect(output).toContain('no source computation attested');
      const zip = await JSZip.loadAsync(await fs.readFile(path.join(h.root, 'out/table-copy.docx'))); const xml = await zip.file('word/document.xml')!.async('string'); expect(xml).toContain('<ut:tbl '); expect(xml).toContain('中文'); expect(xml).toContain('0.3'); expect(xml).toContain('Original paragraph after table');
      const original = await JSZip.loadAsync(await fs.readFile(path.join(h.root, 'out/result.docx'))); expect(await original.file('word/document.xml')!.async('string')).not.toContain('<ut:tbl');
      for (const name of ['word/header1.xml', 'word/footer1.xml', 'word/styles.xml']) expect(await zip.file(name)!.async('string')).toBe(await original.file(name)!.async('string'));
    } finally { await backend.stop(); await reader.dispose(); await h.assets.dispose(); }
  });
  it('O4 generates a Word document then inserts paragraphs through actual HTTP discovery, inspection, worker and save', async () => {
    const h = await saveHost(); const reader = await officeRouteReader(); const editor = await officeRouteEditor(); const renderer = await documentRouteRenderer(); let output = '';
    const backend = new OpenAICompatBackend(config(h.root), async (_url, init) => {
      const body = JSON.parse(init.body); const spec = body.tools.find((tool: any) => tool.function.name === 'edit_office'); expect(spec.function.parameters.properties.edits.items.properties.op.enum).toContain('insert_paragraphs');
      const results = body.messages.filter((message: any) => message.role === 'tool'); const text = (message: any) => typeof message.content === 'string' ? message.content : message.content.map((block: any) => block.text ?? '').join('\n'); let response;
      if (!results.length) response = toolCall('write_document', documentInput('docx', 'Original paragraph'), 'write-word');
      else if (results.length === 1) response = toolCall('inspect_office', { path: 'out/result.docx' }, 'inspect-word');
      else if (results.length === 2) {
        const page = JSON.parse(text(results[1])); const ref = page.prepared_fragments.find((record: any) => record.kind === 'paragraph' && record.record.text === 'Original paragraph').id;
        response = toolCall('edit_office', { schema_version: 1, path: 'out/word-copy.docx', snapshot_ref: page.snapshot_ref, edits: [
          { op: 'insert_paragraphs', target_ref: ref, position: 'before', paragraphs: ['Inserted HTTP paragraph\n中文\tvalue', ''] },
          { op: 'replace_text', target_ref: ref, find: 'Original paragraph', replace: 'Changed original paragraph' },
        ] }, 'insert-word');
      } else { output = text(results.at(-1)); response = reply('Done.'); }
      return { ok: true, status: 200, text: async () => JSON.stringify(response) };
    }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { fileWrites: h.fileWrites('a1'), documentRenderer: renderer });
    (backend as any).tools.setOfficeReader(reader); (backend as any).tools.setOfficeEditor(editor);
    const done = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'turn_complete') resolve(); }));
    try {
      await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Create Word and insert two paragraphs before the original.'); await done; expect(output).toContain('Inserted 2 Word paragraphs before');
      const zip = await JSZip.loadAsync(await fs.readFile(path.join(h.root, 'out/word-copy.docx'))); const xml = await zip.file('word/document.xml')!.async('string'); expect(xml).toContain('Inserted HTTP paragraph'); expect(xml).toContain('Changed original paragraph'); expect(xml).toContain('中文');
      const original = await JSZip.loadAsync(await fs.readFile(path.join(h.root, 'out/result.docx'))); expect(await original.file('word/document.xml')!.async('string')).not.toContain('Inserted HTTP');
      for (const name of ['word/header1.xml', 'word/footer1.xml', 'word/styles.xml']) expect(await zip.file(name)!.async('string')).toBe(await original.file(name)!.async('string'));
    } finally { await backend.stop(); await reader.dispose(); await h.assets.dispose(); }
  });
  it('O4 generates, inspects and imports a donor slide through the actual HTTP tool router and workers', async () => {
    const h = await saveHost(); const reader = await officeRouteReader(); const editor = await officeRouteEditor(); const renderer = await presentationRouteRenderer();
    const deck = new PptxGenJS(); deck.addSlide().addText('Original destination', { x: 1, y: 1, w: 5, h: 1 }); const source = await deck.write({ outputType: 'nodebuffer' }) as Buffer;
    await fs.writeFile(path.join(h.root, 'source.pptx'), source); let output = '';
    const backend = new OpenAICompatBackend(config(h.root), async (_url, init) => {
      const body = JSON.parse(init.body); const spec = body.tools.find((tool: any) => tool.function.name === 'edit_office'); expect(spec.function.parameters.properties.edits.items.properties.op.enum).toContain('insert_generated_slide');
      const results = body.messages.filter((message: any) => message.role === 'tool'); const text = (message: any) => typeof message.content === 'string' ? message.content : message.content.map((block: any) => block.text ?? '').join('\n'); let response;
      if (!results.length) response = toolCall('write_presentation', presentationInput('donor.pptx'), 'generate-donor');
      else if (results.length === 1) response = toolCall('inspect_office', { path: 'donor.pptx' }, 'inspect-donor');
      else if (results.length === 2) response = toolCall('inspect_office', { path: 'source.pptx' }, 'inspect-destination');
      else if (results.length === 3) response = toolCall('edit_office', { schema_version: 1, path: 'donor-copy.pptx', snapshot_ref: JSON.parse(text(results[2])).snapshot_ref,
        edits: [{ op: 'insert_generated_slide', target_ref: 'S1', donor_snapshot_ref: JSON.parse(text(results[1])).snapshot_ref, donor_slide_ref: 'S1' }] }, 'import-donor');
      else { output = text(results.at(-1)); response = reply('Done.'); }
      return { ok: true, status: 200, text: async () => JSON.stringify(response) };
    }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { fileWrites: h.fileWrites('a1'), presentationRenderer: renderer });
    (backend as any).tools.setOfficeReader(reader); (backend as any).tools.setOfficeEditor(editor);
    const done = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'turn_complete') resolve(); }));
    try {
      await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Generate a donor slide and insert it after the original page.'); await done;
      expect(output).toContain('Inserted donor S1'); expect(output).toContain('slide count 1 to 2'); const zip = await JSZip.loadAsync(await fs.readFile(path.join(h.root, 'donor-copy.pptx')));
      const donorSlides = Object.keys(zip.files).filter(name => name.includes('/unode-import-') && !name.includes('/_rels/') && name.endsWith('.xml'));
      const xml = await Promise.all(donorSlides.map(name => zip.file(name)!.async('string'))); expect(xml).toEqual(expect.arrayContaining([expect.stringContaining('季度报告 &amp; Revenue 🌍'), expect.stringContaining('Presenter notes'), expect.stringContaining('<c:v>34</c:v>')]));
      expect((await fs.readFile(path.join(h.root, 'source.pptx'))).equals(source)).toBe(true);
    } finally { await backend.stop(); await reader.dispose(); await h.assets.dispose(); }
  });
  it('O4 sets theme tokens through actual HTTP tool discovery, snapshot selection, worker and save', async () => {
    const h = await saveHost(); const reader = await officeRouteReader(); const editor = await officeRouteEditor(); const deck = new PptxGenJS();
    deck.addSlide().addText('Keep this text', { x: 1, y: 1, w: 5, h: 2 }); const source = await deck.write({ outputType: 'nodebuffer' }) as Buffer;
    await fs.writeFile(path.join(h.root, 'source.pptx'), source); let output = ''; let themeRef = '';
    const backend = new OpenAICompatBackend(config(h.root), async (_url, init) => {
      const body = JSON.parse(init.body); const spec = body.tools.find((tool: any) => tool.function.name === 'edit_office'); expect(spec.function.parameters.properties.edits.items.properties.op.enum).toContain('set_theme_tokens');
      const results = body.messages.filter((message: any) => message.role === 'tool'); const text = (message: any) => typeof message.content === 'string' ? message.content : message.content.map((block: any) => block.text ?? '').join('\n'); let response;
      if (!results.length) response = toolCall('inspect_office', { path: 'source.pptx' }, 'inspect-theme');
      else if (results.length === 1) {
        const page = JSON.parse(text(results[0])); themeRef = page.prepared_fragments.find((record: any) => record.kind === 'part' && record.record.content_type === 'application/vnd.openxmlformats-officedocument.theme+xml').id;
        response = toolCall('edit_office', { schema_version: 1, path: 'theme-copy.pptx', snapshot_ref: page.snapshot_ref,
          edits: [{ op: 'set_theme_tokens', target_ref: themeRef, colors: { accent1: '123ABC' }, fonts: { major: { latin: 'Example Font' } } }] }, 'edit-theme');
      } else { output = text(results.at(-1)); response = reply('Done.'); }
      return { ok: true, status: 200, text: async () => JSON.stringify(response) };
    }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { fileWrites: h.fileWrites('a1') });
    (backend as any).tools.setOfficeReader(reader); (backend as any).tools.setOfficeEditor(editor);
    const done = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'turn_complete') resolve(); }));
    try {
      await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Change the output theme accent and heading font.'); await done;
      expect(output).toContain('Set theme tokens ' + themeRef); const zip = await JSZip.loadAsync(await fs.readFile(path.join(h.root, 'theme-copy.pptx')));
      const xml = await zip.file('ppt/theme/theme1.xml')!.async('string'); expect(xml).toContain('val="123ABC"'); expect(xml).toContain('typeface="Example Font"');
      const original = await JSZip.loadAsync(source); expect(await zip.file('ppt/slides/slide1.xml')!.async('string')).toBe(await original.file('ppt/slides/slide1.xml')!.async('string'));
      expect((await fs.readFile(path.join(h.root, 'source.pptx'))).equals(source)).toBe(true);
    } finally { await backend.stop(); await reader.dispose(); await h.assets.dispose(); }
  });
  it('O4 sets whole shape text through actual HTTP tool discovery, inspection, worker and save', async () => {
    const h = await saveHost(); const reader = await officeRouteReader(); const editor = await officeRouteEditor(); const deck = new PptxGenJS();
    deck.addSlide().addText('Before', { x: 1, y: 1, w: 5, h: 2, bold: true }); const source = await deck.write({ outputType: 'nodebuffer' }) as Buffer;
    await fs.writeFile(path.join(h.root, 'source.pptx'), source); let output = '';
    const backend = new OpenAICompatBackend(config(h.root), async (_url, init) => {
      const body = JSON.parse(init.body); const spec = body.tools.find((tool: any) => tool.function.name === 'edit_office'); expect(spec.function.parameters.properties.edits.items.properties.op.enum).toContain('set_shape_text');
      const results = body.messages.filter((message: any) => message.role === 'tool'); const text = (message: any) => typeof message.content === 'string' ? message.content : message.content.map((block: any) => block.text ?? '').join('\n'); let response;
      if (!results.length) response = toolCall('inspect_office', { path: 'source.pptx' }, 'inspect-shape');
      else if (results.length === 1) response = toolCall('edit_office', { schema_version: 1, path: 'shape-copy.pptx', snapshot_ref: JSON.parse(text(results[0])).snapshot_ref,
        edits: [{ op: 'set_shape_text', target_ref: 'S1-O1', text: 'Actual HTTP title\n第二段' }] }, 'edit-shape');
      else { output = text(results.at(-1)); response = reply('Done.'); }
      return { ok: true, status: 200, text: async () => JSON.stringify(response) };
    }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { fileWrites: h.fileWrites('a1') });
    (backend as any).tools.setOfficeReader(reader); (backend as any).tools.setOfficeEditor(editor);
    const done = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'turn_complete') resolve(); }));
    try {
      await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Set the whole inspected text shape.'); await done;
      expect(output).toContain('Set whole text S1-O1: 2 paragraphs'); const zip = await JSZip.loadAsync(await fs.readFile(path.join(h.root, 'shape-copy.pptx')));
      expect(readOfficeShapeText(await zip.file('ppt/slides/slide1.xml')!.async('nodebuffer'), 'S1-O1', () => {}).text).toBe('Actual HTTP title\n第二段'); expect(await fs.readFile(path.join(h.root, 'source.pptx'))).toEqual(source);
    } finally { await backend.stop(); await reader.dispose(); await h.assets.dispose(); }
  });
  it('O4 updates chart data through HTTP using the actual source transformation and editable workbook', async () => {
    const h = await saveHost(); const reader = await officeRouteReader(); const editor = await officeRouteEditor(); const workbook = await workbookRouteReader();
    const deck = new PptxGenJS(); deck.addSlide().addChart(deck.ChartType.bar, [{ name: 'Old', labels: ['Old'], values: [99] }], { x: 1, y: 1, w: 4, h: 3 });
    await fs.writeFile(path.join(h.root, 'source.pptx'), await deck.write({ outputType: 'nodebuffer' }) as Buffer); await fs.writeFile(path.join(h.root, 'data.csv'), COMPUTE_CSV); let output = '';
    const backend = new OpenAICompatBackend(config(h.root), async (_url, init) => {
      const body = JSON.parse(init.body); const results = body.messages.filter((message: any) => message.role === 'tool'); let response;
      const toolText = (message: any) => typeof message.content === 'string' ? message.content : message.content.map((block: any) => block.text ?? '').join('\n');
      const page = (message: any) => JSON.parse(toolText(message));
      if (!results.length) response = toolCall('read_workbook', { path: 'data.csv' }, 'chart-source');
      else if (results.length === 1) response = toolCall('transform_workbook', workbookSumPlan(page(results[0]).snapshot_ref), 'chart-transform');
      else if (results.length === 2) response = toolCall('inspect_office', { path: 'source.pptx' }, 'inspect-chart');
      else if (results.length === 3) response = toolCall('edit_office', { schema_version: 1, path: 'chart-copy.pptx', snapshot_ref: page(results[2]).snapshot_ref,
        edits: [{ op: 'update_chart_data', target_ref: 'S1-O1', data_from: { transformation_ref: page(results[1]).transformation_ref, label_field: 'team', value_fields: ['total'] } }] }, 'edit-chart');
      else { output = toolText(results.at(-1)); response = reply('Done.'); }
      return { ok: true, status: 200, text: async () => JSON.stringify(response) };
    }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { fileWrites: h.fileWrites('a1') });
    (backend as any).tools.setOfficeReader(reader); (backend as any).tools.setOfficeEditor(editor); (backend as any).tools.setWorkbookReader(workbook);
    const chartEvents: BackendEvent[] = [];
    const done = new Promise<void>(resolve => backend.onEvent(event => { chartEvents.push(event); if (event.kind === 'turn_complete') resolve(); }));
    try {
      await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Update the inspected chart from the calculated totals.'); await done;
      expect(output, JSON.stringify(chartEvents.filter(event => event.kind === 'error'))).toContain('Saved edited PPTX'); expect(output).toContain('data host-transformation'); expect(output).toContain('precision losses 1');
      const zip = await JSZip.loadAsync(await fs.readFile(path.join(h.root, 'chart-copy.pptx')));
      const charts = await Promise.all(Object.keys(zip.files).filter(name => name.startsWith('ppt/charts/unode-') && name.endsWith('.xml')).map(name => zip.file(name)!.async('string')));
      expect(charts).toHaveLength(1); expect(charts[0]).toContain('<c:v>0.3</c:v>'); expect(charts[0]).toContain('<c:v>9007199254740994</c:v>');
    } finally { await backend.stop(); await reader.dispose(); await workbook.dispose(); await h.assets.dispose(); }
  });
  it('O4 replaces an inspected Word image through HTTP with an actually supplied image asset', async () => {
    const h = await saveHost(); const reader = await officeRouteReader(); const editor = await officeRouteEditor();
    const item = attachment('replacement.png', 'image/png', 'image', PRESENTATION_PNG); const sources = await admitUserTurn(h.assets, [item]);
    const ref = attachmentIds(sources)[0]; h.assets.holdForUserRequest('a1', sources.map(source => source.assetId));
    const source = await wordPictureDocument(); await fs.writeFile(path.join(h.root, 'source.docx'), source); let output = '';
    const backend = new OpenAICompatBackend(config(h.root), async (_url, init) => {
      const body = JSON.parse(init.body); const results = body.messages.filter((message: any) => message.role === 'tool');
      if (!results.length) return { ok: true, status: 200, text: async () => JSON.stringify(toolCall('inspect_office', { path: 'source.docx' }, 'inspect-image')) };
      if (results.length === 1) return { ok: true, status: 200, text: async () => JSON.stringify(toolCall('edit_office', {
        schema_version: 1, track_changes: false, path: 'image-copy.docx', snapshot_ref: JSON.parse(results[0].content).snapshot_ref,
        edits: [{ op: 'replace_image', target_ref: JSON.parse(results[0].content).prepared_fragments.find((record: any) => record.kind === 'object' && record.record.object_kind === 'pic').id, asset_ref: ref, fit: 'cover', alt_text: 'HTTP image result' }],
      }, 'replace-image')) };
      output = results.at(-1).content; return { ok: true, status: 200, text: async () => JSON.stringify(reply('Done.')) };
    }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { delegationContentAssets: h.assets, fileWrites: h.fileWrites('a1') });
    (backend as any).tools.setOfficeReader(reader); (backend as any).tools.setOfficeEditor(editor);
    const done = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'turn_complete') resolve(); }));
    try {
      await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Replace the first picture with this image.', { userAttachments: [item], delegationContentSources: sources }); await done;
      expect(output).toContain('Saved edited DOCX'); expect(output).toContain(sha(PRESENTATION_PNG));
      const zip = await JSZip.loadAsync(await fs.readFile(path.join(h.root, 'image-copy.docx')));
      expect(await zip.file('word/document.xml')!.async('string')).toContain('descr="HTTP image result"'); expect(h.state.approvals).toEqual([]); const media = Object.keys(zip.files).filter(name => /word\/unode-.*\.png$/.test(name)); expect(media).toHaveLength(1); expect(await zip.file(media[0])!.async('nodebuffer')).toEqual(PRESENTATION_PNG); expect(await fs.readFile(path.join(h.root, 'source.docx'))).toEqual(source);
    } finally { await backend.stop(); await reader.dispose(); await h.assets.dispose(); }
  });
  it('O4 replaces an inspected PPT image through HTTP with an actually supplied image asset', async () => {
    const h = await saveHost(); const reader = await officeRouteReader(); const editor = await officeRouteEditor();
    const item = attachment('replacement.png', 'image/png', 'image', PRESENTATION_PNG); const sources = await admitUserTurn(h.assets, [item]);
    const ref = attachmentIds(sources)[0]; h.assets.holdForUserRequest('a1', sources.map(source => source.assetId));
    const deck = new PptxGenJS(); deck.addSlide().addImage({ data: `image/png;base64,${PRESENTATION_PNG.toString('base64')}`, x: 1, y: 1, w: 4, h: 4 });
    await fs.writeFile(path.join(h.root, 'source.pptx'), await deck.write({ outputType: 'nodebuffer' }) as Buffer); let output = '';
    const backend = new OpenAICompatBackend(config(h.root), async (_url, init) => {
      const body = JSON.parse(init.body); const results = body.messages.filter((message: any) => message.role === 'tool');
      if (!results.length) return { ok: true, status: 200, text: async () => JSON.stringify(toolCall('inspect_office', { path: 'source.pptx' }, 'inspect-image')) };
      if (results.length === 1) return { ok: true, status: 200, text: async () => JSON.stringify(toolCall('edit_office', {
        schema_version: 1, path: 'image-copy.pptx', snapshot_ref: JSON.parse(results[0].content).snapshot_ref,
        edits: [{ op: 'replace_image', target_ref: 'S1-O1', asset_ref: ref, fit: 'cover', alt_text: 'HTTP image result' }],
      }, 'replace-image')) };
      output = results.at(-1).content; return { ok: true, status: 200, text: async () => JSON.stringify(reply('Done.')) };
    }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { delegationContentAssets: h.assets, fileWrites: h.fileWrites('a1') });
    (backend as any).tools.setOfficeReader(reader); (backend as any).tools.setOfficeEditor(editor);
    const done = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'turn_complete') resolve(); }));
    try {
      await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Replace the first picture with this image.', { userAttachments: [item], delegationContentSources: sources }); await done;
      expect(output).toContain('Saved edited PPTX'); expect(output).toContain(sha(PRESENTATION_PNG));
      const zip = await JSZip.loadAsync(await fs.readFile(path.join(h.root, 'image-copy.pptx')));
      expect(await zip.file('ppt/slides/slide1.xml')!.async('string')).toContain('descr="HTTP image result"'); expect(h.state.approvals).toEqual([]);
    } finally { await backend.stop(); await reader.dispose(); await h.assets.dispose(); }
  });
  it('reads and edits original attachment source_ref bytes through the HTTP turn router', async () => {
    const h = await saveHost(); const reader = await officeRouteReader(); const editor = await officeRouteEditor(); const bytes = await officeRouteDocument();
    const qualifier = await officeRouteAttachmentQualifier(); let editedOutput = '';
    const item = attachment('source.docx', 'application/octet-stream', 'file', bytes); const sources = await admitUserTurn(h.assets, [item]);
    h.assets.holdForUserRequest('a1', sources.map(source => source.assetId)); const ref = item.contentAssetId!; let output = ''; const events: BackendEvent[] = [];
    const backend = new OpenAICompatBackend(config(h.root), async (_url, init) => {
      const body = JSON.parse(init.body); const results = body.messages.filter((message: any) => message.role === 'tool');
      if (!results.length) {
        expect(JSON.stringify(body.messages)).toContain(ref); expect(JSON.stringify(body.messages)).not.toContain('Actual Office 名称');
        return { ok: true, status: 200, text: async () => JSON.stringify(toolCall('inspect_office', { source_ref: ref }, 'source')) };
      }
      if (results.length === 1) return { ok: true, status: 200, text: async () => JSON.stringify(toolCall('edit_office', {
        schema_version: 1, snapshot_ref: JSON.parse(results[0].content).snapshot_ref, path: 'attachment-copy.docx',
        edits: [{ op: 'replace_text', target_ref: 'D1', find: 'Actual Office 名称', replace: 'HTTP attachment result' }],
      }, 'edit-source')) };
      if (results.length === 2) { editedOutput = results[1].content; return { ok: true, status: 200, text: async () => JSON.stringify(toolCall('save_attachment', { asset_id: ref, path: 'attached-original.docx' }, 'save-original')) }; }
      output = typeof results.at(-1).content === 'string' ? results.at(-1).content : JSON.stringify(results.at(-1).content);
      return { ok: true, status: 200, text: async () => JSON.stringify(reply('Done.')) };
    }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { delegationContentAssets: h.assets, fileWrites: h.fileWrites('a1') });
    (backend as any).tools.setOfficeReader(reader); (backend as any).tools.setOfficeEditor(editor);
    (backend as any).tools.setOfficeAttachmentQualifier(qualifier);
    const done = new Promise<void>(resolve => backend.onEvent(event => { events.push(event); if (event.kind === 'turn_complete') resolve(); }));
    try {
      await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Edit the attached document.', { userAttachments: [item], delegationContentSources: sources }); await done;
      expect(editedOutput).toContain('Saved edited DOCX'); expect(output).toContain(sha(bytes)); expect(await fs.readFile(path.join(h.root, 'attached-original.docx'))).toEqual(bytes);
      const zip = await JSZip.loadAsync(await fs.readFile(path.join(h.root, 'attachment-copy.docx')));
      expect(await zip.file('word/document.xml')!.async('string')).toContain('HTTP attachment result');
      expect(events.find(event => event.kind === 'turn_input_delivered')).toMatchObject({ userAttachments: [0] });
      expect(await h.assets.readUserAttachment(ref)).toMatchObject({ status: 'ready', sha256: sha(bytes) });
    } finally { await backend.stop(); await reader.dispose(); await h.assets.dispose(); }
  });
  it.each(['act', 'plan'] as const)('O4 edits an inspected Office file through HTTP in %s with Commands Off', async mode => {
    const root = await temporaryFolder('unode-http-office-edit-'); const reader = await officeRouteReader(); const editor = await officeRouteEditor(); const bytes = await officeRouteDocument();
    await fs.writeFile(path.join(root, 'source.docx'), bytes); let output = '';
    const backend = new OpenAICompatBackend({ ...config(root), allowedTools: ['read', 'write'] }, async (_url, init) => {
      const body = JSON.parse(init.body); const results = body.messages.filter((message: any) => message.role === 'tool');
      if (!results.length) return { ok: true, status: 200, text: async () => JSON.stringify(toolCall('inspect_office', { path: 'source.docx' }, 'inspect')) };
      if (results.length === 1) { const page = JSON.parse(results[0].content); return { ok: true, status: 200, text: async () => JSON.stringify(toolCall('edit_office', {
        schema_version: 1, snapshot_ref: page.snapshot_ref, path: 'copy.docx', edits: [{ op: 'replace_text', target_ref: 'D1', find: 'Actual Office 名称', replace: 'Changed Office' }],
      }, 'edit')) }; }
      output = results.at(-1).content; return { ok: true, status: 200, text: async () => JSON.stringify(reply('Done.')) };
    });
    (backend as any).tools.setOfficeReader(reader); (backend as any).tools.setOfficeEditor(editor);
    const done = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'turn_complete') resolve(); }));
    try {
      await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Edit the inspected document.', { mode }); await done;
      if (mode === 'plan') { expect(output).toContain('Plan'); await expect(fs.stat(path.join(root, 'copy.docx'))).rejects.toMatchObject({ code: 'ENOENT' }); }
      else { expect(output).toContain('Saved edited DOCX'); const zip = await JSZip.loadAsync(await fs.readFile(path.join(root, 'copy.docx'))); expect(await zip.file('word/document.xml')!.async('string')).toContain('Changed Office'); }
      expect(await fs.readFile(path.join(root, 'source.docx'))).toEqual(bytes);
    } finally { await backend.stop(); await reader.dispose(); }
  });
  it.each(['act', 'plan'] as const)('O4 inspects actual Office bytes through HTTP in %s with Commands Off', async mode => {
    const root = await temporaryFolder('unode-http-office-'); const reader = await officeRouteReader(); const input = await officeRouteDocument();
    await fs.writeFile(path.join(root, 'source.docx'), input); let output = '';
    const backend = new OpenAICompatBackend({ ...config(root), allowedTools: ['read'] }, async (_url, init) => {
      const body = JSON.parse(init.body); expect(body.tools.some((tool: any) => tool.function.name === 'inspect_office')).toBe(true);
      const last = body.messages.filter((message: any) => message.role === 'tool').at(-1);
      if (last) { output = last.content; return { ok: true, status: 200, text: async () => JSON.stringify(reply('Inspected.')) }; }
      return { ok: true, status: 200, text: async () => JSON.stringify(toolCall('inspect_office', { path: 'source.docx' }, 'office')) };
    });
    (backend as any).tools.setOfficeReader(reader);
    const done = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'turn_complete') resolve(); }));
    try {
      await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Inspect the document.', { mode }); await done;
      const page = JSON.parse(output); expect(page.kind).toBe('docx'); expect(page.next_cursor).toBeNull();
      expect(officeRouteParagraph(page)).toMatchObject({ text: 'Actual Office 名称', selector: { snapshot_ref: page.snapshot_ref, paragraph_ref: 'D1' } });
      expect(await fs.readFile(path.join(root, 'source.docx'))).toEqual(input);
    } finally { await backend.stop(); await reader.dispose(); }
  });
  it.each(['buffered', 'streaming', 'rejected', 'stopped'] as const)('O2 records only actual accepted workbook payloads in %s and persists content-free facts', async transport => {
    const root = await temporaryFolder('unode-http-data-delivery-'); const reader = await workbookRouteReader(); await fs.writeFile(path.join(root, 'private-delivery.csv'), '1,2');
    const receipts: any[] = []; let calls = 0;
    const next = (wire: string) => {
      calls++; const body = JSON.parse(wire); const result = body.messages.find((message: any) => message.role === 'tool');
      return result ? reply('Done.') : toolCall('read_workbook', { path: 'private-delivery.csv', operation: 'range' }, 'data');
    };
    const fetch: FetchFn = async (_url, init) => { const body = next(init.body); return transport === 'rejected' && calls > 1
      ? { ok: false, status: 400, text: async () => 'Invalid test request.' } : { ok: true, status: 200, text: async () => JSON.stringify(body) }; };
    const stream: StreamFetchFn = async (_url, init) => {
      const answer = next(init.body); const message = answer.choices[0].message;
      const delta = message.tool_calls ? { role: 'assistant', tool_calls: message.tool_calls.map((call: any) => ({ ...call, index: 0 })) } : { content: message.content };
      return { ok: true, status: 200, body: (async function* () { yield new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n'); })() };
    };
    const backend = new OpenAICompatBackend({ ...config(root), allowedTools: ['read'] }, fetch, undefined, undefined, undefined, { maxRetries: 0, retryBaseMs: 0 }, undefined, transport === 'streaming' ? stream : undefined);
    const tools = (backend as any).tools; tools.setWorkbookReader(reader); tools.setContentReceiptObserver((receipt: unknown) => receipts.push(receipt));
    if (transport === 'stopped') { const run = tools.run.bind(tools); vi.spyOn(tools, 'run').mockImplementation(async (...args: unknown[]) => { const result = await run(...args); backend.abort(); return result; }); }
    const done = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'turn_complete') resolve(); }));
    try {
      await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Read data.'); await done;
      const facts = tools.workbookDeliveryFacts();
      expect(facts).toHaveLength(1); expect(facts[0]).toMatchObject({ state: transport === 'stopped' ? 'prepared' : transport === 'rejected' ? 'unknown' : 'payload-submitted', observed_units: [] });
      expect(facts[0].submitted_units).toEqual(transport === 'buffered' || transport === 'streaming' ? ['cell:A1', 'cell:B1'] : []);
      if (transport === 'stopped') expect(calls).toBe(1);
      const workbook = receipts.filter(receipt => receipt.contentClass === 'workbook'); expect(workbook.length).toBe(transport === 'stopped' ? 0 : transport === 'rejected' ? 1 : 2);
      const ledger = new RunLedger(); ledger.recordDelegationDispatched({ coordinatorId: 'pm', handle: 'delivery-task', agentId: 'a1', requestedAgent: 'a1', instruction: 'Read data.', originCorrelationId: 'delivery-root' });
      for (const receipt of workbook) ledger.recordContentReceipt({ ...receipt, agentId: 'a1', correlationId: 'delivery-task',
        sourcePath: root, sourceText: 'DELIVERY-PRIVATE-TEXT-NOT-FOR-LEDGER' } as Parameters<RunLedger['recordContentReceipt']>[0]);
      const restored = new RunLedger(JSON.parse(JSON.stringify(ledger.snapshot()))); const [run] = restored.snapshot();
      expect(run.contentReceipts.map(({ agentId: _agent, recordedAt: _time, ...receipt }) => receipt)).toEqual(workbook);
      expect(JSON.stringify(run.contentReceipts)).not.toContain(root); expect(JSON.stringify(run.contentReceipts)).not.toContain('DELIVERY-PRIVATE-TEXT');
      if (workbook.length) {
        const invalid = structuredClone(run); invalid.contentReceipts = [
          { ...run.contentReceipts[0], contentClass: 'workbook', action: 'observed', submittedUnits: 1, observedUnits: 2 },
          { ...run.contentReceipts[0], contentClass: 'workbook', action: 'unknown', submittedUnits: 1, observedUnits: 0 },
        ] as typeof invalid.contentReceipts;
        expect(new RunLedger([invalid]).snapshot()[0].contentReceipts).toEqual([]);
      }
      const portable = buildPortableRunEvidence(run); const pack = renderRunEvidencePack(run);
      expect(JSON.stringify(portable)).not.toContain('private-delivery.csv'); expect(JSON.stringify(portable)).not.toContain('workbook-delivery-');
      expect(pack).not.toContain('private-delivery.csv');
      if (workbook.length) expect(pack).toContain('does not attest model attention');
    } finally { await backend.stop(); await reader.dispose(); }
  });
  it('fills a source-bound PPTX table through actual HTTP capture, compute and write tool calls', async () => {
    const h = await saveHost(); const reader = await workbookRouteReader(); const renderer = await presentationRouteRenderer(); await fs.writeFile(path.join(h.root, 'table.csv'), COMPUTE_CSV);
    const wordRenderer = await documentRouteRenderer(); let ref = '';
    const backend = new OpenAICompatBackend(config(h.root), async (_url, init) => {
      const body = JSON.parse(init.body); const last = body.messages.filter((message: any) => message.role === 'tool').at(-1); let call;
      if (!last) call = toolCall('read_workbook', { path: 'table.csv' }, 'source');
      else if (last.tool_call_id === 'source') call = toolCall('transform_workbook', workbookSumPlan(JSON.parse(last.content).snapshot_ref), 'compute');
      else if (last.tool_call_id === 'compute') { ref = JSON.parse(last.content).transformation_ref; call = toolCall('write_presentation', boundPresentationInput(ref), 'write'); }
      else if (last.tool_call_id === 'write') call = toolCall('write_document', boundDocumentInput(ref), 'word');
      else return { ok: true, status: 200, text: async () => JSON.stringify(reply('Saved.')) };
      return { ok: true, status: 200, text: async () => JSON.stringify(call) };
    }, undefined, undefined, undefined, { retryBaseMs: 0 }, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, { presentationRenderer: renderer, documentRenderer: wordRenderer, fileWrites: h.fileWrites('a1') });
    (backend as any).tools.setWorkbookReader(reader); const done = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'turn_complete') resolve(); }));
    try { await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Make a source-bound table.'); await done; await assertBoundPresentation(await fs.readFile(path.join(h.root, 'out/bound.pptx'))); await assertBoundDocument(await fs.readFile(path.join(h.root, 'out/bound.docx'))); }
    finally { await backend.stop(); await reader.dispose(); }
  });
  it.each(['act', 'plan'] as const)('computes source totals through actual HTTP tool calls in %s with Commands Off', async mode => {
    const root = await temporaryFolder('unode-http-compute-'); const reader = await workbookRouteReader(); await fs.writeFile(path.join(root, 'table.csv'), COMPUTE_CSV);
    const records = new WorkbookRecordCollector(); let count = 0; const backend = new OpenAICompatBackend({ ...config(root), allowedTools: ['read'] }, async (_url, init) => {
      const body = JSON.parse(init.body); expect(body.tools.some((tool: any) => tool.function.name === 'transform_workbook')).toBe(true);
      const last = body.messages.filter((message: any) => message.role === 'tool').at(-1); let call;
      if (!last) call = toolCall('read_workbook', { path: 'table.csv' }, 'source');
      else if (last.tool_call_id === 'source') call = toolCall('transform_workbook', workbookSumPlan(JSON.parse(last.content).snapshot_ref), 'compute');
      else {
        expect(last.content.length).toBeLessThanOrEqual(24000); expect(last.content).not.toContain('Tool result truncated'); const page = JSON.parse(last.content); records.add(page);
        if (!page.next_cursor) return { ok: true, status: 200, text: async () => JSON.stringify(reply('Computed exact source totals.')) };
        call = toolCall('transform_workbook', { operation: 'read', data_ref: page.data_ref, cursor: page.next_cursor }, `compute-${++count}`);
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(call) };
    });
    (backend as any).tools.setWorkbookReader(reader); const done = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'turn_complete') resolve(); }));
    try {
      await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Compute the source totals.', { mode }); await done;
      const totals = records.records().filter(item => item.kind === 'row'); expect(totals).toHaveLength(2);
      expect(totals.find(item => item.record.cells.team.text === 'A').record.cells.total.exact).toEqual({ numerator: '3', denominator: '10' });
      const delivery = (backend as any).tools.workbookDeliveryFacts().filter((fact: any) => fact.scope.sourceVersion.startsWith('transformation-'));
      expect(new Set(delivery.flatMap((fact: any) => fact.submitted_units)).size).toBe(totals.reduce((sum, item) => sum + Object.keys(item.record.cells).length, 0));
      expect(delivery.every((fact: any) => fact.submitted_units.every((unit: string) => unit.startsWith('table-cell:')) && !fact.observed_units.length)).toBe(true);
      expect(await fs.readFile(path.join(root, 'table.csv'), 'utf8')).toBe(COMPUTE_CSV);
    } finally { await backend.stop(); await reader.dispose(); }
  });
  it.each(['act', 'plan'] as const)('O2 returns saved XLSX cells through the HTTP turn router in %s', async mode => {
    const root = await temporaryFolder('unode-http-xlsx-'); const reader = await workbookRouteReader(); const input = await typedXlsxFixture();
    await fs.writeFile(path.join(root, 'table.xlsx'), input); let output = '';
    const backend = new OpenAICompatBackend({ ...config(root), allowedTools: ['read'] }, async (_url, init) => {
      const body = JSON.parse(init.body); const last = body.messages.filter((message: any) => message.role === 'tool').at(-1);
      if (last) { output = last.content; return { ok: true, status: 200, text: async () => JSON.stringify(reply('Read stored cells.')) }; }
      return { ok: true, status: 200, text: async () => JSON.stringify(toolCall('read_workbook', { path: 'table.xlsx', operation: 'range', range: 'H1:K1' }, 'xlsx')) };
    });
    (backend as any).tools.setWorkbookReader(reader);
    const done = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'turn_complete') resolve(); }));
    try {
      await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Read the saved workbook.', { mode }); await done;
      const page = JSON.parse(output); expect(page.format).toBe('xlsx'); expect(page.delivery).toBe('prepared');
      expect(page.prepared_fragments[0].record.value).toMatchObject({ kind: 'date-serial', raw: '60', epoch: '1900' });
      expect(page.prepared_fragments[3].record.value).toMatchObject({ kind: 'unresolved', reason: 'formula-cache-missing' });
      expect((backend as any).tools.workbookDeliveryFacts()).toMatchObject([{ state: 'payload-submitted', submitted_units: ['cell:H1', 'cell:I1', 'cell:J1', 'cell:K1'], observed_units: [] }]);
      expect(await fs.readFile(path.join(root, 'table.xlsx'))).toEqual(input);
    } finally { await backend.stop(); await reader.dispose(); }
  });
  it.each(['act', 'plan'] as const)('O2 reads CSV fragments through the HTTP turn router in %s without generic truncation', async mode => {
    const root = await temporaryFolder('unode-http-workbook-'); const reader = await workbookRouteReader();
    const text = '😀\n"'.repeat(6000); const original = '"' + text.replaceAll('"', '""') + '",0'; await fs.writeFile(path.join(root, 'table.csv'), original);
    const pages: WorkbookPage[] = []; const bodies: any[] = []; let calls = 0;
    const backend = new OpenAICompatBackend({ ...config(root), allowedTools: ['read'] }, async (_url, init) => {
      const body = JSON.parse(init.body); bodies.push(body); const last = body.messages.filter((message: any) => message.role === 'tool').at(-1);
      let cursor: string | undefined;
      if (last) { expect(last.content).not.toContain('Tool result truncated'); expect(last.content.length).toBeLessThanOrEqual(24000);
        const page = JSON.parse(last.content) as WorkbookPage; pages.push(page); cursor = page.next_cursor ?? undefined;
        if (!cursor) return { ok: true, status: 200, text: async () => JSON.stringify(reply('Read the CSV.')) }; }
      if (++calls > 10) throw new Error('CSV route did not progress');
      return { ok: true, status: 200, text: async () => JSON.stringify(toolCall('read_workbook', { path: 'table.csv', operation: 'range', ...(cursor ? { cursor } : {}) }, `csv-${calls}`)) };
    });
    (backend as any).tools.setWorkbookReader(reader); // Select the actual test-built worker; routing and handlers stay production.
    const receipts: any[] = []; (backend as any).tools.setContentReceiptObserver((receipt: unknown) => receipts.push(receipt));
    const done = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'turn_complete') resolve(); }));
    try {
      await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Read the CSV.', { mode }); await done;
      expect(bodies[0].tools.some((tool: any) => tool.function.name === 'read_workbook')).toBe(true); expect(pages.length).toBeGreaterThan(1);
      const fields = pages.flatMap(page => page.prepared_fragments); expect(fields.filter(cell => cell.cell === 'A1').map(cell => cell.text).join('')).toBe(text);
      expect(fields.filter(cell => cell.cell === 'B1').map(cell => cell.text)).toEqual(['0']); expect(await fs.readFile(path.join(root, 'table.csv'), 'utf8')).toBe(original);
      const facts = (backend as any).tools.workbookDeliveryFacts();
      expect(facts).toHaveLength(pages.length); expect(facts.every((fact: any) => fact.state === 'payload-submitted' && fact.route === 'http' && !fact.observed_units.length)).toBe(true);
      expect(new Set(facts.flatMap((fact: any) => fact.submitted_units))).toEqual(new Set(['cell:A1', 'cell:B1']));
      expect(pages[0].prepared_fragments[0].whole_value).toBe(false); expect(facts[0].submitted_units).toEqual([]);
      expect(receipts.filter(receipt => receipt.contentClass === 'workbook' && receipt.action === 'payload-submitted')).toHaveLength(pages.length);
      expect(receipts.some(receipt => receipt.observedUnits > 0)).toBe(false);
    } finally { await backend.stop(); await reader.dispose(); }
  });
  it('O3 advertises and writes editable PPTX through the real HTTP turn router with Commands Off', async () => {
    const h = await saveHost(); const renderer = await presentationRouteRenderer(); const bodies: any[] = []; let index = 0;
    const sources = await admitUserTurn(h.assets, [attachment('pixels.png', 'image/png', 'image', PRESENTATION_PNG)]);
    const input = presentationWithImage(attachmentIds(sources)[0]);
    const replies = [toolCall('write_presentation', { ...input, draft: 'deck', deck: { ...input.deck, title: 'A'.repeat(75000) } }, 'ppt-part'),
      toolCall('write_presentation', { ...input, draft: 'deck', final: true, deck: { ...input.deck, slides: [] } }, 'ppt'), reply('Saved.')];
    const backend = new OpenAICompatBackend(config(h.root), async (_url, init) => {
      bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => JSON.stringify(replies[Math.min(index++, 2)]) };
    }, undefined, undefined, undefined, { retryBaseMs: 0 }, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, { presentationRenderer: renderer, fileWrites: h.fileWrites('a1'), delegationContentAssets: h.assets });
    const events: BackendEvent[] = [];
    const done = new Promise<void>(resolve => backend.onEvent(event => { events.push(event); if (event.kind === 'turn_complete') resolve(); }));
    try {
      await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Make slides.', { delegationContentSources: sources }); await done;
      expect(bodies[0].tools.some((tool: any) => tool.function.name === 'write_presentation')).toBe(true);
      const bytes = await fs.readFile(path.join(h.root, 'out/result.pptx')); await assertEditablePresentation(bytes);
      await assertOriginalPngEmbedded(bytes);
      expect(events.find(event => event.kind === 'tool_result' && event.presentationWrite?.code === 'written')).toMatchObject({ presentationWrite: { code: 'written', receipt: { sha256: sha(bytes) } } });
      expect(JSON.stringify(bodies[2].messages)).toContain(sha(bytes));
    } finally { await backend.stop(); await h.assets.dispose(); }
  }, 15_000);
  it('relays PDF failure and one closable notice, then accepts an agent-requested Word write with its own receipt', async () => {
    const h = await saveHost(); const renderer = await documentRouteRenderer();
    vi.spyOn(renderer, 'render').mockRejectedValueOnce(new DocumentFailure('font-unavailable'));
    const bodies: any[] = []; let index = 0;
    const pdf = documentInput('pdf'); const docx = { ...pdf, path: 'out/result.docx', format: 'docx' };
    const replies = [toolCall('write_document', pdf, 'pdf-1'), toolCall('write_document', docx, 'docx-2'), reply('Word is ready.')];
    const backend = new OpenAICompatBackend(config(h.root), async (_url, init) => {
      bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => JSON.stringify(replies[index++]) };
    }, undefined, undefined, undefined, { retryBaseMs: 0 }, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, { documentRenderer: renderer, fileWrites: h.fileWrites('a1') });
    const events: BackendEvent[] = [];
    const done = new Promise<void>(resolve => backend.onEvent(event => { events.push(event); if (event.kind === 'turn_complete') resolve(); }));
    try {
      await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Make the contract PDF.'); await done;
      expect(JSON.stringify(bodies[1].messages)).toContain('write the same document now with format docx');
      expect(JSON.stringify(bodies[1].messages)).toContain('Export as PDF');
      expect(events.filter(event => event.kind === 'runtime_notice')).toEqual([
        { kind: 'runtime_notice', text: expect.stringContaining('asked the agent to save it as Word') },
      ]);
      const results = events.filter(event => event.kind === 'tool_result');
      expect(results[0]).toMatchObject({ documentWrite: { code: 'font-unavailable' } });
      const bytes = await fs.readFile(path.join(h.root, docx.path));
      expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304');
      expect(results[1]).toMatchObject({ outcome: { status: 'success' }, documentWrite: { code: 'written', receipt: {
        format: 'docx', path: docx.path, sha256: sha(bytes),
      } } });
      expect(await fs.readdir(path.join(h.root, 'out'))).toEqual(['result.docx']);
    } finally { await backend.stop(); }
  }, 15_000);
  it.each(['docx', 'pdf'] as const)('advertises and writes real %s bytes with one host read-back receipt', async format => {
    const effects: unknown[] = []; const h = await saveHost({ onEffect: effect => effects.push(effect) }); const renderer = await documentRouteRenderer();
    const bodies: any[] = []; let index = 0;
    const replies = [toolCall('write_document', documentInput(format, format === 'docx' ? 'مرحبا' : 'CONTRACT 123'), 'document-1'), reply('Saved.')];
    const backend = new OpenAICompatBackend(config(h.root), async (_url, init) => {
      bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => JSON.stringify(replies[Math.min(index++, 1)]) };
    }, undefined, undefined, undefined, { retryBaseMs: 0 }, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, { documentRenderer: renderer, fileWrites: h.fileWrites('a1') });
    const events: BackendEvent[] = [];
    const done = new Promise<void>(resolve => backend.onEvent(event => { events.push(event); if (event.kind === 'turn_complete') resolve(); }));
    try {
      await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Make the contract.'); await done;
      expect(bodies[0].tools.find((s: any) => s.function.name === 'write_document')).toEqual(WRITE_DOCUMENT_SPEC);
      const bytes = await fs.readFile(path.join(h.root, `out/result.${format}`));
      expect(bytes.subarray(0, 4).toString('hex')).toBe(format === 'docx' ? '504b0304' : '25504446');
      expect(events.find(event => event.kind === 'tool_result')).toMatchObject({ outcome: { status: 'success', observedBy: 'host' },
        documentWrite: { code: 'written', receipt: { format, bytes: bytes.length, sha256: sha(bytes) } } });
      expect(JSON.stringify(bodies[1].messages)).toContain(sha(bytes));
      expect(effects).toHaveLength(1);
      if (format === 'docx') {
        expect(JSON.stringify(bodies[1].messages)).toContain('reader layout');
        expect(events.find(event => event.kind === 'tool_result')).toMatchObject({ summary: expect.stringContaining('reader layout unverified') });
      }
    } finally { await backend.stop(); }
  }, 15_000);
  it('keeps explicit no-write and Plan scopes, and the coordinator contract', async () => {
    const h = await saveHost(); const renderer = await documentRouteRenderer();
    const backend = new OpenAICompatBackend({ ...config(h.root), allowedTools: ['read'] });
    (backend as any).tools.setDocumentRenderer(renderer);
    expect((backend as any).tools.specs().some((s: any) => s.function.name === 'write_document')).toBe(false);
    expect((await (backend as any).routeToolCall('write_document', documentInput('docx'))).ok).toBe(false);
    // v0.9.99 (B15): a contract the coordinator filed that does not cover the write still refuses it.
    const team = { has: () => false, hasTeammates: () => true, canCoordinatorExecute: () => false, specs: () => [],
      currentCoordinatorTaskAttempt: () => ({ contractId: 'contract-1' }) };
    const pm = new OpenAICompatBackend(config(h.root), undefined, team as any);
    (pm as any).tools.setDocumentRenderer(renderer);
    expect((await (pm as any).routeToolCall('write_document', documentInput('docx'))).output).toContain('outside the task contract you filed');
    (pm as any).currentMode = 'plan';
    expect((await (pm as any).routeToolCall('write_document', documentInput('docx'))).ok).toBe(false);
    expect(await fs.readdir(h.root)).toEqual([]);
  });
});

describe('save_attachment on the OpenAI-compatible route (review resolution §2)', () => {
  it('is offered to the model, and a turn handed the attachment saves it byte for byte', async () => {
    const root = realpathSync.native(await temporaryFolder('unode-p4-openai-'));
    const store = new ContentAssetStore();
    const sources = await admitUserTurn(store, [attachment('image.png', 'image/png', 'image', PNG)]);
    const [id] = attachmentIds(sources);
    const bodies: any[] = [];
    const responses = [toolCall('save_attachment', { asset_id: id, path: 'assets/logo.png' }, 'call-1'), reply('Saved.')];
    let index = 0;
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      return { ok: true, status: 200, text: async () => JSON.stringify(responses[Math.min(index++, responses.length - 1)]) };
    };
    const writes = new FileWritePolicy({ workspaceId: () => 'w' }).forAgent({ agentId: 'a1', requestId: () => 'r1', decide: async () => 'once' });
    const backend = new OpenAICompatBackend(
      config(root), fetchFn, undefined, undefined, undefined, { retryBaseMs: 0 },
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { fileWrites: writes, delegationContentAssets: store },
    );
    const results: BackendEvent[] = [];
    const done = new Promise<void>((resolve) => backend.onEvent((event: BackendEvent) => {
      if (event.kind === 'tool_result') results.push(event);
      if (event.kind === 'turn_complete') resolve();
    }));
    await backend.start({ ROAM_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
    backend.sendUserTurn('save it', { delegationContentSources: sources });
    await done;
    await backend.stop();

    const offered = bodies[0].tools.find((tool: any) => tool.function.name === 'save_attachment');
    expect(offered.function.parameters.required).toEqual(['asset_id', 'path']);
    expect((await fs.readFile(path.join(root, 'assets', 'logo.png'))).equals(PNG)).toBe(true);
    const toolMessage = bodies[1].messages.find((message: any) => message.role === 'tool');
    expect(toolMessage.content).toContain(`Saved attachment ${id} to assets/logo.png as a new file: ${PNG.length} bytes, SHA-256 ${sha(PNG)}`);
    await store.dispose();
  });

  // v0.9.99 (B15): as write_file does, a coordinator with teammates and no contract in force reaches the save under its
  // own permissions (here the host still refuses an attachment this turn did not hand it); a filed contract that does
  // not cover the save refuses it.
  it('follows the coordinator contract rule when the agent coordinates teammates, as write_file does', async () => {
    const root = realpathSync.native(await temporaryFolder('unode-p4-openai-pm-'));
    let attempt: unknown = undefined;
    const team = {
      has: () => false,
      hasTeammates: () => true,
      canCoordinatorExecute: () => false,
      currentCoordinatorTaskAttempt: () => attempt,
      specs: () => [],
    };
    const backend = new OpenAICompatBackend(config(root), (async () => ({ ok: true, status: 200, text: async () => '{}' })) as FetchFn, team as any);
    const own = await (backend as any).routeToolCall('save_attachment', { asset_id: 'content-1', path: 'logo.png' });
    expect(own.ok).toBe(false);
    expect(own.output).toMatch(/not available to this agent/);
    expect(own.output).not.toMatch(/task contract/);
    attempt = { contractId: 'contract-1' };
    const routed = await (backend as any).routeToolCall('save_attachment', { asset_id: 'content-1', path: 'logo.png' });
    expect(routed.ok).toBe(false);
    expect(routed.output).toMatch(/outside the task contract you filed/);
    expect(await fs.readdir(root)).toEqual([]);
  });
});

describe('v0.9.108 workbook writers through the actual OpenAI-compatible turn router', () => {
  it('offers edit_workbook/write_workbook in the HTTP tool list and edits an inspected workbook', async () => {
    const h = await saveHost(); const reader = await workbookRouteReader(); const editor = await workbookRouteEditor(); const source = await workbookFixture();
    await fs.writeFile(path.join(h.root, 'book.xlsx'), source); let output = '';
    const backend = new OpenAICompatBackend(config(h.root), async (_url, init) => {
      const body = JSON.parse(init.body); const names = body.tools.map((tool: any) => tool.function.name);
      expect(names).toEqual(expect.arrayContaining(['edit_workbook', 'write_workbook']));
      const results = body.messages.filter((message: any) => message.role === 'tool'); const text = (message: any) => typeof message.content === 'string' ? message.content : message.content.map((block: any) => block.text ?? '').join('\n'); let response;
      if (!results.length) response = toolCall('read_workbook', { path: 'book.xlsx' }, 'inspect-book');
      else if (results.length === 1) response = toolCall('edit_workbook', { schema_version: 1, snapshot_ref: JSON.parse(text(results[0])).snapshot_ref, path: 'copy.xlsx',
        edits: [{ op: 'append_rows', sheet_id: 'sheet-1', rows: [[1, 2]], formulas: { C: 'A{row}+B{row}' } }] }, 'edit-book');
      else { output = text(results.at(-1)); response = reply('Done.'); }
      return { ok: true, status: 200, text: async () => JSON.stringify(response) };
    }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { fileWrites: h.fileWrites('a1') });
    (backend as any).tools.setWorkbookReader(reader); (backend as any).tools.setWorkbookEditor(editor); const done = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'turn_complete') resolve(); }));
    try {
      await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Append a row with a total formula.'); await done;
      expect(output).toContain('Formula cells written (1): sheet-1!C5 = A5+B5'); expect(output).toContain('Recalculated: no.');
      const zip = await JSZip.loadAsync(await fs.readFile(path.join(h.root, 'copy.xlsx')));
      expect(await zip.file('xl/worksheets/sheet1.xml')!.async('string')).toContain('<row r="5"><c r="A5"><v>1</v></c><c r="B5"><v>2</v></c><c r="C5"><f>A5+B5</f></c></row>');
      expect(await fs.readFile(path.join(h.root, 'book.xlsx'))).toEqual(source);
    } finally { await backend.stop(); await reader.dispose(); await h.assets.dispose(); }
  });
});

describe('v0.9.108 recalculate_workbook in the actual OpenAI-compatible tool list', () => {
  it('is offered with Read and Commands and absent without Commands', async () => {
    for (const allowedTools of [['read', 'write', 'execute'], ['read', 'write']] as const) {
      const h = await saveHost(); let names: string[] = [];
      const backend = new OpenAICompatBackend({ ...config(h.root), allowedTools: [...allowedTools] }, async (_url, init) => {
        names = JSON.parse(init.body).tools.map((tool: any) => tool.function.name); return { ok: true, status: 200, text: async () => JSON.stringify(reply('Done.')) };
      }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { fileWrites: h.fileWrites('a1') });
      const done = new Promise<void>(resolve => backend.onEvent(event => { if (event.kind === 'turn_complete') resolve(); }));
      try { await backend.start({ ROAM_API_KEY: 'sk-test' }); backend.sendUserTurn('Hello.'); await done; expect(names.includes('recalculate_workbook')).toBe(allowedTools.length === 3); }
      finally { await backend.stop(); await h.assets.dispose(); }
    }
  });
});
