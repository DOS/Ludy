// SPDX-License-Identifier: AGPL-3.0-only
// The wake-up webhook side of the conformance check (issue #4592; docs/runbooks/mcp-wake-webhook.md, ADR-0051 decision 4).
//
// A connector has to answer the signed `POST` Ludy sends. This file holds the three things the check needs:
//   - `signWake` and `verifyWake`, the rules of the runbook's "Verify it" section (HMAC-SHA256 over `<timestamp>.<raw body>`, constant-time compare
//     against each `v1=` value, a 5 minute replay window);
//   - `createReceiver`, a small receiver that follows them and also drops a repeated event id (the sample webhook of the check);
//   - `sendSamples`, which posts sample events to a receiver (the sample one, or the connector's own at --wake-url) and names what it got wrong.
// Plain Node, no dependencies. An instance cannot be asked to send to a loopback address (it sends to public https names only), so the check
// sends the samples itself: they are signed exactly as the runbook says Ludy signs.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const WINDOW_SECONDS = 300;

/** The test vectors of the runbook ("Test vectors"). A test pins that they are the runbook's. */
export const VECTORS = {
  signer: 'whsec_test_secret_0123456789abcdef',
  previous: 'whsec_other_secret_0123456789abcdef',
  timestamp: '1700000000',
  ping: {
    body: '{"id":"0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a10","type":"ping","created_at":"2026-11-12T03:00:00.000Z","org":"0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a11","grant":"0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a12","data":{}}',
    signature: 'v1=1b9e5052b71fa74cc80fe158f86ea39f178fdfeb59060102e9fd3793d96f47fb',
  },
  schedule: {
    body: '{"id":"0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a10","type":"schedule.due","created_at":"2026-11-12T03:00:00.000Z","org":"0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a11","grant":"0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a12","data":{"date":"2026-11-12"}}',
    signature: 'v1=250e53a9834e4a5b6c4e385b2112157f001bbbc4a09126aad833aee1db9205f0',
  },
  rotation: 'v1=1b9e5052b71fa74cc80fe158f86ea39f178fdfeb59060102e9fd3793d96f47fb,v1=92211602375e74f1fb5c5818ae5848dfaa15cfc7643e3576209a22854f4df395',
};

/** @param {string} secret @param {string} timestamp @param {string} rawBody */
export function signWake(secret, timestamp, rawBody) {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

/**
 * The runbook's verifier. `headers` are lower-cased. Refuses a timestamp more than 5 minutes from `now` (ms), a malformed timestamp and a
 * signature that matches none of the `v1=` values.
 * @param {string} secret @param {Record<string, string | undefined>} headers @param {string} rawBody @param {number} [now]
 */
export function verifyWake(secret, headers, rawBody, now = Date.now()) {
  const ts = headers['ludy-timestamp'];
  if (!/^\d{9,12}$/.test(ts ?? '') || Math.abs(now / 1000 - Number(ts)) > WINDOW_SECONDS) return false;
  const want = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest();
  return String(headers['ludy-signature'] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('v1='))
    .some((part) => {
      const got = Buffer.from(part.slice(3), 'hex');
      return got.length === want.length && timingSafeEqual(got, want);
    });
}

/**
 * The sample receiver: verifies, drops an event id it already handled (answering 200 so the sender stops retrying) and counts what it processed.
 * `flaws` names deliberate faults, for the test of the check: 'accept-stale', 'accept-forged', 'process-repeats'.
 * @param {string} secret @param {{ flaws?: string[] }} [options]
 */
export function createReceiver(secret, options = {}) {
  const flaws = new Set(options.flaws ?? []);
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const processed = [];
  const server = createServer((request, response) => {
    /** @type {Buffer[]} */
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      /** @type {Record<string, string | undefined>} */
      const headers = {};
      for (const name of ['ludy-event-id', 'ludy-timestamp', 'ludy-signature']) {
        const value = request.headers[name];
        headers[name] = Array.isArray(value) ? value.join(',') : value;
      }
      const trusted = flaws.has('accept-forged') || verifyWake(secret, headers, raw, Date.now());
      // 'accept-stale' checks the signature but waives the replay window.
      const waived = flaws.has('accept-stale') && verifySignatureOnly(secret, headers, raw);
      if (!trusted && !waived) {
        response.statusCode = 401;
        response.end();
        return;
      }
      const eventId = headers['ludy-event-id'] ?? '';
      if (seen.has(eventId) && !flaws.has('process-repeats')) {
        response.statusCode = 200;
        response.end();
        return;
      }
      seen.add(eventId);
      processed.push(eventId);
      response.statusCode = 204;
      response.end();
    });
  });
  return {
    processed,
    /** @returns {Promise<string>} */
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const address = /** @type {import('node:net').AddressInfo} */ (server.address());
          resolve(`http://127.0.0.1:${address.port}/wake`);
        });
      }),
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}

