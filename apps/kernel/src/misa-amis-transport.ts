// SPDX-License-Identifier: AGPL-3.0-only
// The MISA AMIS adapter's transport (#3885, S2b of #3854): every call goes through the egress guard (public addresses only, the connection pinned to the checked address, one deadline, a byte
// limit, no redirect followed), to https and to AMIS_HOSTS only. A call to anything else is refused before a socket is opened. The adapter's `AmisError` kinds are the only thing that comes out
// of a failure: no URL, header or message of the guard travels on.
import { AMIS_HOSTS, AmisError, type AmisRequest, type AmisResponse, type AmisTransport } from '@crove/misa-amis';
import { EgressError, guardedRequest } from '@crove/kernel-runtime';

// AMIS answers a save before it has made the voucher, and a page of the dictionary is at most a thousand rows: 30 s and 16 MB are generous for both.
const TIMEOUT_MS = 30_000;
const MAX_BYTES = 16 * 1024 * 1024;

export interface AmisTransportOptions {
  // Tests only: recorded answers in place of the network.
  request?: typeof guardedRequest;
}

export function amisTransport(options: AmisTransportOptions = {}): AmisTransport {
  const request = options.request ?? guardedRequest;
  return async (call: AmisRequest): Promise<AmisResponse> => {
    let url: URL;
    try {
      url = new URL(call.url);
    } catch {
      throw new AmisError('unreachable');
    }
    if (url.protocol !== 'https:' || !(AMIS_HOSTS as readonly string[]).includes(url.hostname)) throw new AmisError('unreachable');
    try {
      const answer = await request(
        url.toString(),
        { method: call.method, headers: call.headers, body: Buffer.from(call.body, 'utf8') },
        { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES, overLimit: 'fail', accept: 'application/json' },
      );
      return { status: answer.status, body: answer.body.toString('utf8') };
    } catch (error) {
      if (!(error instanceof EgressError)) throw new AmisError('lost_answer');
      // Refused before anything was sent: certain. A deadline or a broken connection may have come after AMIS got the request.
      if (error.code === 'invalid_url' || error.code === 'blocked' || error.code === 'dns') throw new AmisError('unreachable');
      throw new AmisError(error.code === 'timeout' ? 'timeout' : 'lost_answer');
    }
  };
}
