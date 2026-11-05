// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FACEBOOK_MAX_NOTICE_BYTES,
  FacebookPagePublisher,
  InstagramPublisher,
  metaSignatureOk,
  parseFacebookNotice,
  parseFacebookNotices,
  parseInstagramNotice,
  parseInstagramNotices,
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

  it('parses Messenger messages, message_echoes, is_deleted, attachments, and ignores standby (#2308)', () => {
    const now = 1762000500 * 1000;
    const payload = {
      object: 'page',
      entry: [
        {
          id: PAGE_ID,
          time: 1762000400 * 1000,
          messaging: [
            {
              sender: { id: 'psid-customer-1' },
              recipient: { id: PAGE_ID },
              timestamp: 1762000401 * 1000,
              message: {
                mid: 'm_inbound_1',
                text: 'Chào shop, mình muốn đặt bánh sinh nhật',
                attachments: [
                  {
                    type: 'image',
                    payload: { url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=123' },
                  },
                ],
              },
            },
            {
              sender: { id: PAGE_ID },
              recipient: { id: 'psid-customer-1' },
              timestamp: 1762000402 * 1000,
              message: {
                mid: 'm_echo_1',
                is_echo: true,
                text: 'Dạ shop chào bạn ạ!',
              },
            },
            {
              sender: { id: 'psid-customer-1' },
              recipient: { id: PAGE_ID },
              timestamp: 1762000403 * 1000,
              message: {
                mid: 'm_inbound_1',
                is_deleted: true,
              },
            },
            {
              sender: { id: 'psid-customer-1' },
              recipient: { id: PAGE_ID },
              timestamp: 1762000404 * 1000,
              message: {
                mid: 'm_sticker_1',
                attachments: [{ type: 'audio', payload: { url: 'https://lookaside.fbsbx.com/audio.mp3' } }],
              },
            },
            // Delivery/read notice without message is ignored.
            {
              sender: { id: 'psid-customer-1' },
              recipient: { id: PAGE_ID },
              timestamp: 1762000405 * 1000,
              delivery: { mids: ['m_echo_1'], watermark: 1762000405 * 1000 },
            },
          ],
          standby: [
            {
              sender: { id: 'psid-customer-2' },
              recipient: { id: PAGE_ID },
              timestamp: 1762000406 * 1000,
              message: { mid: 'm_standby_ignored', text: 'Should be ignored while in standby' },
            },
          ],
        },
      ],
    };

    const notices = parseFacebookNotices(new TextEncoder().encode(JSON.stringify(payload)), now);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.events).toEqual([
      {
        kind: 'direct',
        threadId: 'psid-customer-1',
        messageId: 'm_inbound_1',
        direction: 'in',
        contact: { id: 'psid-customer-1' },
        text: 'Chào shop, mình muốn đặt bánh sinh nhật',
        attachments: [{ kind: 'image', url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=123' }],
        at: new Date(1762000401 * 1000).toISOString(),
      },
      {
        kind: 'direct',
        threadId: 'psid-customer-1',
        messageId: 'm_echo_1',
        direction: 'out',
        contact: { id: 'psid-customer-1' },
        text: 'Dạ shop chào bạn ạ!',
        at: new Date(1762000402 * 1000).toISOString(),
      },
      {
        kind: 'direct',
        threadId: 'psid-customer-1',
        messageId: 'm_inbound_1',
        direction: 'in',
        removed: true,
        contact: { id: 'psid-customer-1' },
        text: '',
        at: new Date(1762000403 * 1000).toISOString(),
      },
      {
        kind: 'direct',
        threadId: 'psid-customer-1',
        messageId: 'm_sticker_1',
        direction: 'in',
        contact: { id: 'psid-customer-1' },
        text: '[Khách gửi tin nhắn đính kèm]',
        at: new Date(1762000404 * 1000).toISOString(),
      },
    ]);
  });

  it('sends Messenger RESPONSE within 24h, HUMAN_AGENT up to 7d, private reply by comment_id, and maps Messenger subcodes (#2308)', async () => {
    const psid = '700800900100200';
    const sentPayloads: Record<string, unknown>[] = [];
    const fetchImpl: Fetch = async (input, init) => {
      const url = new URL(input);
      if (init?.method === 'POST' && url.pathname === `/v24.0/${PAGE_ID}/messages`) {
        const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
        sentPayloads.push(body);
        return new Response(JSON.stringify({ recipient_id: psid, message_id: `m_out_${sentPayloads.length}` }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: 'unexpected', code: 1 } }), { status: 500 });
    };
    const conversations = new FacebookPagePublisher({ appSecret: SECRET }, fetchImpl).conversations!;

    // 1. Within 24h -> RESPONSE
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    const res24h = await conversations.reply({
      secret: TOKEN,
      externalAccountId: PAGE_ID,
      kind: 'direct',
      threadId: psid,
      postId: null,
      contactId: psid,
      text: 'Dạ tiệm gửi báo giá ạ',
      lastInboundAt: twoHoursAgo,
      callKey: 'dm-1',
    });
    expect(res24h).toEqual({ kind: 'accepted', externalId: 'm_out_1' });
    expect(sentPayloads[0]).toEqual({
      recipient: { id: psid },
      messaging_type: 'RESPONSE',
      message: { text: 'Dạ tiệm gửi báo giá ạ' },
    });

    // 2. Between 24h and 7d -> MESSAGE_TAG + HUMAN_AGENT
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600_000).toISOString();
    const res7d = await conversations.reply({
      secret: TOKEN,
      externalAccountId: PAGE_ID,
      kind: 'direct',
      threadId: psid,
      postId: null,
      contactId: psid,
      text: 'Tiệm cập nhật đơn hàng của bạn ạ',
      lastInboundAt: threeDaysAgo,
      callKey: 'dm-2',
    });
    expect(res7d).toEqual({ kind: 'accepted', externalId: 'm_out_2' });
    expect(sentPayloads[1]).toEqual({
      recipient: { id: psid },
      messaging_type: 'MESSAGE_TAG',
      tag: 'HUMAN_AGENT',
      message: { text: 'Tiệm cập nhật đơn hàng của bạn ạ' },
    });

    // 3. Past 7d -> rejected locally with FB_WINDOW_CLOSED
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
    const resClosed = await conversations.reply({
      secret: TOKEN,
      externalAccountId: PAGE_ID,
      kind: 'direct',
      threadId: psid,
      postId: null,
      contactId: psid,
      text: 'Quá hạn 7 ngày',
      lastInboundAt: eightDaysAgo,
      callKey: 'dm-3',
    });
    expect(resClosed).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'FB_WINDOW_CLOSED' });

    // 4. Private reply to comment (`threadId: "private:<comment_id>"`)
    const resPriv = await conversations.reply({
      secret: TOKEN,
      externalAccountId: PAGE_ID,
      kind: 'direct',
      threadId: 'private:900800700600500_111',
      postId: POST_ID,
      contactId: '777888999',
      text: 'Chào bạn, tiệm nhắn riêng báo giá nhé!',
      callKey: 'priv-1',
    });
    expect(resPriv).toEqual({ kind: 'accepted', externalId: 'm_out_3' });
    expect(sentPayloads[2]).toEqual({
      recipient: { comment_id: '900800700600500_111' },
      message: { text: 'Chào bạn, tiệm nhắn riêng báo giá nhé!' },
    });

    // 5. >2000 chars rejected locally
    const resTooLong = await conversations.reply({
      secret: TOKEN,
      externalAccountId: PAGE_ID,
      kind: 'direct',
      threadId: psid,
      postId: null,
      contactId: psid,
      text: 'x'.repeat(2001),
      lastInboundAt: twoHoursAgo,
      callKey: 'dm-long',
    });
    expect(resTooLong).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'FB_TEXT_LENGTH' });

    // 6. Messenger Graph subcodes map to structured rejection reasons
    const makeErrAdapter = (code: number, error_subcode?: number) =>
      new FacebookPagePublisher(
        { appSecret: SECRET },
        async () => new Response(JSON.stringify({ error: { message: 'Messenger error', code, ...(error_subcode ? { error_subcode } : {}) } }), { status: 400 }),
      ).conversations!;

    expect(
      await makeErrAdapter(10, 2018278).reply({
        secret: TOKEN,
        externalAccountId: PAGE_ID,
        kind: 'direct',
        threadId: psid,
        postId: null,
        contactId: psid,
        text: 'Hi',
        lastInboundAt: twoHoursAgo,
        callKey: 'err-win',
      }),
    ).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'FB_WINDOW_CLOSED' });

    expect(
      await makeErrAdapter(100, 10900).reply({
        secret: TOKEN,
        externalAccountId: PAGE_ID,
        kind: 'direct',
        threadId: 'private:900800700600500_111',
        postId: POST_ID,
        contactId: '777888999',
        text: 'Hi',
        callKey: 'err-priv',
      }),
    ).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'FB_PRIVATE_REPLIED' });

    expect(
      await makeErrAdapter(551).reply({
        secret: TOKEN,
        externalAccountId: PAGE_ID,
        kind: 'direct',
        threadId: psid,
        postId: null,
        contactId: psid,
        text: 'Hi',
        lastInboundAt: twoHoursAgo,
        callKey: 'err-551',
      }),
    ).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'FB_RECIPIENT_UNAVAILABLE' });
  });
});

