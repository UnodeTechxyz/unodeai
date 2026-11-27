/** Admission candidates only. These metadata never establish the type of the actual package bytes. */
export const OFFICE_ATTACHMENT_EXTENSIONS = [
  'docx', 'dotx', 'docm', 'dotm',
  'pptx', 'potx', 'ppsx', 'pptm', 'potm', 'ppsm',
  'xlsx', 'xltx', 'xlsm', 'xltm',
] as const;

export const OFFICE_ATTACHMENT_MIMES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  'application/vnd.ms-word.document.macroenabled.12',
  'application/vnd.ms-word.template.macroenabled.12',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.template',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  'application/vnd.ms-powerpoint.presentation.macroenabled.12',
  'application/vnd.ms-powerpoint.template.macroenabled.12',
  'application/vnd.ms-powerpoint.slideshow.macroenabled.12',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
  'application/vnd.ms-excel.sheet.macroenabled.12',
  'application/vnd.ms-excel.template.macroenabled.12',
] as const;

/** Shared host/composer rule; MIME or extension can select passive inspection, never execution or permission. */
export function isOfficeAttachmentCandidate(name: string, mime: string): boolean {
  const dot = name.lastIndexOf('.');
  const suffix = dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
  return (OFFICE_ATTACHMENT_EXTENSIONS as readonly string[]).includes(suffix)
    || (OFFICE_ATTACHMENT_MIMES as readonly string[]).includes(mime.trim().toLowerCase());
}
