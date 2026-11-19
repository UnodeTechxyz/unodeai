/** Preserve existing sentence punctuation and add a full stop only when one is missing. */
export function punctuateMountDetail(detail: string): string {
  return `${detail}${/[.!?]$/.test(detail) ? '' : '.'}`;
}
