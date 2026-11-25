// SPDX-License-Identifier: AGPL-3.0-only
// Mounted React DOM lifecycle tests (react-dom/client + act + real QueryClient) verifying cached unread
// paused -> unpaused verification transitions, pending refetch suppression of markRead/images/PII,
// cache purge on revoked access, and multi-page trim/refetch ordering on pause -> unpause (#3673).
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationDetail } from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

class FakeNode {
  nodeType: number;
  tagName: string;
  nodeName: string;
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  attrs = new Map<string, string>();
  style: Record<string, string> = {};
  nodeValue = '';
  private _textContent = '';
  className = '';
  disabled = false;
  value = '';
  checked = false;
  selected = false;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;

  constructor(nodeType: number, tag = '') {
    this.nodeType = nodeType;
    this.tagName = tag.toUpperCase();
    this.nodeName = nodeType === 3 ? '#text' : nodeType === 8 ? '#comment' : this.tagName;
  }

  get options(): FakeNode[] {
    const out: FakeNode[] = [];
    const walk = (node: FakeNode) => {
      for (const child of node.childNodes) {
        if (child.tagName === 'OPTION') out.push(child);
        else walk(child);
      }
    };
    walk(this);
    return out;
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  get nextSibling(): FakeNode | null {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return i >= 0 ? (this.parentNode.childNodes[i + 1] ?? null) : null;
  }

  get parentElement(): FakeNode | null {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  get ownerDocument() {
    return globalThis.document;
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

  appendChild(child: FakeNode): FakeNode {
    return this.insertBefore(child, null);
  }

  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode {
    if (child.parentNode) child.parentNode.removeChild(child);
    const idx = ref ? this.childNodes.indexOf(ref) : -1;
    if (idx >= 0) this.childNodes.splice(idx, 0, child);
    else this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }

  removeChild(child: FakeNode): FakeNode {
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
  }

  getAttribute(name: string): string | null {
    if (name === 'class') return this.className || this.attrs.get('class') || null;
    return this.attrs.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
    if (name === 'class') this.className = '';
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true;
  }
  focus(): void {}
  blur(): void {}
  contains(node: FakeNode | null): boolean {
    let cur = node;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }
  getBoundingClientRect() {
    return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
  }

  querySelectorAll(selector: string): FakeNode[] {
    const out: FakeNode[] = [];
    const attrMatch = /^\[([^=\]]+)="([^"]*)"\]$/.exec(selector);
    const matches = (el: FakeNode): boolean => {
      if (el.nodeType !== 1) return false;
      if (attrMatch && attrMatch[1]) return el.getAttribute(attrMatch[1]) === attrMatch[2];
      return el.tagName.toLowerCase() === selector.toLowerCase();
    };
    const walk = (node: FakeNode) => {
      for (const child of node.childNodes) {
        if (matches(child)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function installMinimalDom(): void {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = globalThis;
  g.HTMLElement = FakeNode;
  g.HTMLIFrameElement = FakeNode;
  g.Element = FakeNode;
  g.Node = FakeNode;
  if (typeof g.addEventListener !== 'function') g.addEventListener = () => {};
  if (typeof g.removeEventListener !== 'function') g.removeEventListener = () => {};
  g.getComputedStyle = () => ({ overflowY: 'visible' });
  g.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(0), 0);
  g.cancelAnimationFrame = (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
  g.scrollTo = () => {};
  g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  const body = new FakeNode(1, 'body');
  g.document = {
    nodeType: 9,
    defaultView: globalThis,
    body,
    head: new FakeNode(1, 'head'),
    activeElement: null,
    createElement: (tag: string) => new FakeNode(1, tag),
    createElementNS: (_ns: string, tag: string) => new FakeNode(1, tag),
    createTextNode: (text: string) => {
      const n = new FakeNode(3);
      n.textContent = String(text ?? '');
      return n;
    },
    createComment: (text: string) => {
      const n = new FakeNode(8);
      n.nodeValue = String(text ?? '');
      return n;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  if (typeof URL.createObjectURL !== 'function') {
    URL.createObjectURL = () => 'blob:mock-url';
  }
  if (typeof URL.revokeObjectURL !== 'function') {
    URL.revokeObjectURL = () => {};
  }
}

installMinimalDom();

const realQueryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
  },
});

const apiMocks = vi.hoisted(() => ({
  getCalls: 0,
  getImpl: null as ((arg: { conversationId: string }) => Promise<ConversationDetail>) | null,
  listCursors: [] as Array<string | undefined>,
  listImpl: null as ((input: { cursor?: { at: string | null; id: string } | undefined }) => Promise<{ conversations: unknown[]; nextCursor: { at: string | null; id: string } | null; more: boolean }>) | null,
  markReadCalls: [] as Array<{ conversationId: string; seq: number }>,
  fetchImageCalls: [] as string[],
}));

vi.mock('../src/lib/api.ts', () => {
  const resolveInput = (input: unknown, pageParam?: unknown) =>
    typeof input === 'function' ? (input as (c: unknown) => Record<string, unknown>)(pageParam) : ((input ?? {}) as Record<string, unknown>);

  const queryKeyOf = (path: string[], arg?: { input?: unknown }): unknown[] =>
    arg && 'input' in arg && arg.input !== undefined ? [...path, resolveInput(arg.input, undefined)] : path;

  const queryFnFor = (path: string[], arg?: { input?: unknown }) => async (ctx?: { pageParam?: unknown }) => {
    const key = path.join('.');
    const input = resolveInput(arg?.input, ctx?.pageParam);
    if (key === 'org.get') return { role: 'owner', members: [], conversationAddress: null };
    if (key === 'me.get') return { userId: 'u1', orgs: [{ slug: 'acme', role: 'owner' }] };
    if (key === 'conversations.get') {
      apiMocks.getCalls += 1;
      if (apiMocks.getImpl) return apiMocks.getImpl(input as { conversationId: string });
      return Promise.reject(new Error('unexpected conversations.get'));
    }
    if (key === 'conversations.list') {
      const cursor = (ctx?.pageParam ?? input.before) as { at: string | null; id: string } | undefined;
      apiMocks.listCursors.push(cursor?.id);
      if (apiMocks.listImpl) return apiMocks.listImpl({ ...input, cursor });
      return { conversations: [], nextCursor: null, more: false };
    }
    if (key === 'conversations.savedReplies') return { replies: [] };
    if (key === 'conversations.autoDraft') return { autoDraft: false };
    if (key === 'conversations.tasks') return { tasks: [] };
    if (key === 'conversations.aiStatus') return { ai: 'on' };
    return {};
  };

  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (arg?: { input?: unknown }) => ({
            queryKey: queryKeyOf(path, arg),
            queryFn: queryFnFor(path, arg),
          });
        }
        if (prop === 'infiniteOptions') {
          return (arg?: { input?: unknown; initialPageParam?: unknown; getNextPageParam?: (last: unknown) => unknown }) => ({
            queryKey: queryKeyOf(path, arg),
            initialPageParam: arg?.initialPageParam,
            getNextPageParam: arg?.getNextPageParam ?? ((last: { nextCursor?: unknown }) => last?.nextCursor ?? undefined),
            queryFn: queryFnFor(path, arg),
          });
        }
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });

  return {
    orpc: node([]),
    client: {
      conversations: {
        markRead: async (arg: { conversationId: string; seq: number }) => {
          apiMocks.markReadCalls.push(arg);
          return { ok: true };
        },
        aiDraft: async () => ({ body: null }),
        reply: async () => ({ ok: true }),
      },
    },
    getCurrentOrg: () => 'acme',
    queryClient: realQueryClient,
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    isStepUpRequired: () => false,
    fetchConversationImage: async (id: string) => {
      apiMocks.fetchImageCalls.push(id);
      return new Blob(['img'], { type: 'image/png' });
    },
  };
});

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({
    aiEnabled: false,
    modules: ['kernel', 'social'],
    channels: { oauth: [], sandbox: false },
  }),
}));

