// SPDX-License-Identifier: AGPL-3.0-only
// Meta's data deletion callback, one URL for every Meta connection of the deployment (a Meta app has exactly one callback URL;
// ads plan section 9 #2219, conversations plan CV6 #2305, separate write app #2366). The signed request is checked against each Meta
// app secret the deployment holds (the read Ads app's, the write app's that runs ads, and the Pages app's, which may be one app or
// several), and a verified one is fanned out: the Ads accounts the
// person granted (crove_ads.deletion_request) and the conversations of the connections they granted
// (crove_kernel.conversation_deletion_request) each get a request under the same confirmation code. The Meta user id and the body
// are stored nowhere; each side keeps only the keyed hash its connections carry. The worker erases; the status page Meta shows the
// person reads both sides by the code.
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { platformUserHash } from '@crove/ad-platform';
import { DomainError, type Runtime } from '@crove/kernel-runtime';
import { verifySignedRequest, type AdsDeletionOutcome } from './ads-deletion.ts';

export interface MetaDeletionApps {
  // The Ads app's secret, when the Ads module is installed and its app configured.
  ads?: string | undefined;
  // The secret of the app that runs ads (the write connection's), when the Ads module is installed and the app configured. It may be the
  // Ads app or a separate one: the hash of a person who granted the write connection is keyed with this secret, and the request is
  // queued under the hash of the secret that verified it, so the worker finds the right grant whichever app the person removed.
  adsWrite?: string | undefined;
  // The Pages app's secret (the conversations of Facebook Pages and Instagram), when configured.
  conversations?: string | undefined;
  // The Instagram app's secret when Instagram has an app of its own (#2212): a person who granted Instagram through it is hashed with it.
  instagram?: string | undefined;
}

// A person's request, verified against every configured app and queued on each side the app serves. With none configured nothing is
// accepted. The code answered is the Ads side's when it has one, else the conversations side's: a person who asked twice, with one
// side's earlier request still open and the other's finished, sees the open one's code, and both sides' statuses answer by it.
export async function acceptMetaDeletion(runtime: Runtime, apps: MetaDeletionApps, body: string, now: number = Date.now()): Promise<AdsDeletionOutcome> {
  const signed = new URLSearchParams(body).get('signed_request');
  if (!signed) return { status: 400, code: 'DELETION_MALFORMED' };
  const targets: Array<{ side: 'ads' | 'conversations'; secret: string; userId: string }> = [];
  // The Ads side has two apps at most (read and write); one that is the same app as the other is asked once.
  const candidates: Array<{ side: 'ads' | 'conversations'; secret: string | undefined }> = [
    { side: 'ads', secret: apps.ads },
    { side: 'ads', secret: apps.adsWrite },
    { side: 'conversations', secret: apps.conversations },
    { side: 'conversations', secret: apps.instagram },
  ];
  for (const { side, secret } of candidates) {
    if (!secret || targets.some((t) => t.side === side && t.secret === secret)) continue;
    const userId = verifySignedRequest(signed, secret, now);
    if (userId !== null) targets.push({ side, secret, userId });
  }
  if (targets.length === 0) return { status: 401, code: 'DELETION_SIGNATURE' };
  const fresh = randomBytes(16).toString('hex');
  try {
    const codes = await runtime.orgless(async (db) => {
      const out: string[] = [];
      for (const t of targets) {
        const hash = platformUserHash(t.secret, t.userId);
        const { rows } =
          t.side === 'ads'
            ? await sql<{ code: string }>`SELECT crove_ads.deletion_request_enqueue(${fresh}, ${hash}) AS code`.execute(db)
            : await sql<{ code: string }>`SELECT crove_kernel.conversation_deletion_enqueue(${fresh}, ${hash}) AS code`.execute(db);
        if (rows[0]?.code) out.push(rows[0].code);
      }
      return out;
    });
    const [first, second] = codes;
    if (!first) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
    // Two sides with two codes (the person's earlier request is still open on one of them): the answer is the Ads side's code and the
    // conversations side's request is linked to it, so the status page of either code waits for both sides before it says "done".
    if (second && second !== first) {
      const linked = await runtime.orgless(async (db) => {
        const { rows } = await sql<{ linked: boolean }>`SELECT crove_kernel.conversation_deletion_link(${second}, ${first}) AS linked`.execute(db);
        return rows[0]?.linked === true;
      });
      // Not linked (the request closed meanwhile, or too many codes hang on it): the answer is not given, Meta asks again, and the next
      // request finds the sides as they are, so the page is never tied to one side only.
      if (!linked) return { status: 503, code: 'DELETION_BACKLOG' };
    }
    return { status: 200, code: first };
  } catch (error) {
    // The API login is not trusted with volume: past a table's limit its definer raises configuration_limit_exceeded, which the
    // runtime reports as OVERLOADED; Meta tries again later (an open request is found again by its person, so no row doubles).
    if (error instanceof DomainError && error.code === 'OVERLOADED') return { status: 503, code: 'DELETION_BACKLOG' };
    throw error;
  }
}

export interface MetaDeletionStatus {
  requestedAt: Date;
  completedAt: Date | null;
  accounts: number | null;
  connections: number | null;
}

