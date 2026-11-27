import type { LocalApplicationCatalog } from './LocalApplicationCatalog';
import type { NativeOfficeRenderJob } from './NativeOfficeRenderer';

export type OfficeRendererPreference = 'automatic' | 'word-powerpoint' | 'libreoffice';
export interface OfficeRenderPreferences { preferred: OfficeRendererPreference; automaticWindowsCom: boolean }
/** Owner approved 2026-11-20: native Word/PowerPoint first, then LibreOffice when unavailable; existing gates remain. */
export const AUTOMATIC_WINDOWS_COM_DEFAULT = true;
export const OFFICE_RENDERER_PREFERENCE_KEY = 'unode.office.rendererPreference.v1';
/** Word/PowerPoint rendering exists only as the Windows COM adapter; other platforms do not offer that choice. */
export const wordPowerPointRenderingPlatform = (platform: NodeJS.Platform): boolean => platform === 'win32';
/**
 * v0.9.108: the native stage (render_office, export_pdf) runs only through the Windows helper, for LibreOffice too.
 * Elsewhere it is not run and other document work continues (not verified on macOS).
 */
export const nativeOfficeRenderingPlatform = (platform: NodeJS.Platform): boolean => platform === 'win32';
export const officeRendererPreference = (value: unknown): OfficeRendererPreference =>
  value === 'word-powerpoint' || value === 'libreoffice' ? value : 'automatic';

/** Availability selection only. Every selected operation still goes through the existing live execution gates. */
export async function selectOfficeRenderer(kind: 'docx' | 'pptx', preferences: OfficeRenderPreferences,
  catalog: Pick<LocalApplicationCatalog, 'candidate'>): Promise<NativeOfficeRenderJob['renderer'] | undefined> {
  const native = kind === 'docx' ? 'word' : 'powerpoint';
  const allowNative = preferences.automaticWindowsCom || preferences.preferred === 'word-powerpoint';
  const order: NativeOfficeRenderJob['renderer'][] = preferences.preferred === 'libreoffice'
    ? ['libreoffice', ...(allowNative ? [native] as const : [])]
    : [...(allowNative ? [native] as const : []), 'libreoffice'];
  for (const id of order) if (await catalog.candidate(id)) return id;
  return undefined;
}
