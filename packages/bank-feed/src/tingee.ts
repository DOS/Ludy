// SPDX-License-Identifier: AGPL-3.0-only
// The Tingee bank feed adapter (ADR-0039, #2045 S1), built from Tingee's public documentation (https://developers.tingee.vn/docs/, read 2026-11-20) and nothing else.
// Each customer registers its own Tingee account, so the credential is the customer's Client ID and Secret Token (sealed by the kernel, opened by the worker only).
// It reads two endpoints: the accounts a credential reaches and the transactions of one account in a window. It calls nothing else: the interface has no capability that
// moves money, and this file names no path of any other Tingee product (a test reads this source to keep it so; it is a guard rail, and review is what holds the line).
// Every call goes through the fetch it is given, which the caller binds to the hosts below (allowlistedFetch(TINGEE_HOSTS)).
import { createHmac } from 'node:crypto';
import type { BankFeedAccount, BankFeedProvider, BankFeedPull, BankFeedTransaction, Fetch } from './index.ts';

const PRODUCTION_HOST = 'open-api.tingee.vn';
export const TINGEE_HOSTS: readonly string[] = [PRODUCTION_HOST];
// The UAT host, used only for the UAT run (S5); never part of the production allowlist.
export const TINGEE_UAT_HOST = 'uat-open-api.tingee.vn';

// The only two paths this adapter calls.
const ACCOUNTS_PATH = '/v1/get-va-paging';
const TRANSACTIONS_PATH = '/v1/transaction/get-paging';

// The documented limits: a window of at most 10 days, 200 transactions a page, 20 requests in 10 seconds per address.
const MAX_WINDOW_DAYS = 10;
const PAGE_SIZE = 200;
const ACCOUNT_PAGE_SIZE = 200;
// A pull is stored in one command, which takes at most 5000 lines (BANK_FEED_MAX_LINES): a window that would bring more is halved, down to a day.
const MAX_LINES_PER_PULL = 5000;
// The first pull goes back this far; a pull that reaches the present is read again from this far back next time, so a line the bank posted late is caught (its reference keys it).
const FIRST_PULL_DAYS = 31;
const OVERLAP_DAYS = 2;
// Pages one window may take, so a loop that never ends stops.
const MAX_PAGES = 100;
const DEFAULT_SPACING_MS = 600;
const DAY_MS = 86_400_000;
const VIETNAM_OFFSET_MS = 7 * 3_600_000;

export type TingeeErrorKind =
  // The Client ID or the Secret Token was refused (codes 92, 97 "Invalid signature").
  | 'credentials'
  // The clock of this server is out of Tingee's window (codes 90, 91).
  | 'clock'
  // Too many calls from this address (code 1001): the job retries later.
  | 'rate_limited'
  // A page the adapter will not store: a bad line, or more lines than one pull may carry. The cursor stays where it was.
  | 'bad_page'
  // Tingee answered something else, or not at all (an HTTP error, a code the adapter does not know, a duplicate request).
  | 'upstream'
  // The adapter was asked something it cannot do (a malformed credential or cursor, a host that is not Tingee's).
  | 'config';

// An error about a call or a page. Its message carries Tingee's numeric code and the position of a bad item, never the credential, a response body or a transaction's text.
export class TingeeError extends Error {
  readonly kind: TingeeErrorKind;
  readonly tingeeCode: string | null;
  constructor(kind: TingeeErrorKind, message: string, tingeeCode: string | null = null) {
    super(message);
    this.name = 'TingeeError';
    this.kind = kind;
    this.tingeeCode = tingeeCode;
  }
}

export interface TingeeOptions {
  // Bound to TINGEE_HOSTS by the caller (allowlistedFetch); the adapter uses no other.
  fetch: Fetch;
  now?: () => Date;
  // Pause between two calls, so one address stays under 20 calls in 10 seconds.
  spacingMs?: number;
  sleep?: (ms: number) => Promise<void>;
  // The documented production host by default; TINGEE_UAT_HOST for the UAT run.
  host?: typeof TINGEE_UAT_HOST | typeof PRODUCTION_HOST;
}

