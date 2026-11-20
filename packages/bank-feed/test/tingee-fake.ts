// SPDX-License-Identifier: AGPL-3.0-only
// A fake Tingee for the adapter's tests (#2045 S1): no network and no real data. It is a `fetch` the adapter is handed, and it answers the way Tingee's public documentation
// says (https://developers.tingee.vn/docs/, read 2026-11-20): it checks the client id, the timestamp window, the HMAC-SHA512 signature, a repeated signature and the rate
// limit, then answers the two read endpoints the adapter uses. Its fixtures are written by hand from the documented shapes.
import { createHmac } from 'node:crypto';
import type { Fetch } from '../src/index.ts';

export interface FakeAccount {
  accountNumber: string;
  vaAccountNumber: string;
  bankBin: string;
  bankName: string;
  accountName: string;
  status: 'active' | 'inactive' | 'lock';
  transactionType?: 'credit' | 'debit';
}

export interface FakeTransaction {
  transactionId: string;
  code: string;
  // The digits as Tingee writes the JSON number, so an amount beyond 2^53 or with a fraction reaches the adapter untouched.
  amount: string;
  type: 'credit' | 'debit';
  content?: string;
  accountNumber: string;
  vaAccountNumber: string;
  // yyyyMMddHHmmss, Vietnam time.
  transactionDate: string;
  [extra: string]: unknown;
}

const DAY_MS = 86_400_000;
const VIETNAM_OFFSET_MS = 7 * 3_600_000;

const stampToMs = (text: string): number | null => {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})?$/.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  return Date.UTC(y, mo - 1, d, h, mi, s, m[7] ? Number(m[7]) : 0) - VIETNAM_OFFSET_MS;
};

export interface Seen {
  path: string;
  host: string;
  body: Record<string, unknown>;
  code: string;
}

export class FakeTingee {
  readonly requests: Seen[] = [];
  private readonly signatures: Array<{ signature: string; at: number }> = [];
  private readonly calls: number[] = [];

  private readonly clock: { now: Date };
  private readonly credentials: Readonly<Record<string, string>>;
  accounts: FakeAccount[];
  transactions: FakeTransaction[];
  private readonly options: { accountPageCap?: number };

  constructor(
    // The fake's own clock; the adapter's may differ (a skewed server).
    clock: { now: Date },
    credentials: Readonly<Record<string, string>>,
    accounts: FakeAccount[] = [],
    transactions: FakeTransaction[] = [],
    options: { accountPageCap?: number } = {},
  ) {
    this.clock = clock;
    this.credentials = credentials;
    this.accounts = accounts;
    this.transactions = transactions;
    this.options = options;
  }

  private reply(code: string, message: string, data?: unknown): Response {
    const text = JSON.stringify({ code, message, ...(data === undefined ? {} : { data }) });
    // An amount is a JSON number in Tingee's answer: put the digits back as a bare token.
    return new Response(text.replace(/"__AMOUNT__([^"]*)"/g, '$1'), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  readonly fetch: Fetch = async (input, init) => {
    const url = new URL(input);
    const headers = new Headers(init?.headers);
    const raw = typeof init?.body === 'string' ? init.body : '';
    const at = this.clock.now.getTime();
    const record = (code: string): void => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        /* an unreadable body is recorded empty */
      }
      this.requests.push({ path: url.pathname, host: url.hostname, body, code });
    };
    const refuse = (code: string, message: string): Response => {
      record(code);
      return this.reply(code, message);
    };
    // 20 requests in 10 seconds per address.
    this.calls.push(at);
    while (this.calls.length > 0 && (this.calls[0] as number) < at - 10_000) this.calls.shift();
    if (this.calls.length > 20) return refuse('1001', 'Too many requests');
    const clientId = headers.get('x-client-id') ?? '';
    const secret = Object.hasOwn(this.credentials, clientId) ? (this.credentials[clientId] as string) : null;
    if (secret === null) return refuse('92', 'Merchant not found');
    const stamp = headers.get('x-request-timestamp') ?? '';
    const sent = /^\d{17}$/.test(stamp) ? stampToMs(stamp) : null;
    if (sent === null) return refuse('90', 'Timestamp is not in correct format.');
    if (sent > at + 90_000 || sent < at - 11 * 60_000) return refuse('91', 'Request expired.');
    const signature = headers.get('x-signature') ?? '';
    const expected = createHmac('sha512', secret).update(`${stamp}:${raw}`, 'utf8').digest('hex');
    if (signature !== expected) return refuse('97', 'Invalid signature');
    const earlier = this.signatures.findIndex((s) => s.signature === signature && s.at > at - 12 * 60_000);
    if (earlier >= 0) return refuse('97', 'Duplicate request.');
    this.signatures.push({ signature, at });
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return refuse('99', 'Error');
    }
    const skip = Number(body.skipCount ?? 0);
    const size = Math.min(Number(body.maxResultCount ?? 10), url.pathname === '/v1/get-va-paging' ? (this.options.accountPageCap ?? 2000) : 200);

    if (url.pathname === '/v1/get-va-paging') {
      record('00');
      return this.reply('00', 'Success', { totalCount: this.accounts.length, items: this.accounts.slice(skip, skip + size).map((a) => ({ ...a, creationTime: '2026-01-01T00:00:00Z', shopId: 1 })) });
    }
    if (url.pathname === '/v1/transaction/get-paging') {
      const start = stampToMs(String(body.startTime ?? ''));
      const end = stampToMs(String(body.endTime ?? ''));
      if (start === null || end === null) return refuse('99', 'Error');
      // At most 10 days between the two ends.
      if (end - start > 10 * DAY_MS) return refuse('1107', 'Time range too long');
      const wanted = Array.isArray(body.vaAccountNumbers) ? (body.vaAccountNumbers as string[]) : null;
      const found = this.transactions
        .filter((t) => (wanted === null || wanted.includes(t.vaAccountNumber)) && (stampToMs(t.transactionDate) as number) >= start && (stampToMs(t.transactionDate) as number) <= end)
        // Newest first: the order of Tingee's answer is not documented, and the adapter must not rely on it.
        .sort((a, b) => (a.transactionDate < b.transactionDate ? 1 : a.transactionDate > b.transactionDate ? -1 : 0));
      record('00');
      const items = found.slice(skip, skip + size).map((t) => ({ ...t, merchantId: 1, shopId: 1, bankBin: '970418', cashFlowSource: 'bank-transfer', currency: 'VND', amount: `__AMOUNT__${t.amount}` }));
      return this.reply('00', 'Success', { totalCount: found.length, items });
    }
    return refuse('99', 'Error');
  };
}
