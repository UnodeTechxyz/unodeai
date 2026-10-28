// The v0.9.98 field run's F8 pair, verbatim from the saved records (2026-10-26): the needs-rework reason of handle
// 12e2f409, recorded at 05:23:54.823Z, and the objective of the later task the PM dispatched to the same Contract
// Analyst, admitted at 05:24:32.690Z while that rework was still running. They are a bilingual paraphrase of one
// another. Nothing was cut from either text; the quotation marks are the record's own.
// A later change may improve the matcher, but it may not weaken or delete the tests built on this pair.
export const F8_REWORK_REASON = 'T1/T2主要修正和说明已保存，但T1机械替换后在4.5(2)、10.5、11.6(3)、13.6形成‘應不得無故延遲通知’，'
  + 'PM本轮直接读取10.5和11.6(3)确认。请仅将四处‘應不得無故延遲通知’改为‘不得無故延遲通知’，同步ZH-Hant.txt和ZH-Hant.docx，'
  + '保留9.4(1A)本来正确措辞及所有其他条款。完成后验证两份Word分别与对应TXT全文一致、包结构和金额，并给出真实证据。'
  + '英文、旧版本、WorkingDocuments和独立复核报告不动；不声称Word视觉检查。';
export const F8_LATER_TASK = 'Finish the narrow returned rework: remove four redundant 應 characters before 不得無故延遲通知 in the new '
  + 'Traditional Chinese v2.0 text and Word. Validate the final saved files; no other legal or commercial edits.';

// The declared paths of the two contracts. The organization- and project-specific parts were replaced the same way
// in both, so a path that is the same in both records is the same here. Both declare the same paths as inputs and as
// read_files, the effect "modify", no artifact id and no write-scope folder.
export const F8_EXISTING_TARGETS = [
  'contracts/v2.0/ZH-Hant.txt',
  'contracts/v2.0/ZH-Hant.docx',
  'contracts/v2.0/EN.txt',
  'contracts/v2.0/Revision_Notes_ZH-Hant.md',
  'contracts/v2.0/Bilingual_Review_ZH-Hant.md',
];
export const F8_LATER_TARGETS = [
  'contracts/v2.0/ZH-Hant.txt',
  'contracts/v2.0/ZH-Hant.docx',
  'contracts/v2.0/EN.txt',
  'contracts/v2.0/EN.docx',
];

/** The records' own ids: the existing handle and the Contract Analyst both tasks resolved to. */
export const F8_HANDLE = '12e2f409-b6dc-4c77-8e8f-7459cb261582';
export const F8_EXECUTOR = 'b829fe06-e09f-4fae-8a8a-9a3bfdbb5235';
