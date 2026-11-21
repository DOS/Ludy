// SPDX-License-Identifier: AGPL-3.0-only
// The MISA adapter is built and off (#2503): EINVOICE_PROVIDERS=misa is refused, at start and where the providers are built, until the issues of MISA_GATES are done and written
// in the issue; and its transport reaches nothing but MISA's own host over https, through the egress guard.
import { describe, expect, it, vi } from 'vitest';
import { EInvoiceProviderError, MISA_GATES, misaBlockers } from '@ludy/einvoice';
import { EgressError, type EgressResponse, type guardedRequest } from '@ludy/kernel-runtime';
import { loadConfig } from '../src/config.ts';
import { einvoiceProvidersOf } from '../src/kernel.ts';
import { misaTransport } from '../src/einvoice-transport.ts';

const base = { DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'j'.repeat(40), AUTH_ISSUER: 'crove-auth' };

describe('EINVOICE_PROVIDERS=misa stays refused until its gates are written', () => {
  it('has both gates open today', () => {
    expect(MISA_GATES.map((g) => g.issue)).toEqual([2506, 2507]);
    expect(misaBlockers().map((g) => g.issue)).toEqual([2506, 2507]);
  });

  it('is refused at start, on a local and on a public deployment', () => {
    expect(loadConfig({ ...base }).EINVOICE_PROVIDERS).toBe('');
    expect(() => loadConfig({ ...base, EINVOICE_PROVIDERS: 'misa' })).toThrow(/EINVOICE_PROVIDERS=misa is refused until #2506 and #2507/);
    expect(() => loadConfig({ ...base, EINVOICE_PROVIDERS: 'sandbox, misa' })).toThrow(/EINVOICE_PROVIDERS=misa/);
    expect(() => loadConfig({ ...base, PUBLIC_URL: 'https://books.example.com', PUBLIC_AUTH_URL: 'https://auth.example.com/auth/v1', EINVOICE_SANDBOX: 'false', EINVOICE_PROVIDERS: 'misa' })).toThrow(/EINVOICE_PROVIDERS=misa/);
    expect(() => loadConfig({ ...base, EINVOICE_PROVIDERS: 'Not An Id' })).toThrow(/EINVOICE_PROVIDERS/);
    // Leaving it out, or an empty list, offers nothing and boots.
    expect(() => loadConfig({ ...base, EINVOICE_PROVIDERS: '' })).not.toThrow();
  });

  it('is refused where the providers are built, whatever got past the config', () => {
    expect(einvoiceProvidersOf({ EINVOICE_SANDBOX: 'false', EINVOICE_PROVIDERS: '' })).toEqual({});
    expect(Object.keys(einvoiceProvidersOf({ EINVOICE_SANDBOX: 'true', EINVOICE_PROVIDERS: '' }))).toEqual(['sandbox']);
    // An id this build does not know offers nothing.
    expect(einvoiceProvidersOf({ EINVOICE_SANDBOX: 'false', EINVOICE_PROVIDERS: 'typo' })).toEqual({});
    expect(() => einvoiceProvidersOf({ EINVOICE_SANDBOX: 'false', EINVOICE_PROVIDERS: 'misa' })).toThrow(/#2506 and #2507/);
    expect(() => einvoiceProvidersOf({ EINVOICE_SANDBOX: 'true', EINVOICE_PROVIDERS: 'sandbox,misa' })).toThrow(/#2506 and #2507/);
  });
});

describe('the MISA transport', () => {
  const answer = (status: number, body: string): EgressResponse => ({ url: 'https://developer.misa.vn/x', status, contentType: 'application/json', body: Buffer.from(body), truncated: false });
  const call = { method: 'POST' as const, url: 'https://developer.misa.vn/apis/itg/meinvoice/invoice/token', headers: { ClientID: 'c' }, body: '{"a":1}' };

  it('sends through the guard to https and MISA\'s host with the headers and the body, and returns the status and text', async () => {
    const request = vi.fn(async () => answer(200, '{"Success":true}'));
    const out = await misaTransport({ request: request as unknown as typeof guardedRequest })(call);
    expect(out).toEqual({ status: 200, body: '{"Success":true}' });
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init, options] = request.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: Buffer }, { timeoutMs: number; overLimit: string }];
    expect(url).toBe(call.url);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ ClientID: 'c' });
    expect(init.body.toString()).toBe('{"a":1}');
    expect(options.overLimit).toBe('fail');
  });

  it('sends a GET with no body', async () => {
    const request = vi.fn(async () => answer(200, '{}'));
    await misaTransport({ request: request as unknown as typeof guardedRequest })({ ...call, method: 'GET', body: null });
    expect(Object.keys((request.mock.calls[0] as unknown as [string, object])[1])).not.toContain('body');
  });

  it('refuses another host, plain http and a URL that is not one, before the guard is asked', async () => {
    const request = vi.fn(async () => answer(200, '{}'));
    const transport = misaTransport({ request: request as unknown as typeof guardedRequest });
    for (const url of ['https://example.com/apis/itg/meinvoice/invoice/token', 'http://developer.misa.vn/apis/itg/meinvoice/invoice/token', 'https://developer.misa.vn.example.com/x', 'not a url']) {
      await expect(transport({ ...call, url })).rejects.toMatchObject({ kind: 'unreachable' });
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('says unreachable when nothing was sent, timeout at the deadline and lost_answer for the rest', async () => {
    const failing = (code: ConstructorParameters<typeof EgressError>[0] | 'other') =>
      misaTransport({
        request: (async () => {
          throw code === 'other' ? new Error('boom') : new EgressError(code, 'recorded');
        }) as unknown as typeof guardedRequest,
      })(call);
    for (const code of ['invalid_url', 'blocked', 'dns'] as const) await expect(failing(code)).rejects.toMatchObject({ kind: 'unreachable' });
    await expect(failing('timeout')).rejects.toMatchObject({ kind: 'timeout' });
    for (const code of ['too_large', 'network', 'encoding', 'redirects', 'other'] as const) await expect(failing(code)).rejects.toBeInstanceOf(EInvoiceProviderError);
    await expect(failing('network')).rejects.toMatchObject({ kind: 'lost_answer' });
  });
});
