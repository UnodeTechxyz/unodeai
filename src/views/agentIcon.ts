import { esc, escAttr } from './webviewSecurity';

export const MAX_AGENT_ICON_BYTES = 64 * 1024;
export const MAX_AGENT_ICON_DATA_URI_LENGTH = Math.ceil(MAX_AGENT_ICON_BYTES * 4 / 3) + 128;

const DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

export function isDataImageIcon(icon: string | undefined): boolean {
  return typeof icon === 'string' && icon.startsWith('data:image/');
}

export function isValidDataImageIcon(icon: string | undefined): icon is string {
  return typeof icon === 'string' &&
    icon.length <= MAX_AGENT_ICON_DATA_URI_LENGTH &&
    DATA_IMAGE_RE.test(icon);
}

export function sanitizeAgentIcon(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const value = raw.trim();
  if (!value) {
    return undefined;
  }
  if (isDataImageIcon(value)) {
    return isValidDataImageIcon(value) ? value : undefined;
  }
  return value.slice(0, 40);
}

export function renderAgentIcon(icon: string | undefined, className: string, fallback = '🤖'): string {
  const value = (icon ?? fallback).trim() || fallback;
  if (isValidDataImageIcon(value)) {
    return `<img class="${escAttr(`${className} agent-icon-img`)}" src="${escAttr(value)}" alt="">`;
  }
  return `<span class="${escAttr(className)}">${esc(value)}</span>`;
}
