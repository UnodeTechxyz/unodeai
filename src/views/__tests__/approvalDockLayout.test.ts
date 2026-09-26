import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { APPROVAL_DOCK_HYSTERESIS_PX, shouldInlineApprovalDock } from '../approvalDockLayout';

describe('content-aware Workbench approval dock', () => {
  it.each([
    { viewportHeight: 500, columnRequiredHeight: 689, expected: true },
    { viewportHeight: 540, columnRequiredHeight: 689, expected: true },
    { viewportHeight: 600, columnRequiredHeight: 733, expected: true },
    { viewportHeight: 660, columnRequiredHeight: 733, expected: true },
    { viewportHeight: 800, columnRequiredHeight: 733, expected: false },
  ])(
    'chooses the safe dock layout at the $viewportHeight px field-repro height',
    ({ viewportHeight, columnRequiredHeight, expected }) => {
      expect(shouldInlineApprovalDock({
        viewportHeight,
        columnRequiredHeight,
        hasPendingDecision: true,
        currentlyInline: false,
      })).toBe(expected);
    },
  );

  it('enters only when a pending decision makes the column exceed the viewport', () => {
    const atBoundary = {
      viewportHeight: 700,
      columnRequiredHeight: 700,
      hasPendingDecision: true,
      currentlyInline: false,
    };

    expect(shouldInlineApprovalDock(atBoundary)).toBe(false);
    expect(shouldInlineApprovalDock({ ...atBoundary, columnRequiredHeight: 701 })).toBe(true);
    expect(shouldInlineApprovalDock({ ...atBoundary, columnRequiredHeight: 900, hasPendingDecision: false })).toBe(false);
  });

  it('requires 24 px of clearance before returning an inline dock to floating', () => {
    const inline = {
      viewportHeight: 800,
      hasPendingDecision: true,
      currentlyInline: true,
    };

    expect(shouldInlineApprovalDock({
      ...inline,
      columnRequiredHeight: 800 - APPROVAL_DOCK_HYSTERESIS_PX + 1,
    })).toBe(true);
    expect(shouldInlineApprovalDock({
      ...inline,
      columnRequiredHeight: 800 - APPROVAL_DOCK_HYSTERESIS_PX,
    })).toBe(false);
  });

  it('keeps every class-triggered declaration identical to the short-viewport fallback', () => {
    const source = readFileSync(join(process.cwd(), 'src/views/ChatViewProvider.ts'), 'utf8');
    expect(source).toContain('const shouldInlineApprovalDock = ${shouldInlineApprovalDock.toString()};');
    expect(source).toContain("document.body.classList.toggle('approval-dock-inline', shouldInlineApprovalDock({");
    expect(source).toContain('columnRequiredHeight: hasPendingDecision ? minimumApprovalColumnHeight() : 0');
    const mediaStart = source.indexOf('@media (max-height: 560px)');
    const mediaEnd = source.indexOf('@media (max-width: 620px)', mediaStart);
    expect(mediaStart).toBeGreaterThan(0);
    expect(mediaEnd).toBeGreaterThan(mediaStart);
    const media = source.slice(mediaStart, mediaEnd);

    const pairs = [
      ['body.container-workbench:where(.approval-dock-inline)', 'body.container-workbench'],
      ['body.container-workbench:where(.approval-dock-inline) .composer-dock', 'body.container-workbench .composer-dock'],
      ['body.container-workbench:where(.approval-dock-inline) .composer-shell', 'body.container-workbench .composer-shell'],
      ['body.container-workbench:where(.approval-dock-inline) .composer-shell textarea', 'body.container-workbench .composer-shell textarea'],
      ['body.container-workbench:where(.approval-dock-inline) #transcript', 'body.container-workbench #transcript'],
      ['body.container-workbench:where(.approval-dock-inline).rail-open .inspector', 'body.container-workbench.rail-open .inspector'],
    ] as const;

    for (const [classSelector, mediaSelector] of pairs) {
      expect(ruleDeclarations(source, classSelector), classSelector)
        .toBe(ruleDeclarations(media, mediaSelector));
    }
  });
});

function ruleDeclarations(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) {
    throw new Error(`CSS rule not found: ${selector}`);
  }
  const open = source.indexOf('{', start);
  const close = source.indexOf('}', open);
  if (open < 0 || close < 0) {
    throw new Error(`CSS rule is incomplete: ${selector}`);
  }
  return source.slice(open + 1, close).replace(/\s+/g, ' ').trim();
}
