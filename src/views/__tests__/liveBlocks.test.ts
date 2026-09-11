import { describe, expect, it } from 'vitest';
import { WEBVIEW_LIVE_BLOCKS_SOURCE } from '../liveBlocks';

class FakeTextNode {
  readonly nodeType = 3;
  parentNode: FakeElement | undefined;

  constructor(private value: string) {}

  get textContent(): string {
    return this.value;
  }

  set textContent(value: string) {
    this.value = value;
  }
}

class FakeElement {
  readonly nodeType = 1;
  parentNode: FakeElement | undefined;
  readonly childNodes: Array<FakeElement | FakeTextNode> = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  className = '';
  href = '';
  type = '';
  // The production source intentionally owns this opaque webview-only state.
  __unodeLiveBlocks: unknown[] | undefined;

  constructor(readonly tagName: string) {}

  get children(): FakeElement[] {
    return this.childNodes.filter((node): node is FakeElement => node.nodeType === 1);
  }

  get firstChild(): FakeElement | FakeTextNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): FakeElement | FakeTextNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  get textContent(): string {
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value: string) {
    this.childNodes.splice(0);
    if (value) this.appendChild(new FakeTextNode(value));
  }

  appendChild<T extends FakeElement | FakeTextNode>(node: T): T {
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  append(...nodes: Array<FakeElement | FakeTextNode>): void {
    nodes.forEach((node) => this.appendChild(node));
  }

  removeChild<T extends FakeElement | FakeTextNode>(node: T): T {
    const index = this.childNodes.indexOf(node);
    if (index < 0) throw new Error('cannot remove a node that is not a child');
    this.childNodes.splice(index, 1);
    node.parentNode = undefined;
    return node;
  }

  addEventListener(): void {}
}

function paragraph(text: string) {
  return { type: 'paragraph', spans: [{ type: 'text', text }] };
}

function inlineParagraph(spans: Array<{ type: string; text: string; href?: string }>) {
  return { type: 'paragraph', spans };
}

function liveBlocksHarness() {
  const document = {
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => new FakeTextNode(text),
  };
  const factory = new Function('document', 'navigator', `${WEBVIEW_LIVE_BLOCKS_SOURCE}
return { replaceLiveBlocks };`);
  return factory(document, { clipboard: { writeText: () => Promise.resolve() } }) as {
    replaceLiveBlocks(root: FakeElement, replaceFrom: number, blocks: unknown[]): void;
  };
}

describe('live markdown blocks in the webview', () => {
  it('keeps a growing plain-text paragraph node while leaving the stable prefix untouched', () => {
    const { replaceLiveBlocks } = liveBlocksHarness();
    const root = new FakeElement('div');
    replaceLiveBlocks(root, 0, [paragraph('settled'), paragraph('draft')]);
    const settled = root.children[0];
    const draft = root.children[1];

    replaceLiveBlocks(root, 1, [paragraph('draft continues')]);

    expect(root.children[0]).toBe(settled);
    expect(root.children[1]).toBe(draft);
    expect(draft.textContent).toBe('draft continues');
    expect(root.dataset.blockCount).toBe('2');
  });

  it('replaces a tail node when a Markdown reparse no longer has a text prefix', () => {
    const { replaceLiveBlocks } = liveBlocksHarness();
    const root = new FakeElement('div');
    replaceLiveBlocks(root, 0, [paragraph('opening *note')]);
    const before = root.children[0];

    replaceLiveBlocks(root, 0, [{
      type: 'paragraph',
      spans: [{ type: 'text', text: 'opening ' }, { type: 'em', text: 'note' }],
    }]);

    expect(root.children[0]).not.toBe(before);
    expect(root.children[0].textContent).toBe('opening note');
  });

  it('keeps every existing child when inline markup has a growing trailing text span', () => {
    const { replaceLiveBlocks } = liveBlocksHarness();
    const root = new FakeElement('div');
    replaceLiveBlocks(root, 0, [inlineParagraph([
      { type: 'text', text: 'Read ' },
      { type: 'strong', text: 'this' },
      { type: 'text', text: ' before' },
    ])]);
    const paragraphNode = root.children[0];
    const [leading, emphasis, trailing] = paragraphNode.childNodes;

    replaceLiveBlocks(root, 0, [inlineParagraph([
      { type: 'text', text: 'Read ' },
      { type: 'strong', text: 'this' },
      { type: 'text', text: ' before continuing' },
    ])]);

    expect(root.children[0]).toBe(paragraphNode);
    expect(paragraphNode.childNodes[0]).toBe(leading);
    expect(paragraphNode.childNodes[1]).toBe(emphasis);
    expect(paragraphNode.childNodes[2]).toBe(trailing);
    expect(trailing.textContent).toBe(' before continuing');
  });

  it('rebuilds when an inline prefix changes its link href', () => {
    const { replaceLiveBlocks } = liveBlocksHarness();
    const root = new FakeElement('div');
    replaceLiveBlocks(root, 0, [inlineParagraph([
      { type: 'text', text: 'Read ' },
      { type: 'link', text: 'docs', href: 'https://old.example/' },
      { type: 'text', text: ' now' },
    ])]);
    const before = root.children[0];

    replaceLiveBlocks(root, 0, [inlineParagraph([
      { type: 'text', text: 'Read ' },
      { type: 'link', text: 'docs', href: 'https://new.example/' },
      { type: 'text', text: ' now later' },
    ])]);

    expect(root.children[0]).not.toBe(before);
    expect(root.children[0].textContent).toBe('Read docs now later');
  });

  it('appends genuinely new spans only after preserving the growing prefix', () => {
    const { replaceLiveBlocks } = liveBlocksHarness();
    const root = new FakeElement('div');
    replaceLiveBlocks(root, 0, [inlineParagraph([
      { type: 'text', text: 'Read ' },
      { type: 'strong', text: 'this' },
      { type: 'text', text: ' now' },
    ])]);
    const paragraphNode = root.children[0];
    const before = [...paragraphNode.childNodes];

    replaceLiveBlocks(root, 0, [inlineParagraph([
      { type: 'text', text: 'Read ' },
      { type: 'strong', text: 'this' },
      { type: 'text', text: ' now and later' },
      { type: 'em', text: ' too' },
    ])]);

    expect(root.children[0]).toBe(paragraphNode);
    expect(paragraphNode.childNodes.slice(0, 3)).toEqual(before);
    expect(paragraphNode.childNodes[3]).toMatchObject({ tagName: 'em', textContent: ' too' });
  });

  it('does not treat a newly styled suffix as a plain-text append', () => {
    const { replaceLiveBlocks } = liveBlocksHarness();
    const root = new FakeElement('div');
    replaceLiveBlocks(root, 0, [paragraph('opening ')]);
    const before = root.children[0];

    replaceLiveBlocks(root, 0, [{
      type: 'paragraph',
      spans: [{ type: 'text', text: 'opening ' }, { type: 'strong', text: 'note' }],
    }]);

    expect(root.children[0]).not.toBe(before);
    expect(root.children[0].textContent).toBe('opening note');
    expect(root.children[0].children[0].tagName).toBe('strong');
  });
});