describe('parseInstagramNotices & InstagramConversations (#2309)', () => {
  const IG_ID = '17841400000000001';
  const IG_MEDIA_ID = '18000000000000099';
  const IG_SECRET = JSON.stringify({ accessToken: 'p'.repeat(24), pageId: PAGE_ID });

  it('parses Instagram comments, live_comments, and direct messages, and ignores standby', () => {
    const now = 1762000600 * 1000;
    const payload = {
      object: 'instagram',
      entry: [
        {
          id: IG_ID,
          time: 1762000500,
          changes: [
            {
              field: 'comments',
              value: {
                id: '17900000000000111',
                text: 'Áo này còn size M không shop?',
                timestamp: 1762000501,
                from: { id: '900100200300400', username: 'linh.nguyen' },
                media: { id: IG_MEDIA_ID, media_product_type: 'FEED' },
              },
            },
            {
              field: 'comments',
              value: {
                id: '17900000000000222',
                parent_id: '17900000000000111',
                text: 'Dạ còn bạn nhé!',
                timestamp: 1762000502,
                from: { id: IG_ID, username: 'quan.a' },
                media: { id: IG_MEDIA_ID },
              },
            },
          ],
          messaging: [
            {
              sender: { id: 'igsid-customer-1' },
              recipient: { id: IG_ID },
              timestamp: 1762000505 * 1000,
              message: {
                mid: 'ig_mid_1',
                text: 'Gửi ảnh mẫu giúp mình nhé',
                attachments: [
                  {
                    type: 'image',
                    payload: { url: 'https://scontent.cdninstagram.com/v/t51.2885-15/sample.jpg' },
                  },
                ],
              },
            },
            {
              sender: { id: 'igsid-customer-1' },
              recipient: { id: IG_ID },
              timestamp: 1762000506 * 1000,
              message: {
                mid: 'ig_mid_unsupported',
                is_unsupported: true,
              },
            },
          ],
          standby: [
            {
              sender: { id: 'igsid-customer-2' },
              recipient: { id: IG_ID },
              timestamp: 1762000507 * 1000,
              message: { mid: 'ig_standby_1', text: 'Ignored standby' },
            },
          ],
        },
      ],
    };

    const raw = new TextEncoder().encode(JSON.stringify(payload));
    const notices = parseInstagramNotices(raw, now);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.accountId).toBe(IG_ID);
    expect(notices[0]?.events).toEqual([
      {
        kind: 'comment_thread',
        threadId: '17900000000000111',
        postId: IG_MEDIA_ID,
        messageId: '17900000000000111',
        direction: 'in',
        contact: { id: '900100200300400', name: 'linh.nguyen' },
        text: 'Áo này còn size M không shop?',
        at: new Date(1762000501 * 1000).toISOString(),
      },
      {
        kind: 'comment_thread',
        threadId: '17900000000000111',
        postId: IG_MEDIA_ID,
        messageId: '17900000000000222',
        direction: 'out',
        contact: { id: 'commenter:17900000000000111' },
        text: 'Dạ còn bạn nhé!',
        at: new Date(1762000502 * 1000).toISOString(),
      },
      {
        kind: 'direct',
        threadId: 'igsid-customer-1',
        messageId: 'ig_mid_1',
        direction: 'in',
        contact: { id: 'igsid-customer-1' },
        text: 'Gửi ảnh mẫu giúp mình nhé',
        attachments: [{ kind: 'image', url: 'https://scontent.cdninstagram.com/v/t51.2885-15/sample.jpg' }],
        at: new Date(1762000505 * 1000).toISOString(),
      },
      {
        kind: 'direct',
        threadId: 'igsid-customer-1',
        messageId: 'ig_mid_unsupported',
        direction: 'in',
        contact: { id: 'igsid-customer-1' },
        text: '[Khách gửi tin nhắn đính kèm]',
        at: new Date(1762000506 * 1000).toISOString(),
      },
    ]);
    expect(parseInstagramNotice(raw, now).accountId).toBe(IG_ID);
    expect(parseFacebookNotices(raw, now)).toEqual([]);
  });

  it('replies to Instagram comments, DMs (24h/7d/1000-char cap), private replies, hides comments, subscribes Page, and reconciles media comments', async () => {
    const IGSID = '700800900100300';
    const calls: { method: string; path: string; form: URLSearchParams; json: Record<string, unknown> | null; query: URLSearchParams }[] = [];
    const fetchImpl: Fetch = async (input, init) => {
      const url = new URL(input);
      const method = init?.method ?? 'GET';
      const path = url.pathname;
      const contentType = new Headers(init?.headers).get('content-type') ?? '';
      const rawBody = typeof init?.body === 'string' ? init.body : '';
      const json = contentType.includes('application/json') && rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : null;
      const form = new URLSearchParams(json ? '' : rawBody);
      calls.push({ method, path, form, json, query: url.searchParams });

      if (method === 'POST' && path === '/v24.0/17900000000000111/replies') {
        return new Response(JSON.stringify({ id: '17900000000000333' }), { status: 200 });
      }
      if (method === 'POST' && path === `/v24.0/${IG_ID}/messages`) {
        return new Response(JSON.stringify({ recipient_id: IGSID, message_id: `ig_out_${calls.length}` }), { status: 200 });
      }
      if (method === 'POST' && path === '/v24.0/17900000000000111') {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (method === 'POST' && path === `/v24.0/${PAGE_ID}/subscribed_apps`) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (method === 'GET' && path === `/v24.0/${IG_ID}/media`) {
        return new Response(JSON.stringify({ data: [{ id: IG_MEDIA_ID }] }), { status: 200 });
      }
      if (method === 'GET' && path === `/v24.0/${IG_MEDIA_ID}/comments`) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: '17900000000000111',
                text: 'Bình luận gốc trên IG',
                timestamp: '2026-11-04T10:00:00+0000',
                username: 'khach.ig',
                from: { id: '900100200300400', username: 'khach.ig' },
                hidden: false,
                replies: {
                  data: [
                    {
                      id: '17900000000000222',
                      text: 'Shop trả lời trên IG',
                      timestamp: '2026-11-04T10:05:00+0000',
                      username: 'quan.a',
                      from: { id: IG_ID, username: 'quan.a' },
                      hidden: false,
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: { message: 'unexpected', code: 1 } }), { status: 500 });
    };

    const conversations = new InstagramPublisher({ appSecret: SECRET }, fetchImpl).conversations;

    // 1. Public comment reply (up to 2200 chars)
    const commentReply = await conversations.reply({
      secret: IG_SECRET,
      externalAccountId: IG_ID,
      kind: 'comment_thread',
      threadId: '17900000000000111',
      postId: IG_MEDIA_ID,
      contactId: '900100200300400',
      text: 'Dạ shop còn hàng ạ!',
      callKey: 'ig-c-1',
    });
    expect(commentReply).toEqual({ kind: 'accepted', externalId: '17900000000000333' });
    expect(calls[0]?.form.get('message')).toBe('Dạ shop còn hàng ạ!');

    const commentTooLong = await conversations.reply({
      secret: IG_SECRET,
      externalAccountId: IG_ID,
      kind: 'comment_thread',
      threadId: '17900000000000111',
      postId: IG_MEDIA_ID,
      contactId: '900100200300400',
      text: 'x'.repeat(2201),
      callKey: 'ig-c-long',
    });
    expect(commentTooLong).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'IG_COMMENT_LENGTH' });

    // 2. Direct message within 24h and between 24h-7d, plus 1000-char limit
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
    const dm24h = await conversations.reply({
      secret: IG_SECRET,
      externalAccountId: IG_ID,
      kind: 'direct',
      threadId: IGSID,
      postId: null,
      contactId: IGSID,
      text: 'Chào bạn trên Instagram!',
      lastInboundAt: oneHourAgo,
      callKey: 'ig-dm-1',
    });
    expect(dm24h).toEqual({ kind: 'accepted', externalId: 'ig_out_2' });
    expect(calls[1]?.json).toEqual({
      recipient: { id: IGSID },
      messaging_type: 'RESPONSE',
      message: { text: 'Chào bạn trên Instagram!' },
    });

    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600_000).toISOString();
    const dm7d = await conversations.reply({
      secret: IG_SECRET,
      externalAccountId: IG_ID,
      kind: 'direct',
      threadId: IGSID,
      postId: null,
      contactId: IGSID,
      text: 'Nhân viên hỗ trợ trả lời sau 24h',
      lastInboundAt: twoDaysAgo,
      callKey: 'ig-dm-2',
    });
    expect(dm7d).toEqual({ kind: 'accepted', externalId: 'ig_out_3' });
    expect(calls[2]?.json).toEqual({
      recipient: { id: IGSID },
      messaging_type: 'MESSAGE_TAG',
      tag: 'HUMAN_AGENT',
      message: { text: 'Nhân viên hỗ trợ trả lời sau 24h' },
    });

    const dmTooLong = await conversations.reply({
      secret: IG_SECRET,
      externalAccountId: IG_ID,
      kind: 'direct',
      threadId: IGSID,
      postId: null,
      contactId: IGSID,
      text: 'x'.repeat(1001),
      lastInboundAt: oneHourAgo,
      callKey: 'ig-dm-long',
    });
    expect(dmTooLong).toMatchObject({ kind: 'rejected', error: 'bad_request', code: 'IG_TEXT_LENGTH' });

    // 3. Private reply to an Instagram comment
    const privReply = await conversations.reply({
      secret: IG_SECRET,
      externalAccountId: IG_ID,
      kind: 'direct',
      threadId: 'private:17900000000000111',
      postId: IG_MEDIA_ID,
      contactId: '900100200300400',
      text: 'Shop gửi báo giá qua tin nhắn riêng nhé!',
      callKey: 'ig-priv-1',
    });
    expect(privReply).toEqual({ kind: 'accepted', externalId: 'ig_out_4' });
    expect(calls[3]?.json).toEqual({
      recipient: { comment_id: '17900000000000111' },
      message: { text: 'Shop gửi báo giá qua tin nhắn riêng nhé!' },
    });

    // 4. Hide comment (`hide=true`)
    const hidden = await conversations.hide!({
      secret: IG_SECRET,
      externalAccountId: IG_ID,
      externalMessageId: '17900000000000111',
      hidden: true,
      callKey: 'ig-hide-1',
    });
    expect(hidden).toEqual({ kind: 'done' });
    expect(calls[4]?.form.get('hide')).toBe('true');

    // 5. Subscribe linked Facebook Page
    const sub = await conversations.subscribe({
      secret: IG_SECRET,
      externalAccountId: IG_ID,
    });
    expect(sub).toEqual({ ok: true });
    expect(calls[5]?.path).toBe(`/v24.0/${PAGE_ID}/subscribed_apps`);
    expect(calls[5]?.form.get('subscribed_fields')).toBe('feed,messages,message_echoes');

    // 6. History reconciliation
    const history = await conversations.history!({
      secret: IG_SECRET,
      externalAccountId: IG_ID,
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
          threadId: '17900000000000111',
          postId: IG_MEDIA_ID,
          messageId: '17900000000000111',
          direction: 'in',
          hidden: false,
          contact: { id: '900100200300400', name: 'khach.ig' },
          text: 'Bình luận gốc trên IG',
          at: '2026-11-04T10:00:00.000Z',
        },
        {
          kind: 'comment_thread',
          threadId: '17900000000000111',
          postId: IG_MEDIA_ID,
          messageId: '17900000000000222',
          direction: 'out',
          hidden: false,
          contact: { id: 'commenter:17900000000000111' },
          text: 'Shop trả lời trên IG',
          at: '2026-11-04T10:05:00.000Z',
        },
      ],
    });
  });
});
