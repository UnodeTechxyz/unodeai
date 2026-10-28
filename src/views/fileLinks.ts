/*---------------------------------------------------------------------------------------------
 *  UnodeAi - File links in chat replies
 *
 *  A link in a reply is the model's candidate, never an authorisation. This module only reads the link destination
 *  as written: a web address, a path on this computer, or something that is never followed. It touches no file and
 *  decides no permission. When the user clicks a file link, the host finds the reply again, resolves the path
 *  against the folder recorded with that reply and re-checks the agent's read folders before VS Code opens it.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { windowsNameProblem } from '../backend/workspacePath';
import type { MarkdownBlock, MarkdownInline } from './markdown';

/** Bounds of a link destination and of the line and column a link may name. */
export const FILE_LINK_LIMITS = {
  destination: 2048,
} as const;

/** Why a link destination is never followed. Each is shown beside the link text as a short note. */
export type LinkRefusal =
  | 'empty'
  | 'too-long'
  | 'control'
  | 'in-page'
  | 'network-path'
  | 'device-path'
  | 'drive-relative'
  | 'foreign-path'
  | 'file-uri'
  | 'scheme'
  | 'encoding'
  | 'parent'
  | 'windows-name';

/** A 1-based place in a file, parsed apart from the path and bounded. */
export interface FileLinkPosition {
  line: number;
  column?: number;
}

export type LinkDestination =
  | { kind: 'web'; href: string }
  | {
      kind: 'file';
      /** The path after one decoding pass, in the host's own spelling. Never contains a `..` segment. */
      path: string;
      absolute: boolean;
      position?: FileLinkPosition;
      /** A `#` location that is not a line, kept only to say that it was not followed. */
      unsupportedFragment?: string;
    }
  | { kind: 'refused'; reason: LinkRefusal; scheme?: string };

// C0 and C1 controls, and the bidirectional marks and overrides that can make a path read as another one.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
// `#L12`, `#L12C3`, and a GitHub range `#L12-L20` (its first line is the place).
const LINE_FRAGMENT = /^L(\d{1,7})(?:C(\d{1,5}))?(?:-L?\d{1,7}(?:C\d{1,5})?)?$/;
const LINE_SUFFIX = /:(\d{1,7})(?::(\d{1,5}))?$/;
const LINE_ONLY = /^:\d{1,7}(?::\d{1,5})?$/;
// An encoded dot, separator, colon or control character is refused rather than decoded: `%2e%2e%2f` is a parent
// escape, `%3a` would make a drive or stream, and no person writes a path that only works once decoded.
const REFUSED_ESCAPE = /%(?:2[EeFf]|5[Cc]|3[Aa]|[01][0-9A-Fa-f]|7[Ff])/;

/**
 * Read one link destination under the host's path rules (`pathApi` is explicit in tests).
 *
 * - `http:`/`https:` with `//` stays a web link, exactly as before.
 * - A drive letter is not a URI scheme: on Windows `C:\…` or `C:/…` is an absolute path; `C:notes.md` and `\notes.md`
 *   depend on a current drive or folder and are refused. On other hosts a drive path is not a path on this computer.
 * - Every other scheme (`file:`, `command:`, `javascript:`, `data:`, `vscode:` …), network shares and device paths
 *   are refused.
 * - `#L12`, `#L12C3` or a trailing `:12` / `:12:3` is a place, parsed apart from the path. Another `#` location is
 *   kept only to say that it was not followed.
 * - The path is decoded once. A malformed or double escape, an encoded dot, separator, colon or control character,
 *   and any `..` segment are refused; `..name` is an ordinary name.
 */
