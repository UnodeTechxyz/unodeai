import type { OfficeKind } from './OfficePackage';
import type { OfficeInventoryManifest } from './OfficeInventory';
import type { PictureFit } from './OfficePictureFit';
import type { PresentationImageInput, PresentationImageReceipt } from './PresentationContracts';
import { validateOfficeChartEdit, type OfficeChartEdit, type OfficeChartFact } from './OfficeChartData';
import type { WorkbookBindingInput } from '../content/WorkbookBinding';
import { validateOfficeThemeTokensEdit, type OfficeThemeTokensEdit } from './OfficeThemeTokens';
import { validateWordParagraphInsert, type OfficeWordParagraphInsert } from './OfficeWordParagraphs';
import { validateWordTableInsert, type OfficeWordTableInsert } from './OfficeWordTable';
import { validateControlTextEdit, type OfficeControlTextEdit } from './OfficeControlText';
import { validateBookmarkTextEdit, type OfficeBookmarkTextEdit } from './OfficeBookmarkText';
export interface OfficeTextEdit { op: 'replace_text'; target_ref: string; find: string; replace: string; all: boolean }
export interface OfficeRevisionDecisionEdit { op: 'accept_revision' | 'reject_revision'; target_ref: string }
export type OfficeCommentEdit = { op: 'add_comment'; target_ref: string; find: string; text: string } | { op: 'reply_comment'; target_ref: string; text: string } | { op: 'resolve_comment'; target_ref: string };
export interface OfficeShapeTextEdit { op: 'set_shape_text'; target_ref: string; text: string }
export interface OfficeShapeTextFact { target_ref: string; characters: number; paragraphs: number; line_endings_normalized: boolean }
/** PPT chart title: a string sets the stored title text, null deletes the title. */
export interface OfficeChartTitleEdit { op: 'set_chart_title'; target_ref: string; title: string | null }
export interface OfficeChartTitleFact { target_ref: string; title: string | null; paragraphs: number; chart_part_copied: boolean; line_endings_normalized: boolean }
export type OfficeImageEdit = PictureFit & { op: 'replace_image'; target_ref: string; asset_ref: string; alt_text?: string };
export interface OfficeSlideDuplicateEdit { op: 'duplicate_slide'; target_ref: string; after_ref?: string | null }
export interface OfficeSlideRemoveEdit { op: 'remove_slide'; target_ref: string }
export interface OfficeDonorSlideEdit { op: 'insert_generated_slide'; target_ref: string; donor_snapshot_ref: string; donor_slide_ref: string; after_ref?: string | null }
export interface OfficeDonorInput { snapshotRef: string; source: string; directory: string; manifest: OfficeInventoryManifest; bytes: number }
export interface OfficeDonorFact extends OfficeSlideDuplicateFact { donor_snapshot_ref: string; donor_slide_ref: string; donor_sha256: string; auxiliary_slides: number }
export interface OfficeSlideRemoveFact { target_ref: string; before: number; after: number; order: number; auxiliary_references: number; removed_slide_id?: string }
export interface OfficeSlideDuplicateFact { target_ref: string; new_slide_id: string; before: number; after: number; order: number;
  unavailable_dependencies: number; unknown_content_types: number; metadata_unavailable: boolean }
