// SPDX-License-Identifier: AGPL-3.0-only
// Security invariants for @crove/sign Vietnam CA adapters (self-contained suite for Decision 7).
// Locks SSRF allowlisting, HTTP/redirect refusal, secret redaction, reconcile_only, and USB-token refusal.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CA_PROVIDERS,
  CaProviderError,
  createPinnedCaFetch,
  getCaAdapter,
  isPublicCaIpAddress,
} from '../../src/index.ts';

const DIGEST = createHash('sha256').update('ludy-invariant-digest').digest('hex');

const SECRETS = {
  sandbox: 'sandbox',
  vnpt_smartca: JSON.stringify({
    spId: 'vnpt-inv-sp',
    spPassword: 'vnpt-inv-password',
    userId: '079090000111',
  }),
  viettel_mysign: JSON.stringify({
    clientId: 'vt-inv-client',
    clientSecret: 'vt-inv-secret',
    userId: 'vt-inv-user',
    profileId: 'vt-inv-profile',
  }),
  misa_wesign: JSON.stringify({
    clientId: 'misa-inv-client',
    clientKey: 'misa-inv-key',
    username: 'signer@example.com',
    password: 'misa-inv-password',
  }),
} as const;

describe('CA adapter security invariants', () => {
  it('enforces remote-only capabilities and reconcile_only initiation on every provider', () => {
    for (const id of CA_PROVIDERS) {
      const adapter = getCaAdapter(id);
      expect(adapter.capabilities.localUsbTokenSupported).toBe(false);
      expect(adapter.capabilities.signing).not.toBe('usb_token');
      expect(adapter.capabilities.retry.initiateSign).toBe('reconcile_only');
    }
  });

  it('refuses private hosts, IP literals, non-HTTPS, and non-allowlisted URLs before calling fetch', async () => {
    const blockedUrls = [
      'http://gwsca.vnpt.vn',
      'https://127.0.0.1/sca',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/ca',
      'https://ca.internal/api',
      'https://attacker.example/api',
      'https://user:pass@gwsca.vnpt.vn',
      'https://gwsca.vnpt.vn:8443/sca',
    ];

    for (const id of ['vnpt_smartca', 'viettel_mysign', 'misa_wesign'] as const) {
      let fetchCalls = 0;
      const neverFetch: typeof fetch = async () => {
        fetchCalls += 1;
        return new Response('{}', { status: 200 });
      };
      const adapter = getCaAdapter(id, { fetch: neverFetch });
      const baseCreds = JSON.parse(SECRETS[id]) as Record<string, unknown>;

      for (const badUrl of blockedUrls) {
        await expect(
          adapter.testConnection(JSON.stringify({ ...baseCreds, baseUrl: badUrl })),
        ).rejects.toMatchObject({ kind: 'unsafe_url' });
        await expect(
          adapter.initiateSign(JSON.stringify({ ...baseCreds, baseUrl: badUrl }), {
            idempotencyKey: 'inv-ssrf-1',
            digestSha256: DIGEST,
            certRef: 'cert-1',
          }),
        ).rejects.toMatchObject({ kind: 'unsafe_url' });
      }
      expect(fetchCalls).toBe(0);
    }
  });

  it('uses redirect: error and never leaks credential secrets into error messages', async () => {
    const marker = 'INVARIANT-TOP-SECRET-TOKEN';
    for (const id of ['vnpt_smartca', 'viettel_mysign', 'misa_wesign'] as const) {
      let sawRedirectError = false;
      const redirectFetch: typeof fetch = async (_input, init) => {
        sawRedirectError = init?.redirect === 'error';
        throw new Error(`HTTP 500 upstream error body leaked ${marker}`);
      };
      const adapter = getCaAdapter(id, { fetch: redirectFetch });
      const secret = SECRETS[id].replace(
        /vnpt-inv-password|vt-inv-secret|misa-inv-password/,
        marker,
      );

      const err = await adapter
        .initiateSign(secret, {
          idempotencyKey: 'inv-secret-1',
          digestSha256: DIGEST,
          certRef: 'cert-1',
        })
        .catch((e: unknown) => e);
      expect(sawRedirectError).toBe(true);
      expect(err).toBeInstanceOf(CaProviderError);
      expect(String(err)).not.toContain(marker);
      expect((err as Error).message).not.toContain(marker);
    }
  });

  it('rejects USB-token / hardware-token modes in credentials and signing requests without contacting fetch', async () => {
    for (const id of CA_PROVIDERS) {
      let fetchCalls = 0;
      const neverFetch: typeof fetch = async () => {
        fetchCalls += 1;
        return new Response('{}', { status: 200 });
      };
      const adapter = getCaAdapter(id, { fetch: neverFetch });
      const baseSecret = id === 'sandbox' ? {} : (JSON.parse(SECRETS[id]) as Record<string, unknown>);

      for (const badMode of ['usb_token', 'USB', 'pkcs11', 'hw_token']) {
        expect(
          await adapter.testConnection(JSON.stringify({ ...baseSecret, mode: badMode })),
        ).toBe('usb_token_unsupported');
        await expect(
          adapter.initiateSign(SECRETS[id], {
            idempotencyKey: `inv-usb-${badMode}`,
            digestSha256: DIGEST,
            certRef: `usb:${badMode}`,
            signingMode: badMode,
          } as unknown as Parameters<typeof adapter.initiateSign>[1]),
        ).rejects.toMatchObject({ kind: 'usb_token_unsupported' });
      }
      expect(fetchCalls).toBe(0);
    }
  });

  it('rejects private/loopback/metadata DNS resolutions in createPinnedCaFetch before opening sockets', async () => {
    expect(isPublicCaIpAddress('203.113.131.1')).toBe(true);
    expect(isPublicCaIpAddress('127.0.0.1')).toBe(false);
    expect(isPublicCaIpAddress('169.254.169.254')).toBe(false);
    expect(isPublicCaIpAddress('::1')).toBe(false);
    expect(isPublicCaIpAddress('::ffff:127.0.0.1')).toBe(false);

    for (const badAddress of ['127.0.0.1', '169.254.169.254', '10.0.0.5', '172.16.0.1', '192.168.1.1', '::1', '::ffff:127.0.0.1']) {
      let socketsOpened = 0;
      const pinnedFetch = createPinnedCaFetch({
        dnsLookup: async () => [{ address: badAddress, family: badAddress.includes(':') ? 6 : 4 }],
        requestImpl: (() => {
          socketsOpened += 1;
          throw new Error('socket must not be opened');
        }) as unknown as typeof import('node:https').request,
      });
      const adapter = getCaAdapter('vnpt_smartca', { fetch: pinnedFetch });
      await expect(
        adapter.initiateSign(SECRETS.vnpt_smartca, {
          idempotencyKey: 'inv-dns-pin-1',
          digestSha256: DIGEST,
          certRef: 'cert-1',
        }),
      ).rejects.toMatchObject({ kind: 'unsafe_url' });
      expect(socketsOpened).toBe(0);
    }
  });
});
