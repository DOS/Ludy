// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createConversationsCache } from '../src/screens/conversations/cache.ts';
import type { ConversationDetail, ConversationSummary } from '../src/screens/conversations/model.ts';
import { memoryStore, SERVER } from './helpers.ts';

function makeSummary(index: number, pad = ''): ConversationSummary {
  return {
    id: `conv-${index}`,
    kind: 'direct',
    status: 'new',
    channel: { connectionId: 'conn-1', provider: 'zalo_oa', displayName: 'Zalo OA' },
    postId: null,
    contact: {
      identityId: `id-${index}`,
      displayName: `Khách ${index} ${pad}`,
      idTail: '0001',
      partyId: null,
      partyName: null,
      address: null,
    },
    assigneeUserId: null,
    lastSeq: 3,
    lastMessageAt: '2026-11-26T10:00:00.000Z',
    lastInboundAt: '2026-11-26T10:00:00.000Z',
    replyWindowUntil: '2026-11-28T10:00:00.000Z',
    preview: `Tin nhắn xem trước ${index} ${pad}`,
    unread: true,
    composing: [],
    intent: null,
  };
}

function makeDetail(index: number, bodyPad = ''): ConversationDetail {
  return {
    conversation: makeSummary(index),
    messages: [
      {
        id: `msg-${index}-1`,
        seq: 1,
        direction: 'in',
        authorKind: 'contact',
        authorUserId: null,
        authorName: `Khách ${index}`,
        authorTail: '0001',
        body: `Nội dung tiếng Việt đầy đủ dấu ${index} ${bodyPad}`,
        attachments: [],
        sentAt: '2026-11-26T09:50:00.000Z',
        sendState: null,
        sendErrorCode: null,
        hidden: false,
        hideRequest: null,
        hideErrorCode: null,
        removed: false,
      },
    ],
    notes: [],
    parentId: null,
    reply: { allowed: true, reason: null },
    gap: null,
    draft: {
      id: `draft-${index}`,
      state: 'live',
      source: 'asked',
      body: 'Dạ chào {tên}, shop gửi bạn báo giá ạ.',
      tainted: true,
    },
    suggestions: [],
    others: [],
  };
}

