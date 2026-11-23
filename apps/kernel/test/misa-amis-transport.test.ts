// SPDX-License-Identifier: AGPL-3.0-only
// The MISA AMIS transport (#3885, S2b of #3854): https and developer.misa.vn only, through the egress guard, and only the adapter's own error kinds come out of a failure.
import { describe, expect, it } from 'vitest';
import { AMIS_BASE_URL, AmisError, type AmisRequest } from '@ludy/misa-amis';
import { EGRESS_ERROR_CODES, EgressError, type guardedRequest } from '@ludy/kernel-runtime';
import { amisTransport } from '../src/misa-amis-transport.ts';

const call = (over: Partial<AmisRequest> = {}): AmisRequest => ({ method: 'POST', url: `${AMIS_BASE_URL}/amiskt/v1/token`, headers: { ClientID: 'client-id-1234', 'Content-Type': 'application/json' }, body: '{"a":1}', ...over });

type Seen = { url: string; request: Parameters<typeof guardedRequest>[1]; options: Parameters<typeof guardedRequest>[2] };
function recorder(answer: () => Promise<Awaited<ReturnType<typeof guardedRequest>>>) {
  const seen: Seen[] = [];
  const request: typeof guardedRequest = async (url, req, options) => {
    seen.push({ url, request: req, options });
    return answer();
  };
  return { seen, request };
}
const answer = (status: number, body: string) => async () => ({ url: 'https://developer.misa.vn/', status, contentType: 'application/json', body: Buffer.from(body, 'utf8'), truncated: false });

describe('the MISA AMIS transport', () => {
  it('sends the request through the guard with its method, headers and body, under a deadline and a byte cap', async () => {
    const { seen, request } = recorder(answer(200, '{"Success":true}'));
    const out = await amisTransport({ request })(call());
    expect(out).toEqual({ status: 200, body: '{"Success":true}' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://developer.misa.vn/apis/amiskt/v1/token');
    expect(seen[0]?.request.method).toBe('POST');
    expect(seen[0]?.request.headers).toEqual({ ClientID: 'client-id-1234', 'Content-Type': 'application/json' });
    expect(seen[0]?.request.body?.toString('utf8')).toBe('{"a":1}');
    expect(seen[0]?.options).toMatchObject({ timeoutMs: 30_000, overLimit: 'fail' });
    expect(seen[0]?.options.maxBytes).toBeGreaterThan(0);
  });

  it('passes a DELETE through too', async () => {
    const { seen, request } = recorder(answer(200, '{}'));
    await amisTransport({ request })(call({ method: 'DELETE', url: `${AMIS_BASE_URL}/amiskt/v1/delete` }));
    expect(seen[0]?.request.method).toBe('DELETE');
  });

  it('refuses any host but the adapter\'s and any scheme but https before the guard is asked', async () => {
    const { seen, request } = recorder(answer(200, '{}'));
    const transport = amisTransport({ request });
    for (const url of ['http://developer.misa.vn/apis/x', 'https://evil.example/apis/x', 'https://developer.misa.vn.evil.example/apis/x', 'https://sub.developer.misa.vn/apis/x', 'ftp://developer.misa.vn/x', 'not a url', '']) {
      await expect(transport(call({ url }))).rejects.toMatchObject({ name: 'AmisError', kind: 'unreachable' });
    }
    expect(seen).toEqual([]);
  });

  it('says "unreachable" for what the guard refused before anything was sent, and "timeout" or "lost_answer" for what may have reached AMIS', async () => {
    const kinds: Record<string, string> = { invalid_url: 'unreachable', blocked: 'unreachable', dns: 'unreachable', timeout: 'timeout' };
    for (const code of EGRESS_ERROR_CODES) {
      const { request } = recorder(async () => {
        throw new EgressError(code, 'the guard\'s own message, which names https://developer.misa.vn and a header');
      });
      const error = await amisTransport({ request })(call()).catch((e: unknown) => e);
      expect(error, code).toBeInstanceOf(AmisError);
      expect((error as AmisError).kind, code).toBe(kinds[code] ?? 'lost_answer');
      // What comes out is rebuilt: nothing of the guard's message, the URL or the headers.
      expect(JSON.stringify(error), code).not.toContain('developer.misa.vn');
      expect((error as Error).message, code).not.toContain('guard');
    }
  });

  it('turns any other failure of the guard into "lost_answer", without its message', async () => {
    const { request } = recorder(async () => {
      throw new Error('socket hang up while sending ClientID: client-id-1234');
    });
    const error = await amisTransport({ request })(call()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AmisError);
    expect((error as AmisError).kind).toBe('lost_answer');
    expect((error as Error).message).not.toContain('client-id-1234');
  });
});
