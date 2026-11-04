// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FACEBOOK_MAX_NOTICE_BYTES,
  FacebookPagePublisher,
  metaSignatureOk,
  parseFacebookNotice,
  parseFacebookNotices,
  platformUserHash,
  type Fetch,
} from '../src/index.ts';

const SECRET = 's'.repeat(32);
const PAGE_ID = '100200300400500';
const POST_ID = `${PAGE_ID}_900800700600500`;
const TOKEN = JSON.stringify({ accessToken: 'p'.repeat(24) });

function sign(raw: string | Uint8Array, secret = SECRET): string {
  const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
  return `sha256=${createHmac('sha256', secret).update(bytes).digest('hex')}`;
}

describe('metaSignatureOk & platformUserHash (#2307)', () => {
  it('verifies X-Hub-Signature-256 over the exact raw bytes in constant time and supports appSecretPrevious', () => {
    const raw = JSON.stringify({ object: 'page', entry: [] });
    const bytes = new TextEncoder().encode(raw);
    const sig = sign(bytes);
    expect(metaSignatureOk({ appSecret: SECRET, body: bytes, header: sig })).toBe(true);
    expect(metaSignatureOk({ appSecret: SECRET, body: bytes, header: `  ${sig}  ` })).toBe(true);
    expect(metaSignatureOk({ appSecret: 'n'.repeat(24), appSecretPrevious: SECRET, body: bytes, header: sig })).toBe(true);
    expect(metaSignatureOk({ appSecret: 'w'.repeat(24), body: bytes, header: sig })).toBe(false);
    expect(metaSignatureOk({ appSecret: SECRET, body: new TextEncoder().encode(`${raw} `), header: sig })).toBe(false);
    expect(metaSignatureOk({ appSecret: SECRET, body: bytes, header: sig.slice(7) })).toBe(false);
    expect(metaSignatureOk({ appSecret: SECRET, body: bytes, header: sig.toUpperCase() })).toBe(false);
    expect(metaSignatureOk({ appSecret: '', body: bytes, header: sig })).toBe(false);
    expect(metaSignatureOk({ appSecret: SECRET, body: new Uint8Array(FACEBOOK_MAX_NOTICE_BYTES + 1), header: sig })).toBe(false);
  });

  it('computes the same keyed hash as @crove/ad-platform for Meta data deletion', () => {
    expect(platformUserHash(SECRET, '123456789012345')).toBe(
      createHmac('sha256', SECRET).update('ludy.ads.meta_ads.user:123456789012345').digest('hex'),
    );
  });
});

