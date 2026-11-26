// SPDX-License-Identifier: AGPL-3.0-only
// Regression tests for single-popup meetings <-> Web Clipper permission & activeTab tracking (#4638).
import { describe, expect, it, vi } from 'vitest';
import { createActiveTabTracker } from '../src/popup-guards.ts';
import { LOST_KEY, pendingScopeKey, RECORDING_KEY, type LostState, type RecordingState, type StopReply } from '../src/messages.ts';
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
    rejectMeetingsContains?: boolean;
    rejectStopMessage?: boolean;
    stopReply?: StopReply;
    initialRecording?: RecordingState;
    initialLost?: LostState;
    pendingRecordings?: Array<{
      id: string;
      scope: string;
      address?: string;
      tokenId?: string;
      meetingId: string;
      title: string;
      kind: 'audio' | 'video';
      mimeType: string;
      startedAt: number;
      elapsedMs: number;
      chunkCount: number;
      updatedAt: number;
    }>;
    signedOut?: boolean;
    accountTokenId?: string | null;
    rejectMe?: boolean;
    expireMe?: boolean;
    hangMe?: boolean;
    meTokenId?: string;
    meFeatures?: { meetings?: boolean; agenda?: boolean; notes?: boolean };
    ownedLegacyMeetingIds?: string[];
    spoofedLegacyMeetingIds?: string[];
    hangLegacyMeetingIds?: string[];
  }) {
    vi.resetModules();
    const held = new Set<string>(opts.initialPermissions ?? []);
    let activeTabReadyForScript = held.has('activeTab');
    const cachedTokenId = opts.accountTokenId === undefined ? 'tok-1' : opts.accountTokenId;
    const storageData: Record<string, unknown> = {
      ...(opts.signedOut
        ? {}
        : {
            'ludy-extension-state': {
              address: 'https://ludy.example',
              accounts: {
                org1: {
                  orgId: 'org1',
                  orgSlug: 'cong-ty',
                  token: 'crx_test',
                  expiresAt: '2027-01-01T00:00:00Z',
                  ...(cachedTokenId ? { tokenId: cachedTokenId } : {}),
                },
              },
              activeOrg: 'org1',
              enabled: opts.initialEnabled ?? {},
            },
          }),
      ...(opts.initialRecording ? { [RECORDING_KEY]: opts.initialRecording } : {}),
      ...(opts.initialLost ? { [LOST_KEY]: opts.initialLost } : {}),
      ...(opts.pendingRecordings
        ? Object.fromEntries(
            opts.pendingRecordings
              .filter((r) => r.address)
              .map((r) => [pendingScopeKey(r.meetingId), { orgId: r.scope, address: r.address, ...(r.tokenId ? { tokenId: r.tokenId } : {}) }]),
          )
        : {}),
    };
    const pendingItems = [...(opts.pendingRecordings ?? [])].map(({ address: _a, tokenId: _t, ...meta }) => meta);
    const clipCalls: Array<{ title: string; body: string; sourceUrl?: string }> = [];
    const sentMessages: unknown[] = [];
    const extensionStatusCalls: string[] = [];

    const idMap = new Map<string, FakeNode>();
    const root = makeFakeNode('div', idMap);
    root.isConnected = true;
    root.setAttribute('id', 'root');

    vi.stubGlobal('document', {
      getElementById: (id: string) => (id === 'root' ? root : (idMap.get(id) ?? null)),
      createElement: (tag: string) => makeFakeNode(tag, idMap),
    });
    vi.stubGlobal('indexedDB', {
      databases: async () => [],
      open: () => {
        if (!opts.pendingRecordings) throw new Error('no idb');
        const db = {
          objectStoreNames: { contains: () => true },
          onversionchange: null as null | (() => void),
          close: () => undefined,
          transaction: () => {
            const tx = {
              oncomplete: null as null | (() => void),
              onerror: null as null | (() => void),
              onabort: null as null | (() => void),
              objectStore: (name: string) => ({
                getAll: () => {
                  const req = {
                    result: name === 'recordings' ? [...pendingItems] : [],
                    onsuccess: null as null | (() => void),
                    onerror: null as null | (() => void),
                  };
                  queueMicrotask(() => req.onsuccess?.());
                  return req;
                },
                delete: (key: unknown) => {
                  if (name === 'recordings') {
                    const idx = pendingItems.findIndex((m) => m.id === key);
                    if (idx >= 0) pendingItems.splice(idx, 1);
                  }
                  queueMicrotask(() => tx.oncomplete?.());
                },
              }),
            };
            return tx;
          },
        };
        const req = {
          result: db,
          onupgradeneeded: null as null | (() => void),
          onsuccess: null as null | (() => void),
          onerror: null as null | (() => void),
        };
        queueMicrotask(() => req.onsuccess?.());
        return req;
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
        if (opts.hangMe) return new Promise<Response>(() => undefined);
        if (opts.expireMe) return new Response('{}', { status: 401 });
        if (opts.rejectMe) return new Response('{}', { status: 500 });
        return new Response(
          JSON.stringify({
            tokenId: opts.meTokenId ?? 'tok-1',
            orgId: 'org1',
            scopes: ['meetings', 'notes'],
            expiresAt: '2027-01-01T00:00:00Z',
            features: opts.meFeatures ?? { meetings: true, agenda: false, notes: true },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/rpc/notes/clip')) {
        const parsed = JSON.parse(String(init?.body ?? '{}')) as { json: { title: string; body: string; sourceUrl?: string } };
        clipCalls.push(parsed.json);
        return new Response(JSON.stringify({ json: { noteId: 'n1', revision: 1 } }), { status: 200 });
      }
      if (url.endsWith('/api/rpc/meetings/extensionStatus')) {
        const parsed = JSON.parse(String(init?.body ?? '{}')) as { json?: { meetingId?: string } };
        const meetingId = parsed.json?.meetingId ?? '';
        extensionStatusCalls.push(meetingId);
        if (opts.hangLegacyMeetingIds?.includes(meetingId)) {
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
          });
        }
        if (opts.spoofedLegacyMeetingIds?.includes(meetingId)) {
          return new Response(
            JSON.stringify({ json: { meetingId: 'm-different', status: 'ready', hasAudio: false, hasVideo: false, keepVideo: false, liveNotes: false } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (opts.ownedLegacyMeetingIds?.includes(meetingId)) {
          return new Response(
            JSON.stringify({ json: { meetingId, status: 'ready', hasAudio: false, hasVideo: false, keepVideo: false, liveNotes: false } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ code: 'MEETING_NOT_FOUND', message: 'Not found' }), { status: 404 });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('chrome', {
      i18n: { getUILanguage: () => 'vi' },
      runtime: {
        getURL: (path: string) => `chrome-extension://test/${path}`,
        sendMessage: async (msg: unknown) => {
          sentMessages.push(msg);
          if (typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === 'stop') {
            if (opts.rejectStopMessage) throw new Error('Extension runtime disconnected');
            const reply = opts.stopReply ?? { ok: false, reason: 'idle' };
            if (reply.ok || reply.reason === 'idle') delete storageData[RECORDING_KEY];
            return reply;
          }
          return { ok: true };
        },
      },
      identity: { getRedirectURL: () => 'https://test.chromiumapp.org/connect', launchWebAuthFlow: async () => '' },
      action: { setBadgeText: async () => undefined, setTitle: async () => undefined },
      storage: {
        local: {
          get: async (keys: string | string[]) => {
            const list = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(list.filter((k) => k in storageData).map((k) => [k, storageData[k]]));
          },
          set: async (items: Record<string, unknown>) => {
            Object.assign(storageData, items);
          },
          remove: async (key: string) => {
            delete storageData[key];
          },
        },
      },
      permissions: {
        contains: async ({ permissions = [] }: { permissions?: string[] }) => {
          if (opts.rejectMeetingsContains && permissions.includes('tabCapture')) {
            throw new Error('permissions.contains failed');
          }
          return permissions.every((p) => held.has(p));
        },
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
      if (opts.signedOut || opts.expireMe) {
        expect(
          findButtonsByText(root, VIETNAMESE.signIn).length + findButtonsByText(root, VIETNAMESE.save).length,
        ).toBeGreaterThan(0);
      } else if (opts.rejectMe) {
        expect(findAlerts(root).map((a) => a.textContentValue())).toContain(VIETNAMESE.loadFailed);
      } else if (opts.hangMe) {
        expect(findButtonsByText(root, VIETNAMESE.stop).length > 0 || idMap.has('lost')).toBe(true);
      } else {
        expect(idMap.has('notes-capture')).toBe(true);
      }
    });

    return {
      root,
      held,
      clipCalls,
      sentMessages,
      extensionStatusCalls,
      storageData,
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

  it('fails closed in meetingsView when chrome.permissions.contains rejects (#4725)', async () => {
    const failedContains = await mountPopup({
      initialPermissions: ['offscreen', 'tabCapture', 'activeTab'],
      initialEnabled: { meetings: true },
      rejectMeetingsContains: true,
    });
    try {
      await waitForUi(() => {
        expect(failedContains.buttonsNamed(VIETNAMESE.meetingsOn)).toHaveLength(1);
      });
      expect(failedContains.getById('clipper-toggle')).toBeDefined();
    } finally {
      await failedContains.cleanup();
    }
  });

  it('keeps active recording and Stop control visible and distinguishes uploadFailed vs recordingIdle (#4725)', async () => {
    const activeRecordingPopup = await mountPopup({
      initialPermissions: ['offscreen', 'tabCapture', 'activeTab'],
      initialEnabled: { meetings: true },
      rejectMeetingsContains: true,
      stopReply: { ok: true, uploaded: false, meetingId: 'mtg-1' },
      initialRecording: {
        meetingId: 'mtg-1',
        title: 'Cuộc họp đang ghi',
        startedAt: Date.now() - 5_000,
        keepVideo: false,
        micMissing: false,
        orgId: 'org1',
        address: 'https://ludy.example',
        tokenId: 'tok-1',
      },
    });
    try {
      await waitForUi(() => {
        expect(activeRecordingPopup.buttonsNamed(VIETNAMESE.stop)).toHaveLength(1);
      });
      expect(activeRecordingPopup.root.textContentValue()).toContain('Cuộc họp đang ghi');
      expect(activeRecordingPopup.buttonsNamed(VIETNAMESE.meetingsOn)).toHaveLength(0);

      activeRecordingPopup.buttonsNamed(VIETNAMESE.stop)[0]!.click();
      await waitForUi(() => {
        expect(activeRecordingPopup.buttonsNamed(VIETNAMESE.stop)).toHaveLength(0);
        expect(activeRecordingPopup.buttonsNamed(VIETNAMESE.meetingsOn)).toHaveLength(1);
      });
      expect(activeRecordingPopup.sentMessages).toContainEqual({ type: 'stop' });
      expect(activeRecordingPopup.alerts()).toContain(VIETNAMESE.uploadFailed);
    } finally {
      await activeRecordingPopup.cleanup();
    }

    const idleStopPopup = await mountPopup({
      initialPermissions: ['offscreen', 'tabCapture', 'activeTab'],
      initialEnabled: { meetings: true },
      rejectMeetingsContains: true,
      stopReply: { ok: false, reason: 'idle' },
      initialRecording: {
        meetingId: 'mtg-idle-1',
        title: 'Cuộc họp cũ',
        startedAt: Date.now() - 5_000,
        keepVideo: false,
        micMissing: false,
        orgId: 'org1',
        address: 'https://ludy.example',
      },
    });
    try {
      await waitForUi(() => {
        expect(idleStopPopup.buttonsNamed(VIETNAMESE.stop)).toHaveLength(1);
      });
      idleStopPopup.buttonsNamed(VIETNAMESE.stop)[0]!.click();
      await waitForUi(() => {
        expect(idleStopPopup.buttonsNamed(VIETNAMESE.stop)).toHaveLength(0);
        expect(idleStopPopup.alerts()).toContain(VIETNAMESE.recordingIdle);
      });
      expect(idleStopPopup.alerts()).not.toContain(VIETNAMESE.uploadFailed);
    } finally {
      await idleStopPopup.cleanup();
    }
  });

  it('masks cross-org recording title and mic status while keeping Stop visible (#4725)', async () => {
    const crossOrgPopup = await mountPopup({
      initialPermissions: ['offscreen', 'tabCapture', 'activeTab'],
      initialEnabled: { meetings: true },
      rejectMeetingsContains: true,
      initialRecording: {
        meetingId: 'mtg-other-org',
        title: 'Cuộc họp mật của tổ chức khác',
        startedAt: Date.now() - 5_000,
        keepVideo: false,
        micMissing: true,
        orgId: 'org-other',
        address: 'https://ludy.example',
      },
    });
    try {
      await waitForUi(() => {
        expect(crossOrgPopup.buttonsNamed(VIETNAMESE.stop)).toHaveLength(1);
      });
      const renderedText = crossOrgPopup.root.textContentValue();
      expect(renderedText).toContain(VIETNAMESE.recordingOtherOrg);
      expect(renderedText).not.toContain('Cuộc họp mật của tổ chức khác');
      expect(renderedText).not.toContain(VIETNAMESE.micMissing);
    } finally {
      await crossOrgPopup.cleanup();
    }
  });

  it('keeps active recording and reports stopFailed when sendMessage stop rejects (#4725)', async () => {
    const failedStopPopup = await mountPopup({
      initialPermissions: ['offscreen', 'tabCapture', 'activeTab'],
      initialEnabled: { meetings: true },
      rejectStopMessage: true,
      initialRecording: {
        meetingId: 'mtg-reject-1',
        title: 'Cuộc họp giữ nguyên nút dừng',
        startedAt: Date.now() - 5_000,
        keepVideo: false,
        micMissing: false,
        orgId: 'org1',
        address: 'https://ludy.example',
      },
    });
    try {
      await waitForUi(() => {
        expect(failedStopPopup.buttonsNamed(VIETNAMESE.stop)).toHaveLength(1);
      });
      failedStopPopup.buttonsNamed(VIETNAMESE.stop)[0]!.click();
      await waitForUi(() => {
        expect(failedStopPopup.alerts()).toContain(VIETNAMESE.stopFailed);
      });
      expect(failedStopPopup.alerts()).not.toContain(VIETNAMESE.uploadFailed);
      expect(failedStopPopup.buttonsNamed(VIETNAMESE.stop)).toHaveLength(1);
    } finally {
      await failedStopPopup.cleanup();
    }
  });

  it('shows active recording title only for matching tokenId and masks co-member token mismatch (#4725)', async () => {
    const ownPopup = await mountPopup({
      initialPermissions: ['offscreen', 'tabCapture', 'activeTab'],
      initialEnabled: { meetings: true },
      meTokenId: 'tok-1',
      initialRecording: {
        meetingId: 'mtg-own-tok',
        title: 'Cuộc họp của tôi',
        startedAt: Date.now() - 5_000,
        keepVideo: false,
        micMissing: true,
        orgId: 'org1',
        address: 'https://ludy.example',
        tokenId: 'tok-1',
      },
    });
    try {
      await waitForUi(() => {
        expect(ownPopup.buttonsNamed(VIETNAMESE.stop)).toHaveLength(1);
      });
      const text = ownPopup.root.textContentValue();
      expect(text).toContain('Cuộc họp của tôi');
      expect(text).toContain(VIETNAMESE.micMissing);
      expect(text).not.toContain(VIETNAMESE.recordingOtherOrg);
    } finally {
      await ownPopup.cleanup();
    }

    const coMemberPopup = await mountPopup({
      initialPermissions: ['offscreen', 'tabCapture', 'activeTab'],
      initialEnabled: { meetings: true },
      meTokenId: 'tok-1',
      initialRecording: {
        meetingId: 'mtg-comember-tok',
        title: 'Cuộc họp riêng đồng nghiệp',
        startedAt: Date.now() - 5_000,
        keepVideo: false,
        micMissing: true,
        orgId: 'org1',
        address: 'https://ludy.example',
        tokenId: 'tok-other',
      },
    });
    try {
      await waitForUi(() => {
        expect(coMemberPopup.buttonsNamed(VIETNAMESE.stop)).toHaveLength(1);
      });
      const text = coMemberPopup.root.textContentValue();
      expect(text).toContain(VIETNAMESE.recordingOtherOrg);
      expect(text).not.toContain('Cuộc họp riêng đồng nghiệp');
      expect(text).not.toContain(VIETNAMESE.micMissing);
    } finally {
      await coMemberPopup.cleanup();
    }
  });

  it('keeps active Stop, shows owner title with cached tokenId, masks co-member/signed-out, and lets legacy unscoped lost dismiss (#4725)', async () => {
    for (const mode of [
      { label: 'signedOut', opts: { signedOut: true }, tokenId: 'tok-1', expectedText: VIETNAMESE.recordingOtherOrg, showTitle: false },
      { label: 'rejectMeCachedOwner', opts: { rejectMe: true, accountTokenId: 'tok-1' }, tokenId: 'tok-1', expectedText: 'Cuộc họp nhạy cảm', showTitle: true },
      { label: 'rejectMeCachedCoMember', opts: { rejectMe: true, accountTokenId: 'tok-1' }, tokenId: 'tok-other', expectedText: VIETNAMESE.recordingOtherOrg, showTitle: false },
      { label: 'rejectMeUncached', opts: { rejectMe: true, accountTokenId: null }, tokenId: 'tok-1', expectedText: VIETNAMESE.recordingVerifying, showTitle: false },
      { label: 'notesOnly', opts: { meFeatures: { meetings: false, agenda: false, notes: true } }, tokenId: 'tok-1', expectedText: 'Cuộc họp nhạy cảm', showTitle: true },
    ]) {
      const recPopup = await mountPopup({
        ...mode.opts,
        initialRecording: {
          meetingId: `mtg-${mode.label}`,
          title: 'Cuộc họp nhạy cảm',
          startedAt: Date.now() - 5_000,
          keepVideo: false,
          micMissing: true,
          orgId: 'org1',
          address: 'https://ludy.example',
          tokenId: mode.tokenId,
        },
      });
      try {
        await waitForUi(() => {
          expect(recPopup.buttonsNamed(VIETNAMESE.stop)).toHaveLength(1);
        });
        const text = recPopup.root.textContentValue();
        expect(text).toContain(mode.expectedText);
        if (mode.showTitle) {
          expect(text).toContain('Cuộc họp nhạy cảm');
          expect(text).toContain(VIETNAMESE.micMissing);
        } else {
          expect(text).not.toContain('Cuộc họp nhạy cảm');
          expect(text).not.toContain(VIETNAMESE.micMissing);
        }
      } finally {
        await recPopup.cleanup();
      }
    }

    const lostSample: LostState = {
      meetingId: 'mtg-lost-1',
      title: 'Cuộc họp đã rớt',
      reason: 'tab_closed',
      at: Date.now() - 60_000,
      uploaded: true,
      orgId: 'org1',
      address: 'https://ludy.example',
      tokenId: 'tok-1',
    };
    const sameLostPopup = await mountPopup({
      meFeatures: { meetings: false, agenda: false, notes: true },
      initialLost: lostSample,
    });
    try {
      await waitForUi(() => {
        expect(sameLostPopup.getById('lost')).toBeDefined();
      });
      const text = sameLostPopup.root.textContentValue();
      expect(text).toContain('Cuộc họp đã rớt');
      expect(text).toContain(VIETNAMESE.lostReasons.tab_closed);
      expect(text).toContain(VIETNAMESE.lostUploaded);
      expect(text).not.toContain(VIETNAMESE.lostOtherOrg);
      expect(sameLostPopup.getById('lost-dismiss')).toBeDefined();
    } finally {
      await sameLostPopup.cleanup();
    }

    for (const maskedLostOpts of [
      { initialLost: { ...lostSample, tokenId: 'tok-other' } },
      { signedOut: true, initialLost: lostSample },
    ]) {
      const maskedLostPopup = await mountPopup(maskedLostOpts);
      try {
        await waitForUi(() => {
          expect(maskedLostPopup.getById('lost')).toBeDefined();
        });
        const text = maskedLostPopup.root.textContentValue();
        expect(text).toContain(VIETNAMESE.lostOtherOrg);
        expect(text).not.toContain('Cuộc họp đã rớt');
        expect(text).not.toContain(VIETNAMESE.lostReasons.tab_closed);
        expect(text).not.toContain(VIETNAMESE.lostUploaded);
        expect(maskedLostPopup.getById('lost-dismiss')).toBeUndefined();
      } finally {
        await maskedLostPopup.cleanup();
      }
    }

    const legacyUnownedLost: LostState = {
      meetingId: 'm-legacy-unowned',
      title: 'Bản rớt cũ bí mật',
      reason: 'tab_closed',
      at: Date.now() - 30_000,
      uploaded: false,
    };
    const legacyUnownedPopup = await mountPopup({ initialLost: legacyUnownedLost });
    try {
      await waitForUi(() => {
        expect(legacyUnownedPopup.getById('lost-dismiss')).toBeDefined();
      });
      const text = legacyUnownedPopup.root.textContentValue();
      expect(text).toContain(VIETNAMESE.lostOtherOrg);
      expect(text).not.toContain('Bản rớt cũ bí mật');
      expect(text).not.toContain(VIETNAMESE.lostReasons.tab_closed);
      legacyUnownedPopup.getById('lost-dismiss')!.click();
      await waitForUi(() => {
        expect(legacyUnownedPopup.getById('lost')).toBeUndefined();
      });
      expect(legacyUnownedPopup.storageData[LOST_KEY]).toBeUndefined();
    } finally {
      await legacyUnownedPopup.cleanup();
    }
  });

  it('treats { ok: false, reason: "error" } stop reply as stopFailed while keeping Stop intact, and preserves stop result when /me fails (#4725)', async () => {
    const errStopPopup = await mountPopup({
      initialPermissions: ['offscreen', 'tabCapture', 'activeTab'],
      initialEnabled: { meetings: true },
      stopReply: { ok: false, reason: 'error' },
      initialRecording: {
        meetingId: 'mtg-err-1',
        title: 'Cuộc họp lỗi kênh',
        startedAt: Date.now() - 5_000,
        keepVideo: false,
        micMissing: false,
        orgId: 'org1',
        address: 'https://ludy.example',
        tokenId: 'tok-1',
      },
    });
    try {
      await waitForUi(() => {
        expect(errStopPopup.buttonsNamed(VIETNAMESE.stop)).toHaveLength(1);
      });
      errStopPopup.buttonsNamed(VIETNAMESE.stop)[0]!.click();
      await waitForUi(() => {
        expect(errStopPopup.alerts()).toContain(VIETNAMESE.stopFailed);
      });
      expect(errStopPopup.buttonsNamed(VIETNAMESE.stop)).toHaveLength(1);
      expect(errStopPopup.storageData[RECORDING_KEY]).toBeDefined();
    } finally {
      await errStopPopup.cleanup();
    }

    const uploadedWithMeFailure = await mountPopup({
      rejectMe: true,
      stopReply: { ok: true, uploaded: true, meetingId: 'mtg-poc6' },
      initialRecording: {
        meetingId: 'mtg-poc6',
        title: 'Cuộc họp đã tải xong',
        startedAt: Date.now() - 5_000,
        keepVideo: false,
        micMissing: false,
        orgId: 'org1',
        address: 'https://ludy.example',
        tokenId: 'tok-1',
      },
    });
    try {
      await waitForUi(() => {
        expect(uploadedWithMeFailure.buttonsNamed(VIETNAMESE.stop)).toHaveLength(1);
      });
      uploadedWithMeFailure.buttonsNamed(VIETNAMESE.stop)[0]!.click();
      await waitForUi(() => {
        expect(uploadedWithMeFailure.alerts()).toContain(VIETNAMESE.uploaded);
        expect(uploadedWithMeFailure.buttonsNamed(VIETNAMESE.stop)).toHaveLength(0);
      });
      expect(uploadedWithMeFailure.alerts()).not.toContain(VIETNAMESE.loadFailed);
    } finally {
      await uploadedWithMeFailure.cleanup();
    }
  });

  it('filters pending IndexedDB recordings by scope and verifies legacy unscoped entries asynchronously without blocking UI (#4725)', async () => {
    const base = {
      kind: 'audio' as const,
      mimeType: 'audio/webm',
      startedAt: Date.now() - 120_000,
      elapsedMs: 45_000,
      chunkCount: 3,
      updatedAt: Date.now() - 60_000,
    };
    const pendingPopup = await mountPopup({
      meTokenId: 'tok-1',
      ownedLegacyMeetingIds: ['m-legacy-mine'],
      spoofedLegacyMeetingIds: ['m-legacy-spoofed'],
      pendingRecordings: [
        {
          ...base,
          id: 'rec-own',
          scope: 'org1',
          address: 'https://ludy.example',
          tokenId: 'tok-1',
          meetingId: 'm-own',
          title: 'Bản lưu chờ tải của tôi',
        },
        {
          ...base,
          id: 'rec-peer',
          scope: 'org1',
          address: 'https://ludy.example',
          tokenId: 'tok-other',
          meetingId: 'm-peer',
          title: 'Bản lưu bí mật của đồng nghiệp',
        },
        {
          ...base,
          id: 'rec-server',
          scope: 'org1',
          address: 'https://other.ludy.example',
          tokenId: 'tok-1',
          meetingId: 'm-server',
          title: 'Bản lưu máy chủ khác',
        },
        {
          ...base,
          id: 'rec-legacy-mine',
          scope: 'org1',
          meetingId: 'm-legacy-mine',
          title: 'Bản lưu cũ của tôi',
        },
        {
          ...base,
          id: 'rec-legacy-other',
          scope: 'org1',
          meetingId: 'm-legacy-other',
          title: 'Bản lưu cũ của người khác',
        },
        {
          ...base,
          id: 'rec-legacy-spoofed',
          scope: 'org1',
          meetingId: 'm-legacy-spoofed',
          title: 'Bản lưu cũ giả mạo 200',
        },
      ],
    });
    try {
      await waitForUi(() => {
        expect(pendingPopup.buttonsNamed(VIETNAMESE.retry)).toHaveLength(2);
      });
      const text = pendingPopup.root.textContentValue();
      expect(text).toContain('Bản lưu chờ tải của tôi');
      expect(text).toContain('Bản lưu cũ của tôi');
      expect(text).not.toContain('Bản lưu bí mật của đồng nghiệp');
      expect(text).not.toContain('Bản lưu máy chủ khác');
      expect(text).not.toContain('Bản lưu cũ của người khác');
      expect(text).not.toContain('Bản lưu cũ giả mạo 200');
      expect(pendingPopup.buttonsNamed(VIETNAMESE.discard)).toHaveLength(2);
      expect(pendingPopup.extensionStatusCalls.sort()).toEqual(['m-legacy-mine', 'm-legacy-other', 'm-legacy-spoofed']);
      expect(pendingPopup.storageData[pendingScopeKey('m-legacy-mine')]).toEqual({
        orgId: 'org1',
        address: 'https://ludy.example',
        tokenId: 'tok-1',
      });
      expect(pendingPopup.storageData[pendingScopeKey('m-legacy-other')]).toBeUndefined();
      expect(pendingPopup.storageData[pendingScopeKey('m-legacy-spoofed')]).toBeUndefined();
    } finally {
      await pendingPopup.cleanup();
    }

    const nonBlockingPendingPopup = await mountPopup({
      meTokenId: 'tok-1',
      hangLegacyMeetingIds: ['m-legacy-hang'],
      pendingRecordings: [
        {
          ...base,
          id: 'rec-own-fast',
          scope: 'org1',
          address: 'https://ludy.example',
          tokenId: 'tok-1',
          meetingId: 'm-own-fast',
          title: 'Bản lưu sẵn sàng tức thì',
        },
        {
          ...base,
          id: 'rec-legacy-hang',
          scope: 'org1',
          meetingId: 'm-legacy-hang',
          title: 'Bản lưu cũ đang treo mạng',
        },
      ],
    });
    try {
      await waitForUi(() => {
        expect(nonBlockingPendingPopup.buttonsNamed(VIETNAMESE.retry)).toHaveLength(1);
        expect(nonBlockingPendingPopup.getById('capture-save')).toBeDefined();
      });
      const fastText = nonBlockingPendingPopup.root.textContentValue();
      expect(fastText).toContain('Bản lưu sẵn sàng tức thì');
      expect(fastText).not.toContain('Bản lưu cũ đang treo mạng');
    } finally {
      await nonBlockingPendingPopup.cleanup();
    }

    const legacyLostSample: LostState = {
      meetingId: 'm-legacy-lost-mine',
      title: 'Phiên tự dừng trước nâng cấp',
      reason: 'tab_closed',
      at: Date.now() - 30_000,
      uploaded: true,
    };
    const recoveredLostPopup = await mountPopup({
      ownedLegacyMeetingIds: ['m-legacy-lost-mine'],
      initialLost: legacyLostSample,
    });
    try {
      await waitForUi(() => {
        expect(recoveredLostPopup.getById('lost-dismiss')).toBeDefined();
      });
      expect(recoveredLostPopup.root.textContentValue()).toContain('Phiên tự dừng trước nâng cấp');
      expect(recoveredLostPopup.storageData[LOST_KEY]).toMatchObject({
        meetingId: 'm-legacy-lost-mine',
        orgId: 'org1',
        address: 'https://ludy.example',
        tokenId: 'tok-1',
      });
    } finally {
      await recoveredLostPopup.cleanup();
    }
  });

  it('shows owner title from cached tokenId, masks co-member/uncached, and sends stop immediately while /api/extension/me is hanging (#4725)', async () => {
    const cachedOwnerHanging = await mountPopup({
      hangMe: true,
      accountTokenId: 'tok-1',
      stopReply: { ok: true, uploaded: true, meetingId: 'mtg-hang-1' },
      initialRecording: {
        meetingId: 'mtg-hang-1',
        title: 'Cuộc họp đang chờ máy chủ',
        startedAt: Date.now() - 5_000,
        keepVideo: false,
        micMissing: true,
        orgId: 'org1',
        address: 'https://ludy.example',
        tokenId: 'tok-1',
      },
    });
    try {
      await waitForUi(() => {
        expect(cachedOwnerHanging.buttonsNamed(VIETNAMESE.stop)).toHaveLength(1);
      });
      const text = cachedOwnerHanging.root.textContentValue();
      expect(text).toContain('Cuộc họp đang chờ máy chủ');
      expect(text).toContain(VIETNAMESE.micMissing);

      cachedOwnerHanging.buttonsNamed(VIETNAMESE.stop)[0]!.click();
      await waitForUi(() => {
        expect(cachedOwnerHanging.sentMessages).toContainEqual({ type: 'stop' });
        expect(cachedOwnerHanging.alerts()).toContain(VIETNAMESE.uploaded);
        expect(cachedOwnerHanging.buttonsNamed(VIETNAMESE.stop)).toHaveLength(0);
      });
    } finally {
      await cachedOwnerHanging.cleanup();
    }

    const coMemberHanging = await mountPopup({
      hangMe: true,
      accountTokenId: 'tok-1',
      initialRecording: {
        meetingId: 'mtg-hang-peer',
        title: 'Cuộc họp đồng nghiệp đang chờ',
        startedAt: Date.now() - 5_000,
        keepVideo: false,
        micMissing: true,
        orgId: 'org1',
        address: 'https://ludy.example',
        tokenId: 'tok-other',
      },
    });
    try {
      await waitForUi(() => {
        expect(coMemberHanging.buttonsNamed(VIETNAMESE.stop)).toHaveLength(1);
      });
      const text = coMemberHanging.root.textContentValue();
      expect(text).toContain(VIETNAMESE.recordingOtherOrg);
      expect(text).not.toContain('Cuộc họp đồng nghiệp đang chờ');
    } finally {
      await coMemberHanging.cleanup();
    }

    const uncachedHanging = await mountPopup({
      hangMe: true,
      accountTokenId: null,
      initialRecording: {
        meetingId: 'mtg-hang-uncached',
        title: 'Cuộc họp chưa lưu tokenId',
        startedAt: Date.now() - 5_000,
        keepVideo: false,
        micMissing: true,
        orgId: 'org1',
        address: 'https://ludy.example',
        tokenId: 'tok-1',
      },
    });
    try {
      await waitForUi(() => {
        expect(uncachedHanging.buttonsNamed(VIETNAMESE.stop)).toHaveLength(1);
      });
      const text = uncachedHanging.root.textContentValue();
      expect(text).toContain(VIETNAMESE.recordingVerifying);
      expect(text).not.toContain('Cuộc họp chưa lưu tokenId');
    } finally {
      await uncachedHanging.cleanup();
    }
  });

  async function runBackgroundStop(opts: {
    sendMessage: () => Promise<unknown>;
    failRemove?: boolean;
    failSetTitle?: boolean;
    hasOffscreenApi?: boolean;
    contexts?: unknown[];
    concurrentStops?: number;
  }): Promise<{
    reply: unknown;
    extraReplies: unknown[];
    storageData: Record<string, unknown>;
    closedOffscreenCount: number;
    badgeCleared: boolean;
  }> {
    vi.resetModules();
    const storageData: Record<string, unknown> = {
      [RECORDING_KEY]: {
        meetingId: 'mtg-bg-1',
        title: 'Cuộc họp đang ghi',
        startedAt: Date.now() - 3_000,
        keepVideo: false,
        micMissing: false,
      },
      [pendingScopeKey('mtg-bg-1')]: {
        orgId: 'org1',
        address: 'https://ludy.example',
        tokenId: 'tok-1',
      },
    };
    const listeners: Array<(raw: unknown, sender: unknown, respond: (res: unknown) => void) => boolean | undefined> = [];
    let closedOffscreenCount = 0;
    let badgeCleared = false;
    vi.stubGlobal('navigator', { language: 'vi-VN' });
    vi.stubGlobal('chrome', {
      i18n: { getUILanguage: () => 'vi' },
      runtime: {
        id: 'test-ext-id',
        sendMessage: opts.sendMessage,
        ...(opts.contexts !== undefined ? { getContexts: async () => opts.contexts } : {}),
        onMessage: {
          addListener: (fn: (raw: unknown, sender: unknown, respond: (res: unknown) => void) => boolean | undefined) => {
            listeners.push(fn);
          },
        },
      },
      storage: {
        local: {
          get: async (keys: string | string[]) => {
            const list = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(list.filter((k) => k in storageData).map((k) => [k, storageData[k]]));
          },
          set: async (items: Record<string, unknown>) => {
            Object.assign(storageData, items);
          },
          remove: async (key: string) => {
            if (opts.failRemove) throw new Error('storage remove failed');
            delete storageData[key];
          },
        },
      },
      action: {
        setBadgeText: async (details: { text: string }) => {
          if (details.text === '') badgeCleared = true;
        },
        setBadgeBackgroundColor: async () => undefined,
        setTitle: async () => {
          if (opts.failSetTitle) throw new Error('action setTitle failed');
        },
      },
      offscreen: opts.hasOffscreenApi
        ? {
            closeDocument: async () => {
              closedOffscreenCount += 1;
            },
          }
        : undefined,
    });
    try {
      await import('../src/background.ts');
      expect(listeners).toHaveLength(1);
      const sendStop = () =>
        new Promise<unknown>((resolve) => {
          const asyncReply = listeners[0]!({ type: 'stop' }, { id: 'test-ext-id' }, resolve);
          expect(asyncReply).toBe(true);
        });
      const count = opts.concurrentStops ?? 1;
      const [reply, ...extraReplies] = await Promise.all(Array.from({ length: count }, sendStop));
      return { reply, extraReplies, storageData, closedOffscreenCount, badgeCleared };
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it('keeps RECORDING_KEY and open offscreen intact on transport failure, deduplicates concurrent stops, and cleans up per-recording scope (#4725)', async () => {
    const liveTransportFailure = await runBackgroundStop({
      hasOffscreenApi: true,
      contexts: [{ documentUrl: 'chrome-extension://test-ext-id/offscreen.html' }],
      sendMessage: async () => {
        throw new Error('transient port error');
      },
    });
    expect(liveTransportFailure.reply).toEqual({ ok: false, reason: 'error' });
    expect(liveTransportFailure.storageData[RECORDING_KEY]).toBeDefined();
    expect(liveTransportFailure.closedOffscreenCount).toBe(0);
    expect(liveTransportFailure.badgeCleared).toBe(false);

    const offscreenErrorReply = await runBackgroundStop({
      hasOffscreenApi: true,
      contexts: [{ documentUrl: 'chrome-extension://test-ext-id/offscreen.html' }],
      sendMessage: async () => ({ ok: false, reason: 'error' }),
    });
    expect(offscreenErrorReply.reply).toEqual({ ok: false, reason: 'error' });
    expect(offscreenErrorReply.storageData[RECORDING_KEY]).toBeDefined();
    expect(offscreenErrorReply.closedOffscreenCount).toBe(0);

    let captureStopCalls = 0;
    const concurrentStops = await runBackgroundStop({
      hasOffscreenApi: true,
      contexts: [{ documentUrl: 'chrome-extension://test-ext-id/offscreen.html' }],
      concurrentStops: 2,
      sendMessage: async () => {
        captureStopCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return { ok: true, uploaded: true, meetingId: 'mtg-bg-1' };
      },
    });
    expect(captureStopCalls).toBe(1);
    expect(concurrentStops.reply).toEqual({ ok: true, uploaded: true, meetingId: 'mtg-bg-1' });
    expect(concurrentStops.extraReplies).toEqual([{ ok: true, uploaded: true, meetingId: 'mtg-bg-1' }]);

    const noOffscreenApi = await runBackgroundStop({
      hasOffscreenApi: false,
      sendMessage: async () => {
        throw new Error('offscreen missing');
      },
    });
    expect(noOffscreenApi.reply).toEqual({ ok: false, reason: 'idle' });
    expect(noOffscreenApi.storageData[RECORDING_KEY]).toBeUndefined();

    const closedOffscreen = await runBackgroundStop({
      hasOffscreenApi: true,
      contexts: [],
      sendMessage: async () => {
        throw new Error('Receiving end does not exist');
      },
    });
    expect(closedOffscreen.reply).toEqual({ ok: false, reason: 'idle' });
    expect(closedOffscreen.storageData[RECORDING_KEY]).toBeUndefined();

    const okWithCleanupFailure = await runBackgroundStop({
      hasOffscreenApi: true,
      sendMessage: async () => ({ ok: true, uploaded: true, meetingId: 'mtg-bg-1' }),
      failRemove: true,
      failSetTitle: true,
    });
    expect(okWithCleanupFailure.reply).toEqual({ ok: true, uploaded: true, meetingId: 'mtg-bg-1' });
    expect(okWithCleanupFailure.storageData[pendingScopeKey('mtg-bg-1')]).toBeDefined();

    const okCleanedScope = await runBackgroundStop({
      hasOffscreenApi: true,
      sendMessage: async () => ({ ok: true, uploaded: true, meetingId: 'mtg-bg-1' }),
    });
    expect(okCleanedScope.reply).toEqual({ ok: true, uploaded: true, meetingId: 'mtg-bg-1' });
    expect(okCleanedScope.storageData[RECORDING_KEY]).toBeUndefined();
    expect(okCleanedScope.storageData[pendingScopeKey('mtg-bg-1')]).toBeUndefined();

    const keptPendingScope = await runBackgroundStop({
      hasOffscreenApi: true,
      sendMessage: async () => ({ ok: true, uploaded: false, meetingId: 'mtg-bg-1' }),
    });
    expect(keptPendingScope.reply).toEqual({ ok: true, uploaded: false, meetingId: 'mtg-bg-1' });
    expect(keptPendingScope.storageData[pendingScopeKey('mtg-bg-1')]).toEqual({
      orgId: 'org1',
      address: 'https://ludy.example',
      tokenId: 'tok-1',
    });

    const idleWithCleanupFailure = await runBackgroundStop({
      hasOffscreenApi: true,
      sendMessage: async () => ({ ok: false, reason: 'idle' }),
      failRemove: true,
    });
    expect(idleWithCleanupFailure.reply).toEqual({ ok: false, reason: 'error' });
  });

  it('replies error and retains active capture in offscreen.ts when running.stop() rejects so retry succeeds (#4725)', async () => {
    vi.resetModules();
    let stopCalls = 0;
    const listeners: Array<(raw: unknown, sender: unknown, respond: (res: unknown) => void) => boolean | undefined> = [];
    vi.doMock('../src/capture-run.ts', () => ({
      startCapture: async () => ({
        ok: true,
        running: {
          meetingId: 'mtg-off-1',
          startedAt: 1_700_000_000_000,
          micMissing: false,
          elapsedMs: () => 5_000,
          onLost: () => undefined,
          stop: async () => {
            stopCalls += 1;
            if (stopCalls === 1) throw new Error('IndexedDB markStopped failed');
            return { uploaded: true, meetingId: 'mtg-off-1' };
          },
        },
      }),
    }));
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test-ext-id',
        sendMessage: async () => undefined,
        onMessage: {
          addListener: (fn: (raw: unknown, sender: unknown, respond: (res: unknown) => void) => boolean | undefined) => {
            listeners.push(fn);
          },
        },
      },
    });
    try {
      await import('../src/offscreen.ts');
      expect(listeners).toHaveLength(1);
      const sendOffscreen = (msg: unknown) =>
        new Promise<unknown>((resolve) => {
          const handled = listeners[0]!(msg, { id: 'test-ext-id' }, resolve);
          expect(handled).toBe(true);
        });
      const started = await sendOffscreen({
        target: 'offscreen',
        type: 'capture-start',
        address: 'https://ludy.example',
        token: 'crx_test',
        orgId: 'org1',
        uploads: 'direct',
        title: 'Họp thử offscreen',
        consentMethod: 'told_at_start',
        consentAgreed: true,
        keepVideo: false,
        liveNotes: false,
        streamId: 'stream-1',
      });
      expect(started).toMatchObject({ ok: true, meetingId: 'mtg-off-1' });

      const firstStop = await sendOffscreen({ target: 'offscreen', type: 'capture-stop' });
      expect(firstStop).toEqual({ ok: false, reason: 'error' });

      const retryStop = await sendOffscreen({ target: 'offscreen', type: 'capture-stop' });
      expect(retryStop).toEqual({ ok: true, uploaded: true, meetingId: 'mtg-off-1' });
    } finally {
      vi.doUnmock('../src/capture-run.ts');
      vi.unstubAllGlobals();
    }
  });

  it('refuses background start without verified owner tokenId and persists per-recording scope when verified (#4725)', async () => {
    const runStart = async (meOk: boolean) => {
      vi.resetModules();
      const storageData: Record<string, unknown> = {
        'ludy-extension-state': {
          address: 'https://ludy.example',
          accounts: {
            org1: { orgId: 'org1', orgSlug: 'cong-ty', token: 'crx_test', expiresAt: '2027-01-01T00:00:00Z' },
          },
          activeOrg: 'org1',
          enabled: { meetings: true },
        },
      };
      const listeners: Array<(raw: unknown, sender: unknown, respond: (res: unknown) => void) => boolean | undefined> = [];
      let createdOffscreen = 0;
      vi.stubGlobal('navigator', { language: 'vi-VN' });
      vi.stubGlobal('fetch', async (url: string) => {
        if (url.endsWith('/api/config')) return new Response(JSON.stringify({ uploads: 'direct' }), { status: 200 });
        if (url.endsWith('/api/extension/me')) {
          if (!meOk) return new Response('{}', { status: 500 });
          return new Response(
            JSON.stringify({
              tokenId: 'tok-bg',
              orgId: 'org1',
              scopes: ['meetings'],
              expiresAt: '2027-01-01T00:00:00Z',
              features: { meetings: true },
            }),
            { status: 200 },
          );
        }
        return new Response('{}', { status: 404 });
      });
      vi.stubGlobal('chrome', {
        i18n: { getUILanguage: () => 'vi' },
        permissions: { contains: async () => true },
        runtime: {
          id: 'test-ext-id',
          getContexts: async () => [],
          sendMessage: async () => ({ ok: true, meetingId: 'mtg-start-1', startedAt: 1_700_000_000_000, micMissing: false }),
          onMessage: {
            addListener: (fn: (raw: unknown, sender: unknown, respond: (res: unknown) => void) => boolean | undefined) => {
              listeners.push(fn);
            },
          },
        },
        offscreen: {
          createDocument: async () => {
            createdOffscreen += 1;
          },
          closeDocument: async () => undefined,
        },
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
        action: {
          setBadgeText: async () => undefined,
          setBadgeBackgroundColor: async () => undefined,
          setTitle: async () => undefined,
        },
      });
      try {
        await import('../src/background.ts');
        const reply = await new Promise<unknown>((resolve) => {
          const asyncReply = listeners[0]!(
            {
              type: 'start',
              title: 'Họp có kiểm tra chủ',
              consentMethod: 'told_at_start',
              consentAgreed: true,
              keepVideo: false,
              liveNotes: false,
              streamId: 'stream-1',
            },
            { id: 'test-ext-id' },
            resolve,
          );
          expect(asyncReply).toBe(true);
        });
        return { reply, storageData, createdOffscreen };
      } finally {
        vi.unstubAllGlobals();
      }
    };

    const refused = await runStart(false);
    expect(refused.reply).toEqual({ ok: false, reason: 'setup' });
    expect(refused.createdOffscreen).toBe(0);
    expect(refused.storageData[RECORDING_KEY]).toBeUndefined();

    const started = await runStart(true);
    expect(started.reply).toMatchObject({ ok: true, meetingId: 'mtg-start-1' });
    expect(started.createdOffscreen).toBe(1);
    expect(started.storageData[RECORDING_KEY]).toMatchObject({
      meetingId: 'mtg-start-1',
      orgId: 'org1',
      address: 'https://ludy.example',
      tokenId: 'tok-bg',
    });
    expect(started.storageData[pendingScopeKey('mtg-start-1')]).toEqual({
      orgId: 'org1',
      address: 'https://ludy.example',
      tokenId: 'tok-bg',
    });
  });

  it('reconciles stale RECORDING_KEY after a confirmed stop if storage remove failed once without re-uploading (#4725)', async () => {
    vi.resetModules();
    const storageData: Record<string, unknown> = {
      [RECORDING_KEY]: {
        meetingId: 'mtg-reconcile-1',
        title: 'Cuộc họp đã dừng nhưng khóa cũ kẹt',
        startedAt: Date.now() - 4_000,
        keepVideo: false,
        micMissing: false,
      },
    };
    const listeners: Array<(raw: unknown, sender: unknown, respond: (res: unknown) => void) => boolean | undefined> = [];
    let captureStopCalls = 0;
    let removeFailuresLeft = 2;
    vi.stubGlobal('navigator', { language: 'vi-VN' });
    vi.stubGlobal('chrome', {
      i18n: { getUILanguage: () => 'vi' },
      runtime: {
        id: 'test-ext-id',
        getContexts: async () => [{ documentUrl: 'chrome-extension://test-ext-id/offscreen.html' }],
        sendMessage: async () => {
          captureStopCalls += 1;
          return { ok: true, uploaded: true, meetingId: 'mtg-reconcile-1' };
        },
        onMessage: {
          addListener: (fn: (raw: unknown, sender: unknown, respond: (res: unknown) => void) => boolean | undefined) => {
            listeners.push(fn);
          },
        },
      },
      storage: {
        local: {
          get: async (key: string) => (key in storageData ? { [key]: storageData[key] } : {}),
          set: async (items: Record<string, unknown>) => {
            Object.assign(storageData, items);
          },
          remove: async (key: string) => {
            if (key === RECORDING_KEY && removeFailuresLeft > 0) {
              removeFailuresLeft -= 1;
              throw new Error('transient storage error');
            }
            delete storageData[key];
          },
        },
      },
      action: { setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined, setTitle: async () => undefined },
      offscreen: { closeDocument: async () => undefined },
    });
    try {
      await import('../src/background.ts');
      const sendStop = () =>
        new Promise<unknown>((resolve) => {
          listeners[0]!({ type: 'stop' }, { id: 'test-ext-id' }, resolve);
        });
      const firstReply = await sendStop();
      expect(firstReply).toEqual({ ok: true, uploaded: true, meetingId: 'mtg-reconcile-1' });
      expect(captureStopCalls).toBe(1);
      expect(storageData[RECORDING_KEY]).toBeDefined();

      const secondReply = await sendStop();
      expect(secondReply).toEqual({ ok: false, reason: 'idle' });
      expect(captureStopCalls).toBe(1);
      expect(storageData[RECORDING_KEY]).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects malformed or incomplete 2xx extensionStatus responses as unknown (#4725)', async () => {
    const { createClient } = await import('../src/api.ts');
    const makeClient = (status: number, body: unknown) =>
      createClient('https://ludy.example', 'crx_test', async () => new Response(JSON.stringify(body), { status }));
    expect(await makeClient(200, { html: true }).extensionMeetingOwned('m1')).toBe('unknown');
    expect(await makeClient(200, { json: { meetingId: 'm1', status: 'ready' } }).extensionMeetingOwned('m1')).toBe('unknown');
    expect(await makeClient(200, { json: { meetingId: 'm2', status: 'ready', keepVideo: false, liveNotes: false, hasAudio: false, hasVideo: false } }).extensionMeetingOwned('m1')).toBe('unknown');
    expect(await makeClient(200, { json: { meetingId: 'm1', status: 'ready', keepVideo: false, liveNotes: false, hasAudio: false, hasVideo: false } }).extensionMeetingOwned('m1')).toBe('owned');
    expect(await makeClient(404, { code: 'NOT_FOUND' }).extensionMeetingOwned('m1')).toBe('not_owned');
  });

  it('clears stale RECORDING_KEY on start when getContexts is unavailable and no offscreen capture is active (#4725)', async () => {
    vi.resetModules();
    const storageData: Record<string, unknown> = {
      'ludy-extension-state': {
        address: 'https://ludy.example',
        accounts: {
          org1: { orgId: 'org1', orgSlug: 'cong-ty', token: 'crx_test', expiresAt: '2027-01-01T00:00:00Z' },
        },
        activeOrg: 'org1',
        enabled: { meetings: true },
      },
      [RECORDING_KEY]: {
        meetingId: 'mtg-stale-nogetcontexts',
        title: 'Bản ghi cũ khi mất getContexts',
        startedAt: Date.now() - 10_000,
        keepVideo: false,
        micMissing: false,
      },
    };
    const listeners: Array<(raw: unknown, sender: unknown, respond: (res: unknown) => void) => boolean | undefined> = [];
    let createdOffscreen = 0;
    vi.stubGlobal('navigator', { language: 'vi-VN' });
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/api/config')) return new Response(JSON.stringify({ uploads: 'direct' }), { status: 200 });
      if (url.endsWith('/api/extension/me')) {
        return new Response(
          JSON.stringify({
            tokenId: 'tok-bg',
            orgId: 'org1',
            scopes: ['meetings'],
            expiresAt: '2027-01-01T00:00:00Z',
            features: { meetings: true },
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('chrome', {
      i18n: { getUILanguage: () => 'vi' },
      permissions: { contains: async () => true },
      runtime: {
        id: 'test-ext-id',
        sendMessage: async (msg: { type?: string }) => {
          if (msg.type === 'capture-status') throw new Error('Receiving end does not exist');
          return { ok: true, meetingId: 'mtg-fresh-1', startedAt: 1_700_000_000_000, micMissing: false };
        },
        onMessage: {
          addListener: (fn: (raw: unknown, sender: unknown, respond: (res: unknown) => void) => boolean | undefined) => {
            listeners.push(fn);
          },
        },
      },
      offscreen: {
        createDocument: async () => {
          createdOffscreen += 1;
        },
        closeDocument: async () => undefined,
      },
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
      action: { setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined, setTitle: async () => undefined },
    });
    try {
      await import('../src/background.ts');
      const reply = await new Promise<unknown>((resolve) => {
        listeners[0]!(
          {
            type: 'start',
            title: 'Họp mới sau bản cũ',
            consentMethod: 'told_at_start',
            consentAgreed: true,
            keepVideo: false,
            liveNotes: false,
            streamId: 'stream-2',
          },
          { id: 'test-ext-id' },
          resolve,
        );
      });
      expect(reply).toMatchObject({ ok: true, meetingId: 'mtg-fresh-1' });
      expect(createdOffscreen).toBe(1);
      expect(storageData[RECORDING_KEY]).toMatchObject({ meetingId: 'mtg-fresh-1', tokenId: 'tok-bg' });
      expect((storageData['ludy-extension-state'] as { accounts: { org1: { tokenId?: string } } }).accounts.org1.tokenId).toBe('tok-bg');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('verifies and upgrades pending recordings whose pendingScopeKey lacks tokenId (#4725)', async () => {
    const popup = await mountPopup({
      meTokenId: 'tok-1',
      ownedLegacyMeetingIds: ['m-no-token-mine'],
      pendingRecordings: [
        {
          id: 'rec-no-token-mine',
          scope: 'org1',
          address: 'https://ludy.example',
          meetingId: 'm-no-token-mine',
          title: 'Bản lưu cũ có scope thiếu tokenId',
          kind: 'audio',
          mimeType: 'audio/webm',
          startedAt: Date.now() - 90_000,
          elapsedMs: 30_000,
          chunkCount: 2,
          updatedAt: Date.now() - 45_000,
        },
        {
          id: 'rec-no-token-other',
          scope: 'org1',
          address: 'https://ludy.example',
          meetingId: 'm-no-token-other',
          title: 'Bản lưu thiếu tokenId của người khác',
          kind: 'audio',
          mimeType: 'audio/webm',
          startedAt: Date.now() - 80_000,
          elapsedMs: 25_000,
          chunkCount: 2,
          updatedAt: Date.now() - 40_000,
        },
      ],
    });
    try {
      await waitForUi(() => {
        expect(popup.buttonsNamed(VIETNAMESE.retry)).toHaveLength(1);
      });
      const text = popup.root.textContentValue();
      expect(text).toContain('Bản lưu cũ có scope thiếu tokenId');
      expect(text).not.toContain('Bản lưu thiếu tokenId của người khác');
      expect(popup.storageData[pendingScopeKey('m-no-token-mine')]).toEqual({
        orgId: 'org1',
        address: 'https://ludy.example',
        tokenId: 'tok-1',
      });
    } finally {
      await popup.cleanup();
    }
  });

  it('hides recording title immediately on 401 /me and keeps busy on unknown getContexts transient error (#4725)', async () => {
    const expiredPopup = await mountPopup({
      expireMe: true,
      accountTokenId: 'tok-1',
      initialRecording: {
        meetingId: 'mtg-401-1',
        title: 'Cuộc họp bí mật khi hết hạn',
        startedAt: Date.now() - 5_000,
        keepVideo: false,
        micMissing: true,
        orgId: 'org1',
        address: 'https://ludy.example',
        tokenId: 'tok-1',
      },
    });
    try {
      await waitForUi(() => {
        expect(expiredPopup.buttonsNamed(VIETNAMESE.signIn)).toHaveLength(1);
      });
      const text = expiredPopup.root.textContentValue();
      expect(text).toContain(VIETNAMESE.recordingOtherOrg);
      expect(text).not.toContain('Cuộc họp bí mật khi hết hạn');
      expect(text).not.toContain(VIETNAMESE.micMissing);
    } finally {
      await expiredPopup.cleanup();
    }

    vi.resetModules();
    const storageData: Record<string, unknown> = {
      'ludy-extension-state': {
        address: 'https://ludy.example',
        accounts: {
          org1: { orgId: 'org1', orgSlug: 'cong-ty', token: 'crx_test', expiresAt: '2027-01-01T00:00:00Z' },
        },
        activeOrg: 'org1',
        enabled: { meetings: true },
      },
      [RECORDING_KEY]: {
        meetingId: 'mtg-live-unknown',
        title: 'Cuộc họp đang thu thật',
        startedAt: Date.now() - 5_000,
        keepVideo: false,
        micMissing: false,
      },
    };
    const listeners: Array<(raw: unknown, sender: unknown, respond: (res: unknown) => void) => boolean | undefined> = [];
    vi.stubGlobal('navigator', { language: 'vi-VN' });
    vi.stubGlobal('chrome', {
      i18n: { getUILanguage: () => 'vi' },
      permissions: { contains: async () => true },
      runtime: {
        id: 'test-ext-id',
        sendMessage: async () => {
          throw new Error('transient port hiccup');
        },
        onMessage: {
          addListener: (fn: (raw: unknown, sender: unknown, respond: (res: unknown) => void) => boolean | undefined) => {
            listeners.push(fn);
          },
        },
      },
      offscreen: { createDocument: async () => undefined, closeDocument: async () => undefined },
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
      action: { setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined, setTitle: async () => undefined },
    });
    try {
      await import('../src/background.ts');
      const reply = await new Promise<unknown>((resolve) => {
        listeners[0]!(
          {
            type: 'start',
            title: 'Họp mới bị chặn an toàn',
            consentMethod: 'told_at_start',
            consentAgreed: true,
            keepVideo: false,
            liveNotes: false,
            streamId: 'stream-busy',
          },
          { id: 'test-ext-id' },
          resolve,
        );
      });
      expect(reply).toEqual({ ok: false, reason: 'busy' });
      expect(storageData[RECORDING_KEY]).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends capture-stop on runStop even when storage.local.get fails (#4725)', async () => {
    vi.resetModules();
    const listeners: Array<(raw: unknown, sender: unknown, respond: (res: unknown) => void) => boolean | undefined> = [];
    let captureStopCalls = 0;
    vi.stubGlobal('navigator', { language: 'vi-VN' });
    vi.stubGlobal('chrome', {
      i18n: { getUILanguage: () => 'vi' },
      runtime: {
        id: 'test-ext-id',
        sendMessage: async () => {
          captureStopCalls += 1;
          return { ok: true, uploaded: true, meetingId: 'mtg-get-fail' };
        },
        onMessage: {
          addListener: (fn: (raw: unknown, sender: unknown, respond: (res: unknown) => void) => boolean | undefined) => {
            listeners.push(fn);
          },
        },
      },
      storage: {
        local: {
          get: async () => {
            throw new Error('storage read failure');
          },
          set: async () => undefined,
          remove: async () => undefined,
        },
      },
      action: { setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined, setTitle: async () => undefined },
      offscreen: { closeDocument: async () => undefined },
    });
    try {
      await import('../src/background.ts');
      const reply = await new Promise<unknown>((resolve) => {
        listeners[0]!({ type: 'stop' }, { id: 'test-ext-id' }, resolve);
      });
      expect(captureStopCalls).toBe(1);
      expect(reply).toEqual({ ok: true, uploaded: true, meetingId: 'mtg-get-fail' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('logs structured error name/code without note or tab content when pre-stop markStopped retry fails (#5122)', async () => {
    vi.resetModules();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    class FakeInactiveRecorder {
      static instances: FakeInactiveRecorder[] = [];
      static isTypeSupported = () => true;
      state = 'inactive';
      mimeType = 'audio/webm';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      private listeners = new Map<string, Array<(event: unknown) => void>>();
      constructor() {
        FakeInactiveRecorder.instances.push(this);
      }
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        for (const fn of this.listeners.get('stop') ?? []) fn({});
      }
      addEventListener(type: string, listener: (event: unknown) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      markAlreadyStopped() {
        this.state = 'inactive';
        for (const fn of this.listeners.get('stop') ?? []) fn({});
      }
    }
    class FakeStream {
      tracks = [{ stop() {} }];
      getTracks = () => this.tracks;
      getAudioTracks = () => this.tracks;
      getVideoTracks = () => [];
    }
    class FakeAudioContext {
      destination = {};
      createMediaStreamDestination = () => ({ stream: new FakeStream() });
      createMediaStreamSource = () => ({ connect() {} });
      close = () => Promise.resolve();
    }
    vi.stubGlobal('MediaRecorder', FakeInactiveRecorder);
    vi.stubGlobal('MediaStream', FakeStream);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    try {
      const { startCapture } = await import('../src/capture-run.ts');
      const metas = new Map<string, import('@ludy/meeting-recorder').RecordingMeta>();
      let putCalls = 0;
      const client = {
        createMeeting: async () => ({ meetingId: 'mtg-warn-1' }),
        captureHeartbeat: async () => ({ open: true }),
        sendLiveChunk: async () => undefined,
        uploadMedia: async () => ({ fileId: 'file-1' }),
        recordingStopped: async () => undefined,
      };
      const started = await startCapture(
        {
          address: 'https://ludy.example',
          token: 'crx_test',
          orgId: 'org1',
          uploads: 'direct',
          title: 'Secret meeting title',
          consentMethod: 'told_at_start',
          consentAgreed: true,
          keepVideo: false,
          liveNotes: false,
          streamId: 'stream-1',
          joinUrl: 'https://meet.google.com/abc-defg-hij',
        },
        {
          store: {
            put: async (m) => {
              putCalls += 1;
              if (putCalls === 2) {
                throw Object.assign(new Error('Secret tab body https://private.example'), {
                  name: 'QuotaExceededError',
                  code: 'IDB_WRITE_ERR',
                });
              }
              metas.set(m.id, m);
            },
            append: async () => undefined,
            list: async () => [...metas.values()],
            chunks: async () => [new Blob(['audio'])],
            remove: async (id) => void metas.delete(id),
          },
          client: () => client as unknown as import('../src/api.ts').Client,
          getTabStream: async () => new FakeStream() as unknown as MediaStream,
          getMicStream: async () => null,
          now: () => 1_700_000_000_000,
        },
      );
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      FakeInactiveRecorder.instances[0]!.markAlreadyStopped();
      const stopped = await started.running.stop('tab_closed');
      expect(stopped).toEqual({ uploaded: true, meetingId: 'mtg-warn-1' });
      expect(putCalls).toBeGreaterThanOrEqual(2);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith('[clipper] markStopped retry failed', {
        name: 'QuotaExceededError',
        code: 'IDB_WRITE_ERR',
      });
      const logged = JSON.stringify(warnSpy.mock.calls);
      expect(logged).not.toContain('Secret tab body');
      expect(logged).not.toContain('private.example');
      expect(logged).not.toContain('Secret meeting title');
      expect(logged).not.toContain('abc-defg-hij');
    } finally {
      warnSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
