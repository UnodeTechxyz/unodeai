import { describe, it, expect } from 'vitest';
import { normalizeInstruction, similarTaskMatch, type SimilarTaskSubject } from '../SimilarTaskNotice';
import { F8_EXISTING_TARGETS, F8_LATER_TARGETS, F8_LATER_TASK, F8_REWORK_REASON } from './similarTaskFixtures';

const subject = (instruction: string, fields: Partial<SimilarTaskSubject> = {}): SimilarTaskSubject => ({
  executorId: 'contract-analyst', instruction, targets: F8_LATER_TARGETS, effect: 'modify', ...fields,
});
/** The later task, with its own contract's declared paths. */
const later = (instruction = F8_LATER_TASK, fields: Partial<SimilarTaskSubject> = {}) =>
  subject(instruction, { targets: F8_LATER_TARGETS, ...fields });
/** The existing task's latest rework reason, with the existing contract's declared paths. */
const existing = (instruction = F8_REWORK_REASON, fields: Partial<SimilarTaskSubject> = {}) =>
  subject(instruction, { targets: F8_EXISTING_TARGETS, ...fields });

describe('similarTaskMatch', () => {
  describe('the F8 pair, verbatim (must not be weakened or deleted)', () => {
    it('matches the later task to the latest rework reason through the task signature', () => {
      expect(similarTaskMatch(later(), existing())).toBe('signature');
      expect(similarTaskMatch(existing(), later())).toBe('signature');
    });

    it('is not equal after normalization, so exact equality alone would miss it', () => {
      expect(normalizeInstruction(F8_LATER_TASK)).not.toBe(normalizeInstruction(F8_REWORK_REASON));
    });

    it('matches although the two contracts declare different inputs: the rework reason names its two files', () => {
      // The later contract adds EN.docx, the existing one two review notes; both hold the two ZH-Hant files.
      expect(F8_LATER_TARGETS).not.toEqual(F8_EXISTING_TARGETS);
      expect(similarTaskMatch(later(), existing())).toBe('signature');
    });

    it('does not match for another executor', () => {
      expect(similarTaskMatch(later(F8_LATER_TASK, { executorId: 'translator' }), existing())).toBeUndefined();
    });

    it('does not match a conflicting occurrence count, in words or in digits', () => {
      expect(similarTaskMatch(later(F8_LATER_TASK.replace('four', 'three')), existing())).toBeUndefined();
      expect(similarTaskMatch(later(), existing(F8_REWORK_REASON.replace('四处', '3处')))).toBeUndefined();
    });

    it('does not match the opposite action, nor a negation of the named action', () => {
      expect(similarTaskMatch(later(F8_LATER_TASK.replace('remove four redundant', 'add four missing')), existing())).toBeUndefined();
      expect(similarTaskMatch(later(F8_LATER_TASK.replace('Finish the narrow returned rework: remove', 'Do not remove')), existing())).toBeUndefined();
      const hanDoNot = F8_REWORK_REASON.replace('请仅将四处', '不要删除这四处').replace('改为‘不得無故延遲通知’', '');
      expect(similarTaskMatch(later(), existing(hanDoNot))).toBeUndefined();
    });

    it('does not match another target, another artifact revision, or an incompatible effect', () => {
      expect(similarTaskMatch(later(F8_LATER_TASK, { targets: ['contracts/v2.0/EN.docx'] }), existing())).toBeUndefined();
      expect(similarTaskMatch(
        later(F8_LATER_TASK, { targets: ['artifact:contract-zh@3'] }),
        later(F8_LATER_TASK, { targets: ['artifact:contract-zh@2'] }),
      )).toBeUndefined();
      expect(similarTaskMatch(later(F8_LATER_TASK, { effect: 'create' }), existing())).toBeUndefined();
      expect(similarTaskMatch(
        later(F8_LATER_TASK, { writeFolders: ['contracts/v2.0'] }),
        later(F8_LATER_TASK, { writeFolders: ['contracts/v1.0'] }),
      )).toBeUndefined();
    });

    it('needs one side to hold all of the targets of the other side for the signature', () => {
      // Sharing one file of three is not the same targets.
      expect(similarTaskMatch(
        later(F8_LATER_TASK, { targets: ['contracts/v2.0/ZH-Hant.txt', 'contracts/v2.0/EN.txt'] }),
        existing(F8_REWORK_REASON),
      )).toBeUndefined();
    });

    it('needs the occurrence count and the validation intent on both sides for the signature', () => {
      expect(similarTaskMatch(later(F8_LATER_TASK.replace('four redundant', 'the redundant')), existing())).toBeUndefined();
      expect(similarTaskMatch(later(F8_LATER_TASK.replace(' Validate the final saved files;', '')), existing())).toBeUndefined();
    });
  });

  // Codex's audit of 4efdab9b, M1 and M2.
  describe('target identity', () => {
    const rows = 'Remove the duplicated header rows, keep the totals column, and verify parser output carefully.';

    it('keeps two folders\' files of the same name apart, named in the text or declared', () => {
      const text = (folder: string) => `Remove the duplicated header rows from ${folder}/report.csv and verify the row counts.`;
      expect(similarTaskMatch(subject(text('v1'), { targets: [] }), subject(text('v2'), { targets: [] }))).toBeUndefined();
      const bare = 'Remove the duplicated header rows from report.csv and verify the row counts.';
      expect(similarTaskMatch(subject(bare, { targets: ['v1/report.csv'] }), subject(bare, { targets: ['v2/report.csv'] }))).toBeUndefined();
      // The same declared file, named bare in one and with its folder in the other, is one file.
      expect(similarTaskMatch(subject(bare, { targets: ['data/v1/report.csv'] }), subject(text('v1'), { targets: ['data/v1/report.csv'] })))
        .toBe('overlap');
    });

    it('takes a bare name that identifies no declared file, or several, as no identity at all', () => {
      const bare = 'Remove the duplicated header rows from report.csv and verify the row counts.';
      expect(similarTaskMatch(subject(bare, { targets: [] }), subject(bare, { targets: [] }))).toBe('exact');
      // Several declared files share the name: the name identifies none, so the declared paths stand.
      expect(similarTaskMatch(
        subject(bare, { targets: ['v1/report.csv', 'v2/report.csv'] }),
        subject(bare, { targets: ['v3/report.csv'] }),
      )).toBeUndefined();
      // Nor does the name pick one of them: the task declaring both still holds the other task's one file.
      expect(similarTaskMatch(
        subject(bare, { targets: ['v1/report.csv', 'v2/report.csv'] }),
        subject(bare, { targets: ['v2/report.csv'] }),
      )).toBe('exact');
    });

    it('keeps a declared artifact when both instructions name a file', () => {
      const text = 'Update the summary table in notes.md and verify the totals.';
      expect(similarTaskMatch(subject(text, { targets: ['artifact:summary@2'] }), subject(text, { targets: ['artifact:summary@3'] })))
        .toBeUndefined();
      expect(similarTaskMatch(subject(text, { targets: ['artifact:summary@2'] }), subject(text, { targets: ['artifact:summary@2'] })))
        .toBe('exact');
      // Also when the named file is a declared one.
      expect(similarTaskMatch(
        subject(text, { targets: ['docs/notes.md', 'artifact:summary@2'] }),
        subject(text, { targets: ['docs/notes.md', 'artifact:summary@3'] }),
      )).toBeUndefined();
    });

    it('treats targets that only partly overlap as different work for every branch, and one side naming fewer as the same', () => {
      expect(similarTaskMatch(
        subject(`${rows} Please.`, { targets: ['shared.csv', 'two.csv'] }),
        subject(rows, { targets: ['shared.csv', 'one.csv'] }),
      )).toBeUndefined();
      expect(similarTaskMatch(subject(rows, { targets: ['shared.csv', 'two.csv'] }), subject(rows, { targets: ['shared.csv', 'one.csv'] })))
        .toBeUndefined();
      expect(similarTaskMatch(subject(`${rows} Please.`, { targets: ['shared.csv', 'two.csv'] }), subject(rows, { targets: ['shared.csv'] })))
        .toBe('overlap');
    });
  });

  // Each pair below would match through another branch; only the named rule keeps it apart.
  describe('hard non-matches win over every branch', () => {
    const rows = 'Remove the duplicated header rows from report.csv and summary.csv, keep the totals column, then verify the row counts.';

    it('an incompatible effect, even for an equal instruction', () => {
      expect(similarTaskMatch(subject(rows, { effect: 'create' }), subject(rows, { effect: 'modify' }))).toBeUndefined();
      expect(similarTaskMatch(subject(rows, { effect: 'mixed' }), subject(rows, { effect: 'modify' }))).toBe('exact');
    });

    it('a negation of the named action, even when every other token is shared', () => {
      expect(similarTaskMatch(subject(rows.replace('Remove', 'Please remove')), subject(rows))).toBe('overlap');
      expect(similarTaskMatch(subject(rows.replace('Remove', 'Do not remove')), subject(rows))).toBeUndefined();
    });

    it('adding where the other removes, even when the overlap is high', () => {
      const tail = ' config.yaml and settings.yaml, keep the YAML comments and key order unchanged, including nested blocks, '
        + 'and verify the parser accepts both files afterwards.';
      expect(similarTaskMatch(subject(`Add the trailing spaces to${tail}`), subject(`Remove the trailing spaces from${tail}`))).toBeUndefined();
    });
  });

  describe('numeric conflicts (C1.2)', () => {
    it('a number that appears on only one side is not a conflict', () => {
      // The later task names version 2.0 and the rework reason does not; the rework reason names two documents and
      // the later task does not. The F8 pair still matches.
      expect(F8_LATER_TASK).toContain('v2.0');
      expect(F8_REWORK_REASON).toContain('两份');
      expect(similarTaskMatch(subject(F8_LATER_TASK), subject(F8_REWORK_REASON))).toBe('signature');
    });

    it('differing values for the same requirement are a conflict: amount, version, revision', () => {
      const base = 'Update the invoice total in invoice.xlsx to $1,200 for version 3 of the quote, revision 4.';
      expect(similarTaskMatch(subject(base), subject(base.replace('$1,200', '$1,500')))).toBeUndefined();
      expect(similarTaskMatch(subject(base), subject(base.replace('version 3', 'version 4')))).toBeUndefined();
      expect(similarTaskMatch(subject(base), subject(base.replace('revision 4', 'revision 5')))).toBeUndefined();
      // The same version written two ways is the same value.
      expect(similarTaskMatch(subject(base), subject(base.replace('version 3', 'version 3.0')))).toBe('overlap');
    });

    it('a clause number is not a requirement', () => {
      const a = 'Remove the duplicated 應 before 不得無故延遲通知 in clauses 4.5 and 10.5 of ZH-Hant.txt, two places.';
      const b = 'Remove the duplicated 應 before 不得無故延遲通知 in clauses 11.6 and 13.6 of ZH-Hant.txt, two places.';
      expect(similarTaskMatch(subject(a), subject(b))).not.toBeUndefined();
    });
  });

  describe('polarity (C1.3)', () => {
    it('ignores a negation inside a quoted literal or a distinctive run', () => {
      const a = 'Remove the words "do not" from the heading in notes.md, two places, and check the result.';
      const b = 'Remove the words “do not” from the heading in notes.md, two places, and verify the result.';
      expect(similarTaskMatch(subject(a), subject(b))).toBe('signature');
    });

    it('a "do not" scoped to other edits is not a negation of the named action', () => {
      const a = 'Remove the two redundant 應 characters before 不得無故延遲通知 in ZH-Hant.txt. Do not remove anything else.';
      const b = 'Remove two redundant 應 characters before 不得無故延遲通知 in ZH-Hant.txt; no other edits.';
      expect(similarTaskMatch(subject(a), subject(b))).toBe('signature');
      const han = '请删除 ZH-Hant.txt 中两处“不得無故延遲通知”前多余的“應”字，不要删除其他内容，完成后验证。';
      expect(similarTaskMatch(subject(han), subject(b.replace('; no other edits.', ' and verify it.')))).toBe('signature');
    });

    // In these pairs the only mention of removing on one side is a negation scoped to other work, or text inside a
    // literal. Read as a negation, it would oppose the other side's removal and keep a similar pair apart.
    it('a negation scoped to other work does not oppose the other side, in English or in Chinese', () => {
      const latin = 'Fix the broken links in guide.md and faq.md, update the anchors, and do not remove other sections; verify the build.';
      const latinRemoves = 'Fix the broken links in guide.md and faq.md, update the anchors, remove the stale redirect section, and verify the build.';
      expect(similarTaskMatch(subject(latin), subject(latinRemoves))).toBe('overlap');
      const han = '修正 guide.md 和 faq.md 中的“旧链接”与“锚点”，更新“目录”，不要删除其他章节，完成后验证。';
      const hanRemoves = '修正 guide.md 和 faq.md 中的“旧链接”与“锚点”，更新“目录”，删除“过期重定向”，完成后验证。';
      expect(similarTaskMatch(subject(han), subject(hanRemoves))).toBe('overlap');
    });

    it('a negation inside a literal does not oppose the other side', () => {
      const tail = ' header.html and footer.html, keep the layout, and verify the page renders, including the mobile menu and '
        + 'tablet sidebar variants and the print stylesheet.';
      const takeOut = `Take the banner text "do not remove" out of${tail}`;
      const remove = `Remove the banner text "do not remove" from${tail}`;
      expect(similarTaskMatch(subject(takeOut), subject(remove))).toBe('overlap');
    });
  });

  describe('literal quotes (C1.4)', () => {
    it.each([
      ['‘', '’'], ['“', '”'], ['「', '」'], ['『', '』'], ['"', '"'],
    ])('reads a literal quoted with %s %s', (open, close) => {
      const a = `请仅将四处${open}應不得無故延遲通知${close}改为${open}不得無故延遲通知${close}，同步 ZH-Hant.txt 和 ZH-Hant.docx，完成后验证。`;
      expect(similarTaskMatch(subject(F8_LATER_TASK), subject(a))).toBe('signature');
    });
  });

  describe('the other branches', () => {
    it('matches an exactly equal instruction after whitespace normalization', () => {
      expect(similarTaskMatch(subject('Draft the release note.\r\n'), subject('  Draft   the release note.'))).toBe('exact');
    });

    it('keeps case, digits and punctuation in exact equality', () => {
      expect(similarTaskMatch(subject('Draft the release note.', { targets: [] }), subject('draft the release note', { targets: [] }))).toBeUndefined();
    });

    it('matches a fuzzy variant by the overlap coefficient', () => {
      const a = 'Summarise the onboarding survey results in survey.csv into a short findings memo with charts.';
      const b = 'Please summarise the onboarding survey results in survey.csv into a findings memo with charts.';
      expect(similarTaskMatch(subject(a), subject(b))).toBe('overlap');
    });

    it('does not match unrelated work for the same executor', () => {
      const a = 'Summarise the onboarding survey results in survey.csv into a short findings memo with charts.';
      const b = 'Translate the privacy policy in survey.csv into French and keep the headings.';
      expect(similarTaskMatch(subject(a), subject(b))).toBeUndefined();
    });

    it('needs enough discriminative tokens for the overlap branch', () => {
      expect(similarTaskMatch(subject('Fix it.', { targets: [] }), subject('Fix it now please.', { targets: [] }))).toBeUndefined();
    });
  });
});
