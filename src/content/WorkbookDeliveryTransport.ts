/** Decode only actual text-bearing protocol fields, never scan a whole JSON envelope or a model's receipt claim. */
export function workbookDeliveryTexts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap(item => item && typeof item === 'object' && ['text', 'inputText'].includes(item.type) && typeof item.text === 'string' ? [item.text] : []);
}
export function workbookRequestTexts(wire: string): string[] {
  try {
    const body = JSON.parse(wire);
    return Array.isArray(body.messages) ? body.messages.flatMap((message: { content?: unknown }) => workbookDeliveryTexts(message?.content)) : [];
  } catch { return []; }
}
