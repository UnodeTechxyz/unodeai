// Text views of a revision-aware Word story: current (all revisions accepted), original (all rejected) and markup.
import type { WordParagraph, WordStoryModel } from './WordRevisionModel';

export type WordView = 'current' | 'original' | 'markup';
export const WORD_VIEWS: readonly WordView[] = ['current', 'original', 'markup'];
export const isWordView = (value: unknown): value is WordView => typeof value === 'string' && (WORD_VIEWS as readonly string[]).includes(value);

/** Markup comment anchors use the inventory comment_ref (M#); an unknown comment id is shown by its stored id. */
export function wordParagraphText(paragraph: WordParagraph, view: WordView, commentRef: (id: string) => string | undefined = () => undefined): string {
  if (view === 'current') return paragraph.current;
  if (view === 'original') return paragraph.original;
  return paragraph.markup.map(token => typeof token === 'string' ? token : `[#${commentRef(token.comment) ?? 'id:' + token.comment}]`).join('');
}

/** How a whole-document view treats this paragraph: a removed paragraph mark joins it to the next paragraph. */
export function wordParagraphLayout(paragraph: WordParagraph, view: WordView): { joinsNext: boolean; omitted: boolean } {
  if (view === 'markup') return { joinsNext: false, omitted: false };
  const removed = view === 'current' ? ['delete', 'move-from'] : ['insert', 'move-to'];
  return { joinsNext: !!paragraph.mark && removed.includes(paragraph.mark.kind), omitted: !!paragraph.row?.item && removed.includes(paragraph.row.item.kind) };
}

/** Paragraph texts of the whole story in one view, after paragraph-mark joins and table-row omissions. */
export function wordStoryText(model: WordStoryModel, view: WordView, commentRef?: (id: string) => string | undefined): string[] {
  const output: string[] = []; let carry: string | undefined;
  for (const paragraph of model.paragraphs) {
    const layout = wordParagraphLayout(paragraph, view); if (layout.omitted) continue;
    const text = (carry ?? '') + wordParagraphText(paragraph, view, commentRef);
    if (layout.joinsNext) { carry = text; continue; }
    carry = undefined; output.push(text);
  }
  if (carry !== undefined) output.push(carry);
  return output;
}