// What the status page shows for a code: the request is complete when every side that holds it is, and unknown when none does.
export async function metaDeletionStatus(runtime: Runtime, code: string): Promise<MetaDeletionStatus | null> {
  if (!/^[0-9a-f]{32}$/.test(code)) return null;
  return runtime.orgless(async (db) => {
    const kernel = await sql<{ requested_at: Date; completed_at: Date | null; connections: number | null; ads_codes: string[] }>`
      SELECT requested_at, completed_at, connections, ads_codes FROM crove_kernel.conversation_deletion_status(${code})`.execute(db);
    // The Ads side holds the code itself or, when the two sides differ, any of the codes the conversations request is linked to.
    const adsCodes = kernel.rows[0]?.ads_codes ?? [code];
    const adsRows: Array<{ requested_at: Date; completed_at: Date | null; accounts: number | null }> = [];
    // Always asked, installed or not: an Ads request queued before the module was turned off is still open and nobody finishes it, and the
    // page must not call that deletion handled.
    for (const adsCode of adsCodes) {
      const found = await sql<{ requested_at: Date; completed_at: Date | null; accounts: number | null }>`
        SELECT requested_at, completed_at, accounts FROM crove_ads.deletion_request_status(${adsCode})`.execute(db);
      if (found.rows[0]) adsRows.push(found.rows[0]);
    }
    const k = kernel.rows[0];
    if (!k && adsRows.length === 0) return null;
    const sides = [...(k ? [k] : []), ...adsRows];
    const requestedAt = sides.map((s) => s.requested_at).sort((x, y) => x.getTime() - y.getTime())[0] as Date;
    const done = sides.every((s) => s.completed_at !== null);
    const completedAt = done ? (sides.map((s) => s.completed_at as Date).sort((x, y) => y.getTime() - x.getTime())[0] as Date) : null;
    return { requestedAt, completedAt, accounts: adsRows.length > 0 ? adsRows.reduce((n, r) => n + (r.accounts ?? 0), 0) : null, connections: k ? k.connections : null };
  });
}

// The status page's words, in Vietnamese and English (the person is a Meta user, in any language the app speaks).
export function renderMetaDeletionStatus(status: MetaDeletionStatus | null): string {
  const ads = status !== null && status.accounts !== null;
  const conversations = status !== null && status.connections !== null;
  // Each side that holds the request says what it did; a page for one side keeps that side's own words.
  const adsDone = (status?.accounts ?? 0) > 0;
  const convDone = (status?.connections ?? 0) > 0;
  const text = !status
    ? { vi: 'Không tìm thấy yêu cầu xóa dữ liệu này.', en: 'No such data deletion request was found.' }
    : !status.completedAt
      ? { vi: 'Yêu cầu đã được nhận và đang được xử lý, thường trong vòng một giờ.', en: 'The request was received and is being handled, usually within the hour.' }
      : ads && !conversations
        ? adsDone
          ? {
              vi: 'Số liệu quảng cáo, nhật ký cập nhật và các tài khoản quảng cáo bạn đã cấp quyền cho Ludy đã được xóa, và mã truy cập của chúng đã bị hủy.',
              en: 'The ad figures, update logs and ad accounts you granted to Ludy have been deleted, and their access tokens destroyed.',
            }
          : {
              vi: 'Yêu cầu đã được xử lý: không còn tài khoản quảng cáo nào bạn đã cấp quyền nằm trong Ludy, và quyền chạy quảng cáo bạn đã cấp (nếu có) đã được đóng cùng mã truy cập của nó.',
              en: 'The request has been handled: no ad account you granted is left in Ludy, and any permission to run ads you granted has been closed with its access token.',
            }
        : conversations && !ads
          ? convDone
            ? {
                vi: 'Tin nhắn và bình luận của khách trên các trang bạn đã cấp quyền cho Ludy đã được xóa, và mã truy cập của các trang đó đã bị hủy.',
                en: 'The customers\u2019 messages and comments on the pages you granted to Ludy have been deleted, and the pages\u2019 access tokens destroyed.',
              }
            : {
                vi: 'Yêu cầu đã được xử lý: Ludy không tìm thấy trang nào được liên kết với tài khoản của bạn. Nếu bạn đã kết nối một trang cho một tổ chức, hãy nhờ chủ sở hữu tổ chức xóa dữ liệu hội thoại hoặc ngắt kết nối trang đó.',
                en: 'The request has been handled: Ludy found no page linked to your account. If you connected a page for an organization, ask its owner to erase the conversation data or disconnect the page.',
              }
          : adsDone && convDone
            ? {
                vi: 'Dữ liệu bạn đã cấp quyền cho Ludy đã được xóa: số liệu quảng cáo và tài khoản quảng cáo, tin nhắn và bình luận của khách trên các trang đã kết nối, và mã truy cập của chúng đã bị hủy.',
                en: 'The data you granted to Ludy has been deleted: ad figures and ad accounts, customers\u2019 messages and comments on the connected pages, and their access tokens destroyed.',
              }
            : adsDone
              ? { vi: 'Số liệu quảng cáo, nhật ký cập nhật và các tài khoản quảng cáo bạn đã cấp quyền cho Ludy đã được xóa, và mã truy cập của chúng đã bị hủy.', en: 'The ad figures, update logs and ad accounts you granted to Ludy have been deleted, and their access tokens destroyed.' }
              : convDone
                ? { vi: 'Tin nhắn và bình luận của khách trên các trang bạn đã cấp quyền cho Ludy đã được xóa, và mã truy cập của các trang đó đã bị hủy.', en: 'The customers\u2019 messages and comments on the pages you granted to Ludy have been deleted, and the pages\u2019 access tokens destroyed.' }
            : {
                vi: 'Yêu cầu đã được xử lý: Ludy không tìm thấy tài khoản quảng cáo hay trang nào được liên kết với tài khoản của bạn. Nếu bạn đã kết nối một trang cho một tổ chức, hãy nhờ chủ sở hữu tổ chức xóa dữ liệu hội thoại hoặc ngắt kết nối trang đó.',
                en: 'The request has been handled: Ludy found no ad account or page linked to your account. If you connected a page for an organization, ask its owner to erase the conversation data or disconnect the page.',
              };
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Ludy</title></head><body><p>${text.vi}</p><p lang="en">${text.en}</p></body></html>`;
}
