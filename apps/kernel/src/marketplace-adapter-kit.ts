// SPDX-License-Identifier: AGPL-3.0-only
// The pieces every real marketplace adapter shares (#2524, #4237; ADR-0045 point 7): the host-bound fetch, the money parser, the field allow-list that drops a buyer's data at the edge, the capped
// reader of an answer and the page a provider returns being refused as `not_recognized` rather than stored or thrown raw. An adapter (Lazada first, then TikTok Shop) builds on these and adds
// only what is its platform's: the signature, the paths, the status table. Nothing here names a platform.
import { allowlistedFetch, type Fetch } from '@crove/bank-feed';
import { MarketplaceProviderError } from '@crove/mod-finance';

export type { Fetch };

// The fetch an adapter is given: bound to the hosts it declares, over https, with a deadline, and a redirect is never followed, so an allowed host cannot hand a request and its credential to another
// one. The adapter never uses the global fetch.
export const hostBoundFetch = (hosts: readonly string[], fetchImpl?: Fetch, timeoutMs?: number): Fetch => allowlistedFetch(hosts, fetchImpl, timeoutMs);

// The most bytes of an answer an adapter reads: a page is at most a hundred orders of a few kilobytes each, so a larger answer is not the platform's.
export const MARKETPLACE_MAX_ANSWER_BYTES = 4_000_000;

// An amount as the platforms write it and the ledger keeps it: a decimal string with at most four decimals. A JS number, an exponent, a thousands separator or a currency sign is not one.
const MONEY = /^-?\d{1,16}(\.\d{1,4})?$/;
export function marketplaceMoney(value: unknown): string | null {
  return typeof value === 'string' && MONEY.test(value) ? value : null;
}

// Whether a text carries a mask (asterisks), as a platform hides what an app has no right to read. Such a value is never stored: a page that holds one is refused, not guessed.
export const looksMasked = (value: string): boolean => value.includes('*');

const hasControlCharacter = (text: string): boolean => [...text].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
// A text made safe to keep: control characters become spaces, then it is cut to `max` characters.
// Cut by characters, not by UTF-16 units, so a character outside the basic plane is never split.
export function cleanLabel(text: string, max: number): string {
  const plain = Array.from(text, (ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? ' ' : ch)).join('').trim();
  return Array.from(plain).slice(0, max).join('');
}
// An identifier (an order number, an item id, a SKU): short, one line, never masked.
export function marketplaceIdentifier(value: unknown, max: number): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) value = String(value);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length < 1 || text.length > max || hasControlCharacter(text) || looksMasked(text)) return null;
  return text;
}

// An id that is only digits (a Lazada order or item id): not a comma, a bracket or a space that could break the list an items call is asked for.
export function marketplaceDigits(value: unknown, max: number): string | null {
  const id = marketplaceIdentifier(value, max);
  return id !== null && /^\d+$/.test(id) ? id : null;
}

// A calendar day written YYYY-MM-DD that exists.
export function isoDay(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

// Only the named fields of a platform's record: everything else (a buyer's name, phone, address, id, note, tax code, a platform's own internal fields) is dropped here, at the edge, before any other code
// sees the record. An adapter reads a record only through this, never as the whole object.
export function pickAllowed<K extends string>(record: unknown, keys: readonly K[]): Partial<Record<K, unknown>> | null {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return null;
  const source = record as Record<string, unknown>;
  const out: Partial<Record<K, unknown>> = {};
  for (const key of keys) if (Object.hasOwn(source, key)) out[key] = source[key];
  return out;
}

// The text of an answer, read in pieces and refused past `maxBytes` (a declared length too large is refused before reading). `refuse` is what the adapter throws: never the platform's own text.
export async function readCappedAnswer(response: Response, refuse: () => Error, maxBytes = MARKETPLACE_MAX_ANSWER_BYTES): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw refuse();
  }
  if (!response.body) {
    const text = await response.text();
    if (text.length > maxBytes) throw refuse();
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw refuse();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// An answer as JSON, with an integer too large for a JS number kept as the digits the platform wrote, but ONLY in the fields named in `idKeys`: order and item ids of fifteen or sixteen digits can pass
// 2^53, and a parse and a stringify would silently turn them into other ids. Anywhere else (an amount above all) such an integer stays a number, which the decimal-string rule then refuses: money is
// never a number, and this must not turn one into a string that passes.
export function parseMarketplaceJson(text: string, idKeys: readonly string[]): unknown {
  const ids = new Set(idKeys);
  const reviver = (key: string, value: unknown, context?: { source?: string }): unknown =>
    ids.has(key) && typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) && typeof context?.source === 'string' && /^-?\d+$/.test(context.source) ? context.source : value;
  return JSON.parse(text, reviver as unknown as Parameters<typeof JSON.parse>[1]);
}

// A page the adapter will not store: it is `not_recognized` on the connection, the cursor stays and nothing is written. The error carries only its kind, never a value or the platform's text.
export const notRecognized = (): MarketplaceProviderError => new MarketplaceProviderError('not_recognized');