export function classifyLinkDestination(destination: string, pathApi: path.PlatformPath = path): LinkDestination {
  if (!destination) return refused('empty');
  if (destination.length > FILE_LINK_LIMITS.destination) return refused('too-long');
  if (CONTROL_CHARACTERS.test(destination)) return refused('control');
  if (/^https?:\/\//i.test(destination)) return { kind: 'web', href: destination };
  if (destination.startsWith('#')) return refused('in-page');
  const win32 = pathApi.sep === '\\';
  if (/^[\\/]{2}/.test(destination)) {
    return refused(/^[\\/]{2}[?.](?:[\\/]|$)/.test(destination) ? 'device-path' : 'network-path');
  }
  const scheme = SCHEME.exec(destination);
  if (scheme && scheme[1].length === 1) {
    if (!win32) return refused('foreign-path');
    if (!/^[A-Za-z]:[\\/]/.test(destination)) return refused('drive-relative');
  } else if (scheme && !LINE_ONLY.test(destination.slice(scheme[1].length))) {
    // `README.md:12` is a file and its line; anything else before a first colon is a scheme.
    const name = scheme[1].toLowerCase();
    return name === 'file' ? refused('file-uri') : { kind: 'refused', reason: 'scheme', scheme: name.slice(0, 32) };
  }

  // A `#` starts the location, as in a URL; a `#` in a file name is written `%23`.
  const hash = destination.indexOf('#');
  let written = hash < 0 ? destination : destination.slice(0, hash);
  let position: FileLinkPosition | undefined;
  let unsupportedFragment: string | undefined;
  if (hash >= 0) {
    const fragment = destination.slice(hash + 1);
    const place = LINE_FRAGMENT.exec(fragment);
    if (place) position = positionOf(place[1], place[2]);
    else if (fragment) unsupportedFragment = fragment.slice(0, 80);
  } else {
    // The drive colon cannot match: `C:` followed by digits was refused above as drive-relative.
    const place = LINE_SUFFIX.exec(written);
    if (place) {
      position = positionOf(place[1], place[2]);
      written = written.slice(0, place.index);
    }
  }

  if (/%(?![0-9A-Fa-f]{2})/.test(written) || REFUSED_ESCAPE.test(written)) return refused('encoding');
  let decoded: string;
  try {
    decoded = decodeURIComponent(written);
  } catch {
    return refused('encoding');
  }
  // One pass only: what is still an escape after it was encoded twice, and is refused, never decoded again.
  if (CONTROL_CHARACTERS.test(decoded) || /%[0-9A-Fa-f]{2}/.test(decoded)) return refused('encoding');
  if (!decoded) return refused('empty');
  if (decoded.split(win32 ? /[\\/]/ : /\//).includes('..')) return refused('parent');

  let absolute: boolean;
  if (win32) {
    absolute = /^[A-Za-z]:[\\/]/.test(decoded);
    if (!absolute && /^[\\/]/.test(decoded)) return refused('drive-relative');
    if (windowsNameProblem(decoded, 'win32')) return refused('windows-name');
  } else {
    absolute = decoded.startsWith('/');
  }
  return {
    kind: 'file',
    path: decoded,
    absolute,
    ...(position ? { position } : {}),
    ...(unsupportedFragment !== undefined ? { unsupportedFragment } : {}),
  };
}

function positionOf(line: string, column: string | undefined): FileLinkPosition {
  // A place past the end of the file is clamped by the editor; line 0 is read as the first line.
  return { line: Math.max(1, Number(line)), ...(column !== undefined ? { column: Math.max(1, Number(column)) } : {}) };
}

function refused(reason: LinkRefusal): LinkDestination {
  return { kind: 'refused', reason };
}

/** The short note shown beside a link that is never followed. Host-written; the webview shows it as text. */
export function linkRefusalNote(destination: Extract<LinkDestination, { kind: 'refused' }>): string {
  switch (destination.reason) {
    case 'scheme': return `link not opened: ${destination.scheme ?? 'this'}: links are not followed`;
    case 'file-uri': return 'link not opened: file: links are not followed; a workspace path is';
    case 'network-path': return 'link not opened: network paths are not followed';
    case 'device-path': return 'link not opened: device paths are not followed';
    case 'drive-relative': return 'link not opened: the path depends on a current drive or folder';
    case 'foreign-path': return 'link not opened: not a path on this computer';
    case 'encoding': return 'link not opened: the path is encoded in a way UnodeAi does not accept';
    case 'control': return 'link not opened: the path contains control characters';
    case 'parent': return 'link not opened: paths with .. are not followed';
    case 'windows-name': return 'link not opened: the path names a stream, a device or a name Windows reads differently';
    case 'in-page': return 'in-page link, not followed';
    case 'too-long': return 'link not opened: the path is too long';
    case 'empty': return 'link not opened: the link has no destination';
  }
}

const FILE_REFERENCE_ID = /^(\d{1,15})\.([0-9a-f]{16})$/;

/**
 * The id a file link in one reply gets: that reply's transcript sequence and a digest of the link as written. It is
 * opaque to the webview and no secret; the host finds the reply and the link again from it, and authorises nothing
 * because of it.
 */
export function fileReferenceId(scope: number, destination: string): string {
  return `${scope}.${createHash('sha256').update(`${scope}\n${destination}`).digest('hex').slice(0, 16)}`;
}

/** The reply sequence an id names, or undefined for anything that is not a file reference id. */
export function fileReferenceScope(id: string): number | undefined {
  const match = FILE_REFERENCE_ID.exec(id);
  if (!match) return undefined;
  const scope = Number(match[1]);
  return Number.isSafeInteger(scope) ? scope : undefined;
}

/** Why a chat surface found nothing to open before the navigation boundary was asked. */
export type FileNavigationRefusal = 'not-shown' | 'unknown-link' | 'unknown-receipt' | 'changed';

/** A file link the chat host found again in a reply it keeps. Every field is the host's; none comes from a webview. */
export interface ChatFileLinkReference {
  /** The link destination as written in the reply. */
  destination: string;
  /** The folders recorded with the reply. Absent on a reply written before they were recorded. */
  roots?: readonly string[];
  /**
   * FOPEN-N1: the agent's read ceiling WHEN the reply was written, recorded with it as real paths read then
   * (FOPEN-RC-N1) and never resolved again. The physical target must be
   * inside this as well as the agent's current ceiling, so a later widening of the agent's scope does not open an
   * old link and a narrowing revokes it. Absent on a reply written before this was recorded: such a reply grants
   * nothing (fail closed), because its message-time authority cannot be proven.
   */
  ceilings?: readonly string[];
  /** Asked again after any wait: false once the link, its reply or its conversation is no longer shown. */
  stillShown(): boolean;
}

export type FileLinkSpan = Extract<MarkdownInline, { type: 'fileLink' }>;

/** The file link with this id in one reply's blocks, or undefined. */
export function findFileLink(blocks: readonly MarkdownBlock[], id: string): FileLinkSpan | undefined {
  const inSpans = (spans: readonly MarkdownInline[] | undefined) =>
    spans?.find((span): span is FileLinkSpan => span.type === 'fileLink' && span.ref === id);
  for (const block of blocks) {
    let found: FileLinkSpan | undefined;
    if (block.type === 'heading' || block.type === 'paragraph') found = inSpans(block.spans);
    else if (block.type === 'list') found = block.items.map(inSpans).find(Boolean);
    else if (block.type === 'table') found = [...block.header, ...block.rows.flat()].map(inSpans).find(Boolean);
    if (found) return found;
  }
  return undefined;
}