/** @param {string} secret @param {Record<string, string | undefined>} headers @param {string} rawBody */
function verifySignatureOnly(secret, headers, rawBody) {
  const want = createHmac('sha256', secret).update(`${headers['ludy-timestamp'] ?? ''}.${rawBody}`).digest();
  return String(headers['ludy-signature'] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('v1='))
    .some((part) => {
      const got = Buffer.from(part.slice(3), 'hex');
      return got.length === want.length && timingSafeEqual(got, want);
    });
}

/** A `ping` body as Ludy writes it, with a fresh event id. @returns {{ id: string, body: string }} */
export function sampleBody() {
  const id = randomUUID();
  return { id, body: JSON.stringify({ id, type: 'ping', created_at: new Date().toISOString(), org: randomUUID(), grant: randomUUID(), data: {} }) };
}

/**
 * Posts one signed delivery. Resolves with the HTTP status (0 when the connection failed).
 * @param {string} url @param {{ id: string, body: string, timestamp: string, signature: string }} delivery
 */
async function post(url, delivery) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', 'ludy-event-id': delivery.id, 'ludy-timestamp': delivery.timestamp, 'ludy-signature': delivery.signature },
      body: delivery.body,
      signal: AbortSignal.timeout(10_000),
    });
    await response.arrayBuffer().catch(() => undefined);
    return response.status;
  } catch {
    return 0;
  }
}

const isOk = (/** @type {number} */ status) => status >= 200 && status < 300;

/**
 * The samples a receiver must get right. Returns one verdict per named rule (`{ name, ok, message }`) and the event id it sent twice.
 * @param {string} url @param {string} secret
 * @returns {Promise<{ verdicts: { name: string, ok: boolean, message: string }[], repeatedId: string }>}
 */
export async function sendSamples(url, secret) {
  const now = Math.floor(Date.now() / 1000);
  /** @param {number} offset @param {{ secretToUse?: string, tamper?: boolean, signWith?: string[] }} [how] */
  const delivery = (offset, how = {}) => {
    const { id, body } = sampleBody();
    const timestamp = String(now + offset);
    const sent = how.tamper ? `${body} ` : body;
    const signature = (how.signWith ?? [how.secretToUse ?? secret]).map((s) => signWake(s, timestamp, body)).join(',');
    return { id, body: sent, timestamp, signature };
  };
  /** @type {{ name: string, ok: boolean, message: string }[]} */
  const out = [];
  const verdict = (/** @type {string} */ name, /** @type {boolean} */ ok, /** @type {string} */ message) => out.push({ name, ok, message });

  const valid = await post(url, delivery(0));
  verdict('wake.valid-accepted', isOk(valid), isOk(valid) ? `a correctly signed event was answered ${valid}` : `a correctly signed event was answered ${valid || 'with no answer'}; it must be 2xx`);

  const inside = await post(url, delivery(-240));
  verdict('wake.window-accepted', isOk(inside), isOk(inside) ? 'an event signed 4 minutes ago was accepted' : `an event signed 4 minutes ago (inside the window) was answered ${inside || 'with no answer'}; it must be 2xx`);

  const forged = await post(url, delivery(0, { tamper: true }));
  const wrong = await post(url, delivery(0, { secretToUse: 'whsec_not_the_secret' }));
  verdict(
    'wake.bad-signature-refused',
    !isOk(forged) && !isOk(wrong),
    !isOk(forged) && !isOk(wrong) ? 'a changed body and a wrong secret were both refused' : `${isOk(forged) ? 'a body changed after signing was accepted' : 'a wrong secret was accepted'}; verify the HMAC over the raw bytes`,
  );

  const past = await post(url, delivery(-(WINDOW_SECONDS + 60)));
  const future = await post(url, delivery(WINDOW_SECONDS + 60));
  verdict(
    'wake.stale-timestamp-refused',
    !isOk(past) && !isOk(future),
    !isOk(past) && !isOk(future) ? 'a timestamp 6 minutes old and one 6 minutes ahead were both refused' : `a validly signed event with a timestamp ${isOk(past) ? '6 minutes old' : '6 minutes ahead'} was accepted; refuse a timestamp more than 5 minutes from your clock`,
  );

  const rotated = await post(url, delivery(0, { signWith: ['whsec_old_secret_for_rotation', secret] }));
  verdict('wake.rotation-accepted', isOk(rotated), isOk(rotated) ? 'an event with two signatures, one of them current, was accepted' : `an event with two v1= values (one valid) was answered ${rotated || 'with no answer'}; accept it if any value matches`);

  const again = delivery(0);
  const first = await post(url, again);
  const second = await post(url, again);
  const answered = (/** @type {number} */ status) => isOk(status) || status === 409;
  verdict(
    'wake.repeated-event-id',
    answered(first) && answered(second),
    answered(first) && answered(second) ? 'the same event id sent twice was answered both times without an error (handle it once)' : `a repeated event id was answered ${first || 'nothing'} then ${second || 'nothing'}; answer 2xx (or 409) and handle the id once`,
  );
  return { verdicts: out, repeatedId: again.id };
}