describe('parseFacebookNotices (#2307)', () => {
  it('parses add, edited, remove, hide and unhide comment events and groups by Page', () => {
    const now = 1762000200 * 1000;
    const payload = {
      object: 'page',
      entry: [
        {
          id: PAGE_ID,
          time: 1762000100,
          changes: [
            {
              field: 'feed',
              value: {
                item: 'comment',
                verb: 'add',
                comment_id: '900800700600500_111',
                post_id: POST_ID,
                parent_id: POST_ID,
                created_time: 1762000010,
                message: 'Cho mình hỏi giá bánh nhé',
                from: { id: '777888999', name: 'Nguyễn Lan' },
              },
            },
            {
              field: 'feed',
              value: {
                item: 'comment',
                verb: 'add',
                comment_id: '900800700600500_112',
                post_id: POST_ID,
                parent_id: '900800700600500_111',
                created_time: 1762000020,
                message: 'Dạ tiệm gửi bảng giá ạ',
                from: { id: PAGE_ID, name: 'Tiệm Bánh An Nhiên' },
              },
            },
            {
              field: 'feed',
              value: {
                item: 'comment',
                verb: 'edited',
                comment_id: '900800700600500_111',
                post_id: POST_ID,
                parent_id: POST_ID,
                created_time: 1762000030,
                message: 'Cho mình hỏi giá bánh kem nhé',
                from: { id: '777888999', name: 'Nguyễn Lan' },
              },
            },
            {
              field: 'feed',
              value: {
                item: 'comment',
                verb: 'hide',
                comment_id: '900800700600500_111',
                post_id: POST_ID,
                parent_id: POST_ID,
                created_time: 1762000040,
              },
            },
            {
              field: 'feed',
              value: {
                item: 'comment',
                verb: 'unhide',
                comment_id: '900800700600500_111',
                post_id: POST_ID,
                parent_id: POST_ID,
                created_time: 1762000050,
              },
            },
            {
              field: 'feed',
              value: {
                item: 'comment',
                verb: 'remove',
                comment_id: '900800700600500_111',
                post_id: POST_ID,
                parent_id: POST_ID,
                created_time: 1762000061,
              },
            },
            // Non-comment feed item is ignored.
            {
              field: 'feed',
              value: { item: 'like', verb: 'add', post_id: POST_ID, created_time: 1762000070 },
            },
          ],
        },
      ],
    };
    const raw = new TextEncoder().encode(JSON.stringify(payload));
    const notices = parseFacebookNotices(raw, now);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.accountId).toBe(PAGE_ID);
    expect(notices[0]?.events).toEqual([
      {
        kind: 'comment_thread',
        threadId: '900800700600500_111',
        postId: POST_ID,
        messageId: '900800700600500_111',
        direction: 'in',
        contact: { id: '777888999', name: 'Nguyễn Lan' },
        text: 'Cho mình hỏi giá bánh nhé',
        at: new Date(1762000010 * 1000).toISOString(),
      },
      {
        kind: 'comment_thread',
        threadId: '900800700600500_111',
        postId: POST_ID,
        messageId: '900800700600500_112',
        direction: 'out',
        contact: { id: 'commenter:900800700600500_111' },
        text: 'Dạ tiệm gửi bảng giá ạ',
        at: new Date(1762000020 * 1000).toISOString(),
      },
      {
        kind: 'comment_thread',
        threadId: '900800700600500_111',
        postId: POST_ID,
        messageId: '900800700600500_111',
        direction: 'in',
        edited: true,
        contact: { id: '777888999', name: 'Nguyễn Lan' },
        text: 'Cho mình hỏi giá bánh kem nhé',
        at: new Date(1762000030 * 1000).toISOString(),
      },
      {
        kind: 'comment_thread',
        threadId: '900800700600500_111',
        postId: POST_ID,
        messageId: '900800700600500_111',
        direction: 'in',
        hiddenOnly: true,
        hidden: true,
        contact: { id: 'commenter:900800700600500_111' },
        text: '',
        at: new Date(1762000040 * 1000).toISOString(),
      },
      {
        kind: 'comment_thread',
        threadId: '900800700600500_111',
        postId: POST_ID,
        messageId: '900800700600500_111',
        direction: 'in',
        hiddenOnly: true,
        hidden: false,
        contact: { id: 'commenter:900800700600500_111' },
        text: '',
        at: new Date(1762000050 * 1000).toISOString(),
      },
      {
        kind: 'comment_thread',
        threadId: '900800700600500_111',
        postId: POST_ID,
        messageId: '900800700600500_111',
        direction: 'in',
        removed: true,
        contact: { id: 'commenter:900800700600500_111' },
        text: '',
        at: new Date(1762000061 * 1000).toISOString(),
      },
    ]);
    expect(parseFacebookNotice(raw, now).accountId).toBe(PAGE_ID);
  });
});