vi.mock('../src/lib/use-me.ts', () => ({
  useMe: () => ({ canWrite: true, isAdmin: false, role: 'owner', userId: 'u1' }),
}));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'acme' }),
    useSearch: () => ({}),
    useNavigate: () => () => {},
    Link: ({ children, to, className }: { children?: React.ReactNode; to: string; className?: string }) => createElement('a', { href: to, className }, children),
  };
});

const { ConversationThread, useConversationPages } = await import('../src/components/conversation-inbox.tsx');
const { ContactPanel } = await import('../src/components/conversation-contact-panel.tsx');

function sampleDetail(conversationId: string, body: string, attachmentId: string, unread = true): ConversationDetail {
  return {
    conversation: {
      id: conversationId,
      kind: 'direct',
      status: 'new',
      unread,
      lastSeq: 4,
      lastMessageAt: '2026-11-25T10:00:00.000Z',
      lastInboundAt: '2026-11-25T10:00:00.000Z',
      replyWindowUntil: null,
      preview: body,
      postId: null,
      assigneeUserId: null,
      channel: { connectionId: 'ch-1', provider: 'facebook_page', displayName: 'Crove Page' },
      contact: { identityId: 'ct-1', displayName: 'Lan Nguyễn', idTail: 'ct-1', partyId: null, partyName: null, address: 'lan@example.com' },
      senderUnverified: false,
      subject: null,
      intent: null,
      composing: [],
    },
    messages: [
      {
        id: `msg-${conversationId}`,
        seq: 4,
        direction: 'in',
        authorKind: 'contact',
        authorUserId: null,
        authorName: 'Lan Nguyễn',
        authorTail: null,
        body,
        sentAt: '2026-11-25T10:00:00.000Z',
        sendState: 'sent',
        sendErrorCode: null,
        removed: false,
        hidden: false,
        hideRequest: null,
        hideErrorCode: null,
        privateReplyConversationId: null,
        attachments: [{ id: attachmentId, contentType: 'image/png', width: 120, height: 80 }],
      },
    ],
    notes: [],
    parentId: null,
    reply: { allowed: true, reason: null },
    gap: null,
    draft: null,
    suggestions: [],
    others: [],
    hideAllowed: false,
  };
}

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={realQueryClient}>
      <IntlProvider locale="vi" messages={catalog('vi')} timeZone="Asia/Ho_Chi_Minh">
        {children}
      </IntlProvider>
    </QueryClientProvider>
  );
}