export type OfficeEdit = OfficeTextEdit | OfficeRevisionDecisionEdit | OfficeCommentEdit | OfficeShapeTextEdit | OfficeImageEdit | OfficeChartEdit | OfficeSlideDuplicateEdit | OfficeSlideRemoveEdit | OfficeThemeTokensEdit | OfficeDonorSlideEdit | OfficeWordParagraphInsert | OfficeWordTableInsert | OfficeControlTextEdit | OfficeBookmarkTextEdit | OfficeChartTitleEdit;
export interface OfficeEditRequest { schema_version: 1; path: string; snapshot_ref: string; edits: OfficeEdit[]; track_changes?: boolean }
/** Host-resolved author and write time of tracked Word changes for one request; absent means a direct (untracked) edit. */
export interface OfficeTracking { author: string; initials: string; authorSource: 'setting' | 'word-user-name' | 'member-name'; date: string }
export interface OfficeEditInput { source: string; directory: string; manifest: OfficeInventoryManifest; snapshotRef: string; edits: OfficeEdit[]; tracking?: OfficeTracking; commentAuthor?: OfficeTracking; images?: PresentationImageInput[]; bindings?: WorkbookBindingInput[]; donors?: OfficeDonorInput[] }
export interface OfficeEditResult { bytes: Uint8Array; sha256: string; sourceSha256: string; kind: OfficeKind; preservedParts: number; preservationDigest: string;
  changedParts: string[]; addedParts: number; templateConverted: boolean; signaturesPresent: boolean; images?: PresentationImageReceipt[]; charts?: OfficeChartFact[];
  slides?: OfficeSlideDuplicateFact[];
  shapes?: OfficeShapeTextFact[];
  chartTitles?: OfficeChartTitleFact[];
  themes?: Array<Omit<OfficeThemeTokensEdit, 'op'>>;
  insertedSlides?: OfficeDonorFact[];
  insertedParagraphs?: Array<{ target_ref: string; paragraphs: number; position: 'before' | 'after'; line_endings_normalized: boolean }>;
  insertedTables?: Array<{ target_ref: string; rows: number; columns: number; position: 'before' | 'after'; header_row: boolean; style_id?: string; trailing_paragraph: boolean; line_endings_normalized: boolean }>;
  regionTextEdits?: string[];
  storyParts?: string[];
  controlTexts?: Array<{ target_ref: string; characters: number; paragraphs_added: number; placeholder_flag_removed: boolean; binding_present: boolean; line_endings_normalized: boolean }>;
  bookmarkTexts?: Array<{ target_ref: string; characters: number; paragraphs_added: number; line_endings_normalized: boolean }>;
  removedSlides?: OfficeSlideRemoveFact[]; removedParts?: string[]; retainedRemovalParts?: number; removalMetadataUnavailable?: boolean;
  removedThumbnailParts?: string[];
  /** Word tracked changes: whether edits were recorded as revisions, the author used and the revisions this request added or decided. */
  tracked?: boolean; author?: { name: string; source: OfficeTracking['authorSource'] };
  revisionsAdded?: Array<{ revision_ref_new: string; kind: string; author: string; story_ref: string }>;
  revisionsDecided?: Array<{ target_ref: string; decision: 'accepted' | 'rejected'; removed_paragraphs: string[] }>;
  commentsAdded?: Array<{ target_ref: string; kind: 'comment' | 'reply'; comment_ref_new: string; author: string }>; commentsResolved?: Array<{ target_ref: string; thread_root_ref: string }>;
  changes: Array<{ target_ref: string; replacements: number; changed_text_nodes: number; line_endings_normalized: boolean }> }
export interface OfficeEditReceipt { kind: 'office-edited'; version: 1; path: string; bytes: number; sha256: string; sourceSha256: string;
  effect: 'created' | 'replaced' | 'unchanged'; restorePointId?: string }
const codes = ['invalid-office-edits', 'source-changed', 'source-unreadable', 'source-unavailable', 'snapshot-unavailable', 'cancelled', 'destination-extension-mismatch',
  'unsupported-edit-target', 'unsupported-word-picture', 'unsupported-word-region', 'unsupported-control-text', 'unsupported-bookmark-text', 'edit-target-unavailable', 'donor-presentation-required', 'picture-geometry-unavailable', 'invalid-chart-data', 'chart-source-unavailable', 'invalid-office-content-types', 'macro-edit-unavailable', 'unsupported-package-preservation',
  'office-preservation-check-failed', 'office-output-check-failed', 'invalid-image', 'unsupported-image', 'image-unavailable', 'unsupported-xml-dtd', 'unsupported-xml-encoding', 'unsupported-text-child',
  'invalid-text-opening', 'unsupported-text-controls', 'unsupported-field-line-break', 'empty-text-match', 'text-not-found',
  'text-match-crosses-structural-control', 'edited-text-check-failed', 'out-of-memory', 'worker-unavailable', 'office-edit-failed',
  'edit-not-trackable', 'overlaps-foreign-revision', 'revision-not-decidable', 'track-changes-unsupported-kind', 'word-id-space-exhausted', 'comment-anchor-ambiguous'] as const;
