import { DocumentFailure } from './DocumentContracts';

/** Fixed R6 M9 grammar and aliases: neither OS locale nor ICU contributes to canonicalization. */
export function canonicalDocumentLanguage(value: unknown): string {
  if (typeof value !== 'string' || value.length > 35) throw new DocumentFailure('invalid-input');
  const match = /^([A-Za-z]{2,8})(?:-([A-Za-z]{4}))?(?:-([A-Za-z]{2}|[0-9]{3}))?$/.exec(value);
  if (!match) throw new DocumentFailure('invalid-input');
  const language = match[1].toLowerCase();
  const script = match[2] ? match[2][0].toUpperCase() + match[2].slice(1).toLowerCase() : undefined;
  const region = match[3]?.toUpperCase();
  if (language === 'zh' && !script) {
    if (region === 'CN' || region === 'SG') return 'zh-Hans';
    if (region === 'TW' || region === 'HK' || region === 'MO') return 'zh-Hant';
  }
  return [language, script, region].filter(Boolean).join('-');
}

/** Static DOCX hints, not installed-font discovery and not a PDF FontPlan. */
export function documentFontHint(language: string): string {
  if (/^zh-Hans(?:-|$)/.test(language)) return 'Microsoft YaHei';
  if (/^zh-Hant(?:-|$)/.test(language)) return 'Microsoft JhengHei';
  if (/^ja(?:-|$)/.test(language)) return 'Yu Gothic';
  if (/^ko(?:-|$)/.test(language)) return 'Malgun Gothic';
  return 'Arial';
}
