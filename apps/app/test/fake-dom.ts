// SPDX-License-Identifier: AGPL-3.0-only
// Shared lightweight scoped fake DOM harness for mounted React 19 / Base UI / TanStack Query component tests.
import { act } from 'react';
import type { Root } from 'react-dom/client';

export class FakeDomNode {
  static DOCUMENT_POSITION_DISCONNECTED = 1;
  static DOCUMENT_POSITION_PRECEDING = 2;
  static DOCUMENT_POSITION_FOLLOWING = 4;
  static DOCUMENT_POSITION_CONTAINS = 8;
  static DOCUMENT_POSITION_CONTAINED_BY = 16;
  static DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC = 32;

  nodeType: number;
  tagName: string;
  nodeName: string;
  childNodes: FakeDomNode[] = [];
  parentNode: FakeDomNode | null = null;
  attrs = new Map<string, string>();
  nodeValue = '';
  private _textContent = '';
  private _value = '';
  private _listeners = new Map<string, Set<{ fn: (e: unknown) => void; capture: boolean }>>();
  className = '';
  disabled = false;
  checked = false;
  selected = false;
  tabIndex = 0;
  type = '';
  name = '';
  offsetLeft = 0;
  offsetTop = 0;
  offsetWidth = 100;
  offsetHeight = 40;
  clientWidth = 100;
  clientHeight = 40;
  scrollWidth = 100;
  scrollLeft = 0;
  scrollTop = 0;
  scrollHeight = 40;
  style = Object.assign(Object.create(null) as Record<string, unknown>, {
    setProperty: (_name: string, _val: string) => undefined,
    removeProperty: (_name: string) => '',
    getPropertyValue: (_name: string) => '',
  });
  classList = {
    add: (...tokens: string[]) => {
      const next = new Set(this.className.split(/\s+/).filter(Boolean));
      for (const tok of tokens) next.add(tok);
      this.className = [...next].join(' ');
    },
    remove: (...tokens: string[]) => {
      const next = new Set(this.className.split(/\s+/).filter(Boolean));
      for (const tok of tokens) next.delete(tok);
      this.className = [...next].join(' ');
    },
    contains: (token: string) => this.className.split(/\s+/).includes(token),
  };

  constructor(nodeType: number, tag = '') {
    this.nodeType = nodeType;
    this.tagName = tag.toUpperCase();
    this.nodeName = nodeType === 3 ? '#text' : nodeType === 8 ? '#comment' : this.tagName;
  }

