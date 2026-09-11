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
}

export type WebviewElement = Record<string | symbol, unknown> & {
  classList: { add(name: string): void; remove(name: string): void; toggle(name: string, force?: boolean): boolean; contains(name: string): boolean };
};

export interface WebviewBootOptions {
  /** Extra window properties for a panel-specific test. */
  window?: object;
}

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
  const recordListener = (type: unknown, listener: unknown): void => {
    if (typeof type !== 'string' || typeof listener !== 'function') { return; }
    (listeners[type] ??= []).push(listener as WebviewListener);
  };

  const makeElement = (): Record<string | symbol, unknown> => {
    // A real class set, not a no-op: a panel that expresses visibility as a class (because the `hidden`
    // attribute is defeated by its own stylesheet) can only be asserted if toggling is observable.
    const classes = new Set<string>();
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
    const target: Record<string | symbol, unknown> = {
      value: '', textContent: '', innerHTML: '', innerText: '', className: '', id: '',
      hidden: false, checked: false, disabled: false, open: false, selected: false,
      style: {}, dataset: {}, classList, children: [], length: 0,
      scrollHeight: 0, scrollTop: 0, clientHeight: 0, firstChild: null, lastChild: null,
      append() {}, appendChild() {}, prepend() {}, replaceChildren() {}, insertBefore() {},
      remove() {}, setAttribute() {}, removeAttribute() {}, focus() {}, click() {},
      closest() { return null; }, querySelectorAll() { return []; },
      querySelector() { return null; }, getAttribute() { return null; },
    };
    return new Proxy(target, {
      get(value, property) {
        if (property in value) { return value[property]; }
        if (property === Symbol.iterator) { return [][Symbol.iterator].bind([]); }
        if (property === 'addEventListener') {
          return (type: unknown, listener: unknown) => recordListener(type, listener);
        }
        if (property === 'removeEventListener') { return () => {}; }
        // Unknown DOM APIs are intentionally inert. Returning a function avoids coupling this harness
        // to the next harmless DOM method a panel starts using.
        return () => makeElement();
      },
      set(value, property, next) {
        value[property] = next;
        return true;
      },
    });
  };

  const elements = new Map<string, Record<string | symbol, unknown>>();
  const elementFor = (id: string) => {
    let element = elements.get(id);
    if (!element) {
      element = makeElement();
      elements.set(id, element);
    }
    return element;
  };
  const document = {
    getElementById: (id: string) => elementFor(id),
    querySelector: (_selector: string) => makeElement(),
    querySelectorAll: (_selector: string) => [],
    createElement: (_tag: string) => makeElement(),
    createTextNode: (_text: string) => makeElement(),
    createDocumentFragment: () => makeElement(),
    addEventListener: (type: unknown, listener: unknown) => recordListener(type, listener),
    removeEventListener() {},
    body: makeElement(),
  };
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
  const vscode = { postMessage(message: unknown) { postedMessages.push(message); }, getState: () => undefined, setState() {} };

  // Constructing separately makes syntax errors as visible as execution errors. The invocation below is
  // the important half: TDZ failures parse cleanly but prevent every handler from registering.
  const execute = new Function('document', 'window', 'acquireVsCodeApi', script);
  execute(document, window, () => vscode);
  return { listeners, script, elements: elements as Map<string, WebviewElement>, postedMessages };
}

/** The static half of the guard: VS Code stubs blocking browser dialogs out. */
export function blockingDialogCalls(script: string): RegExpMatchArray | null {
  const code = script.replace(/\/\/[^\n]*/g, ''); // Ban calls, not explanatory comments.
  return code.match(/\bwindow\.(confirm|alert|prompt)\s*\(|(^|[^.\w])(confirm|alert)\s*\(/m);
}
