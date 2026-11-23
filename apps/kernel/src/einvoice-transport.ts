// SPDX-License-Identifier: AGPL-3.0-only
// The MISA adapter's transport (#2503, ADR-0044 point 6): every call goes through the egress guard (public addresses only, the connection pinned to the checked address, one
// deadline, a byte limit, no redirect followed), to https and to the adapter's declared hosts only. A call to anything else is refused before a socket is opened.
import { EInvoiceProviderError, MISA_HOSTS, type MisaRequest, type MisaResponse, type MisaTransport } from '@ludy/einvoice';
import { EgressError, guardedRequest } from '@ludy/kernel-runtime';

// Publishing signs on the provider's HSM, so it may take a while; the answers (an XML, a PDF in base64) stay small.
const TIMEOUT_MS = 30_000;
const MAX_BYTES = 16 * 1024 * 1024;

export interface MisaTransportOptions {
  // Tests only: recorded answers in place of the network.
  request?: typeof guardedRequest;
}

export function misaTransport(options: MisaTransportOptions = {}): MisaTransport {
  const request = options.request ?? guardedRequest;
  return async (call: MisaRequest): Promise<MisaResponse> => {
    let url: URL;
    try {
      url = new URL(call.url);
    } catch {
      throw new EInvoiceProviderError('unreachable');
    }
    if (url.protocol !== 'https:' || !(MISA_HOSTS as readonly string[]).includes(url.hostname)) throw new EInvoiceProviderError('unreachable');
    try {
      const answer = await request(
        url.toString(),
        { method: call.method, headers: call.headers, ...(call.body === null ? {} : { body: Buffer.from(call.body, 'utf8') }) },
        { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES, overLimit: 'fail', accept: 'application/json' },
      );
      return { status: answer.status, body: answer.body.toString('utf8') };
    } catch (error) {
      if (!(error instanceof EgressError)) throw new EInvoiceProviderError('lost_answer');
      // Refused before anything was sent: certain. A deadline or a broken connection may have come after MISA got the request.
      if (error.code === 'invalid_url' || error.code === 'blocked' || error.code === 'dns') throw new EInvoiceProviderError('unreachable');
      throw new EInvoiceProviderError(error.code === 'timeout' ? 'timeout' : 'lost_answer');
    }
  };
}
