// SPDX-License-Identifier: AGPL-3.0-only
// Regression tests for single-popup meetings <-> Web Clipper permission & activeTab tracking (#4638).
import { describe, expect, it, vi } from 'vitest';
import { createActiveTabTracker } from '../src/popup-guards.ts';
import { VIETNAMESE } from '../src/strings.ts';

interface FakeNode {
  tag: string;
  id: string;
  className: string;
  type: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  lang: string;
  attributes: Record<string, string>;
  children: Array<FakeNode | string>;
  listeners: Map<string, Array<() => void>>;
  isConnected: boolean;
  setAttribute: (k: string, v: string) => void;
  append: (...items: Array<FakeNode | string>) => void;
  replaceChildren: (...items: Array<FakeNode | string>) => void;
  addEventListener: (event: string, cb: () => void) => void;
  after: (...items: Array<FakeNode | string>) => void;
  remove: () => void;
  focus: () => void;
  click: () => void;
  setChecked: (next: boolean) => void;
  setValue: (next: string) => void;
  textContentValue: () => string;
}

function makeFakeNode(tag: string, idMap: Map<string, FakeNode>): FakeNode {
  const node: FakeNode = {
    tag,
    id: '',
    className: '',
    type: '',
    value: '',
    checked: false,
    disabled: false,
    lang: '',
    attributes: {},
    children: [],
    listeners: new Map(),
    isConnected: false,
    setAttribute(k, v) {
      node.attributes[k] = v;
      if (k === 'id') {
        node.id = v;
        idMap.set(v, node);
      } else if (k === 'class') {
        node.className = v;
      } else if (k === 'type') {
        node.type = v;
      } else if (k === 'value') {
        node.value = v;
      }
    },
    append(...items) {
      for (const item of items) {
        node.children.push(item);
        if (typeof item !== 'string') markConnected(item, node.isConnected);
      }
    },
    replaceChildren(...items) {
      for (const child of node.children) {
        if (typeof child !== 'string') markConnected(child, false);
      }
      node.children = [];
      node.append(...items);
      rebuildIds(node, idMap);
    },
    addEventListener(event, cb) {
      const list = node.listeners.get(event) ?? [];
      list.push(cb);
      node.listeners.set(event, list);
    },
    after() {},
    remove() {},
    focus() {},
    click() {
      for (const cb of node.listeners.get('click') ?? []) cb();
    },
    setChecked(next) {
      node.checked = next;
      for (const cb of node.listeners.get('change') ?? []) cb();
    },
    setValue(next) {
      node.value = next;
      for (const cb of node.listeners.get('input') ?? []) cb();
    },
    textContentValue() {
      return node.children
        .map((c) => (typeof c === 'string' ? c : c.textContentValue()))
        .join('');
    },
  };
  return node;
}

function markConnected(node: FakeNode, connected: boolean): void {
  node.isConnected = connected;
  for (const c of node.children) {
    if (typeof c !== 'string') markConnected(c, connected);
  }
}

function rebuildIds(root: FakeNode, idMap: Map<string, FakeNode>): void {
  idMap.clear();
  const visit = (n: FakeNode) => {
    if (n.id) idMap.set(n.id, n);
    for (const c of n.children) {
      if (typeof c !== 'string') visit(c);
    }
  };
  visit(root);
}

function findButtonsByText(root: FakeNode, label: string): FakeNode[] {
  const out: FakeNode[] = [];
  const visit = (n: FakeNode) => {
    if (n.tag === 'button' && n.textContentValue() === label) out.push(n);
    for (const c of n.children) {
      if (typeof c !== 'string') visit(c);
    }
  };
  visit(root);
  return out;
}

function findAlerts(root: FakeNode): FakeNode[] {
  const out: FakeNode[] = [];
  const visit = (n: FakeNode) => {
    if (n.attributes.role === 'alert') out.push(n);
    for (const c of n.children) {
      if (typeof c !== 'string') visit(c);
    }
  };
  visit(root);
  return out;
}

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
};

async function waitForUi(check: () => void): Promise<void> {
  await vi.waitFor(check, { timeout: 2_000, interval: 5 });
}

