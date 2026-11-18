// SPDX-License-Identifier: AGPL-3.0-only
// The calls to MISA AMIS Kế toán (AMISKT v1.0.0, #3854). The adapter has no network of its own: the caller injects a transport bound to AMIS_HOSTS and https (the kernel's guarded egress), as the meInvoice adapter
// does. The integrator's ClientID is a secret of the deployment (it is also the callback's HMAC key): it lives only in this closure, goes out only in the ClientID header, and is in no error. The customer's access
// code is given per call and exchanged for a token that is kept in memory only, never stored.
//
// Nothing is retried here except one renewal of an expired token. A save is idempotent by org_refid (the same id updates the same request until a person has turned it into a voucher, then AMIS answers
// IsCreatedVoucher) and a delete of a missing request answers VoucherNotFound, so the caller may ask again after a `timeout` or a `lost_answer`.
import { createHash } from 'node:crypto';
import { AmisError, amisErrorKind, safeAmisCode, type AmisErrorKind } from './errors.ts';
import { toJsonText } from './json.ts';
import { parseCallbackResults, type AmisCallbackResult } from './callback.ts';
import { AMIS_SAVE_BATCH_MAX, checkVoucher, isKnownVoucherType, isOrgRefId, type AmisVoucher } from './vouchers.ts';

export const AMIS_HOSTS = ['developer.misa.vn'] as const;
// The document's base URL; the paths below follow it. Unconfirmed until the live sandbox check.
export const AMIS_BASE_URL = 'https://developer.misa.vn/apis';

export interface AmisRequest {
  method: 'POST' | 'DELETE';
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string;
}
export interface AmisResponse {
  status: number;
  body: string;
}
// Rejects with an AmisError: `unreachable` when nothing was sent, `timeout` or `lost_answer` when the request may have reached MISA. Any other rejection is taken as `unreachable`.
export type AmisTransport = (request: AmisRequest) => Promise<AmisResponse>;

/** One customer's connection: the access code they made in AMIS and the code Ludy gave their data (org_company_code, free text on MISA's side). */
export interface AmisConnection {
  accessCode: string;
  orgCompanyCode: string;
}

// The numbers of get_dictionary's data_type.
export const AMIS_DICTIONARIES = {
  accountObject: 1,
  inventoryItem: 2,
  stock: 3,
  unit: 4,
  account: 5,
  organizationUnit: 6,
  bank: 8,
  expenseItem: 9,
  inventoryCategory: 14,
} as const;
export type AmisDictionaryType = (typeof AMIS_DICTIONARIES)[keyof typeof AMIS_DICTIONARIES];

export interface AmisDictionaryQuery {
  dataType: AmisDictionaryType;
  skip: number;
  take: number;
  // Only what changed since the previous answer's time (the document's last_sync_time), or null for everything.
  lastSyncTime?: string | null;
  branchId?: string | null;
}
export type AmisRecord = Readonly<Record<string, unknown>>;

export interface AmisClientOptions {
  clientId: string;
  transport: AmisTransport;
  // Milliseconds, for the token's life; a test passes its own.
  now?: () => number;
}

export interface AmisClient {
  /** The test of a connection: asks for a token, then for the company's information. Rejects with `credentials` when the access code or the app is refused. */
  companyInfo(connection: AmisConnection, branchId?: string | null): Promise<AmisRecord | null>;
  dictionary(connection: AmisConnection, query: AmisDictionaryQuery): Promise<AmisRecord[]>;
  /** Creates catalogue entries (parties, items, ...): only for rows a person confirmed. */
  saveDictionary(connection: AmisConnection, dataType: AmisDictionaryType, rows: readonly AmisRecord[]): Promise<void>;
  /** Pushes vouchers as requests to generate a voucher. Success means MISA queued them; the results come by callback or by `callbackResults`. */
  save(connection: AmisConnection, vouchers: readonly AmisVoucher[]): Promise<void>;
  /** Removes requests not yet turned into vouchers. */
  remove(connection: AmisConnection, vouchers: readonly { voucher_type: number; org_refid: string }[]): Promise<void>;
  /** The results of earlier saves and deletes, when the callback could not reach us (dates are YYYY-MM-DD). The shape of MISA's answer is unconfirmed until the live sandbox check. */
  callbackResults(connection: AmisConnection, range: { from: string; to: string; skip: number; take: number }): Promise<AmisCallbackResult[]>;
}

