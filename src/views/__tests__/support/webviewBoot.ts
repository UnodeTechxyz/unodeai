/**
 * Execute an inline VS Code webview script without requiring a browser DOM.
 *
 * The stub is deliberately permissive: this guard answers one narrow question --
 * can the script reach its event registrations?  It must not turn into a second
 * implementation of every panel's DOM.  Real top-level errors (including a TDZ
 * error before the first handler is registered) still escape and fail the test.
 */

export type WebviewListener = (...args: unknown[]) => unknown;

export interface WebviewBootResult {
  /** Dispatch one element's real listeners, without also clicking unrelated controls. */
  dispatchElementEvent(element: WebviewElement, type: string, event?: unknown): void;
  /** All document, window, and element listeners registered while booting. */
  listeners: Record<string, WebviewListener[]>;
  /** The sole inline script extracted from the rendered panel. */
  script: string;
  /**
   * Elements the script looked up by id, so a test can assert what a state actually RENDERED.
   *
   * The v0.9.50 context meter was verified by reading its source and its state object, and shipped a
   * control that said nothing. Reachability was never the gap; what the user is shown was.
   */
  elements: Map<string, WebviewElement>;
  /** Messages posted by the booted webview script, for state-to-renderer behavior checks. */
  postedMessages: unknown[];
  /** Every state the script handed to `vscode.setState`, oldest first. */
  savedStates: unknown[];
  /** `document.body`, so a test can read the classes the script set on it. */
  body: WebviewElement;
  /** `document.activeElement` under `focusModel`; undefined without it. */
  activeElement(): unknown;
  /**
   * Under `mutations`: every mutation record, oldest first, as a MutationObserver on the document with `subtree`,
   * `childList`, `characterData` and `attributes` would receive them. Empty without it.
   */
  mutations: WebviewMutationRecord[];
  /** Under `mutations`: whether `node` is `root` or was appended under it. */
  isInside(node: unknown, root: unknown): boolean;
  /**
   * Under `mutations`: whether a MutationObserver observing `root`'s subtree received `record`: its target was `root`,
   * or under `root`, when the mutation happened. A node changed before it was attached is not observed.
   */
  observedUnder(record: WebviewMutationRecord, root: unknown): boolean;
  /** Under `mutations`: the nodes `node` was appended under, nearest first. */
  ancestors(node: unknown): unknown[];
}

/** One record of the `mutations` model, with a MutationRecord's fields. */
export interface WebviewMutationRecord {
  type: 'childList' | 'characterData' | 'attributes';
  target: unknown;
  addedNodes: unknown[];
  removedNodes: unknown[];
  attributeName?: string;
  /** The target's ancestors when the mutation happened, nearest first. */
  ancestors: unknown[];
}

export type WebviewElement = Record<string | symbol, unknown> & {
  classList: { add(name: string): void; remove(name: string): void; toggle(name: string, force?: boolean): boolean; contains(name: string): boolean };
};

export interface WebviewBootOptions {
  /** Extra window properties for a panel-specific test. */
  window?: object;
  /** Optional selector hooks for tests that exercise a message against concrete panel elements. */
  document?: {
    querySelector?: (selector: string) => unknown;
    querySelectorAll?: (selector: string) => unknown[];
  };
  /** The webview state VS Code would hand a restored page; `getState` returns the newest saved one after that. */
  state?: unknown;
  /** Classes the rendered `<body>` starts with, such as `container-workbench`. None by default. */
  bodyClasses?: readonly string[];
  /**
   * A minimal model of keyboard focus, off by default. `focus()` makes an element `document.activeElement`. An element
   * that is moved or removed while it, or an element inside it, holds focus loses it to `document.body`, as in a
   * browser, where moving a node (into a DocumentFragment, or with `replaceChildren`) first takes it out of the
   * document. It models nothing else: no tab order, no visibility, no focus events. `hasFocus` answers
   * `document.hasFocus()` (true when omitted).
   */
  focusModel?: { hasFocus?: () => boolean };
  /**
   * A model of what a MutationObserver sees, off by default (no DOM library is installed). Each node remembers the node
   * it was appended under; `createTextNode` makes a text node whose `data` is its text. Recorded: a child list change
   * (append, prepend, insertBefore, replaceChildren, and setting an element's `textContent`), a text node's `data`
   * change, and an attribute change (`setAttribute`, `removeAttribute`, and setting `hidden`).
   */
  mutations?: boolean;
  /**
   * v0.9.103 (6.2): a model of the streaming row, off by default. `#live-message`, `#live-reasoning` and
   * `#thinking-indicator` exist only while an element the script gave that id is in the page (inside an element it
   * looked up by id), as in a browser, so the delta path builds and inserts its own row; and an element answers `querySelector('[data-NAME="VALUE"]')` with the
   * first element under it whose dataset holds that value. A node has one parent: moving it (append, insertBefore,
   * replaceChildren) or removing it (`remove`, `removeChild`) takes it out of the children of the parent it had. A
   * fragment has nodeType 11; the stub keeps a fragment where it was put, so a reader takes its children in its place.
   * Nothing else changes.
   */
  liveRows?: boolean;
}