describe('createActiveTabTracker (#4638)', () => {
  it('keeps activeTab flagged as mid-popup granted across meetings -> Web Clipper -> off/on cycles', async () => {
    const held = new Set<string>();
    const permissions = {
      contains: async ({ permissions: req }: { permissions: string[] }) => req.every((p) => held.has(p)),
    };

    const tracker = createActiveTabTracker();
    await tracker.captureBaseline(permissions);
    expect(tracker.isJustGranted()).toBe(false);

    // 1. User enables meetings mid-popup (grants activeTab without a toolbar click).
    held.add('offscreen');
    held.add('tabCapture');
    held.add('activeTab');
    tracker.onMeetingsEnabled(true);
    expect(tracker.isJustGranted()).toBe(true);

    // 2. User switches to Web Clipper and enables it in the same popup open.
    held.add('scripting');
    expect(tracker.onWebClipperToggled(true, true)).toBe(true);
    expect(tracker.isJustGranted()).toBe(true);

    // 3. Toggling Web Clipper off keeps activeTab for meetings, then re-enabling Web Clipper still requires reopen.
    held.delete('scripting');
    await tracker.onPermissionsRemoved(['scripting'], permissions);
    expect(tracker.onWebClipperToggled(false, false)).toBe(false);
    expect(tracker.isJustGranted()).toBe(false);

    held.add('scripting');
    expect(tracker.onWebClipperToggled(true, true)).toBe(true);
    expect(tracker.isJustGranted()).toBe(true);

    // 4. Denied permission prompt clears justGranted.
    expect(tracker.onWebClipperToggled(true, false)).toBe(false);
    expect(tracker.isJustGranted()).toBe(false);
  });

  it('tracks popup-open activeTab baseline and invalidates it if meetings turnOff revokes activeTab mid-popup', async () => {
    const held = new Set<string>(['offscreen', 'tabCapture', 'activeTab']);
    const permissions = {
      contains: async ({ permissions: req }: { permissions: string[] }) => req.every((p) => held.has(p)),
    };

    const tracker = createActiveTabTracker();
    await tracker.captureBaseline(permissions);

    // While activeTab stayed held continuously since popup open, enabling Web Clipper needs no reopen.
    held.add('scripting');
    expect(tracker.onWebClipperToggled(true, true)).toBe(false);
    expect(tracker.isJustGranted()).toBe(false);

    // Turning meetings off after turning clipper off revokes activeTab mid-popup.
    held.delete('scripting');
    held.delete('activeTab');
    await tracker.onPermissionsRemoved(['activeTab', 'scripting'], permissions);
    expect(tracker.onWebClipperToggled(false, false)).toBe(false);

    held.delete('offscreen');
    held.delete('tabCapture');
    await tracker.onPermissionsRemoved(['offscreen', 'tabCapture', 'activeTab'], permissions);

    // Re-enabling meetings then Web Clipper mid-popup must require reopen.
    held.add('offscreen');
    held.add('tabCapture');
    held.add('activeTab');
    tracker.onMeetingsEnabled(true);
    held.add('scripting');
    expect(tracker.onWebClipperToggled(true, true)).toBe(true);
    expect(tracker.isJustGranted()).toBe(true);

    // Once a tab capture actually succeeds, activeTab is verified active for this popup.
    tracker.onCaptureSucceeded();
    expect(tracker.isJustGranted()).toBe(false);
  });
});