export type OfficeEditCode = typeof codes[number];
const known = new Set<string>(codes);
export const isOfficeEditCode = (value: unknown): value is OfficeEditCode => typeof value === 'string' && known.has(value);
export class OfficeEditFailure extends Error {
  constructor(code: OfficeEditCode, public readonly inputIssue?: { location: string; issue: string }) { super(code); }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function validateOfficeEditRequest(value: unknown): OfficeEditRequest {
  const fail = (): never => { throw new OfficeEditFailure('invalid-office-edits'); };
  const invalid = (location: string, issue: string): never => { throw new OfficeEditFailure('invalid-office-edits', { location, issue }); };
  if (!object(value)) return invalid('request', 'Use an object with schema_version, path, snapshot_ref and edits.');
  if (Object.keys(value).some(key => !['schema_version', 'path', 'snapshot_ref', 'edits', 'track_changes'].includes(key))) return invalid('request', 'Allowed fields: schema_version, path, snapshot_ref, edits, track_changes.');
  if (value.track_changes !== undefined && typeof value.track_changes !== 'boolean') return invalid('track_changes', 'Use true or false, or omit it for the Word default.');
  if (value.schema_version !== 1) return invalid('schema_version', 'Use schema_version:1.');
  if (typeof value.path !== 'string' || !value.path.trim()) return invalid('path', 'Supply the destination file path.');
  if (typeof value.snapshot_ref !== 'string' || !/^office-[0-9a-f-]{36}$/.test(value.snapshot_ref)) return invalid('snapshot_ref', 'Use the exact snapshot_ref returned by inspect_office for the source. Do not construct it from a hash.');
  if (!Array.isArray(value.edits) || !value.edits.length) return invalid('edits', 'Supply a nonempty array of typed edits.');
  const operations = ['add_comment', 'reply_comment', 'resolve_comment', 'accept_revision', 'reject_revision', 'set_chart_title', 'set_bookmark_text', 'set_control_text', 'insert_table', 'insert_paragraphs', 'insert_generated_slide', 'set_theme_tokens', 'set_shape_text', 'remove_slide', 'duplicate_slide', 'update_chart_data', 'replace_image', 'replace_text'];
  const edits = value.edits.map((edit, index): OfficeEdit => {
    if (!object(edit) || typeof edit.op !== 'string' || !operations.includes(edit.op)) return invalid(`edits[${index}].op`, `Use one supported op: ${operations.join(', ')}. Select targets using inspect_office; unsupported operations do not create new editing capabilities.`);
    try {
    if (object(edit) && (edit.op === 'accept_revision' || edit.op === 'reject_revision')) {
      if (Object.keys(edit).some(key => !['op', 'target_ref'].includes(key)) || typeof edit.target_ref !== 'string' || !/^(?:P[1-9]\d*-)?R[1-9]\d*$/.test(edit.target_ref)) return fail();
      return { op: edit.op, target_ref: edit.target_ref };
    }
    if (object(edit) && (edit.op === 'add_comment' || edit.op === 'reply_comment' || edit.op === 'resolve_comment')) {
      const fields = edit.op === 'add_comment' ? ['op', 'target_ref', 'find', 'text'] : edit.op === 'reply_comment' ? ['op', 'target_ref', 'text'] : ['op', 'target_ref'];
      const text = (value: unknown) => typeof value === 'string' && !!value && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF\uFFFE\uFFFF]/u.test(value);
      if (Object.keys(edit).some(key => !fields.includes(key)) || typeof edit.target_ref !== 'string'
        || !(edit.op === 'add_comment' ? /^(?:P[1-9]\d*-)?D[1-9]\d*$/ : /^M[1-9]\d*$/).test(edit.target_ref)
        || edit.op !== 'resolve_comment' && !text(edit.text) || edit.op === 'add_comment' && !text(edit.find)) return fail();
      return edit.op === 'add_comment' ? { op: 'add_comment', target_ref: edit.target_ref, find: edit.find as string, text: edit.text as string }
        : edit.op === 'reply_comment' ? { op: 'reply_comment', target_ref: edit.target_ref, text: edit.text as string } : { op: 'resolve_comment', target_ref: edit.target_ref };
    }
    if (object(edit) && edit.op === 'set_bookmark_text') return validateBookmarkTextEdit(edit);
    if (object(edit) && edit.op === 'set_control_text') return validateControlTextEdit(edit);
    if (object(edit) && edit.op === 'insert_table') return validateWordTableInsert(edit);
    if (object(edit) && edit.op === 'insert_paragraphs') return validateWordParagraphInsert(edit);
    if (object(edit) && edit.op === 'insert_generated_slide') {
      if (Object.keys(edit).some(key => !['op', 'target_ref', 'donor_snapshot_ref', 'donor_slide_ref', 'after_ref'].includes(key))
        || typeof edit.target_ref !== 'string' || !/^(?:S|P)[1-9]\d*$/.test(edit.target_ref)
        || typeof edit.donor_snapshot_ref !== 'string' || !/^office-[0-9a-f-]{36}$/.test(edit.donor_snapshot_ref)
        || typeof edit.donor_slide_ref !== 'string' || !/^S[1-9]\d*$/.test(edit.donor_slide_ref)
        || (edit.after_ref !== undefined && edit.after_ref !== null && (typeof edit.after_ref !== 'string' || !/^S[1-9]\d*$/.test(edit.after_ref)))) return fail();
      return { op: 'insert_generated_slide', target_ref: edit.target_ref, donor_snapshot_ref: edit.donor_snapshot_ref, donor_slide_ref: edit.donor_slide_ref,
        ...(edit.after_ref === undefined ? {} : { after_ref: edit.after_ref as string | null }) };
    }
    if (object(edit) && edit.op === 'set_theme_tokens') return validateOfficeThemeTokensEdit(edit);
    if (object(edit) && edit.op === 'set_shape_text') {
      if (Object.keys(edit).some(key => !['op', 'target_ref', 'text'].includes(key)) || typeof edit.target_ref !== 'string' || !/^S[1-9]\d*-O[1-9]\d*$/.test(edit.target_ref)
        || typeof edit.text !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF\uFFFE\uFFFF]/u.test(edit.text)) return fail();
      return { op: 'set_shape_text', target_ref: edit.target_ref, text: edit.text };
    }
    if (object(edit) && edit.op === 'set_chart_title') {
      if (Object.keys(edit).some(key => !['op', 'target_ref', 'title'].includes(key)) || typeof edit.target_ref !== 'string' || !edit.target_ref
        || edit.title !== null && (typeof edit.title !== 'string'
          || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF\uFFFE\uFFFF]/u.test(edit.title))) return fail();
      return { op: 'set_chart_title', target_ref: edit.target_ref, title: edit.title as string | null };
    }
    if (object(edit) && edit.op === 'remove_slide') {
      if (Object.keys(edit).some(key => !['op', 'target_ref'].includes(key)) || typeof edit.target_ref !== 'string' || !/^S[1-9]\d*$/.test(edit.target_ref)) return fail();
      return { op: 'remove_slide', target_ref: edit.target_ref };
    }
    if (object(edit) && edit.op === 'duplicate_slide') {
      if (Object.keys(edit).some(key => !['op', 'target_ref', 'after_ref'].includes(key))
        || typeof edit.target_ref !== 'string' || !/^S[1-9]\d*$/.test(edit.target_ref)
        || (edit.after_ref !== undefined && edit.after_ref !== null && (typeof edit.after_ref !== 'string' || !/^S[1-9]\d*$/.test(edit.after_ref)))) return fail();
      return { op: 'duplicate_slide', target_ref: edit.target_ref, ...(edit.after_ref === undefined ? {} : { after_ref: edit.after_ref as string | null }) };
    }
    if (object(edit) && edit.op === 'update_chart_data') { try { return validateOfficeChartEdit(edit); } catch { return fail(); } }
    if (object(edit) && edit.op === 'replace_image') {
      if (Object.keys(edit).some(key => !['op', 'target_ref', 'asset_ref', 'fit', 'crop', 'focal_rect', 'alt_text'].includes(key))
        || typeof edit.target_ref !== 'string' || typeof edit.asset_ref !== 'string' || !edit.asset_ref
        || (edit.fit !== undefined && edit.fit !== 'contain' && edit.fit !== 'cover')
        || (edit.alt_text !== undefined && (typeof edit.alt_text !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF\uFFFE\uFFFF]/u.test(edit.alt_text)))) return fail();
      const region = (raw: unknown) => {
        if (!object(raw) || Object.keys(raw).some(key => !['x', 'y', 'w', 'h'].includes(key))) return fail();
        const { x, y, w, h } = raw;
        if ([x, y, w, h].some(number => typeof number !== 'number' || !Number.isFinite(number))
          || (x as number) < 0 || (y as number) < 0 || (w as number) <= 0 || (h as number) <= 0
          || (x as number) + (w as number) > 1 || (y as number) + (h as number) > 1) return fail();
        return { x: x as number, y: y as number, w: w as number, h: h as number };
      };
      return { op: 'replace_image', target_ref: edit.target_ref, asset_ref: edit.asset_ref, fit: edit.fit === 'cover' ? 'cover' : 'contain',
        ...(edit.crop === undefined ? {} : { crop: region(edit.crop) }), ...(edit.focal_rect === undefined ? {} : { focal_rect: region(edit.focal_rect) }),
        ...(edit.alt_text === undefined ? {} : { alt_text: edit.alt_text as string }) };
    }
    if (!object(edit) || Object.keys(edit).some(key => !['op', 'target_ref', 'find', 'replace', 'all'].includes(key)) || edit.op !== 'replace_text'
      || typeof edit.target_ref !== 'string' || typeof edit.find !== 'string' || !edit.find || typeof edit.replace !== 'string'
      || (edit.all !== undefined && typeof edit.all !== 'boolean')) return fail();
    return { op: 'replace_text', target_ref: edit.target_ref, find: edit.find, replace: edit.replace, all: edit.all !== false };
    } catch (error) {
      if (error instanceof OfficeEditFailure && error.message === 'invalid-office-edits' && !error.inputIssue) {
        return invalid(`edits[${index}]`, `Use the documented fields for ${edit.op} and an exact target_ref returned by inspect_office. `
          + (edit.op === 'replace_text' ? 'replace_text needs string find and replace; find must be nonempty and all, if supplied, must be boolean.'
            : edit.op === 'update_chart_data' ? 'update_chart_data needs matching series labels/values, or data_from with a current transformation_ref and selected value_fields/rows; use label_field for categories or x_field for scatter.'
              : 'Use the op-specific parameter fields; unsupported fields and value types cannot be applied.'));
      }
      throw error;
    }
  });
  return { schema_version: 1, path: value.path, snapshot_ref: value.snapshot_ref, edits, ...(value.track_changes === undefined ? {} : { track_changes: value.track_changes as boolean }) };
}