async function waitUntil(check: () => boolean) {
  for (let i = 0; i < 20; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe('mounted ConversationThread and useConversationPages real-QueryClient DOM lifecycle (#3673)', () => {
  let container: FakeNode;
  let root: Root;

  beforeEach(() => {
    installMinimalDom();
    onlineManager.setOnline(true);
    realQueryClient.clear();
    apiMocks.getCalls = 0;
    apiMocks.getImpl = null;
    apiMocks.listCursors = [];
    apiMocks.listImpl = null;
    apiMocks.markReadCalls = [];
    apiMocks.fetchImageCalls = [];
    container = document.createElement('div') as unknown as FakeNode;
    root = createRoot(container as unknown as Element);
  });

  afterEach(async () => {
    onlineManager.setOnline(true);
    await act(async () => {
      root.unmount();
    });
    realQueryClient.clear();
  });

  it('keeps cached unread thread hidden and suppresses markRead + MessageImage fetches across paused -> pending verify -> resolved', async () => {
    const cached = sampleDetail('c-dom-1', 'Tin nhắn riêng tư cần xác minh', 'att-dom-1', true);
    realQueryClient.setQueryData(['conversations', 'get', { conversationId: 'c-dom-1' }], cached);

    let resolveFresh!: (d: ConversationDetail) => void;
    apiMocks.getImpl = () =>
      new Promise<ConversationDetail>((resolve) => {
        resolveFresh = resolve;
      });

    // Step 1: Mounted with paused={true} (?settings=true open over cached unread thread)
    await act(async () => {
      root.render(
        <Providers>
          <ConversationThread conversationId="c-dom-1" paused={true} onGone={() => {}} />
        </Providers>,
      );
    });

    expect(apiMocks.getCalls).toBe(0);
    expect(apiMocks.markReadCalls).toEqual([]);
    expect(apiMocks.fetchImageCalls).toEqual([]);
    expect(container.querySelector('[data-testid="conversation-thread"]')?.getAttribute('class')).toBe('hidden');
    expect(container.querySelector('[data-testid="thread-skeleton"]')).not.toBeNull();

    // Step 2: Settings closes (paused: true -> false); fresh verification request is pending
    await act(async () => {
      root.render(
        <Providers>
          <ConversationThread conversationId="c-dom-1" paused={false} onGone={() => {}} />
        </Providers>,
      );
    });

    expect(apiMocks.getCalls).toBe(1);
    expect(apiMocks.markReadCalls).toEqual([]);
    expect(apiMocks.fetchImageCalls).toEqual([]);
    expect(container.querySelector('[data-testid="conversation-thread"]')?.getAttribute('class')).toBe('hidden');
    expect(container.querySelector('[data-testid="thread-skeleton"]')).not.toBeNull();

    // Step 3: Verification request resolves with distinct fresh snapshot -> fresh body shows, old body is gone, fresh attachment fetches
    const fresh = sampleDetail('c-dom-1', 'Tin nhắn mới sau xác minh', 'att-dom-1-fresh', true);
    await act(async () => {
      resolveFresh(fresh);
    });
    await waitUntil(
      () =>
        container.querySelector('[data-testid="thread-skeleton"]') === null &&
        container.textContent.includes('Tin nhắn mới sau xác minh') &&
        apiMocks.fetchImageCalls.includes('att-dom-1-fresh'),
    );

    expect(container.querySelector('[data-testid="thread-skeleton"]')).toBeNull();
    expect(container.querySelector('[data-testid="conversation-thread"]')?.getAttribute('class')).not.toBe('hidden');
    expect(container.textContent).toContain('Tin nhắn mới sau xác minh');
    expect(container.textContent).not.toContain('Tin nhắn riêng tư cần xác minh');
    expect(apiMocks.markReadCalls).toEqual([{ conversationId: 'c-dom-1', seq: 4 }]);
    expect(apiMocks.fetchImageCalls).toEqual(['att-dom-1-fresh']);
  });

  it('purges cached thread PII and suppresses markRead + MessageImage when unpause verify rejects with 403 FORBIDDEN', async () => {
    const cached = sampleDetail('c-dom-403', 'Dữ liệu khách bị thu hồi', 'att-dom-403', true);
    const queryKey = ['conversations', 'get', { conversationId: 'c-dom-403' }];
    realQueryClient.setQueryData(queryKey, cached);

    let rejectFresh!: (err: unknown) => void;
    apiMocks.getImpl = () =>
      new Promise<ConversationDetail>((_resolve, reject) => {
        rejectFresh = reject;
      });

    await act(async () => {
      root.render(
        <Providers>
          <ConversationThread conversationId="c-dom-403" paused={true} onGone={() => {}} />
        </Providers>,
      );
    });

    await act(async () => {
      root.render(
        <Providers>
          <ConversationThread conversationId="c-dom-403" paused={false} onGone={() => {}} />
        </Providers>,
      );
    });

    expect(apiMocks.markReadCalls).toEqual([]);
    expect(apiMocks.fetchImageCalls).toEqual([]);

    await act(async () => {
      rejectFresh(Object.assign(new Error('Forbidden'), { code: 'FORBIDDEN' }));
    });
    await waitUntil(() => container.querySelector('[data-testid="thread-error"]') !== null);

    expect(container.querySelector('[data-testid="thread-error"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Dữ liệu khách bị thu hồi');
    expect(realQueryClient.getQueryData(queryKey)).toBeUndefined();
    expect(apiMocks.getCalls).toBe(1);
    expect(apiMocks.markReadCalls).toEqual([]);
    expect(apiMocks.fetchImageCalls).toEqual([]);
  });

  it('shares one unpause verify call across ConversationThread + ContactPanel and purges both without looping on 403', async () => {
    const cached = sampleDetail('c-dom-shared', 'Dữ liệu liên hệ nhạy cảm', 'att-dom-shared', true);
    const queryKey = ['conversations', 'get', { conversationId: 'c-dom-shared' }];
    realQueryClient.setQueryData(queryKey, cached);

    let rejectFresh!: (err: unknown) => void;
    apiMocks.getImpl = () =>
      new Promise<ConversationDetail>((_resolve, reject) => {
        rejectFresh = reject;
      });

    await act(async () => {
      root.render(
        <Providers>
          <>
            <ConversationThread conversationId="c-dom-shared" paused={true} onGone={() => {}} />
            <ContactPanel conversationId="c-dom-shared" paused={true} onOpen={() => {}} onErased={() => {}} />
          </>
        </Providers>,
      );
    });

    await act(async () => {
      root.render(
        <Providers>
          <>
            <ConversationThread conversationId="c-dom-shared" paused={false} onGone={() => {}} />
            <ContactPanel conversationId="c-dom-shared" paused={false} onOpen={() => {}} onErased={() => {}} />
          </>
        </Providers>,
      );
    });

    expect(apiMocks.getCalls).toBe(1);
    expect(container.querySelector('[data-testid="thread-skeleton"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="panel-skeleton"]')).not.toBeNull();

    await act(async () => {
      rejectFresh(Object.assign(new Error('Forbidden'), { code: 'FORBIDDEN' }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(apiMocks.getCalls).toBe(1);
    expect(container.querySelector('[data-testid="thread-error"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="panel-error"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Dữ liệu liên hệ nhạy cảm');
    expect(realQueryClient.getQueryData(queryKey)).toBeUndefined();
    expect(apiMocks.markReadCalls).toEqual([]);
    expect(apiMocks.fetchImageCalls).toEqual([]);
  });

  it('trims multi-page cache while mounted paused=true and fetches only page 1 on paused -> false', async () => {
    const input = { limit: 25, status: 'new' as const };
    const listKey = ['conversations', 'list', input];
    const mkRow = (id: string) => ({
      id,
      kind: 'direct',
      status: 'new',
      unread: false,
      lastSeq: 1,
      lastMessageAt: '2026-11-25T10:00:00.000Z',
      assigneeUserId: null,
      channel: { id: 'ch-1', provider: 'facebook_page', displayName: 'Page' },
      contact: { id: 'ct-1', kind: 'external', address: 'u', displayName: id, partyId: null, partyName: null },
      senderUnverified: false,
      subject: null,
      intent: null,
      composing: [],
    });

    realQueryClient.setQueryData(listKey, {
      pages: [
        { conversations: [mkRow('p1')], nextCursor: { at: 't1', id: 'p1' }, more: true },
        { conversations: [mkRow('p2')], nextCursor: { at: 't2', id: 'p2' }, more: true },
        { conversations: [mkRow('p3')], nextCursor: null, more: false },
      ],
      pageParams: [undefined, { at: 't1', id: 'p1' }, { at: 't2', id: 'p2' }],
    });

    let releasePage1!: (v: { conversations: unknown[]; nextCursor: null; more: boolean }) => void;
    apiMocks.listImpl = () =>
      new Promise((resolve) => {
        releasePage1 = resolve;
      });

    const snapshots: Array<{ pageCount: number; verifying: boolean; loaded: boolean }> = [];
    function PagesProbe({ paused }: { paused: boolean }) {
      const res = useConversationPages(input, { enabled: true, paused });
      useEffect(() => {
        snapshots.push({ pageCount: res.pageCount, verifying: res.verifying, loaded: res.loaded });
      });
      return (
        <div
          data-testid="pages-probe"
          data-pages={String(res.pageCount)}
          data-verifying={String(res.verifying)}
          data-loaded={String(res.loaded)}
        />
      );
    }

    // Mount paused=true with 3 pre-cached pages -> effect cancels in-flight queries and trims cache down to 1 page without fetching
    await act(async () => {
      root.render(
        <Providers>
          <PagesProbe paused={true} />
        </Providers>,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(realQueryClient.getQueryData<{ pages: unknown[] }>(listKey)?.pages.length).toBe(1);
    expect(container.querySelector('[data-testid="pages-probe"]')?.getAttribute('data-pages')).toBe('1');
    expect(apiMocks.listCursors).toEqual([]);

    // Transition paused: true -> false -> verifying=true while page 1 fetch is pending (only cursor undefined)
    await act(async () => {
      root.render(
        <Providers>
          <PagesProbe paused={false} />
        </Providers>,
      );
    });
    expect(apiMocks.listCursors).toEqual([undefined]);
    expect(container.querySelector('[data-testid="pages-probe"]')?.getAttribute('data-verifying')).toBe('true');

    await act(async () => {
      releasePage1({ conversations: [mkRow('p1-fresh')], nextCursor: null, more: false });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(apiMocks.listCursors).toEqual([undefined]);
    expect(container.querySelector('[data-testid="pages-probe"]')?.getAttribute('data-verifying')).toBe('false');
    expect(container.querySelector('[data-testid="pages-probe"]')?.getAttribute('data-loaded')).toBe('true');
    expect(snapshots.some((s) => s.verifying)).toBe(true);
  });

  it('keeps MFA_REQUIRED 401 query recoverable by refetchQueries while hiding PII across ConversationThread + ContactPanel', async () => {
    const cached = sampleDetail('c-dom-mfa', 'Tin nhắn cần xác thực MFA', 'att-dom-mfa', true);
    const queryKey = ['conversations', 'get', { conversationId: 'c-dom-mfa' }];
    realQueryClient.setQueryData(queryKey, cached);

    let rejectFresh!: (err: unknown) => void;
    apiMocks.getImpl = () =>
      new Promise<ConversationDetail>((_resolve, reject) => {
        rejectFresh = reject;
      });

    await act(async () => {
      root.render(
        <Providers>
          <>
            <ConversationThread conversationId="c-dom-mfa" paused={true} onGone={() => {}} />
            <ContactPanel conversationId="c-dom-mfa" paused={true} onOpen={() => {}} onErased={() => {}} />
          </>
        </Providers>,
      );
    });

    await act(async () => {
      root.render(
        <Providers>
          <>
            <ConversationThread conversationId="c-dom-mfa" paused={false} onGone={() => {}} />
            <ContactPanel conversationId="c-dom-mfa" paused={false} onOpen={() => {}} onErased={() => {}} />
          </>
        </Providers>,
      );
    });

    await act(async () => {
      rejectFresh(Object.assign(new Error('MFA required'), { code: 'MFA_REQUIRED', status: 401 }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.querySelector('[data-testid="thread-error"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="panel-error"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Tin nhắn cần xác thực MFA');
    expect(realQueryClient.getQueryState(queryKey)?.status).toBe('error');

    // Simulate afterMfaRefusal retrying errored queries after MFA succeeds
    apiMocks.getImpl = async () => cached;
    await act(async () => {
      await realQueryClient.refetchQueries({ predicate: (q) => q.state.status === 'error' });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.querySelector('[data-testid="thread-error"]')).toBeNull();
    expect(container.textContent).toContain('Tin nhắn cần xác thực MFA');
  });

  it('shows OfflineVerifyNotice on cold offline ConversationThread load and clears it once online resolves', async () => {
    const fresh = sampleDetail('c-dom-cold-off', 'Khách nhắn lúc ngoại tuyến', 'att-cold-off', false);
    onlineManager.setOnline(false);
    apiMocks.getImpl = async () => fresh;

    await act(async () => {
      root.render(
        <Providers>
          <ConversationThread conversationId="c-dom-cold-off" paused={false} onGone={() => {}} />
        </Providers>,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.querySelector('[data-testid="thread-offline"]')).not.toBeNull();

    await act(async () => {
      onlineManager.setOnline(true);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.querySelector('[data-testid="thread-offline"]')).toBeNull();
    expect(container.textContent).toContain('Khách nhắn lúc ngoại tuyến');
  });

  it('does not reset errored multi-page list state to success when pausing Settings', async () => {
    const input = { limit: 25, status: 'new' as const };
    const listKey = ['conversations', 'list', input];
    const mkRow = (id: string) => ({
      id,
      kind: 'direct',
      status: 'new',
      unread: false,
      lastSeq: 1,
      lastMessageAt: '2026-11-25T10:00:00.000Z',
      assigneeUserId: null,
      channel: { id: 'ch-1', provider: 'facebook_page', displayName: 'Page' },
      contact: { id: 'ct-1', kind: 'external', address: 'u', displayName: id, partyId: null, partyName: null },
      senderUnverified: false,
      subject: null,
      intent: null,
      composing: [],
    });

    realQueryClient.setQueryData(listKey, {
      pages: [
        { conversations: [mkRow('e1')], nextCursor: { at: 't1', id: 'e1' }, more: true },
        { conversations: [mkRow('e2')], nextCursor: null, more: false },
      ],
      pageParams: [undefined, { at: 't1', id: 'e1' }],
    });
    apiMocks.listImpl = () => Promise.reject(new Error('Server 500'));

    function ErroredPagesProbe({ paused }: { paused: boolean }) {
      const res = useConversationPages(input, { enabled: true, paused });
      return <div data-testid="errored-pages" data-pages={String(res.pageCount)} data-error={String(Boolean(res.error))} />;
    }

    await act(async () => {
      root.render(
        <Providers>
          <ErroredPagesProbe paused={false} />
        </Providers>,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(realQueryClient.getQueryState(listKey)?.status).toBe('error');

    await act(async () => {
      root.render(
        <Providers>
          <ErroredPagesProbe paused={true} />
        </Providers>,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(realQueryClient.getQueryState(listKey)?.status).toBe('error');
    expect(realQueryClient.getQueryData<{ pages: unknown[] }>(listKey)?.pages.length).toBe(2);
  });

  it('hides cached list rows and purges the list cache immediately when Load older rejects with 403 FORBIDDEN', async () => {
    const input = { limit: 25, status: 'new' as const };
    const listKey = ['conversations', 'list', input];
    const mkRow = (id: string) => ({
      id,
      kind: 'direct',
      status: 'new',
      unread: false,
      lastSeq: 1,
      lastMessageAt: '2026-11-25T10:00:00.000Z',
      assigneeUserId: null,
      channel: { id: 'ch-1', provider: 'facebook_page', displayName: 'Page' },
      contact: { id: 'ct-1', kind: 'external', address: 'u', displayName: id, partyId: null, partyName: null },
      senderUnverified: false,
      subject: null,
      intent: null,
      composing: [],
    });

    apiMocks.listImpl = ({ cursor }) => {
      if (!cursor) {
        return Promise.resolve({ conversations: [mkRow('ok-1')], nextCursor: { at: 't1', id: 'ok-1' }, more: true });
      }
      return Promise.reject(Object.assign(new Error('Forbidden'), { code: 'FORBIDDEN', status: 403 }));
    };

    const actions: { loadMore?: () => void; retry?: () => void } = {};
    function ActivePagesProbe() {
      const res = useConversationPages(input, { enabled: true, paused: false });
      actions.loadMore = res.loadMore;
      actions.retry = res.retry;
      return (
        <div
          data-testid="active-pages"
          data-items={String(res.items.length)}
          data-pages={String(res.pageCount)}
          data-loaded={String(res.loaded)}
          data-pending={String(res.isPending)}
          data-load-failed={String(res.loadFailed)}
          data-error={String(Boolean(res.error))}
        >
          {res.items.map((item) => (
            <span key={item.id}>{item.contact.displayName}</span>
          ))}
        </div>
      );
    }

    await act(async () => {
      root.render(
        <Providers>
          <ActivePagesProbe />
        </Providers>,
      );
    });
    await waitUntil(() => container.textContent.includes('ok-1'));
    expect(container.querySelector('[data-testid="active-pages"]')?.getAttribute('data-loaded')).toBe('true');

    await act(async () => {
      actions.loadMore?.();
    });
    await waitUntil(
      () =>
        container.querySelector('[data-testid="active-pages"]')?.getAttribute('data-error') === 'true' &&
        realQueryClient.getQueryData(listKey) === undefined,
    );

    const deniedEl = container.querySelector('[data-testid="active-pages"]');
    expect(deniedEl?.getAttribute('data-items')).toBe('0');
    expect(deniedEl?.getAttribute('data-pages')).toBe('0');
    expect(deniedEl?.getAttribute('data-loaded')).toBe('false');
    expect(deniedEl?.getAttribute('data-pending')).toBe('false');
    expect(deniedEl?.getAttribute('data-load-failed')).toBe('false');
    expect(deniedEl?.getAttribute('data-error')).toBe('true');
    expect(container.textContent).not.toContain('ok-1');
    expect(realQueryClient.getQueryData(listKey)).toBeUndefined();

    apiMocks.listImpl = () => Promise.resolve({ conversations: [mkRow('ok-2')], nextCursor: null, more: false });
    await act(async () => {
      actions.retry?.();
    });
    await waitUntil(() => container.textContent.includes('ok-2'));
    expect(container.querySelector('[data-testid="active-pages"]')?.getAttribute('data-loaded')).toBe('true');
  });
});
