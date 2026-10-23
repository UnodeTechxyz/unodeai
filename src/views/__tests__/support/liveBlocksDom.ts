/**
 * A small DOM for running the chat webview's production block renderer (`WEBVIEW_LIVE_BLOCKS_SOURCE`) in a test,
 * with the parts a file link uses: attributes, `tabIndex`, `title` and per-element event listeners that a test can
 * dispatch, as a mouse click or a key press would. It is not a browser; it records what the renderer built.
 */
import { WEBVIEW_LIVE_BLOCKS_SOURCE } from '../../liveBlocks';

export class FakeTextNode {
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

export interface FakeEvent {
  type: string;
  key?: string;
  defaultPrevented: boolean;
  preventDefault(): void;
}

export class FakeElement {
  readonly nodeType = 1;
  parentNode: FakeElement | undefined;
  readonly childNodes: Array<FakeElement | FakeTextNode> = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();
  className = '';
  href = '';
  title = '';
  type = '';
  tabIndex = -1;
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

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  /** What the browser does for a click or a key press on this element: run its listeners with one event. */
  dispatch(type: string, init: { key?: string } = {}): FakeEvent {
    const event: FakeEvent = {
      type,
      ...init,
      defaultPrevented: false,
      preventDefault() { event.defaultPrevented = true; },
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
}

/** Every element below `root`, depth first. */
export function descendants(root: FakeElement): FakeElement[] {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}

export interface LiveBlocksPage {
  replaceLiveBlocks(root: FakeElement, replaceFrom: number, blocks: unknown[]): void;
  renderBlocks(blocks: unknown[]): FakeElement;
}

/**
 * The production renderer, with the page functions it calls supplied by the test. `pageSource` is production page
 * code to run beside it (the chat page's own `requestFileLinkOpen`, for one); `page` supplies its globals.
 */
export function liveBlocksPage(pageSource = '', page: Record<string, unknown> = {}): LiveBlocksPage {
  const document = {
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => new FakeTextNode(text),
  };
  const names = Object.keys(page);
  const factory = new Function('document', 'navigator', ...names, `${pageSource}
${WEBVIEW_LIVE_BLOCKS_SOURCE}
return { replaceLiveBlocks, renderBlocks };`);
  return factory(document, { clipboard: { writeText: () => Promise.resolve() } }, ...names.map((name) => page[name])) as LiveBlocksPage;
}