describe('FacebookPageConversations adapter (#2307)', () => {
  it('replies to a comment, hides and unhides a comment, subscribes the Page, and reconciles recent comments', async () => {
    const calls: { method: string; url: URL; form: URLSearchParams }[] = [];
    const fetchImpl: Fetch = async (input, init) => {
      const url = new URL(input);
      const method = init?.method ?? 'GET';
      const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
      calls.push({ method, url, form });
      if (method === 'POST' && url.pathname === '/v24.0/900800700600500_111/comments') {
        return new Response(JSON.stringify({ id: '900800700600500_222' }), { status: 200 });
      }
      if (method === 'POST' && url.pathname === '/v24.0/900800700600500_111') {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (method === 'POST' && url.pathname === `/v24.0/${PAGE_ID}/subscribed_apps`) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (method === 'GET' && url.pathname === `/v24.0/${PAGE_ID}/published_posts`) {
        return new Response(JSON.stringify({ data: [{ id: POST_ID }] }), { status: 200 });
      }
      if (method === 'GET' && url.pathname === `/v24.0/${POST_ID}/comments`) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: '900800700600500_111',
                message: 'Bình luận từ lịch sử',
                created_time: '2026-11-04T10:00:00+0000',
                from: { id: '777888999', name: 'Nguyễn Lan' },
                is_hidden: false,
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: { message: 'unexpected', code: 1 } }), { status: 500 });
    };

    const publisher = new FacebookPagePublisher({ appSecret: SECRET }, fetchImpl);
    const conversations = publisher.conversations;
    expect(conversations).toBeDefined();

    const replied = await conversations!.reply({
      secret: TOKEN,
      externalAccountId: PAGE_ID,
      kind: 'comment_thread',
      threadId: '900800700600500_111',
      postId: POST_ID,
      contactId: '777888999',
      text: 'Cảm ơn bạn đã nhắn tiệm!',
      callKey: 'call-reply-1',
    });
    expect(replied).toEqual({ kind: 'accepted', externalId: '900800700600500_222' });
    expect(calls[0]?.form.get('message')).toBe('Cảm ơn bạn đã nhắn tiệm!');

    const hidden = await conversations!.hide!({
      secret: TOKEN,
      externalAccountId: PAGE_ID,
      externalMessageId: '900800700600500_111',
      hidden: true,
      callKey: 'call-hide-1',
    });
    expect(hidden).toEqual({ kind: 'done' });
    expect(calls[1]?.form.get('is_hidden')).toBe('true');

    const history = await conversations!.history!({
      secret: TOKEN,
      externalAccountId: PAGE_ID,
      since: new Date('2026-11-04T00:00:00Z'),
      maxChats: 10,
    });
    expect(history).toEqual({
      kind: 'ok',
      complete: true,
      oldest: '2026-11-04T10:00:00.000Z',
      events: [
        {
          kind: 'comment_thread',
          threadId: '900800700600500_111',
          postId: POST_ID,
          messageId: '900800700600500_111',
          direction: 'in',
          hidden: false,
          contact: { id: '777888999', name: 'Nguyễn Lan' },
          text: 'Bình luận từ lịch sử',
          at: '2026-11-04T10:00:00.000Z',
        },
      ],
    });
  });

  it('maps Graph error codes to rejected and unknown ConversationCallResult / ConversationHideResult', async () => {
    const makeAdapter = (status: number, body: unknown) =>
      new FacebookPagePublisher(
        { appSecret: SECRET },
        async () => new Response(JSON.stringify(body), { status }),
      ).conversations!;

    expect(
      await makeAdapter(400, { error: { message: 'Invalid OAuth access token.', code: 190 } }).reply({
        secret: TOKEN,
        externalAccountId: PAGE_ID,
        kind: 'comment_thread',
        threadId: '900800700600500_111',
        postId: POST_ID,
        contactId: '777888999',
        text: 'Hi',
        callKey: 'call-1',
      }),
    ).toMatchObject({ kind: 'rejected', error: 'token_expired', code: '190' });

    expect(
      await makeAdapter(400, { error: { message: 'Permissions error', code: 200 } }).reply({
        secret: TOKEN,
        externalAccountId: PAGE_ID,
        kind: 'comment_thread',
        threadId: '900800700600500_111',
        postId: POST_ID,
        contactId: '777888999',
        text: 'Hi',
        callKey: 'call-2',
      }),
    ).toMatchObject({ kind: 'rejected', error: 'permission', code: '200' });

    expect(
      await makeAdapter(429, { error: { message: 'Application request limit reached', code: 4 } }).reply({
        secret: TOKEN,
        externalAccountId: PAGE_ID,
        kind: 'comment_thread',
        threadId: '900800700600500_111',
        postId: POST_ID,
        contactId: '777888999',
        text: 'Hi',
        callKey: 'call-3',
      }),
    ).toMatchObject({ kind: 'rejected', error: 'rate_limited', code: '4' });

    expect(
      await makeAdapter(400, { error: { message: 'Unsupported post request. Object with ID does not exist', code: 100 } }).hide!({
        secret: TOKEN,
        externalAccountId: PAGE_ID,
        externalMessageId: '900800700600500_111',
        hidden: true,
        callKey: 'call-4',
      }),
    ).toMatchObject({ kind: 'rejected', error: 'bad_request', code: '100' });
  });
});
