export const APPROVAL_DOCK_HYSTERESIS_PX = 24;

export interface ApprovalDockLayoutInput {
  viewportHeight: number;
  columnRequiredHeight: number;
  hasPendingDecision: boolean;
  currentlyInline: boolean;
  hysteresisPx?: number;
}

/**
 * Chooses whether a Workbench composer must return to the chat's flex column so it cannot cover a
 * pending decision. The caller measures the column's minimum required height in floating-dock
 * geometry; this function deliberately knows nothing about the DOM so its boundary cannot regress
 * behind a browser harness that has no layout engine.
 */
export function shouldInlineApprovalDock(input: ApprovalDockLayoutInput): boolean {
  if (!input.hasPendingDecision) {
    return false;
  }

  const viewportHeight = Number(input.viewportHeight);
  const columnRequiredHeight = Number(input.columnRequiredHeight);
  if (!Number.isFinite(viewportHeight) || !Number.isFinite(columnRequiredHeight)) {
    return false;
  }

  const requestedHysteresis = input.hysteresisPx === undefined
    ? APPROVAL_DOCK_HYSTERESIS_PX
    : Number(input.hysteresisPx);
  const hysteresis = Number.isFinite(requestedHysteresis)
    ? Math.max(0, requestedHysteresis)
    : APPROVAL_DOCK_HYSTERESIS_PX;
  const boundary = input.currentlyInline ? viewportHeight - hysteresis : viewportHeight;
  return columnRequiredHeight > boundary;
}
