import { describe, expect, it } from 'vitest';
import { setOfficeChartTitle } from '../OfficeChartPatch';
import { OfficeEditFailure, validateOfficeEditRequest } from '../OfficeEditContracts';
import { EDIT_OFFICE_SPEC } from '../OfficeEditTool';

const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PLOT = '<c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:axId val="1"/></c:barChart></c:plotArea><c:plotVisOnly val="1"/>';
const chart = (inner: string, namespace = C, drawing = A) =>
  Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="${namespace}" xmlns:a="${drawing}"><c:chart>${inner}</c:chart><c:txPr><a:bodyPr/></c:txPr></c:chartSpace>`);
const run = (bytes: Buffer, title: string | null) => setOfficeChartTitle(bytes, title, () => {}).bytes.toString('utf8');
const code = (action: () => unknown) => { try { action(); } catch (error) { return error instanceof OfficeEditFailure ? error.message : String(error); } return 'no error'; };

describe('setOfficeChartTitle', () => {
  it('inserts a title as the first chart child with the flag after it, keeping every other byte', () => {
    const before = chart(PLOT); const after = run(before, 'Revenue & <cost>');
    expect(after).toContain(`<c:chart><c:title xmlns:c="${C}"><c:tx xmlns:c="${C}" xmlns:a="${A}"><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Revenue &amp; &lt;cost&gt;</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted xmlns:c="${C}" val="0"/>${PLOT}`);
    expect(after.replace(/<c:title[\s\S]*?<\/c:title><c:autoTitleDeleted[^>]*\/>/, '')).toBe(before.toString('utf8'));
  });

  it('replaces existing title text but reuses its body, list, paragraph and run properties and other title children', () => {
    const before = chart('<c:title><c:tx><c:rich><a:bodyPr rot="0"/><a:lstStyle><a:lvl1pPr/></a:lstStyle><a:p><a:pPr algn="l"><a:defRPr sz="2100"/></a:pPr><a:r><a:rPr sz="2100" b="1"/><a:t>Old</a:t></a:r><a:r><a:t> more</a:t></a:r></a:p></c:rich></c:tx><c:layout/><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>' + PLOT);
    const after = run(before, 'First\r\nSecond');
    expect(after).toContain('<c:rich><a:bodyPr rot="0"/><a:lstStyle><a:lvl1pPr/></a:lstStyle><a:p><a:pPr algn="l"><a:defRPr sz="2100"/></a:pPr><a:r><a:rPr sz="2100" b="1"/><a:t>First</a:t></a:r></a:p><a:p><a:pPr algn="l"><a:defRPr sz="2100"/></a:pPr><a:r><a:rPr sz="2100" b="1"/><a:t>Second</a:t></a:r></a:p></c:rich></c:tx><c:layout/><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>');
    expect(after).not.toContain('Old'); expect(after).not.toContain(' more');
    expect(setOfficeChartTitle(before, 'First\r\nSecond', () => {})).toMatchObject({ paragraphs: 2, lineEndingsNormalized: true });
  });

  it('turns a cell-reference or automatic title into stored text and sets the flag to 0', () => {
    const referenced = run(chart('<c:title><c:tx><c:strRef><c:f>Sheet1!$A$1</c:f></c:strRef></c:tx></c:title><c:autoTitleDeleted val="1"/>' + PLOT), 'Stored');
    expect(referenced).not.toContain('strRef'); expect(referenced).toContain('<a:t>Stored</a:t>'); expect(referenced).toContain('<c:autoTitleDeleted val="0"/>');
    const automatic = run(chart('<c:title><c:txPr><a:bodyPr vert="horz"/><a:p><a:pPr><a:defRPr sz="1400"/></a:pPr></a:p></c:txPr></c:title>' + PLOT), 'Auto');
    expect(automatic).toContain('<c:title><c:tx'); expect(automatic).toContain('<a:bodyPr vert="horz"/>'); expect(automatic).toContain('<a:pPr><a:defRPr sz="1400"/></a:pPr><a:r><a:t>Auto</a:t>');
    expect(automatic).toContain('</c:rich></c:tx><c:txPr>');
    expect(run(chart('<c:title/>' + PLOT), 'Closed')).toContain(`<c:title><c:tx xmlns:c="${C}" xmlns:a="${A}">`);
  });

  it('deletes the title and records that the automatic title is off', () => {
    expect(run(chart('<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>Old</a:t></a:r></a:p></c:rich></c:tx></c:title><c:autoTitleDeleted val="0"/>' + PLOT), null))
      .toContain('<c:chart><c:autoTitleDeleted val="1"/><c:plotArea>');
    expect(run(chart(PLOT), null)).toContain(`<c:chart><c:autoTitleDeleted xmlns:c="${C}" val="1"/><c:plotArea>`);
    expect(setOfficeChartTitle(chart(PLOT), null, () => {})).toMatchObject({ paragraphs: 0, lineEndingsNormalized: false });
  });

  // Audit F1: a compact chart (title right after <c:chart>, no flag) must not depend on whitespace to delete its title.
  it.each(['', '\n  '])('deletes a title with no flag whatever the whitespace before it (%j)', gap => {
    const title = '<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>Old</a:t></a:r></a:p></c:rich></c:tx></c:title>';
    const before = chart(gap + title + PLOT); const after = run(before, null);
    expect(after).toContain(`<c:chart>${gap}<c:autoTitleDeleted xmlns:c="${C}" val="1"/>${PLOT}`);
    expect(after.replace(`<c:autoTitleDeleted xmlns:c="${C}" val="1"/>`, '')).toBe(before.toString('utf8').replace(title, ''));
  });

  it('uses the strict DrawingML namespace for a strict chart', () => {
    const strict = run(chart(PLOT, 'http://purl.oclc.org/ooxml/drawingml/chart', 'http://purl.oclc.org/ooxml/drawingml/main'), 'Strict');
    expect(strict).toContain('xmlns:a="http://purl.oclc.org/ooxml/drawingml/main"><c:rich>');
  });

  it('refuses out-of-schema-order or duplicated title elements and unbound copied prefixes instead of guessing', () => {
    expect(code(() => run(chart('<c:autoTitleDeleted val="0"/><c:title/>' + PLOT), 'x'))).toBe('unsupported-edit-target');
    expect(code(() => run(chart('<c:title/><c:title/>' + PLOT), 'x'))).toBe('unsupported-edit-target');
    expect(code(() => run(chart('<c:title><c:tx xmlns:d="' + A + '"><c:rich><d:bodyPr/><d:p><d:r><d:t>x</d:t></d:r></d:p></c:rich></c:tx></c:title>' + PLOT), 'y'))).toBe('unsupported-edit-target');
  });
});

describe('set_chart_title request', () => {
  const request = (edit: Record<string, unknown>) => validateOfficeEditRequest({ schema_version: 1, path: 'out.pptx', snapshot_ref: 'office-00000000-0000-0000-0000-000000000000', edits: [edit] });
  it('accepts a title string or null and nothing else', () => {
    expect(request({ op: 'set_chart_title', target_ref: 'S1-O1', title: 'T' }).edits[0]).toEqual({ op: 'set_chart_title', target_ref: 'S1-O1', title: 'T' });
    expect(request({ op: 'set_chart_title', target_ref: 'S1-O1', title: null }).edits[0]).toEqual({ op: 'set_chart_title', target_ref: 'S1-O1', title: null });
    for (const bad of [{ op: 'set_chart_title', target_ref: 'S1-O1' }, { op: 'set_chart_title', target_ref: 'S1-O1', title: 3 },
      { op: 'set_chart_title', target_ref: 'S1-O1', title: 'bell\u0007' }, { op: 'set_chart_title', target_ref: 'S1-O1', title: 'x', text: 'y' }])
      expect(code(() => request(bad))).toBe('invalid-office-edits');
  });
  it('is offered in the one edit_office schema every connection uses', () => {
    const items = EDIT_OFFICE_SPEC.function.parameters.properties.edits.items;
    expect(items.properties.op.enum).toContain('set_chart_title');
    expect(items.properties.title).toEqual(expect.objectContaining({ anyOf: [{ type: 'string' }, { type: 'null' }] }));
    expect(EDIT_OFFICE_SPEC.function.description).toContain('PPT set_chart_title');
  });
});
