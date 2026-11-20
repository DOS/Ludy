// SPDX-License-Identifier: AGPL-3.0-only
// The callback MISA AMIS posts the result of a save or a delete to (#3854). The envelope is { success, app_id, error_code, error_message, signature, data_type, org_company_code, data }, `data` being a JSON string
// of results, and `signature` the hex HMAC-SHA256 of that string with the integrator's ClientID as the key. ONLY `data` is signed: app_id, org_company_code and data_type are not, so a caller must never
// believe org_company_code (a replayed message could carry another one): it finds the organisation from its own stored push row by org_refid and compares.
//
// Order of reading: the raw body is parsed only as far as the `signature` and `data` strings, the signature is checked in constant time, and only then is `data` parsed and every other field read.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isOrgRefId } from './vouchers.ts';
import { safeAmisCode } from './errors.ts';
import type { AmisProduct } from './client.ts';

export interface AmisCallbackResult {
  // Ludy's voucher id, lower case.
  orgRefId: string;
  voucherType: number;
  success: boolean;
  // MISA's error code when it is a plain word, else null.
  errorCode: string | null;
  errorMessage: string | null;
  sessionId: string | null;
}
export interface AmisCallback {
  dataType: number;
  // As the (unsigned) envelope says: a hint to compare with the stored connection, never a fact.
  orgCompanyCode: string;
  // The envelope's own error_code when it says the whole batch failed (success false) and the code is a plain word. NOT signed, so it never moves the state of a request: at most it is a reason to poll for the signed results.
  batchError: string | null;
  results: AmisCallbackResult[];
}
export type AmisCallbackRead = { ok: true; callback: AmisCallback } | { ok: false; reason: 'malformed' | 'signature' | 'app_id' | 'data' };

export const AMIS_CALLBACK_RESULTS_MAX = 1000;
const MESSAGE_MAX = 500;
const ORG_COMPANY_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/** The signature MISA puts on `data`: hex HMAC-SHA256 with the ClientID as the key. */
export function signCallbackData(data: string, clientId: string): string {
  return createHmac('sha256', clientId).update(data, 'utf8').digest('hex');
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

// MISA's text is untrusted and ends in a text column: a NUL (or a lone surrogate) makes PostgreSQL refuse the value (22021), so the command would fail, the route would answer 503 and MISA would retry for ever.
// NUL and every other control character (C0, DEL and C1, a newline and a tab included: a refusal reason is one line) are dropped before the cap, and a lone surrogate becomes U+FFFD.
const withoutControls = (value: string): string =>
  Array.from(value.toWellFormed())
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return !(code <= 0x1f || (code >= 0x7f && code <= 0x9f));
    })
    .join('');
const text = (value: unknown, max: number): string | null => (typeof value === 'string' ? withoutControls(value).slice(0, max) : null);

/** The results in a `data` string (a callback's or a polling answer's), or null when it is not a list of results in the document's shape. */
export function parseCallbackResults(data: string): AmisCallbackResult[] | null {
  let list: unknown;
  try {
    list = JSON.parse(data);
  } catch {
    return null;
  }
  if (!Array.isArray(list) || list.length > AMIS_CALLBACK_RESULTS_MAX) return null;
  const results: AmisCallbackResult[] = [];
  for (const item of list as unknown[]) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (!isOrgRefId(row.org_refid) || !Number.isInteger(row.voucher_type) || typeof row.success !== 'boolean') return null;
    results.push({
      orgRefId: row.org_refid.toLowerCase(),
      voucherType: row.voucher_type as number,
      success: row.success,
      errorCode: safeAmisCode(row.error_code),
      errorMessage: text(row.error_message, MESSAGE_MAX),
      sessionId: text(row.session_id, 64),
    });
  }
  return results;
}

/** A ClientID the deployment holds and the product it was issued for (#4103): MISA AMIS and MISA ASP post to one address, each signing with its own. */
export interface AmisCallbackKey {
  product: AmisProduct;
  clientId: string;
}
// `products`: every product whose key verified the message (one, unless the deployment holds the same ClientID for both products, which MISA may issue: then the signature cannot tell them apart).
export type AmisCallbackReadAny = { ok: true; callback: AmisCallback; products: AmisProduct[] } | { ok: false; reason: 'malformed' | 'signature' | 'app_id' | 'data' };

/**
 * The callback read against every key a deployment holds, one per product: the keys that verify the signature of `data` and equal the envelope's `app_id` give the message's product(s) (an AMIS-signed
 * result must not settle an ASP voucher, nor the reverse: the caller keeps the product with the result). Where the deployment holds the SAME ClientID for both products every product matches and all are returned: the
 * signature cannot tell them apart, so the caller stores the result for each and the claim, which finds the stored voucher only through a connection of that product, lets the real connection's row through. Every key is tried, none is skipped once another has matched, so the time taken does not say which key signed
 * or how many were tried before it. A failure that no key decides (a body that is not an envelope, a `data` that is not a list of results) is that failure; otherwise the refusal is the signature's, whichever key
 * came closest (a good signature under another `app_id` is the same refusal as a bad signature). Nothing here names a key.
 */
export function readCallbackAny(rawBody: string, keys: readonly AmisCallbackKey[]): AmisCallbackReadAny {
  const reads = keys.map((key) => ({ key, read: readCallback(rawBody, key.clientId) }));
  const good = reads.find((r) => r.read.ok);
  if (good?.read.ok) return { ok: true, callback: good.read.callback, products: [...new Set(reads.filter((r) => r.read.ok).map((r) => r.key.product))] };
  const decided = reads.find((r) => !r.read.ok && (r.read.reason === 'malformed' || r.read.reason === 'data'));
  return decided && !decided.read.ok ? { ok: false, reason: decided.read.reason } : { ok: false, reason: 'signature' };
}

export function readCallback(rawBody: string, clientId: string): AmisCallbackRead {
  let envelope: unknown;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) return { ok: false, reason: 'malformed' };
  const fields = envelope as Record<string, unknown>;
  // Only these two are read before the signature is known to be good.
  const signature = fields.signature;
  const data = fields.data;
  // A `data` with an unpaired surrogate is refused: it would be hashed as the replacement character, the same as a text that really holds one.
  if (typeof signature !== 'string' || typeof data !== 'string' || data === '' || !data.isWellFormed()) return { ok: false, reason: 'malformed' };
  if (!sameText(signature.toLowerCase(), signCallbackData(data, clientId))) return { ok: false, reason: 'signature' };
  if (typeof fields.app_id !== 'string' || !sameText(fields.app_id, clientId)) return { ok: false, reason: 'app_id' };
  const orgCompanyCode = fields.org_company_code;
  if (typeof orgCompanyCode !== 'string' || !ORG_COMPANY_CODE.test(orgCompanyCode) || !Number.isInteger(fields.data_type)) return { ok: false, reason: 'malformed' };
  const results = parseCallbackResults(data);
  if (results === null) return { ok: false, reason: 'data' };
  const batchError = fields.success === false ? (safeAmisCode(fields.error_code) ?? 'unknown') : null;
  return { ok: true, callback: { dataType: fields.data_type as number, orgCompanyCode, batchError, results } };
}