// MISA says 24 hours in one place and 12 in another, and gives `expired_time` without a time zone: the token is trusted for half an hour at most and renewed once when MISA says it is expired.
export const AMIS_TOKEN_TTL_MS = 30 * 60 * 1000;
const PAGE_MAX = 1000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Answer {
  data: unknown;
}

export function createAmisClient(options: AmisClientOptions): AmisClient {
  const { clientId, transport } = options;
  const now = options.now ?? Date.now;
  const tokens = new Map<string, { token: string; until: number }>();
  const pending = new Map<string, Promise<string>>();

  const keyOf = (c: AmisConnection) => `${c.orgCompanyCode}\u0000${createHash('sha256').update(c.accessCode).digest('hex')}`;

  async function send(path: string, method: AmisRequest['method'], body: unknown, token: string | null): Promise<Answer> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ClientID: clientId };
    if (token !== null) headers['X-MISA-AccessToken'] = token;
    // Written first: a value that cannot be written is refused here, before the transport is asked to send anything.
    const text = toJsonText(body);
    let response: AmisResponse;
    try {
      response = await transport({ method, url: `${AMIS_BASE_URL}${path}`, headers, body: text });
    } catch (error: unknown) {
      // The transport's own three kinds pass; anything else it throws (its message may name a header) is `unreachable`.
      // Rebuilt, not rethrown: whatever the transport attached to its error (a request, headers) is not passed on.
      throw new AmisError(error instanceof AmisError && (error.kind === 'unreachable' || error.kind === 'timeout' || error.kind === 'lost_answer') ? error.kind : 'unreachable');
    }
    // The status is read before the body: only a 2xx can be a success, a gateway's 401 or 403 is a refused connection, anything else non-2xx is not MISA's answer.
    if (response.status === 401 || response.status === 403) throw new AmisError('credentials');
    if (response.status >= 500 || response.status === 429) throw new AmisError('unavailable');
    if (response.status < 200 || response.status > 299) throw new AmisError('invalid_response');
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new AmisError('invalid_response');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new AmisError('invalid_response');
    const answer = parsed as Record<string, unknown>;
    const code = safeAmisCode(answer.ErrorCode);
    if (answer.Success === false || (answer.Success !== true && code !== null)) {
      const kind: AmisErrorKind = code === null ? 'refused' : amisErrorKind(code);
      throw new AmisError(kind, { code });
    }
    if (answer.Success !== true) throw new AmisError('invalid_response');
    return { data: answer.Data };
  }

  async function fetchToken(c: AmisConnection): Promise<string> {
    let answer: Answer;
    try {
      answer = await send('/amiskt/v1/token', 'POST', { access_code: c.accessCode, org_company_code: c.orgCompanyCode }, null);
    } catch (error: unknown) {
      // A refused token request means the access code (or the app) is refused: nothing to renew.
      if (error instanceof AmisError && error.kind === 'token') throw new AmisError('credentials', { code: error.code });
      throw error;
    }
    const data = answer.data;
    const token = typeof data === 'object' && data !== null ? (data as Record<string, unknown>).access_token : undefined;
    if (typeof token !== 'string' || token === '') throw new AmisError('invalid_response');
    return token;
  }

  async function tokenOf(c: AmisConnection): Promise<string> {
    const key = keyOf(c);
    const hit = tokens.get(key);
    if (hit && now() < hit.until) return hit.token;
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;
    const request = fetchToken(c)
      .then((token) => {
        tokens.set(key, { token, until: now() + AMIS_TOKEN_TTL_MS });
        return token;
      })
      .finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  }

  // One call with the connection's token. An expired or refused token is renewed once; if the second answer is the same, the connection is what is refused.
  async function authed(c: AmisConnection, path: string, method: AmisRequest['method'], body: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const token = await tokenOf(c);
      try {
        return (await send(path, method, body, token)).data;
      } catch (error: unknown) {
        if (!(error instanceof AmisError) || error.kind !== 'token') throw error;
        // Only the token that was refused is dropped: another call may have renewed it meanwhile.
        if (tokens.get(keyOf(c))?.token === token) tokens.delete(keyOf(c));
        if (attempt > 0) throw new AmisError('credentials', { code: error.code });
      }
    }
  }

  const asList = (data: unknown): unknown[] => {
    let value = data;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        throw new AmisError('invalid_response');
      }
    }
    if (!Array.isArray(value)) throw new AmisError('invalid_response');
    return value as unknown[];
  };
  const records = (list: unknown[]): AmisRecord[] => list.filter((row): row is AmisRecord => typeof row === 'object' && row !== null && !Array.isArray(row));
  const page = (skip: number, take: number) => {
    if (!Number.isSafeInteger(skip) || skip < 0 || !Number.isSafeInteger(take) || take < 1 || take > PAGE_MAX) throw new AmisError('invalid_request', { reason: 'bad_page' });
  };

  return {
    async companyInfo(c, branchId = null) {
      const data = await authed(c, '/amiskt/v1/get_company_info', 'POST', { branch_id: branchId });
      let value = data;
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch {
          return null;
        }
      }
      return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as AmisRecord) : null;
    },

    async dictionary(c, query) {
      page(query.skip, query.take);
      const data = await authed(c, '/amiskt/v1/get_dictionary', 'POST', {
        data_type: query.dataType,
        skip: query.skip,
        take: query.take,
        last_sync_time: query.lastSyncTime ?? null,
        branch_id: query.branchId ?? null,
      });
      return records(asList(data));
    },

    async saveDictionary(c, dataType, rows) {
      if (rows.length === 0 || rows.length > AMIS_SAVE_BATCH_MAX) throw new AmisError('invalid_request', { reason: 'too_many_rows' });
      toJsonText(rows);
      await authed(c, '/amiskt/v1/save_dictionary', 'POST', { org_company_code: c.orgCompanyCode, data_type: dataType, dictionary: rows });
    },

    async save(c, vouchers) {
      if (vouchers.length === 0 || vouchers.length > AMIS_SAVE_BATCH_MAX) throw new AmisError('invalid_request', { reason: 'too_many_vouchers' });
      for (const voucher of vouchers) checkVoucher(voucher);
      // One kind per call: the document does not say a mixed list is taken.
      if (new Set(vouchers.map((v) => v.voucher_type)).size > 1) throw new AmisError('invalid_request', { reason: 'mixed_voucher_types' });
      await authed(c, '/amiskt/v1/save', 'POST', { org_company_code: c.orgCompanyCode, voucher: vouchers });
    },

    async remove(c, vouchers) {
      if (vouchers.length === 0 || vouchers.length > AMIS_SAVE_BATCH_MAX) throw new AmisError('invalid_request', { reason: 'too_many_vouchers' });
      for (const v of vouchers) {
        if (!isOrgRefId(v.org_refid)) throw new AmisError('invalid_request', { reason: 'bad_org_refid' });
        if (!isKnownVoucherType(v.voucher_type)) throw new AmisError('invalid_request', { reason: 'bad_voucher_type' });
      }
      await authed(c, '/amiskt/v1/delete', 'DELETE', { org_company_code: c.orgCompanyCode, voucher: vouchers.map((v) => ({ voucher_type: v.voucher_type, org_refid: v.org_refid })) });
    },

    async callbackResults(c, range) {
      page(range.skip, range.take);
      if (!DATE.test(range.from) || !DATE.test(range.to)) throw new AmisError('invalid_request', { reason: 'bad_page' });
      const data = await authed(c, '/amiskt/v1/get_call_back_detail_error', 'POST', { from_date: range.from, to_date: range.to, skip: String(range.skip), take: String(range.take) });
      const results = parseCallbackResults(typeof data === 'string' ? data : JSON.stringify(data ?? null));
      if (results === null) throw new AmisError('invalid_response');
      return results;
    },
  };
}
