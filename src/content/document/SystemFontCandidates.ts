import * as path from 'node:path';
import { canonicalDocumentLanguage } from './DocumentLanguage';

export interface SystemFontCandidate { file: string; family: string; style: 'regular' | 'bold' }
const windows = {
  latin: [['Arial', 'arial.ttf', 'arialbd.ttf'], ['Segoe UI', 'segoeui.ttf', 'segoeuib.ttf']],
  'zh-Hans': [['Microsoft YaHei', 'msyh.ttc', 'msyhbd.ttc']],
  'zh-Hant': [['Microsoft JhengHei', 'msjh.ttc', 'msjhbd.ttc']],
  ja: [['Yu Gothic', 'YuGothR.ttc', 'YuGothB.ttc'], ['Meiryo', 'meiryo.ttc', 'meiryob.ttc']],
  ko: [['Malgun Gothic', 'malgun.ttf', 'malgunbd.ttf']],
} as const;

/** No enumeration at activation. Non-Windows aliases stay empty until actual R0 source/face evidence exists. */
export function systemFontCandidates(platform: NodeJS.Platform, fontDirectory: string, language: string,
  style: 'regular' | 'bold'): SystemFontCandidate[] {
  if (platform !== 'win32') return [];
  const tag = canonicalDocumentLanguage(language);
  const profile = tag.startsWith('zh-Hans') ? 'zh-Hans' : tag.startsWith('zh-Hant') ? 'zh-Hant'
    : /^ja(?:-|$)/.test(tag) ? 'ja' : /^ko(?:-|$)/.test(tag) ? 'ko' : 'latin';
  return windows[profile].map(([family, regular, bold]) => ({ family, file: path.join(fontDirectory, style === 'regular' ? regular : bold), style }));
}
