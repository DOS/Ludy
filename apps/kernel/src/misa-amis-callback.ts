// SPDX-License-Identifier: AGPL-3.0-only
// The callback MISA AMIS posts the result of a save to (#3903, S4 of #3854). The route is public: the only thing that tells a message from MISA is the HMAC of its `data` with the ClientID, one key for the whole
// deployment, so a good signature proves the sender and not the organisation. The API holds no tenant context at this edge and cannot enter a system context (that is the worker's alone, gate T5), so it records
// nothing about a voucher: after the signature is good it hands the signed results to a machinery table through one orgless definer (ludy_finance.misa_amis_callback_enqueue, as a bank feed notice does,
// ADR-0039), and the worker relay (misa-amis-callback-relay.ts) finds the organisation from our own stored push row and records through the one write path.
//
// Order of work, which is the point: the client address is limited and the body capped before the body is read (http.ts); readCallback parses only the signature and `data`, compares in constant time and only
// then reads the rest; only a verified message reaches the database. A refusal is a fixed code and nothing else: the body, the signature, MISA's text and the ClientID are never logged, stored or echoed (MISA's
// own capped text for a refusal is the one thing stored, in the machinery table, until the relay is done with it). A verified message is answered 200 whatever its results are, so the answer never tells a caller
// whether an org_refid exists; the API reads no tenant row at all. `batchError` and every other unsigned field are not passed on.
import { sql } from 'kysely';
import { readCallbackAny, type AmisCallbackKey } from '@ludy/misa-amis';
import type { Runtime } from '@ludy/kernel-runtime';

// 1000 results of about 300 bytes each, with the envelope and MISA's error texts (each cut at 500 characters): well inside this.
export const MAX_MISA_AMIS_CALLBACK_BYTES = 1024 * 1024;

export type MisaAmisCallbackOutcome =
  | { status: 200 }
  | { status: 401; code: 'WEBHOOK_SIGNATURE' }
  | { status: 400; code: 'WEBHOOK_MALFORMED' };

// `keys` are the ClientIDs the deployment holds, one per product (MISA AMIS and MISA ASP post to the one address, #4103): the signature must verify under one of them and the envelope's `app_id` must be that one.
// The product of the key that verified travels with the results (the enqueue of that product), so the relay can settle a voucher only for the product that signed. Nothing here, and nothing the route logs, says
// which key matched or which failed.
export async function acceptMisaAmisCallback(runtime: Runtime, keys: readonly AmisCallbackKey[], rawBody: string): Promise<MisaAmisCallbackOutcome> {
  const read = readCallbackAny(rawBody, keys);
  if (!read.ok) return read.reason === 'signature' || read.reason === 'app_id' ? { status: 401, code: 'WEBHOOK_SIGNATURE' } : { status: 400, code: 'WEBHOOK_MALFORMED' };
  const { callback } = read;
  // A message that repeats a refid keeps its last result, as polling does; the relay records forward only, whatever the order.
  // A result whose voucher type is not one AMIS has (1 to 99) is dropped on its own: it would fail the integer cast of the whole list and make MISA retry the message for ever.
  const results = [...new Map(callback.results.filter((r) => r.voucherType >= 1 && r.voucherType <= 99).map((r) => [r.orgRefId, r] as const)).values()];
  if (results.length === 0) return { status: 200 };
  // The envelope's company code is a hint the relay compares with the located connection's own code. MISA's text is kept for a refusal only.
  await runtime.orgless(async (db) => {
    const args = sql`${callback.orgCompanyCode}, ${results.map((r) => r.orgRefId)}::uuid[], ${results.map((r) => r.voucherType)}::integer[], ${results.map((r) => r.success)}::boolean[],
        ${results.map((r) => r.errorCode)}::text[], ${results.map((r) => (r.success ? null : r.errorMessage))}::text[]`;
    // One definer per product, each writing its own product on the machinery row: a result signed under one product's ClientID is never taken for the other's. Where both products hold the same ClientID the
    // signature cannot tell them apart: the result is stored for each, and the claim finds the stored voucher only through a connection of that product, so only the real one's row is settled.
    for (const product of read.products) await (product === 'asp' ? sql`SELECT ludy_finance.misa_asp_callback_enqueue(${args})` : sql`SELECT ludy_finance.misa_amis_callback_enqueue(${args})`).execute(db);
  });
  return { status: 200 };
}