describe('popup.ts single-popup meetings-then-Web-Clipper flow (#4638)', () => {
  async function mountPopup(opts: {
    initialPermissions?: string[];
    initialEnabled?: Record<string, boolean>;
  }) {
    vi.resetModules();
    const held = new Set<string>(opts.initialPermissions ?? []);
    let activeTabReadyForScript = held.has('activeTab');
    const storageData: Record<string, unknown> = {
      'ludy-extension-state': {
        address: 'https://ludy.example',
        accounts: {
          org1: { orgId: 'org1', orgSlug: 'cong-ty', token: 'crx_test', expiresAt: '2027-01-01T00:00:00Z' },
        },
        activeOrg: 'org1',
        enabled: opts.initialEnabled ?? {},
      },
    };
    const clipCalls: Array<{ title: string; body: string; sourceUrl?: string }> = [];

    const idMap = new Map<string, FakeNode>();
    const root = makeFakeNode('div', idMap);
    root.isConnected = true;
    root.setAttribute('id', 'root');

    vi.stubGlobal('document', {
      getElementById: (id: string) => (id === 'root' ? root : (idMap.get(id) ?? null)),
      createElement: (tag: string) => makeFakeNode(tag, idMap),
    });
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('no idb');
      },
    });
    vi.stubGlobal('navigator', {
      language: 'vi-VN',
      userAgent: 'TestBrowser',
      permissions: { query: async () => ({ state: 'granted' }) },
      clipboard: { writeText: async () => undefined },
    });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/extension/me')) {
        return new Response(
          JSON.stringify({
            tokenId: 'tok-1',
            orgId: 'org1',
            scopes: ['meetings', 'notes'],
            expiresAt: '2027-01-01T00:00:00Z',
            features: { meetings: true, agenda: false, notes: true },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/rpc/notes/clip')) {
        const parsed = JSON.parse(String(init?.body ?? '{}')) as { json: { title: string; body: string; sourceUrl?: string } };
        clipCalls.push(parsed.json);
        return new Response(JSON.stringify({ json: { noteId: 'n1', revision: 1 } }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('chrome', {
      i18n: { getUILanguage: () => 'vi' },
      runtime: { getURL: (path: string) => `chrome-extension://test/${path}`, sendMessage: async () => ({ ok: true }) },
      identity: { getRedirectURL: () => 'https://test.chromiumapp.org/connect', launchWebAuthFlow: async () => '' },
      action: { setBadgeText: async () => undefined, setTitle: async () => undefined },
      storage: {
        local: {
          get: async (key: string) => (key in storageData ? { [key]: storageData[key] } : {}),
          set: async (items: Record<string, unknown>) => {
            Object.assign(storageData, items);
          },
          remove: async (key: string) => {
            delete storageData[key];
          },
        },
      },
      permissions: {
        contains: async ({ permissions = [] }: { permissions?: string[] }) => permissions.every((p) => held.has(p)),
        request: async ({ permissions = [] }: { permissions?: string[] }) => {
          for (const p of permissions) held.add(p);
          return true;
        },
        remove: async ({ permissions = [] }: { permissions?: string[] }) => {
          for (const p of permissions) {
            held.delete(p);
            if (p === 'activeTab') activeTabReadyForScript = false;
          }
          return true;
        },
      },
      tabs: {
        query: async () => [{ id: 10, url: 'https://example.com/article' }],
        create: async () => undefined,
      },
      scripting: {
        executeScript: async () => {
          // Real Chrome refuses activeTab script injection until the popup is reopened from the toolbar.
          if (!activeTabReadyForScript) {
            throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.');
          }
          return [
            {
              result: {
                url: 'https://example.com/article',
                title: 'Bài viết mẫu',
                selectedHtml: '',
                selectedText: '',
                contentHtml: '<p>Nội dung chuẩn</p>',
                textFallback: 'Nội dung chuẩn',
              },
            },
          ];
        },
      },
    });

    await import('../src/popup.ts');
    await waitForUi(() => {
      expect(idMap.has('notes-capture')).toBe(true);
    });

    return {
      root,
      held,
      clipCalls,
      getById: (id: string) => idMap.get(id),
      buttonsNamed: (label: string) => findButtonsByText(root, label),
      alerts: () => findAlerts(root).map((a) => a.textContentValue()),
      cleanup: async () => {
        await settle();
        vi.unstubAllGlobals();
      },
    };
  }

  it('surfaces clipReopenRequired when meetings was enabled mid-popup before Web Clipper in the same popup open', async () => {
    const ui = await mountPopup({});
    try {
      // Preserve Quick Capture draft across enabling meetings and toggling Web Clipper.
      ui.getById('capture-title')!.setValue('Nháp ghi chú');
      ui.getById('capture-body')!.setValue('Nội dung nháp');

      // 1. Enable meetings mid-popup (grants activeTab without toolbar activation).
      const turnOnBtn = ui.buttonsNamed(VIETNAMESE.meetingsOn)[0];
      expect(turnOnBtn).toBeDefined();
      turnOnBtn!.click();
      await waitForUi(() => {
        expect(ui.buttonsNamed(VIETNAMESE.meetingsOff)).toHaveLength(1);
      });
      expect(ui.held.has('activeTab')).toBe(true);

      // 2. Switch to Web Clipper in the same popup open and enable it.
      ui.getById('clipper-toggle')!.setChecked(true);
      await waitForUi(() => {
        expect(ui.getById('clip-now')).toBeDefined();
      });
      expect(ui.getById('capture-title')!.value).toBe('Nháp ghi chú');

      // 3. Clicking Clip must surface clipReopenRequired rather than generic clipFailed.
      ui.getById('clip-now')!.click();
      await waitForUi(() => {
        expect(ui.alerts()).toContain(VIETNAMESE.clipReopenRequired);
      });
      expect(ui.clipCalls).toEqual([]);

      // 4. Toggling Web Clipper off and back on while meetings keeps activeTab still preserves clipReopenRequired.
      ui.getById('clipper-toggle')!.setChecked(false);
      await waitForUi(() => {
        expect(ui.getById('clip-now')).toBeUndefined();
      });
      expect(ui.held.has('activeTab')).toBe(true);
      ui.getById('clipper-toggle')!.setChecked(true);
      await waitForUi(() => {
        expect(ui.getById('clip-now')).toBeDefined();
      });
      ui.getById('clip-now')!.click();
      await waitForUi(() => {
        expect(ui.alerts()).toContain(VIETNAMESE.clipReopenRequired);
      });
    } finally {
      await ui.cleanup();
    }
  });

  it('allows immediate clip when meetings already held activeTab on popup open, and requires reopen if meetings turns off and back on', async () => {
    const preGranted = await mountPopup({
      initialPermissions: ['offscreen', 'tabCapture', 'activeTab'],
      initialEnabled: { meetings: true },
    });
    try {
      preGranted.getById('clipper-toggle')!.setChecked(true);
      await waitForUi(() => {
        expect(preGranted.getById('clip-now')).toBeDefined();
      });
      preGranted.getById('clip-now')!.click();
      await waitForUi(() => {
        expect(preGranted.clipCalls).toHaveLength(1);
      });
      expect(preGranted.alerts()).toEqual([]);
      expect(preGranted.clipCalls).toEqual([
        { title: 'Bài viết mẫu', body: 'Nội dung chuẩn', sourceUrl: 'https://example.com/article' },
      ]);
    } finally {
      await preGranted.cleanup();
    }

    const revokedMidPopup = await mountPopup({
      initialPermissions: ['offscreen', 'tabCapture', 'activeTab'],
      initialEnabled: { meetings: true },
    });
    try {
      revokedMidPopup.buttonsNamed(VIETNAMESE.meetingsOff)[0]!.click();
      await waitForUi(() => {
        expect(revokedMidPopup.buttonsNamed(VIETNAMESE.meetingsOn)).toHaveLength(1);
      });
      expect(revokedMidPopup.held.has('activeTab')).toBe(false);

      revokedMidPopup.buttonsNamed(VIETNAMESE.meetingsOn)[0]!.click();
      await waitForUi(() => {
        expect(revokedMidPopup.buttonsNamed(VIETNAMESE.meetingsOff)).toHaveLength(1);
      });
      revokedMidPopup.getById('clipper-toggle')!.setChecked(true);
      await waitForUi(() => {
        expect(revokedMidPopup.getById('clip-now')).toBeDefined();
      });
      revokedMidPopup.getById('clip-now')!.click();
      await waitForUi(() => {
        expect(revokedMidPopup.alerts()).toContain(VIETNAMESE.clipReopenRequired);
      });
    } finally {
      await revokedMidPopup.cleanup();
    }
  });
});