describe('conversations persisted KeyValue read cache', () => {
  it('saves lists and bounded threads with UTF-8 chunking and distinct storage keys', async () => {
    const store = memoryStore();
    const cache = createConversationsCache(store);

    const saved = await cache.upsertList({
      serverUrl: SERVER,
      orgSlug: 'acme-vn',
      userId: 'user-a',
      savedAt: 1_764_150_000_000,
      filter: 'new',
      items: Array.from({ length: 12 }, (_, i) => makeSummary(i)),
      counts: { new: 12, pending: 3, resolved: 5, unread: 7 },
      salesCoworkerName: 'Dy',
    });
    expect(saved).not.toBeNull();

    // Upsert 18 threads: cache bounds retained threads to 15 newest.
    for (let i = 0; i < 18; i++) {
      await cache.upsertThread({
        serverUrl: SERVER,
        orgSlug: 'acme-vn',
        userId: 'user-a',
        savedAt: 1_764_150_000_000 + i * 1000,
        detail: makeDetail(i),
      });
    }

    const encoder = new TextEncoder();
    for (const [k, v] of store.data.entries()) {
      expect(encoder.encode(v).length).toBeLessThanOrEqual(1650);
      expect(k.startsWith('ludy.conversations.cache.')).toBe(true);
    }

    const loaded = await cache.load(SERVER, 'acme-vn', 'user-a');
    expect(loaded).not.toBeNull();
    expect(loaded?.lists.new).toHaveLength(12);
    expect(loaded?.counts?.unread).toBe(7);
    expect(Object.keys(loaded?.threads ?? {})).toHaveLength(15);
    expect(loaded?.threads['conv-0']).toBeUndefined();
    expect(loaded?.threads['conv-17']).toBeDefined();
  });

  it('shrinks oversized payloads cleanly without corrupting JSON', async () => {
    const store = memoryStore();
    const cache = createConversationsCache(store);
    const hugePad = 'Tin nhắn tiếng Việt rất dài '.repeat(50);

    await cache.save({
      serverUrl: SERVER,
      orgSlug: 'acme-vn',
      userId: 'user-a',
      savedAt: 2_000_000,
      salesCoworkerName: 'Dy',
      counts: { new: 30, pending: 0, resolved: 0, unread: 10 },
      lists: {
        new: Array.from({ length: 30 }, (_, i) => makeSummary(i, hugePad)),
      },
      threads: Object.fromEntries(
        Array.from({ length: 15 }, (_, i) => [
          `conv-${i}`,
          { conversationId: `conv-${i}`, cachedAt: 2_000_000 + i, detail: makeDetail(i, hugePad) },
        ]),
      ),
    });

    const loaded = await cache.load(SERVER, 'acme-vn', 'user-a');
    expect(loaded).not.toBeNull();
    expect(loaded?.salesCoworkerName).toBe('Dy');
  });

  it('isolates cached data strictly by (serverUrl, orgSlug, userId)', async () => {
    const store = memoryStore();
    const cache = createConversationsCache(store);
    await cache.upsertList({
      serverUrl: SERVER,
      orgSlug: 'org-a',
      userId: 'user-a',
      savedAt: 1000,
      filter: 'new',
      items: [makeSummary(1)],
    });

    expect(await cache.load(SERVER, 'org-b', 'user-a')).toBeNull();
    expect(await cache.load('https://other.example', 'org-a', 'user-a')).toBeNull();
    expect(await cache.load(SERVER, 'org-a', 'user-b')).toBeNull();
    expect(await cache.load(SERVER, 'org-a', null)).toBeNull();
    expect(await cache.load(SERVER, 'org-a', 'user-a')).not.toBeNull();
  });

  it('respects clearEpoch, AbortSignal, and session active guards during concurrent saves', async () => {
    const base = memoryStore();
    const gate: { enter: (() => void) | null; release: (() => void) | null } = {
      enter: null,
      release: null,
    };
    const enteredSet = new Promise<void>((resolve) => {
      gate.enter = resolve;
    });
    const delayedStore = {
      ...base,
      async set(key: string, value: string) {
        if (key.startsWith('ludy.conversations.cache.v1.')) {
          gate.enter?.();
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
        }
        return base.set(key, value);
      },
    };
    const cache = createConversationsCache(delayedStore);
    const startEpoch = cache.epoch();
    const controller = new AbortController();

    const pendingSave = cache.save(
      {
        serverUrl: SERVER,
        orgSlug: 'org-a',
        userId: 'user-a',
        savedAt: 1000,
        salesCoworkerName: 'Dy',
        counts: null,
        lists: { new: [makeSummary(1)] },
        threads: {},
      },
      { expectedEpoch: startEpoch, signal: controller.signal },
    );

    await enteredSet;
    const pendingClear = cache.clear();
    expect(cache.epoch()).toBe(startEpoch + 1);
    gate.release?.();

    expect(await pendingSave).toBe(false);
    await pendingClear;
    expect(await cache.load(SERVER, 'org-a', 'user-a')).toBeNull();
    expect(base.data.size).toBe(0);

    // Aborted signal or inactive session check rejects save without persisting.
    const abortCtrl = new AbortController();
    abortCtrl.abort();
    expect(
      await cache.save(
        {
          serverUrl: SERVER,
          orgSlug: 'org-a',
          userId: 'user-a',
          savedAt: 2000,
          salesCoworkerName: 'Dy',
          counts: null,
          lists: { new: [makeSummary(2)] },
          threads: {},
        },
        { signal: abortCtrl.signal },
      ),
    ).toBe(false);
    expect(
      await cache.save(
        {
          serverUrl: SERVER,
          orgSlug: 'org-a',
          userId: 'user-a',
          savedAt: 2000,
          salesCoworkerName: 'Dy',
          counts: null,
          lists: { new: [makeSummary(2)] },
          threads: {},
        },
        { isSessionStillActive: () => false },
      ),
    ).toBe(false);
    expect(base.data.size).toBe(0);
  });

  it('cleans up orphan chunks from failed mid-writes and removes STAGE_KEY last on clear()', async () => {
    const base = memoryStore();
    const removeOrder: string[] = [];
    let chunkWrites = 0;
    const flakyStore = {
      ...base,
      async set(key: string, value: string) {
        if (key.startsWith('ludy.conversations.cache.v1.')) {
          chunkWrites += 1;
          if (chunkWrites >= 2) throw new Error('disk full');
        }
        return base.set(key, value);
      },
      async remove(key: string) {
        removeOrder.push(key);
        return base.remove(key);
      },
    };
    const cache = createConversationsCache(flakyStore);

    await expect(
      cache.save({
        serverUrl: SERVER,
        orgSlug: 'org-a',
        userId: 'user-a',
        savedAt: 1000,
        salesCoworkerName: 'Dy',
        counts: null,
        lists: { new: Array.from({ length: 12 }, (_, i) => makeSummary(i)) },
        threads: {},
      }),
    ).rejects.toThrow('disk full');

    expect(base.data.has('ludy.conversations.cache.stage.v1')).toBe(true);
    await cache.clear();
    expect(base.data.size).toBe(0);
    expect(removeOrder.at(-1)).toBe('ludy.conversations.cache.stage.v1');
  });

  it('fails closed on corrupted metadata or missing chunks', async () => {
    const store = memoryStore();
    const cache = createConversationsCache(store);
    await cache.save({
      serverUrl: SERVER,
      orgSlug: 'org-a',
      userId: 'user-a',
      savedAt: 1000,
      salesCoworkerName: 'Dy',
      counts: null,
      lists: { new: Array.from({ length: 10 }, (_, i) => makeSummary(i)) },
      threads: {},
    });
    store.data.delete('ludy.conversations.cache.v1.1.0');
    expect(await cache.load(SERVER, 'org-a', 'user-a')).toBeNull();

    store.data.set('ludy.conversations.cache.meta.v1', '{broken-json');
    expect(await cache.load(SERVER, 'org-a', 'user-a')).toBeNull();
  });
});
