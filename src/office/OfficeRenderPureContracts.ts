export type OfficeRenderPureJob = { operation: 'copy'; source: string; memoryBudget: number }
  | { operation: 'png'; bytes: Uint8Array; memoryBudget: number }
  | { operation: 'preview'; bytes: Uint8Array; memoryBudget: number; maxBytes: number };
export type OfficeRenderPureRequest = OfficeRenderPureJob & { id: string };
export const OFFICE_RENDER_PURE_ERROR = /^(?:render-(?:copy|preview)-[a-z-]+|invalid-image|unsupported-image|out-of-memory)$/;