const LIVE_ROW_IDS = new Set(['live-message', 'live-reasoning', 'thinking-indicator']);
const DETACH = Symbol('detach');

/** Extract the one executable script a UnodeAi panel emits. */
export function inlineWebviewScript(html: string): string {
  const scripts = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi), (match) => match[1]);
  if (scripts.length !== 1) {
    throw new Error(`Expected exactly one inline webview script, found ${scripts.length}.`);
  }
  return scripts[0];
}

/**
 * Render a panel, extract its script, and execute it against a permissive DOM stub.
 * Throws on a syntax or top-level runtime error, which is the failure mode that made
 * the v0.9.28 Agent Builder look rendered but leave every control inert.
 */
export function bootWebviewScript(html: string, options: WebviewBootOptions = {}): WebviewBootResult {
  const script = inlineWebviewScript(html);
  const listeners: Record<string, WebviewListener[]> = {};
  const elementListeners = new Map<unknown, Record<string, WebviewListener[]>>();
  const recordListener = (type: unknown, listener: unknown): void => {
    if (typeof type !== 'string' || typeof listener !== 'function') { return; }
    (listeners[type] ??= []).push(listener as WebviewListener);
  };

  // The focus model (`focusModel`): the element that holds focus, and whether a moved or removed node takes it away.
  const modelsFocus = options.focusModel !== undefined;
  let activeElement: unknown;
  const within = (node: unknown, target: unknown): boolean => {
    if (!node || typeof node !== 'object' || target === undefined || target === null) { return false; }
    if (node === target) { return true; }
    const nested = (node as { children?: unknown }).children;
    return Array.isArray(nested) && nested.some((child) => within(child, target));
  };
  const holdsFocus = (node: unknown): boolean => modelsFocus && within(node, activeElement);
  const leaveDocument = (nodes: readonly unknown[]): void => {
    if (nodes.some((node) => holdsFocus(node))) { activeElement = document.body; }
  };

  // The `liveRows` model: the streaming rows the script made, by the id it gave them, and the one parent of each node.
  const liveRows = new Map<string, unknown>();
  const parentOf = new WeakMap<object, unknown>();
  const take = (nodes: readonly unknown[]): void => {
    if (!options.liveRows) { return; }
    for (const node of nodes) {
      const parent = node && typeof node === 'object' ? parentOf.get(node) : undefined;
      if (parent) { (parent as Record<symbol, (node: unknown) => void>)[DETACH](node); parentOf.delete(node as object); }
    }
  };
  const own = (parent: unknown, nodes: readonly unknown[]): void => {
    if (!options.liveRows) { return; }
    for (const node of nodes) { if (node && typeof node === 'object') { parentOf.set(node, parent); } }
  };
  const disown = (parent: unknown, nodes: readonly unknown[]): void => {
    if (!options.liveRows) { return; }
    for (const node of nodes) { if (node && typeof node === 'object' && parentOf.get(node) === parent) { parentOf.delete(node); } }
  };
  const byDataset = (root: unknown, selector: unknown): unknown => {
    const match = /^\[data-([a-z-]+)="([^"]*)"\]$/.exec(String(selector));
    if (!match) { return null; }
    const key = match[1].replace(/-([a-z])/g, (_all, letter: string) => letter.toUpperCase());
    const search = (node: unknown): unknown => {
      for (const child of ((node as { children?: unknown[] })?.children ?? [])) {
        if ((child as { dataset?: Record<string, unknown> })?.dataset?.[key] === match[2]) { return child; }
        const found = search(child);
        if (found) { return found; }
      }
      return null;
    };
    return search(root);
  };

  // The `mutations` model: each node's parent, and the records a MutationObserver on the document would receive.
  const recording = options.mutations === true;
  const mutations: WebviewMutationRecord[] = [];
  const parents = new WeakMap<object, unknown>();
  const adopt = (parent: unknown, nodes: readonly unknown[]): void => {
    if (!recording) { return; }
    for (const node of nodes) { if (node && typeof node === 'object') { parents.set(node, parent); } }
  };
  const ancestors = (node: unknown): unknown[] => {
    const found: unknown[] = [];
    let at = node && typeof node === 'object' ? parents.get(node) : undefined;
    while (at !== undefined && !found.includes(at)) { found.push(at); at = at && typeof at === 'object' ? parents.get(at) : undefined; }
    return found;
  };
  const recordChildList = (target: unknown, addedNodes: readonly unknown[], removedNodes: readonly unknown[]): void => {
    if (recording) { mutations.push({ type: 'childList', target, addedNodes: [...addedNodes], removedNodes: [...removedNodes], ancestors: ancestors(target) }); }
  };
  const recordAttribute = (target: unknown, attributeName: string): void => {
    if (recording) { mutations.push({ type: 'attributes', target, addedNodes: [], removedNodes: [], attributeName, ancestors: ancestors(target) }); }
  };

  /** `text`: a text node (under `mutations`), whose `data`, `nodeValue` and `textContent` are its text. */
  const makeElement = (text?: string): Record<string | symbol, unknown> => {
    // A real class set, not a no-op: a panel that expresses visibility as a class (because the `hidden`
    // attribute is defeated by its own stylesheet) can only be asserted if toggling is observable.
    const classes = new Set<string>();
    let self: unknown;
    const classList = {
      add(name: string) { classes.add(name); },
      remove(name: string) { classes.delete(name); },
      toggle(name: string, force?: boolean) {
        const next = force === undefined ? !classes.has(name) : force;
        if (next) { classes.add(name); } else { classes.delete(name); }
        return next;
      },
      contains(name: string) { return classes.has(name); },
    };
    const children: unknown[] = [];
    // Attributes are recorded like classes, so accessibility semantics (a role, a label) can be asserted.
    const attributes = new Map<string, string>();
    const updateEnds = (target: Record<string | symbol, unknown>): void => {
      target.firstChild = children[0] ?? null;
      target.lastChild = children.at(-1) ?? null;
      target.length = children.length;
    };
    const target: Record<string | symbol, unknown> = {
      value: '', textContent: '', innerHTML: '', innerText: '', className: '', id: '',
      hidden: false, checked: false, disabled: false, open: false, selected: false,
      style: {}, dataset: {}, classList, children, length: 0,
      scrollHeight: 0, scrollTop: 0, clientHeight: 0, firstChild: null, lastChild: null,
      append(...nodes: unknown[]) { leaveDocument(nodes); take(nodes); children.push(...nodes); updateEnds(target); adopt(self, nodes); own(self, nodes); recordChildList(self, nodes, []); },
      appendChild(node: unknown) { leaveDocument([node]); take([node]); children.push(node); updateEnds(target); adopt(self, [node]); own(self, [node]); recordChildList(self, [node], []); return node; },
      prepend(...nodes: unknown[]) { leaveDocument(nodes); take(nodes); children.unshift(...nodes); updateEnds(target); adopt(self, nodes); own(self, nodes); recordChildList(self, nodes, []); },
      replaceChildren(...nodes: unknown[]) {
        leaveDocument([...children, ...nodes]);
        take(nodes);
        const removed = children.splice(0, children.length, ...nodes);
        updateEnds(target);
        adopt(self, nodes);
        disown(self, removed);
        own(self, nodes);
        recordChildList(self, nodes, removed);
      },
      // Under `liveRows` only: a node leaves its parent when it is moved elsewhere or removed.
      [DETACH](node: unknown) { const index = children.indexOf(node); if (index >= 0) { children.splice(index, 1); updateEnds(target); } },
      ...(options.liveRows ? { removeChild(node: unknown) { take([node]); return node; } } : {}),
      insertBefore(node: unknown, before: unknown) {
        leaveDocument([node]);
        take([node]);
        own(self, [node]);
        const index = children.indexOf(before);
        if (index < 0) children.push(node); else children.splice(index, 0, node);
        updateEnds(target);
        adopt(self, [node]);
        recordChildList(self, [node], []);
        return node;
      },
      remove() { leaveDocument([self]); if (options.liveRows) { take([self]); } },
      focus() { if (modelsFocus) { activeElement = self; } },
      // The node itself or one appended under it, as `Node.contains`.
      contains(node: unknown): boolean { return within(self, node); },
      click() {},
      setAttribute(name: unknown, value: unknown) { attributes.set(String(name), String(value)); recordAttribute(self, String(name)); },
      removeAttribute(name: unknown) { attributes.delete(String(name)); recordAttribute(self, String(name)); },
      closest() { return null; }, querySelectorAll() { return []; },
      querySelector(selector: unknown) { return options.liveRows ? byDataset(self, selector) : null; },
      getAttribute(name: unknown) { return attributes.get(String(name)) ?? null; },
    };
    if (text !== undefined) { Object.assign(target, { nodeType: 3, data: text, nodeValue: text, textContent: text }); }
    self = new Proxy(target, {
      get(value, property) {
        if (property in value) { return value[property]; }
        if (property === Symbol.iterator) { return [][Symbol.iterator].bind([]); }
        if (property === 'addEventListener') {
          return (type: unknown, listener: unknown) => {
            recordListener(type, listener);
            if (typeof type === 'string' && typeof listener === 'function') {
              const registered = elementListeners.get(self) ?? {};
              (registered[type] ??= []).push(listener as WebviewListener);
              elementListeners.set(self, registered);
            }
          };
        }
        if (property === 'removeEventListener') { return () => {}; }
        // Under `liveRows`, an expando the script reads before it sets one (`__name`) is undefined, as in a browser.
        if (options.liveRows && typeof property === 'string' && property.startsWith('__')) { return undefined; }
        // Unknown DOM APIs are intentionally inert. Returning a function avoids coupling this harness
        // to the next harmless DOM method a panel starts using.
        return () => makeElement();
      },
      set(value, property, next) {
        if (recording && text !== undefined && (property === 'data' || property === 'nodeValue' || property === 'textContent')) {
          Object.assign(value, { data: String(next), nodeValue: String(next), textContent: String(next) });
          mutations.push({ type: 'characterData', target: self, addedNodes: [], removedNodes: [], ancestors: ancestors(self) });
          return true;
        }
        value[property] = next;
        if (options.liveRows && property === 'id' && LIVE_ROW_IDS.has(String(next))) { liveRows.set(String(next), self); }
        if (recording && property === 'hidden') { recordAttribute(self, 'hidden'); }
        if (recording && property === 'textContent' && text === undefined) { recordChildList(self, [], []); }
        return true;
      },
    });
    return self as Record<string | symbol, unknown>;
  };

  const elements = new Map<string, Record<string | symbol, unknown>>();
  /**
   * Whether `row` is, or is under, an element the script looked up by id. v0.9.105 S8: walks up the one-parent map
   * (every append, prepend, insertBefore and replaceChildren records the parent; take and disown forget it) instead of
   * searching every looked-up element's whole subtree on each lookup, which made a long transcript's every
   * getElementById cost the whole tree. Each step checks that the parent still holds the node; a node with no recorded
   * parent is attached nowhere. A link the map and the children disagree on falls back to the full search.
   */
  const attachedUnderLookedUp = (row: unknown): boolean => {
    const roots = new Set<unknown>(elements.values());
    const seen = new Set<unknown>();
    let node: unknown = row;
    while (node && typeof node === 'object' && !seen.has(node)) {
      if (roots.has(node)) { return true; }
      seen.add(node);
      const parent = parentOf.get(node);
      if (parent === undefined) { return false; }
      const siblings = (parent as { children?: unknown }).children;
      if (!Array.isArray(siblings) || !siblings.includes(node)) {
        return [...elements.values()].some((element) => within(element, row));
      }
      node = parent;
    }
    return false;
  };
  const elementFor = (id: string) => {
    if (options.liveRows && LIVE_ROW_IDS.has(id)) {
      const row = liveRows.get(id);
      return row && attachedUnderLookedUp(row) ? row : null;
    }
    let element = elements.get(id);
    if (!element) {
      element = makeElement();
      elements.set(id, element);
    }
    return element;
  };
  const body = makeElement() as WebviewElement;
  for (const name of options.bodyClasses ?? []) { body.classList.add(name); }
  // The Workbench sets layout variables on the body.
  body.style = { setProperty() {}, removeProperty() {} };
  const document = {
    getElementById: (id: string) => elementFor(id),
    querySelector: (selector: string) => options.document?.querySelector?.(selector) ?? makeElement(),
    querySelectorAll: (selector: string) => options.document?.querySelectorAll?.(selector) ?? [],
    createElement: (_tag: string) => makeElement(),
    createTextNode: (text: string) => (recording ? makeElement(String(text)) : makeElement()),
    // Under `liveRows` a fragment says it is one (nodeType 11), so a reader can take its children as the parent's.
    createDocumentFragment: () => (options.liveRows ? Object.assign(makeElement(), { nodeType: 11 }) : makeElement()),
    addEventListener: (type: unknown, listener: unknown) => recordListener(type, listener),
    removeEventListener() {},
    body,
    /** Undefined unless `focusModel` is on. */
    get activeElement() { return activeElement; },
    hasFocus: () => options.focusModel?.hasFocus?.() ?? true,
  };
  if (modelsFocus) { activeElement = body; }
  const windowTarget: Record<string | symbol, unknown> = {
    // VS Code webviews stub these blocking dialogs. In particular confirm must not return true: doing
    // so would conceal handlers that treat the real undefined result as a user cancellation.
    confirm: () => undefined,
    alert: () => undefined,
    prompt: () => undefined,
    CSS: undefined,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener: (type: unknown, listener: unknown) => recordListener(type, listener),
    removeEventListener() {},
    scrollTo() {},
    ...options.window,
  };
  const window = new Proxy(windowTarget, {
    get(target, property) {
      if (property in target) { return target[property]; }
      return () => undefined;
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    },
  });
  const postedMessages: unknown[] = [];
  const savedStates: unknown[] = [];
  const vscode = {
    postMessage(message: unknown) { postedMessages.push(message); },
    getState: () => (savedStates.length > 0 ? savedStates.at(-1) : options.state),
    setState(next: unknown) { savedStates.push(next); },
  };

  // Constructing separately makes syntax errors as visible as execution errors. The invocation below is
  // the important half: TDZ failures parse cleanly but prevent every handler from registering.
  const execute = new Function('document', 'window', 'acquireVsCodeApi', script);
  execute(document, window, () => vscode);
  return {
    dispatchElementEvent(element, type, event = {}) {
      for (const listener of elementListeners.get(element)?.[type] ?? []) listener(event);
    },
    listeners, script, elements: elements as Map<string, WebviewElement>, postedMessages, savedStates, body,
    activeElement: () => activeElement,
    mutations,
    isInside: (node, root) => node === root || ancestors(node).includes(root),
    observedUnder: (record, root) => record.target === root || record.ancestors.includes(root),
    ancestors,
  };
}

/** The static half of the guard: VS Code stubs blocking browser dialogs out. */
export function blockingDialogCalls(script: string): RegExpMatchArray | null {
  const code = script.replace(/\/\/[^\n]*/g, ''); // Ban calls, not explanatory comments.
  return code.match(/\bwindow\.(confirm|alert|prompt)\s*\(|(^|[^.\w])(confirm|alert)\s*\(/m);
}