  get value(): string {
    return this._value;
  }
  set value(v: string) {
    this._value = String(v ?? '');
  }
  get id(): string {
    return this.attrs.get('id') ?? '';
  }
  set id(v: string) {
    this.attrs.set('id', String(v ?? ''));
  }
  get firstChild(): FakeDomNode | null {
    return this.childNodes[0] ?? null;
  }
  get nextSibling(): FakeDomNode | null {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return i >= 0 ? (this.parentNode.childNodes[i + 1] ?? null) : null;
  }
  get parentElement(): FakeDomNode | null {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  get ownerDocument() {
    return globalThis.document;
  }
  get isConnected(): boolean {
    const docBody = (globalThis.document as unknown as { body: FakeDomNode }).body;
    if (this === docBody) return true;
    let cur = this.parentNode;
    while (cur) {
      if (cur === docBody) return true;
      cur = cur.parentNode;
    }
    return false;
  }
  get textContent(): string {
    if (this.nodeType === 3 || this.nodeType === 8) return this._textContent;
    return this.childNodes.length > 0 ? this.childNodes.map((c) => c.textContent).join('') : this._textContent;
  }
  set textContent(v: string) {
    const s = String(v ?? '');
    this._textContent = s;
    if (this.nodeType === 3) this.nodeValue = s;
    else this.childNodes = [];
  }
  appendChild(child: FakeDomNode): FakeDomNode {
    return this.insertBefore(child, null);
  }
  insertBefore(child: FakeDomNode, ref: FakeDomNode | null): FakeDomNode {
    if (child.parentNode) child.parentNode.removeChild(child);
    const idx = ref ? this.childNodes.indexOf(ref) : -1;
    if (idx >= 0) this.childNodes.splice(idx, 0, child);
    else this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }
  removeChild(child: FakeDomNode): FakeDomNode {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }
  setAttribute(name: string, val: string): void {
    const s = String(val);
    this.attrs.set(name, s);
    if (name === 'class') this.className = s;
    else if (name === 'value') this._value = s;
    else if (name === 'type') this.type = s;
    else if (name === 'name') this.name = s;
    else if (name === 'disabled') this.disabled = s !== 'false';
    else if (name === 'checked') this.checked = true;
    else if (name === 'tabindex') this.tabIndex = Number(s);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
    if (name === 'class') this.className = '';
    else if (name === 'disabled') this.disabled = false;
    else if (name === 'checked') this.checked = false;
  }
  getAttribute(name: string): string | null {
    if (name === 'class') return this.className || this.attrs.get('class') || null;
    if (name === 'disabled') return this.disabled ? (this.attrs.get('disabled') ?? '') : null;
    return this.attrs.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    if (name === 'disabled') return this.disabled;
    return this.attrs.has(name) || (name === 'class' && this.className !== '');
  }
  addEventListener(type: string, fn: (e: unknown) => void, options?: boolean | { capture?: boolean }): void {
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    let set = this._listeners.get(type);
    if (!set) {
      set = new Set();
      this._listeners.set(type, set);
    }
    set.add({ fn, capture });
  }
  removeEventListener(type: string, fn: (e: unknown) => void, options?: boolean | { capture?: boolean }): void {
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    const set = this._listeners.get(type);
    if (!set) return;
    for (const entry of set) {
      if (entry.fn === fn && entry.capture === capture) set.delete(entry);
    }
  }
  dispatchEvent(rawEvent: Record<string, unknown>): boolean {
    const path: Array<{
      node: FakeDomNode | Record<string, unknown>;
      listeners?: Map<string, Set<{ fn: (e: unknown) => void; capture: boolean }>>;
    }> = [{ node: this, listeners: this._listeners }];
    let cur = this.parentNode;
    while (cur) {
      path.push({ node: cur, listeners: cur._listeners });
      cur = cur.parentNode;
    }
    const doc = globalThis.document as unknown as {
      _listeners?: Map<string, Set<{ fn: (e: unknown) => void; capture: boolean }>>;
    };
    path.push({ node: doc as unknown as Record<string, unknown>, listeners: doc._listeners });

    const eventType = String(rawEvent.type);
    const bubbles = rawEvent.bubbles !== false;
    const cancelable = rawEvent.cancelable !== false;
    let defaultPrevented = false;
    let propagationStopped = false;
    let immediateStopped = false;
    const event: Record<string, unknown> = {
      ...rawEvent,
      type: eventType,
      bubbles,
      cancelable,
      target: this,
      currentTarget: null,
      get defaultPrevented() {
        return defaultPrevented;
      },
      preventDefault() {
        if (cancelable) defaultPrevented = true;
      },
      stopPropagation() {
        propagationStopped = true;
      },
      stopImmediatePropagation() {
        propagationStopped = true;
        immediateStopped = true;
      },
    };
    const invoke = (entry: (typeof path)[number], capturePhase: boolean) => {
      const set = entry.listeners?.get(eventType);
      if (!set) return;
      event.currentTarget = entry.node;
      for (const listener of Array.from(set)) {
        if (listener.capture !== capturePhase) continue;
        listener.fn(event);
        if (immediateStopped) break;
      }
    };
    for (let i = path.length - 1; i > 0 && !propagationStopped; i -= 1) {
      invoke(path[i]!, true);
    }
    if (!propagationStopped) {
      invoke(path[0]!, true);
      if (!immediateStopped) invoke(path[0]!, false);
    }
    if (bubbles) {
      for (let i = 1; i < path.length && !propagationStopped; i += 1) {
        invoke(path[i]!, false);
      }
    }
    return !defaultPrevented;
  }
  focus(): void {
    (globalThis.document as unknown as { activeElement: unknown }).activeElement = this;
  }
  blur(): void {
    const doc = globalThis.document as unknown as { activeElement: unknown };
    if (doc.activeElement === this) doc.activeElement = null;
  }
  checkValidity(): boolean {
    return true;
  }
  reportValidity(): boolean {
    return true;
  }
  contains(node: FakeDomNode | null): boolean {
    let cur = node;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }
  compareDocumentPosition(other: FakeDomNode): number {
    if (this === other) return 0;
    if (this.contains(other)) {
      return FakeDomNode.DOCUMENT_POSITION_CONTAINED_BY | FakeDomNode.DOCUMENT_POSITION_FOLLOWING;
    }
    if (other.contains(this)) {
      return FakeDomNode.DOCUMENT_POSITION_CONTAINS | FakeDomNode.DOCUMENT_POSITION_PRECEDING;
    }
    const pathToRoot = (start: FakeDomNode | null): FakeDomNode[] => {
      const chain: FakeDomNode[] = [];
      let cur = start;
      while (cur) {
        chain.push(cur);
        cur = cur.parentNode;
      }
      return chain.reverse();
    };
    const aPath = pathToRoot(this);
    const bPath = pathToRoot(other);
    if (aPath[0] !== bPath[0]) return FakeDomNode.DOCUMENT_POSITION_DISCONNECTED;
    let i = 0;
    while (i < aPath.length && i < bPath.length && aPath[i] === bPath[i]) i += 1;
    const lca = aPath[i - 1]!;
    const idxA = lca.childNodes.indexOf(aPath[i]!);
    const idxB = lca.childNodes.indexOf(bPath[i]!);
    return idxA < idxB ? FakeDomNode.DOCUMENT_POSITION_FOLLOWING : FakeDomNode.DOCUMENT_POSITION_PRECEDING;
  }
  getBoundingClientRect() {
    return { top: 0, bottom: 40, left: 0, right: 100, width: 100, height: 40, x: 0, y: 0 };
  }
  matches(selector: string): boolean {
    if (this.nodeType !== 1) return false;
    const m = /^([a-zA-Z0-9_-]+)?(?:\[([^=\]]+)(?:="([^"]*)")?\])?$/.exec(selector.trim());
    if (!m || (!m[1] && !m[2])) return false;
    if (m[1] && this.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
    if (m[2]) {
      return m[3] === undefined ? this.hasAttribute(m[2]) : this.getAttribute(m[2]) === m[3];
    }
    return true;
  }
  closest(selector: string): FakeDomNode | null {
    if (this.matches(selector)) return this;
    let cur = this.parentNode;
    while (cur) {
      if (cur.matches(selector)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
  querySelectorAll(selector: string): FakeDomNode[] {
    const out: FakeDomNode[] = [];
    const walk = (node: FakeDomNode) => {
      for (const child of node.childNodes) {
        if (child.matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector: string): FakeDomNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

export function createScopedDomHarness(onTeardown?: () => void) {
  const savedGlobals = new Map<string, { had: boolean; value: unknown }>();
  let mountedRoot: Root | null = null;
  let scheduledTimers: ReturnType<typeof setTimeout>[] = [];

  const setGlobal = (key: string, value: unknown) => {
    if (!savedGlobals.has(key)) {
      savedGlobals.set(key, { had: key in globalThis, value: (globalThis as Record<string, unknown>)[key] });
    }
    (globalThis as Record<string, unknown>)[key] = value;
  };

  const installScopedDom = () => {
    setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    setGlobal('window', globalThis);
    setGlobal('HTMLElement', FakeDomNode);
    setGlobal('HTMLButtonElement', FakeDomNode);
    setGlobal('HTMLDivElement', FakeDomNode);
    setGlobal('HTMLInputElement', FakeDomNode);
    setGlobal('HTMLFormElement', FakeDomNode);
    setGlobal('HTMLIFrameElement', FakeDomNode);
    setGlobal('SVGElement', FakeDomNode);
    setGlobal('Element', FakeDomNode);
    setGlobal('Node', FakeDomNode);
    setGlobal('getComputedStyle', () => ({ overflowY: 'visible', direction: 'ltr', getPropertyValue: () => '' }));
    setGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
      const id = setTimeout(() => cb(0), 0);
      scheduledTimers.push(id);
      return id;
    });
    setGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
    setGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    setGlobal('MutationObserver', class { observe() {} disconnect() {} takeRecords() { return []; } });
    const body = new FakeDomNode(1, 'body');
    const docListeners = new Map<string, Set<{ fn: (e: unknown) => void; capture: boolean }>>();
    const docObj = {
      nodeType: 9,
      defaultView: globalThis,
      body,
      head: new FakeDomNode(1, 'head'),
      documentElement: body,
      activeElement: null as unknown,
      _listeners: docListeners,
      createElement: (tag: string) => new FakeDomNode(1, tag),
      createElementNS: (_ns: string, tag: string) => new FakeDomNode(1, tag),
      createTextNode: (text: string) => {
        const n = new FakeDomNode(3);
        n.textContent = text;
        return n;
      },
      createComment: (text: string) => {
        const n = new FakeDomNode(8);
        n.nodeValue = String(text ?? '');
        return n;
      },
      createRange: () => ({
        setStart: () => undefined,
        setEnd: () => undefined,
        commonAncestorContainer: body,
        getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
      }),
      getElementById: (id: string) => body.querySelector(`[id="${id}"]`),
      addEventListener: (type: string, fn: (e: unknown) => void, options?: boolean | { capture?: boolean }) => {
        const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
        let set = docListeners.get(type);
        if (!set) {
          set = new Set();
          docListeners.set(type, set);
        }
        set.add({ fn, capture });
      },
      removeEventListener: (type: string, fn: (e: unknown) => void, options?: boolean | { capture?: boolean }) => {
        const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
        const set = docListeners.get(type);
        if (!set) return;
        for (const entry of set) {
          if (entry.fn === fn && entry.capture === capture) set.delete(entry);
        }
      },
    };
    setGlobal('document', docObj);
    return body;
  };

  const teardownScopedDom = async () => {
    if (mountedRoot) {
      await act(async () => {
        mountedRoot?.unmount();
      });
      mountedRoot = null;
    }
    for (const t of scheduledTimers) clearTimeout(t);
    scheduledTimers = [];
    for (const [key, entry] of savedGlobals) {
      if (entry.had) (globalThis as Record<string, unknown>)[key] = entry.value;
      else delete (globalThis as Record<string, unknown>)[key];
    }
    savedGlobals.clear();
    onTeardown?.();
  };

  return {
    installScopedDom,
    teardownScopedDom,
    setMountedRoot: (root: Root | null) => {
      mountedRoot = root;
    },
  };
}