interface Credential {
  clientId: string;
  secretToken: string;
}

const hasControlCharacter = (text: string): boolean => [...text].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
const cleanText = (text: string): string => [...text].map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? ' ' : ch)).join('');

// The sealed secret of a connection: {"clientId": "...", "secretToken": "..."}. A malformed one is refused without echoing it.
export function parseTingeeSecret(secret: string): Credential {
  let value: unknown;
  try {
    value = JSON.parse(secret);
  } catch {
    throw new TingeeError('config', 'tingee: the stored credential is not readable');
  }
  const { clientId, secretToken } = (value ?? {}) as Record<string, unknown>;
  const fine = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 200 && v === v.trim() && !hasControlCharacter(v);
  if (!fine(clientId) || !fine(secretToken)) throw new TingeeError('config', 'tingee: the stored credential is not readable');
  return { clientId, secretToken };
}

// HMAC_SHA512(timestamp + ":" + body, secretToken), hex: how Tingee signs a request (config-info, "Sinh chu ky").
export function signTingeeRequest(secretToken: string, timestamp: string, body: string): string {
  return createHmac('sha512', secretToken).update(`${timestamp}:${body}`, 'utf8').digest('hex');
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');

// A clock reading in Vietnam time (UTC+7) as digits: yyyyMMddHHmmss, with the milliseconds when asked.
export function vietnamStamp(date: Date, withMillis = false): string {
  const v = new Date(date.getTime() + VIETNAM_OFFSET_MS);
  const base = `${v.getUTCFullYear()}${pad(v.getUTCMonth() + 1, 2)}${pad(v.getUTCDate(), 2)}${pad(v.getUTCHours(), 2)}${pad(v.getUTCMinutes(), 2)}${pad(v.getUTCSeconds(), 2)}`;
  return withMillis ? `${base}${pad(v.getUTCMilliseconds(), 3)}` : base;
}

// The instant of yyyyMMddHHmmss in Vietnam time, or null when it is not a real calendar time.
function parseStamp(text: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
  return ms - VIETNAM_OFFSET_MS;
}

// The response as JSON, with each `amount` kept as the digits Tingee wrote (a JSON number would go through a JS number, which Ludy's money never does).
function parseResponse(text: string): unknown {
  const reviver = (key: string, value: unknown, context?: { source?: string }): unknown => (key === 'amount' && typeof value === 'number' && typeof context?.source === 'string' ? context.source : value);
  return JSON.parse(text, reviver as unknown as Parameters<typeof JSON.parse>[1]);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// One transaction as Tingee reports it, as a line; a message names what is wrong with it (never its content).
function toLine(item: unknown, index: number): BankFeedTransaction | null {
  const bad = (what: string): never => {
    throw new TingeeError('bad_page', `tingee: transaction ${index} of the page has ${what}`);
  };
  if (!isRecord(item)) return bad('an unreadable shape');
  const type = item.type;
  if (type !== 'credit' && type !== 'debit') return bad('no known type');
  const raw = item.amount;
  if (typeof raw !== 'string' || !/^-?\d+(\.\d+)?$/.test(raw)) return bad('an unreadable amount');
  const negative = raw.startsWith('-');
  if (negative && type === 'credit') return bad('a negative credit');
  let digits = negative ? raw.slice(1) : raw;
  if (digits.includes('.')) digits = digits.replace(/0+$/, '').replace(/\.$/, '');
  digits = digits.replace(/^0+(?=\d)/, '');
  if (/^0(\.0*)?$/.test(digits)) return null;
  if (/\.\d{3,}$/.test(digits)) return bad('an amount with more than 2 decimals');
  // The most integer digits the ledger's money takes (zMoney).
  if (digits.split('.')[0]!.length > 16) return bad('an amount with more than 16 digits');
  const stamp = typeof item.transactionDate === 'string' ? item.transactionDate : '';
  if (parseStamp(stamp) === null) return bad('an unreadable date');
  const code = typeof item.code === 'string' ? item.code.trim() : '';
  const id = typeof item.transactionId === 'string' ? item.transactionId.trim() : '';
  const reference = code.length >= 1 && code.length <= 100 ? code : id.length >= 1 && id.length <= 100 ? id : '';
  if (reference === '') return bad('no reference');
  const content = typeof item.content === 'string' ? cleanText(item.content).slice(0, 1000) : '';
  return {
    date: `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`,
    description: content,
    amount: type === 'debit' ? `-${digits}` : digits,
    balance: null,
    reference,
  };
}

export function tingeeBankFeed(options: TingeeOptions): BankFeedProvider {
  const now = options.now ?? (() => new Date());
  const spacingMs = options.spacingMs ?? DEFAULT_SPACING_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const host = options.host ?? PRODUCTION_HOST;
  if (host !== PRODUCTION_HOST && host !== TINGEE_UAT_HOST) throw new TingeeError('config', 'tingee: that host is not Tingee\'s');
  let lastCall = Number.NEGATIVE_INFINITY;

  // One signed POST; the `data` of an answer whose code is "00".
  async function call(credential: Credential, path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    // The slot is taken before waiting, so two calls in flight at once are spaced from each other too.
    const slot = Math.max(now().getTime(), lastCall + spacingMs);
    const wait = slot - now().getTime();
    lastCall = slot;
    if (wait > 0) await sleep(wait);
    const body = JSON.stringify(payload);
    const timestamp = vietnamStamp(now(), true);
    let response: Response;
    try {
      response = await options.fetch(`https://${host}${path}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-client-id': credential.clientId,
          'x-request-timestamp': timestamp,
          'x-signature': signTingeeRequest(credential.secretToken, timestamp, body),
        },
        body,
      });
    } catch {
      throw new TingeeError('upstream', 'tingee: the request did not complete');
    }
    if (!response.ok) throw new TingeeError('upstream', `tingee: HTTP ${response.status}`);
    let answer: unknown;
    try {
      answer = parseResponse(await response.text());
    } catch {
      throw new TingeeError('upstream', 'tingee: the answer is not JSON');
    }
    if (!isRecord(answer)) throw new TingeeError('upstream', 'tingee: the answer has an unexpected shape');
    const code = String(answer.code ?? '');
    if (code !== '00') {
      const message = typeof answer.message === 'string' ? answer.message : '';
      if (code === '92' || (code === '97' && !/duplicate/i.test(message))) throw new TingeeError('credentials', `tingee refused the credential (code ${code})`, code);
      if (code === '90' || code === '91') throw new TingeeError('clock', `tingee refused the request time (code ${code}); check this server's clock`, code);
      if (code === '1001') throw new TingeeError('rate_limited', 'tingee: too many requests (code 1001)', code);
      if (code === '1107') throw new TingeeError('config', 'tingee: the window is too long (code 1107)', code);
      throw new TingeeError('upstream', `tingee answered code ${/^[0-9A-Za-z_-]{1,12}$/.test(code) ? code : 'unknown'}`, /^[0-9A-Za-z_-]{1,12}$/.test(code) ? code : null);
    }
    if (!isRecord(answer.data)) throw new TingeeError('upstream', 'tingee: the answer has no data');
    return answer.data;
  }

  return {
    id: 'bank_tingee',
    hosts: TINGEE_HOSTS,

    async accounts(secret: string): Promise<BankFeedAccount[]> {
      const credential = parseTingeeSecret(secret);
      const found = new Map<string, BankFeedAccount>();
      for (let page = 0, skip = 0; page < MAX_PAGES; page++) {
        const data = await call(credential, ACCOUNTS_PATH, { skipCount: skip, maxResultCount: ACCOUNT_PAGE_SIZE });
        const items = Array.isArray(data.items) ? (data.items as unknown[]) : null;
        if (items === null) throw new TingeeError('upstream', 'tingee: the account list has an unexpected shape');
        for (const item of items) {
          if (!isRecord(item) || item.status !== 'active') continue;
          const number = [item.vaAccountNumber, item.accountNumber].find((v): v is string => typeof v === 'string' && v.trim() !== '' && !hasControlCharacter(v));
          if (number === undefined) continue;
          const id = number.trim().slice(0, 200);
          const bank = typeof item.bankName === 'string' && item.bankName.trim() !== '' ? item.bankName.trim() : typeof item.bankBin === 'string' ? item.bankBin.trim() : '';
          const owner = typeof item.accountName === 'string' ? cleanText(item.accountName).trim() : '';
          const displayName = [bank, id].filter((p) => p !== '').join(' ') + (owner !== '' ? ` - ${owner}` : '');
          if (!found.has(id)) found.set(id, { externalAccountId: id, displayName: displayName.slice(0, 200) });
        }
        skip += items.length;
        if (typeof data.totalCount !== 'number') throw new TingeeError('upstream', 'tingee: the account list has no total');
        if (items.length === 0 || skip >= data.totalCount) return [...found.values()];
      }
      throw new TingeeError('upstream', 'tingee: the account list never ended');
    },

    async pull(secret: string, externalAccountId: string, cursor: string | null): Promise<BankFeedPull> {
      const credential = parseTingeeSecret(secret);
      if (externalAccountId.length < 1 || externalAccountId.length > 200 || hasControlCharacter(externalAccountId)) throw new TingeeError('config', 'tingee: unknown account');
      const present = now().getTime();
      let from: number;
      if (cursor === null) {
        // The start of the day FIRST_PULL_DAYS ago, Vietnam time.
        const today = parseStamp(`${vietnamStamp(new Date(present)).slice(0, 8)}000000`) as number;
        from = today - FIRST_PULL_DAYS * DAY_MS;
      } else {
        const at = parseStamp(cursor);
        if (at === null) throw new TingeeError('config', 'tingee: unreadable cursor');
        from = at;
      }
      let days = MAX_WINDOW_DAYS;
      for (;;) {
        // Both ends are inclusive and a second apart from the next window's start, so the span is a little under `days`.
        const end = Math.min(from + days * DAY_MS - 1000, present);
        const lines: BankFeedTransaction[] = [];
        const ordered: Array<{ at: string; id: string; line: BankFeedTransaction }> = [];
        let tooMany = false;
        for (let page = 0, skip = 0; page < MAX_PAGES; page++) {
          const data = await call(credential, TRANSACTIONS_PATH, {
            skipCount: skip,
            maxResultCount: PAGE_SIZE,
            vaAccountNumbers: [externalAccountId],
            startTime: vietnamStamp(new Date(from)),
            endTime: vietnamStamp(new Date(end)),
          });
          const items = Array.isArray(data.items) ? (data.items as unknown[]) : null;
          if (items === null) throw new TingeeError('upstream', 'tingee: the transaction list has an unexpected shape');
          for (const [i, item] of items.entries()) {
            const line = toLine(item, skip + i);
            if (line === null) continue;
            const row = item as Record<string, unknown>;
            ordered.push({ at: String(row.transactionDate), id: typeof row.transactionId === 'string' ? row.transactionId : '', line });
          }
          skip += items.length;
          if (typeof data.totalCount !== 'number') throw new TingeeError('upstream', 'tingee: the transaction list has no total');
          const total = data.totalCount;
          if (total > MAX_LINES_PER_PULL) tooMany = true;
          if (tooMany || items.length === 0 || skip >= total) break;
          if (page === MAX_PAGES - 1) throw new TingeeError('upstream', 'tingee: the transaction list never ended');
        }
        if (tooMany) {
          if (days <= 1) throw new TingeeError('bad_page', 'tingee: a single day has more transactions than one pull may carry');
          days = Math.max(1, Math.floor(days / 2));
          continue;
        }
        // Oldest first, as the port asks; the order of Tingee's own answer is not documented.
        ordered.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        for (const o of ordered) lines.push(o.line);
        const more = end < present;
        // A window that reaches the present leaves the cursor OVERLAP_DAYS back (never behind where it started), so the next pull reads the last days again; an earlier one moves on to the next second.
        const next = more ? end + 1000 : Math.max(from, present - OVERLAP_DAYS * DAY_MS);
        return { transactions: lines, cursor: vietnamStamp(new Date(next)), more };
      }
    },
  };
}
